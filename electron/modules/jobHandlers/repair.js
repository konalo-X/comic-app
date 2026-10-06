'use strict'

const path = require('path')
const fs = require('fs')
const safeFs = require('../safeFs')
const sources = require('../../sources/registry')
const db = require('../../db')
const { sleep } = require('../../utils')
const {
  findComicDir, getPrimaryDownloadRoot,
  downloadChapterImages, checkComicHealth, downloadBuf, existsAsync
} = require('../downloadPaths')
const sharpPool = require('../sharpPool')
const { getJobQueue } = require('./helpers')

async function autoRepairDownloadedComics() {
  const jobQueue = getJobQueue()
  if (!jobQueue) return
  try {
    const result = await db.getComics({ page: 1, pageSize: 100, localOnly: true })
    const comics = result.docs || result.data || result
    let enqueued = 0

    for (const comic of comics) {
      if (!comic.local_path) continue
      if (!comic.sourceUrl) continue
      // [2026-10-06] 已导出 EPUB 的漫画不修复(原图可能已删, epub_exported 标记保证不重拉)
      if (comic.epubExported) continue

      const comicDir = comic.local_path
      if (!(await existsAsync(comicDir))) continue

      const health = await checkComicHealth(comicDir)
      if (health.healthy) continue

      const activeJobs = jobQueue.listJobs('active', 200).filter(j =>
        j.type === 'repairComic' && j.payload?.sourceUrl === comic.sourceUrl
      )
      if (activeJobs.length > 0) continue

      jobQueue.add('repairComic', {
        sourceUrl: comic.sourceUrl,
        comicTitle: comic.title,
        comicDir: comic.local_path,
        deepCheck: false
      }, { priority: 5, source: 'auto' })
      enqueued++
    }

    if (enqueued > 0) {
      console.log(`[AutoRepair] 已为 ${enqueued} 部问题漫画创建修复任务`)
    } else {
      console.log('[AutoRepair] 所有已下载漫画健康，无需修复')
    }
  } catch (e) {
    console.warn('[AutoRepair] 自动修复扫描失败:', e.message)
  }
}

async function jobHandlerRepairComic(job, onProgress) {
  const { sourceUrl, comicTitle, comicDir: payloadComicDir, deepCheck } = job.payload

  if (!sourceUrl) throw new Error('repairComic 需要 sourceUrl')

  const comic = await db.getComicByUrl(sourceUrl)
  if (!comic) throw new Error(`未找到漫画: ${sourceUrl}`)
  // [2026-10-06] 已导出 EPUB 的漫画不修复(原图可能已删)
  if (comic.epubExported) {
    console.log(`[修复] ${comicTitle} 已导出 EPUB, 跳过修复`)
    return { success: true, skipped: true, reason: 'epub_exported' }
  }

  const comicDir = payloadComicDir || comic.local_path || await findComicDir(comic.title, sourceUrl)
  if (!comicDir || !(await existsAsync(comicDir))) {
    throw new Error(`漫画目录不存在: ${comicDir}`)
  }

  const downloadRoot = getPrimaryDownloadRoot()
  if (downloadRoot.startsWith('/Volumes/') && !(await existsAsync(downloadRoot))) {
    throw new Error(`下载磁盘未挂载: ${downloadRoot}`)
  }

  const src = sources.default
  const chapters = comic.chapters || []
  if (!chapters.length) throw new Error('漫画无章节信息')

  // [兜底补齐 2026-10-03] 波动墙下 repair 实时抓章节页也会拿到残缺图数(如6), 误判"健康"。
  // 用本漫画各章 image_count 的中位数当"应有图数基线": 某章明显低于基线(如 6 vs 同本~150) 就判残缺,
  // 即使 repair 实时抓取撞墙, 也能用同本基线发现缺图并触发重抓。
  const _counts = chapters.map(c => c.image_count || 0).filter(n => n > 0).sort((a, b) => a - b)
  const _median = _counts.length ? _counts[Math.floor(_counts.length / 2)] : 0
  const _expectedFor = (idx) => {
    const hist = chapters[idx] && chapters[idx].image_count ? chapters[idx].image_count : 0
    if (hist > 0) return hist
    return _median > 0 ? _median : 0
  }

  const chapterOnlineCounts = []
  if (deepCheck) {
    console.log(`[修复] 深度检查模式: 逐章获取在线图片数 ${comic.title}`)
    for (let i = 0; i < chapters.length; i++) {
      if (job.cancelled()) throw new Error('已取消')
      try {
        const pageList = await src.getPageList(chapters[i].url, sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        chapterOnlineCounts[i] = images ? images.length : 0
      } catch (e) {
        console.warn(`[修复] 获取在线图片数失败 章节${i}: ${e.message}`)
        chapterOnlineCounts[i] = null
      }
      if (i < chapters.length - 1) {
        if (job.cancelled()) break
        await sleep(800 + Math.random() * 1200)
      }
    }
  }

  const health = await checkComicHealth(comicDir, { chapterOnlineCounts })
  if (health.healthy) {
    console.log(`[修复] ${comic.title} 所有章节健康，无需修复`)
    return { healthy: true, repairedChapters: 0, totalImagesFixed: 0 }
  }

  let repairedChapters = 0
  let totalImagesFixed = 0

  if (health.missingCover && comic.cover) {
    const coverPath = path.join(comicDir, 'cover.webp')
    try {
      const { buffer: buf } = await downloadBuf(comic.cover, sourceUrl)
      await sharpPool.webpConvert(buf, coverPath, { quality: 85 })
      console.log(`[修复] ${comic.title} 封面已补全`)
    } catch (e) {
      console.warn(`[修复] ${comic.title} 封面补全失败: ${e.message}`)
    }
  }

  const problemChapters = health.chapters.filter(ch => !ch.healthy)
  // [兜底补齐 2026-10-03] 用同本中位数补判: 实时抓取撞墙导致 onlineCount 缺失时,
  // 本地图数远低于同本基线也判为残缺, 触发重抓。
  if (_median > 0) {
    for (const ch of health.chapters) {
      if (ch.healthy) continue
      if (ch.onlineCount && ch.onlineCount > 0) continue
      const exp = _expectedFor(ch.chapterIndex)
      if (exp > 0 && ch.validCount > 0 && ch.validCount < exp * 0.5) {
        if (!problemChapters.includes(ch)) problemChapters.push(ch)
      }
    }
  }
  console.log(`[修复] ${comic.title} 发现 ${problemChapters.length} 个问题章节`)

  for (let pi = 0; pi < problemChapters.length; pi++) {
    if (job.cancelled()) throw new Error('已取消')
    const ch = problemChapters[pi]
    const chapterIdx = ch.chapterIndex
    const chapterInfo = chapters[chapterIdx]
    if (!chapterInfo || !chapterInfo.url) {
      console.warn(`[修复] 章节 ${chapterIdx} 无在线URL，跳过`)
      continue
    }

    const chDir = path.join(comicDir, ch.dirName)
    if (!(await existsAsync(chDir))) {
      await safeFs.mkdir(chDir, { recursive: true })
    }

    try {
      const pageList = await src.getPageList(chapterInfo.url, sourceUrl)
      const images = Array.isArray(pageList) ? pageList : pageList.images
      if (!images?.length) {
        console.warn(`[修复] 章节 ${chapterIdx} 无法获取在线图片列表，跳过`)
        continue
      }

      const result = await downloadChapterImages(
        job, images, chDir, 0,
        comic.title, ch.dirName,
        { index: chapterIdx, url: chapterInfo.url },
        sourceUrl,
        (prog) => {
          onProgress({
            current: pi + 1,
            total: problemChapters.length,
            chapterName: ch.dirName,
            imageProgress: prog
          })
        }
      )

      if (result.success) {
        repairedChapters++
        totalImagesFixed += (result.downloaded || 0)
        console.log(`[修复] 章节 ${chapterIdx} (${ch.dirName}) 修复完成, 下载${result.downloaded || 0}张`)
        await db.saveDownloadRecord({
          comicId: sourceUrl, comicTitle: comic.title,
          chapterIndex: chapterIdx, chapterName: ch.dirName,
          imagesCount: result.downloaded, path: chDir
        })
      }
    } catch (e) {
      console.warn(`[修复] 章节 ${chapterIdx} 修复失败: ${e.message}`)
    }

    if (pi < problemChapters.length - 1) {
      if (job.cancelled()) break
      await sleep(1500 + Math.random() * 1500)
    }
  }

  console.log(`[修复] ${comic.title} 完成: 修复${repairedChapters}章, 补下${totalImagesFixed}张图片`)
  return { healthy: repairedChapters === problemChapters.length, repairedChapters, totalImagesFixed, totalProblemChapters: problemChapters.length }
}

module.exports = { jobHandlerRepairComic, autoRepairDownloadedComics }