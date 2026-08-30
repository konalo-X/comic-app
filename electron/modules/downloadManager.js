'use strict'

const path = require('path')
const fs = require('fs')
const safeFs = require('./safeFs')
const { sanitizeFilename: sanitize } = require('../utils')
const sources = require('../sources/registry')
const {
  findComicDir,
  resolveUniqueComicDir,
  getPrimaryDownloadRoot,
  existsAsync,
  findChapterDir,
  getValidChapterImages,
  loadChapterState,
  saveChapterState,
  downloadAndConvert,
  validateImageFile,
  listChapterImages,
  getChapterStatePath
} = require('./downloadPaths')
const db = require('../db')

// ============ 下载管理器（保留原有兼容） ============
class DownloadManager {
  getStatePath(comicDir) { return path.join(comicDir, '.download_state.json') }
  async loadState(comicDir, title) {
    const p = this.getStatePath(comicDir)
    try { if (await existsAsync(p)) return JSON.parse(await safeFs.readFile(p, 'utf8')) } catch {}
    return null
  }
  async saveState(comicDir, title, state) {
    try { await safeFs.writeFile(this.getStatePath(comicDir), JSON.stringify(state, null, 2)) } catch {}
  }

  async downloadComic(comicData, win) {
    const { title, chapters, referer, cover, sourceUrl } = comicData
    if (!chapters?.length) return { success: false, error: '暂无章节' }

    // 优先复用现有目录，否则落到主路径
    let comicDir = await findComicDir(title, sourceUrl)
    if (!comicDir) {
      const preferred = path.join(getPrimaryDownloadRoot(), sanitize(title))
      comicDir = await resolveUniqueComicDir(preferred, sourceUrl)
    }
    // 安全检查：如果磁盘未挂载，不要创建本地目录
    const downloadRoot = getPrimaryDownloadRoot()
    if (downloadRoot.startsWith('/Volumes/') && !(await existsAsync(downloadRoot))) {
      throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
    }
    const state = await this.loadState(comicDir, title) || {
      comicId: sourceUrl, title, totalChapters: chapters.length,
      completedChapters: [], completedImages: 0, startTime: Date.now()
    }
    if (!(await existsAsync(comicDir))) await safeFs.mkdir(comicDir, { recursive: true })

    const src = sources.default
    let successImages = state.completedImages, failedChapters = 0
    let bytesDownloaded = 0
    let speedStartTime = Date.now()
    let speedBytes = 0
    let speed = '0 KB/s'

    if (cover && !state.completedChapters.includes(-1)) {
      const cp = path.join(comicDir, 'cover.webp')
      let coverOk = false
      if (!(await existsAsync(cp))) {
        try { await downloadAndConvert(cover, cp, referer); coverOk = true } catch (e) {
          console.warn(`[下载] 封面下载失败: ${e.message}`)
        }
      } else { coverOk = true }
      // Bug #13 修复: 只有封面下载成功(或已存在)才标记完成,失败不 push(-1) 以便下次重试
      if (coverOk) {
        state.completedChapters.push(-1)
        await this.saveState(comicDir, title, state)
      }
    }

    const usedDirs = new Set()
    for (let i = 0; i < chapters.length; i++) {
      if (state.completedChapters.includes(i)) continue
      const ch = chapters[i]

      // 扫描磁盘：章节是否已存在（带全局去重，避免同一目录被多个章节匹配）
      // 使用有效图片检测，过滤损坏文件
      const chDirOnDisk = await findChapterDir(comicDir, i, ch.name, usedDirs)
      if (chDirOnDisk) {
        const validFiles = await getValidChapterImages(chDirOnDisk)
        const allFiles = await listChapterImages(chDirOnDisk)
        const corruptCount = allFiles.length - validFiles.length
        if (validFiles.length > 0 && corruptCount === 0) {
          successImages += validFiles.length
          state.completedChapters.push(i)
          state.completedImages = successImages
          await this.saveState(comicDir, title, state)
          usedDirs.add(chDirOnDisk)
          continue
        }
        if (corruptCount > 0) {
          console.warn(`[DownloadManager] 检测到损坏章节: ${title} › ${ch.name} (${corruptCount}张损坏)，重新下载`)
        }
      }

      try {
        const pageList = await src.getPageList(ch.url, referer || sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        const chapterName = Array.isArray(pageList) ? '' : (pageList.chapterName || '')
        if (!images?.length) { failedChapters++; continue }
        const folderName = `${i + 1}-${sanitize(chapterName)}`
        const chDir = path.join(comicDir, folderName)
        if (!(await existsAsync(chDir))) await safeFs.mkdir(chDir, { recursive: true })
        if (!state._dirs) state._dirs = {}
        state._dirs[i] = chDir

        // 使用断点续传状态
        const chState = await loadChapterState(chDir) || { completedIndices: [], failedImages: [] }
        let chOk = 0
        let chFailed = 0

        for (let j = 0; j < images.length; j++) {
          // 跳过已完成的图片（断点续传）
          if (chState.completedIndices.includes(j)) {
            chOk++
            continue
          }

          const f = `${String(j + 1).padStart(3, '0')}.webp`
          const outPath = path.join(chDir, f)

          // 如果文件已存在且有效，跳过
          if (await existsAsync(outPath)) {
            const isValid = await validateImageFile(outPath)
            if (isValid) {
              chOk++
              if (!chState.completedIndices.includes(j)) {
                chState.completedIndices.push(j)
              }
              continue
            }
            // 文件损坏，删除后重新下载
            try { await safeFs.unlink(outPath) } catch (_) {}
          }

          try {
            const bytes = await downloadAndConvert(images[j], outPath, ch.url)
            chOk++
            bytesDownloaded += bytes
            speedBytes += bytes
            if (!chState.completedIndices.includes(j)) {
              chState.completedIndices.push(j)
            }
            // 从失败列表中移除
            chState.failedImages = (chState.failedImages || []).filter(fi => fi.index !== j + 1)
          } catch (e) {
            chFailed++
            if (!chState.failedImages) chState.failedImages = []
            const existingFail = chState.failedImages.find(fi => fi.index === j + 1)
            if (!existingFail) {
              chState.failedImages.push({ index: j + 1, url: images[j], error: e.message })
            }
          }

          // 每5张保存一次状态（防止崩溃后大量重复下载）
          if (j % 5 === 0 || j === images.length - 1) {
            await saveChapterState(chDir, chState)
          }
        }

        // 全部完成，清理状态文件
        if (chState.completedIndices.length >= images.length) {
          try {
            const statePath = getChapterStatePath(chDir)
            if (await existsAsync(statePath)) await safeFs.unlink(statePath)
          } catch (_) {}
        }

        successImages += chOk
        state.completedImages = successImages
        state.completedChapters.push(i)
        this.saveState(comicDir, title, state)

        const elapsed = (Date.now() - speedStartTime) / 1000
        if (elapsed > 0) speed = formatBytes(Math.round(speedBytes / elapsed)) + '/s'
        if (win) win.webContents.send('download:progress', {
          chapter: i + 1, totalChapters: chapters.length,
          chapterName: chapterName, images: images.length, successImages,
          chapterSuccess: chOk, chapterFailed: chFailed,
          speed, bytesDownloaded
        })
      } catch (e) {
        failedChapters++
        console.error(`[下载] 章节 ${ch.name} 失败:`, e.message)
      }
    }
    state.completed = true; state.endTime = Date.now()
    await this.saveState(comicDir, title, state)
    if (sourceUrl) {
      try { await db.updateComic(sourceUrl, { local_path: comicDir }) } catch (_) {}
    }
    return { success: true, path: comicDir, successImages, failedChapters }
  }
}

module.exports = DownloadManager

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}