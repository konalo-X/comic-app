'use strict'

const path = require('path')
const fs = require('fs')
const sharpPool = require('../sharpPool')
const { app } = require('electron')
const sources = require('../../sources/registry')
const db = require('../../db')
const { sanitizeFilename: sanitize } = require('../../utils')
const {
  resolveComicDir, getPrimaryDownloadRoot,
  findChapterDir, getValidChapterImages, getValidChapterImagesCached, listChapterImages,
  downloadChapterImages, downloadBuf,
  getGlobalDownloadConcurrency
} = require('../downloadPaths')

async function downloadCoverIfNeeded(comicDir, coverUrl, referer) {
  if (!coverUrl || fs.existsSync(path.join(comicDir, 'cover.webp'))) return
  try {
    const { buffer: buf } = await downloadBuf(coverUrl, referer)
    await sharpPool.webpConvert(buf, path.join(comicDir, 'cover.webp'), { quality: 85 })
  } catch (e) {
    console.warn(`[下载] 封面保存失败: ${e.message}`)
  }
}

async function checkChapterAlreadyDownloaded(comicDir, chapterIndex, chapterName, comicTitle, sourceUrl, usedDirs) {
  // 源站应有图数(image_count): skip 必须磁盘已有数 == 源站应有数, 否则当缺图补下。
  // 主人要求: 数量缺就不能算已下载, 不能 skip。未知(0)时保留旧行为(只要有图就跳)。
  let expected = 0
  try { expected = await db.getChapterImageCountBySourceUrl(sourceUrl, chapterIndex) } catch (_) {}
  const countOk = (validCount) => expected > 0 ? validCount >= expected : validCount > 0

  const chDirOnDisk = findChapterDir(comicDir, chapterIndex, chapterName, usedDirs)
  if (chDirOnDisk) {
    const { validFiles } = await getValidChapterImagesCached(chDirOnDisk)
    const allFiles = listChapterImages(chDirOnDisk)
    const corruptCount = allFiles.length - validFiles.length
    if (validFiles.length > 0 && corruptCount === 0 && countOk(validFiles.length)) {
      if (usedDirs) usedDirs.add(chDirOnDisk)
      try {
        await db.saveDownloadRecord({
          comicId: sourceUrl || comicTitle, comicTitle, chapterIndex,
          chapterName, imagesCount: validFiles.length, path: chDirOnDisk
        })
      } catch (_) {}
      return { skipped: true, validFiles: validFiles.length, chDirOnDisk }
    }
    // 数量不足 / 有损坏: 不 skip, 回去真下载补齐
    return { skipped: false, corrupt: corruptCount > 0, chDirOnDisk, validFiles: validFiles.length, expected }
  }

  const existingRecords = await db.getDownloadRecords({ comicId: sourceUrl || comicTitle, chapterIndex })
  const already = existingRecords.find(r =>
    (r.comicId === sourceUrl || r.comicId === comicTitle) && r.chapterIndex === chapterIndex
  )
  if (already && already.path && fs.existsSync(already.path)) {
    const { validFiles } = await getValidChapterImagesCached(already.path)
    if (validFiles.length > 0 && countOk(validFiles.length)) {
      return { skipped: true, validFiles: validFiles.length }
    }
  }

  return { skipped: false, expected }
}

async function downloadChapterCore(job, comicDir, chapter, chapterIndex, comicTitle, sourceUrl, referer, onProgress) {
  const src = sources.default
  const pageList = await src.getPageList(chapter.url, referer || sourceUrl)
  const images = Array.isArray(pageList) ? pageList : pageList.images
  const chapterName = Array.isArray(pageList) ? '' : (pageList.chapterName || '')
  if (!images || !images.length) throw new Error('无图片')

  const folder = sanitize(`${chapterIndex + 1}-${chapterName}`)
  const chDir = path.join(comicDir, folder)
  if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true })

  const result = await downloadChapterImages(job, images, chDir, 0, comicTitle, chapterName, chapter, sourceUrl, onProgress)
  return { result, chapterName, chDir }
}

async function saveChapterResult(chapterIndex, chapterName, comicTitle, sourceUrl, result, chDir) {
  if (!result.success) return
  // 源站应有图数 = result.total(getPageList 页数)。
  // result.downloaded 只是本次新下载的张数(增量补齐只下缺的),
  // 判断完整性必须看磁盘实际有效图数, 不能只看本次 downloaded。
  const expected = result.total || 0
  const hasFailed = !!(result.failedImages && result.failedImages.length)
  // 磁盘实际有效图数(真 sharp 校验, 含旧有+本次补的)
  let diskValid = 0
  try {
    const { getValidChapterImagesCached } = require('../downloadPaths')
    const r = await getValidChapterImagesCached(chDir)
    diskValid = r.validFiles.length
  } catch (_) {
    diskValid = result.downloaded || 0
  }
  // 主人要求: 只有「数量不缺 + 每张都真 sharp 过 OK」才算 success。
  const isComplete = expected > 0 && diskValid >= expected && !hasFailed
  try {
    await db.saveDownloadRecord({
      comicId: sourceUrl, comicTitle, chapterIndex,
      chapterName, imagesCount: diskValid, path: chDir,
      status: isComplete ? 'success' : 'incomplete'
    })
  } catch (_) {}
  if (sourceUrl) {
    // 图数列(image_count)应存源站应有数(total), 不能用实际落盘数覆盖,
    // 否则部分失败会把权威图数污染, 永久掩盖缺图。
    if (expected > 0) {
      try { await db.updateChapterImageCountBySourceUrl(sourceUrl, chapterIndex, expected) } catch (_) {}
    }
    try { await db.updateComic(sourceUrl, { local_path: path.dirname(chDir) }) } catch (_) {}
    // 规则：下载到本地的漫画默认为已收藏，纳入自动追更池
    try { await db.setFavorite(sourceUrl, 1) } catch (_) {}
    if (isComplete) {
      try { await db.resetUpdateDelta(sourceUrl) } catch (_) {}
    }
  }
  // 下载完成且完整的章: getValidChapterImagesCached 已对每张真 sharp 校验并写缓存,
  // 无需重复写。不完整时不标 success, 让后续 sync 重新校验发现缺图。
}

async function jobHandlerDownloadChapter(job, onProgress) {
  let { comicTitle, chapter, referer, sourceUrl, coverUrl, comicDir: payloadComicDir } = job.payload

  if (!comicTitle || !comicTitle.trim() || comicTitle.trim() === '未命名漫画') {
    throw new Error(`漫画名无效 (${comicTitle || '空'})，请先补全漫画详情后再下载`)
  }

  const comicDir = resolveComicDir(comicTitle, sourceUrl, payloadComicDir)
  await downloadCoverIfNeeded(comicDir, coverUrl, sourceUrl || referer)

  let actualChapterName = chapter.name
  if (db.isChapterNameGeneric?.(actualChapterName)) {
    console.warn(`[下载] 章节名过于简单 (${actualChapterName})，重新爬取详情页`)
    try {
      const source = sources.get('smtt6') || sources.default
      const detail = await source.getDetail(sourceUrl)
      if (detail.chapters && detail.chapters[chapter.index]) {
        actualChapterName = detail.chapters[chapter.index].name
        console.log(`[下载] 已校正章节名: ${actualChapterName}`)
      }
    } catch (e) {
      console.warn(`[下载] 重新爬取详情页失败: ${e.message}`)
    }
  }

  const skipResult = await checkChapterAlreadyDownloaded(comicDir, chapter.index, actualChapterName, comicTitle, sourceUrl)
  if (skipResult.skipped) {
    onProgress({ chapterIdx: chapter.index, current: 0, total: 0, downloaded: 0, done: true, skipped: true })
    return { success: true, skipped: true, chapter: actualChapterName, chapterDir: skipResult.chDirOnDisk, comicTitle }
  }

  if (skipResult.corrupt || (skipResult.chDirOnDisk && skipResult.validFiles > 0)) {
    const src = sources.default
    try {
      const pageList = await src.getPageList(chapter.url, referer || sourceUrl)
      const images = Array.isArray(pageList) ? pageList : pageList.images
      const onlineCount = images ? images.length : 0

      if (onlineCount > skipResult.validFiles || skipResult.corrupt) {
        const reason = skipResult.corrupt ? '检测到损坏图片，重新下载全章' : `漏下图片 (本地${skipResult.validFiles}图 / 在线${onlineCount}图)`
        console.log(`[下载] ${reason}: ${comicTitle} › ${actualChapterName}`)
        const result = await downloadChapterImages(job, images, skipResult.chDirOnDisk, 0, comicTitle, actualChapterName, chapter, sourceUrl, onProgress)
        await saveChapterResult(chapter.index, actualChapterName, comicTitle, sourceUrl, result, skipResult.chDirOnDisk)
        return { ...result, comicTitle }
      }
    } catch (e) {
      console.warn(`[下载] 检查漏下图片失败: ${e.message}`)
    }
    onProgress({ chapterIdx: chapter.index, current: 0, total: 0, downloaded: 0, done: true, skipped: true })
    return { success: true, skipped: true, chapter: actualChapterName, chapterDir: skipResult.chDirOnDisk, comicTitle }
  }

  try {
    const { result, chapterName, chDir } = await downloadChapterCore(
      job, comicDir, chapter, chapter.index, comicTitle, sourceUrl, referer, onProgress
    )
    await saveChapterResult(chapter.index, chapterName, comicTitle, sourceUrl, result, chDir)
    return { ...result, comicTitle }
  } catch (e) {
    throw e
  }
}

async function jobHandlerDownloadComic(job, onProgress) {
  let { comicTitle, chapters, referer, sourceUrl, coverUrl, comicDir: payloadComicDir } = job.payload

  if (!comicTitle || !comicTitle.trim() || comicTitle.trim() === '未命名漫画') {
    throw new Error(`漫画名无效 (${comicTitle || '空'})，请先补全漫画详情后再下载`)
  }

  const totalChapters = chapters.length
  if (!totalChapters) return { completed: 0, totalChapters: 0 }

  let downloadConcurrency = getGlobalDownloadConcurrency() || 3
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (stored.downloadConcurrency) downloadConcurrency = stored.downloadConcurrency
  } catch (_) {}

  const comicDir = resolveComicDir(comicTitle, sourceUrl, payloadComicDir)
  await downloadCoverIfNeeded(comicDir, coverUrl, sourceUrl || referer)

  let completed = 0
  const usedDirs = new Set()
  const results = []

  const processChapter = async (chapter, idx) => {
    if (job.cancelled()) return { cancelled: true }

    const chapterName = chapter.name || `第${idx + 1}章`

    const skipResult = await checkChapterAlreadyDownloaded(comicDir, idx, chapterName, comicTitle, sourceUrl, usedDirs)
    if (skipResult.skipped) {
      completed++
      onProgress({ chapter: completed, totalChapters, chapterName })
      return { success: true, skipped: true, chapter: chapterName }
    }
    if (skipResult.corrupt) {
      console.warn(`[下载] 整本下载检测到损坏章节: ${comicTitle} › ${chapterName}`)
    }

    try {
      const { result, chapterName: chName, chDir } = await downloadChapterCore(
        job, comicDir, chapter, idx, comicTitle, sourceUrl, referer,
        (prog) => {
          onProgress({
            chapter: completed, totalChapters, chapterName,
            current: prog.current, total: prog.total
          })
        }
      )
      await saveChapterResult(idx, chName, comicTitle, sourceUrl, result, chDir)
      completed++
      onProgress({ chapter: completed, totalChapters, chapterName: chName })
      return result
    } catch (e) {
      completed++
      onProgress({ chapter: completed, totalChapters, chapterName, error: e.message })
      return { error: e.message, chapter: chapterName }
    }
  }

  let idx = 0
  async function worker() {
    while (idx < chapters.length && !job.cancelled()) {
      const i = idx++
      try {
        results.push(await processChapter(chapters[i], i))
      } catch (e) {
        results.push({ error: e.message, chapter: chapters[i].name })
      }
      if (i < chapters.length - 1 && !job.cancelled()) {
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500))
      }
    }
  }

  const workers = Array.from({ length: downloadConcurrency }, () => worker())
  await Promise.all(workers)

  if (sourceUrl) {
    try { await db.updateComic(sourceUrl, { local_path: comicDir }) } catch (_) {}
    // 规则：下载到本地的漫画默认为已收藏，纳入自动追更池
    try { await db.setFavorite(sourceUrl, 1) } catch (_) {}
  }

  return { completed, totalChapters, results, comicTitle }
}

module.exports = { jobHandlerDownloadChapter, jobHandlerDownloadComic }