'use strict'

const path = require('path')
const fs = require('fs')
const { sanitizeFilename: sanitize } = require('../../utils')

function register(deps) {
  const {
    app, BrowserWindow, ipcMain,
    db, downloadMgr, downloadPaths,
    getExternalRoot, setExternalRoot,
    getGlobalDownloadConcurrency, setGlobalDownloadConcurrency
  } = deps

  const jq = deps.jq

  // 防重入：跟踪正在进行的下载 IPC 请求，防止重复注册监听器
  const _pendingDownloads = new Map()

  // 全局下载进度转发: 不仅用户手动下载, sync 自动追更的 downloadChapter/downloadComic
  // 任务进度(含网速 speed)也广播给前端 footer, 避免状态栏网速永远显示 0。
  // 延迟注册: register() 同步执行时 jobQueue 可能尚未就绪, 用 getJobQueue() 惰性获取。
  let _globalProgressForwarderRegistered = false
  const registerGlobalProgressForward = () => {
    if (_globalProgressForwarderRegistered) return
    const q = (deps.getJobQueue && deps.getJobQueue()) || deps.jq
    if (!q || typeof q.on !== 'function') {
      setTimeout(registerGlobalProgressForward, 1000)
      return
    }
    _globalProgressForwarderRegistered = true
    q.on('progress', (data) => {
      if (!data || (data.type !== 'downloadChapter' && data.type !== 'downloadComic')) return
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('download:jobProgress', data)
      }
    })
  }
  registerGlobalProgressForward()

  const {
    findComicDir, findChapterDir, getValidChapterImages, checkComicHealth,
    downloadChapterImages, resolveComicDir, getPrimaryDownloadRoot,
    getDownloadRoots
  } = downloadPaths
  const { getLocalProxyUrl } = deps.imageProxy

  // --- Download ---
  ipcMain.handle('download:comic', async (_, comicData) => {
    const win = BrowserWindow.getAllWindows()[0]
    return downloadMgr.downloadComic(comicData, win)
  })
  ipcMain.handle('download:listLocal', async () => db.getDownloadRecords())
  ipcMain.handle('download:deleteLocal', async (_, id) => db.deleteDownloadRecord(id))
  ipcMain.handle('download:getHighestDownloadedIndex', async (_, { comicTitle, sourceUrl, totalChapters }) => {
    let diskChapterCount = 0
    const comicDir = findComicDir(comicTitle, sourceUrl)
    if (comicDir) {
      try {
        const dirEntries = fs.readdirSync(comicDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
        diskChapterCount = dirEntries.length
      } catch (_) {}
    }
    return {
      diskChapterCount,
      diskDir: comicDir || null
    }
  })

  ipcMain.handle('download:getLocalChapterIndices', async (_, { comicTitle, sourceUrl }) => {
    const comicDir = findComicDir(comicTitle, sourceUrl)
    if (!comicDir) return []
    try {
      const entries = fs.readdirSync(comicDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
      const indices = []
      for (const e of entries) {
        const m = e.name.match(/^(\d+)-/)
        if (m) indices.push(parseInt(m[1], 10) - 1)
      }
      return indices
    } catch (_) { return [] }
  })

  ipcMain.handle('download:getLocalChapterImages', async (_, comicId, chapterIndex, comicTitle) => {
    let records = []
    if (comicId) {
      records = await db.getDownloadRecords({ comicId })
    }
    if (records.length === 0 && comicTitle) {
      records = await db.getDownloadRecords({ comicTitle })
    }

    if (records.length > 0) {
      const record = records.find(r => r.chapterIndex === chapterIndex)
      if (record && record.path && fs.existsSync(record.path)) {
        const validFiles = await getValidChapterImages(record.path)
        if (validFiles.length > 0) return validFiles.map(f => getLocalProxyUrl(f))
      }
    }

    if (comicTitle) {
      const cDir = findComicDir(comicTitle, comicId)
      if (cDir) {
        const chDir = findChapterDir(cDir, chapterIndex, '')
        if (chDir) {
          const validFiles = await getValidChapterImages(chDir)
          if (validFiles.length > 0) return validFiles.map(f => getLocalProxyUrl(f))
        }
      }
    }
    return null
  })

  // --- 辅助函数 ---
  function resolveComicDirForPayload(comicTitle, sourceUrl) {
    return resolveComicDir(comicTitle, sourceUrl, null)
  }

  ipcMain.handle('download:queueChapter', async (event, opts) => {
    let { comicTitle, chapter, referer, sourceUrl, coverUrl } = opts
    const win = BrowserWindow.fromWebContents(event.sender)

    if (!comicTitle || !comicTitle.trim() || comicTitle.trim() === '未命名漫画') {
      throw new Error(`漫画名无效 (${comicTitle || '空'})，请先补全漫画详情后再下载`)
    }
    if (!chapter || !chapter.url) {
      throw new Error('章节信息不完整，无法创建下载任务')
    }

    const comicDir = resolveComicDirForPayload(comicTitle, sourceUrl)

    // 防重：如果同一章节已有正在进行的请求，复用现有 Promise
    const pendingKey = `chapter:${sourceUrl}:${chapter.index}`
    if (_pendingDownloads.has(pendingKey)) {
      console.log(`[queueChapter] 已有相同请求在进行中，复用现有 Promise: ${pendingKey}`)
      return _pendingDownloads.get(pendingKey)
    }

    const id = jq.add('downloadChapter', { comicTitle, chapter, referer, sourceUrl, coverUrl, comicDir }, { priority: 0 })

    const promise = new Promise((resolve) => {
      let resolved = false
      function cleanup() {
        _pendingDownloads.delete(pendingKey)
      }

      const unsub = jq.on('progress', (data) => {
        if (!resolved && data.jobId === id && win) {
          win.webContents.send('download:jobProgress', data)
        }
      })
      const unsub2 = jq.on('completed', (data) => {
        if (!resolved && data.jobId === id && win) {
          resolved = true
          win.webContents.send('download:jobDone', data.result)
          unsub(); unsub2()
          cleanup()
          resolve({ jobId: id, result: data.result })
        }
      })
      const unsub3 = jq.on('failed', (data) => {
        if (!resolved && data.jobId === id && win) {
          resolved = true
          win.webContents.send('download:jobDone', { error: data.error, jobId: id })
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobId: id, error: data.error })
        }
      })

      // 安全兜底：30秒后如果还没完成，清理监听器
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobId: id })
        }
      }, 30000)
    })

    _pendingDownloads.set(pendingKey, promise)
    return promise
  })
  ipcMain.handle('download:queueAllChapters', async (event, opts) => {
    let { comicTitle, chapters, referer, sourceUrl, coverUrl } = opts
    const win = BrowserWindow.fromWebContents(event.sender)

    if (!comicTitle || !comicTitle.trim() || comicTitle.trim() === '未命名漫画') {
      throw new Error(`漫画名无效 (${comicTitle || '空'})，请先补全漫画详情后再下载`)
    }
    if (!chapters || chapters.length === 0) {
      throw new Error('章节列表为空，无法创建下载任务')
    }

    const dup = jq.db.prepare(
      `SELECT id FROM job_queue WHERE type='downloadComic'
       AND status IN ('waiting','running','active','paused')
       AND (json_extract(payload, '$.sourceUrl') = ? OR json_extract(payload, '$.comicTitle') = ?)
       LIMIT 1`
    ).get(sourceUrl, comicTitle)
    if (dup) {
      console.log(`[queueAllChapters] 漫画《${comicTitle}》已有下载任务(${dup.id.substring(0,8)})，跳过重复添加`)
      return { jobIds: [dup.id], count: chapters.length, skipped: true }
    }

    const comicDir = resolveComicDirForPayload(comicTitle, sourceUrl)

    // 防重：如果同一漫画已有正在进行的整本下载请求，复用现有 Promise
    const pendingKey = `comic:${sourceUrl || comicTitle}`
    if (_pendingDownloads.has(pendingKey)) {
      console.log(`[queueAllChapters] 已有相同请求在进行中，复用现有 Promise: ${pendingKey}`)
      return _pendingDownloads.get(pendingKey)
    }

    const id = jq.add('downloadComic', {
      comicTitle, chapters, referer, sourceUrl, coverUrl, comicDir
    }, { priority: 0 })
    console.log(`[queueAllChapters] 创建任务: id=${id}, comicTitle=${comicTitle}, chapters=${chapters.length}, comicDir=${comicDir}`)

    const promise = new Promise((resolve) => {
      let resolved = false
      function cleanup() {
        _pendingDownloads.delete(pendingKey)
      }

      const unsub = jq.on('progress', (data) => {
        if (!resolved && data.jobId === id && win) {
          win.webContents.send('download:jobProgress', data)
        }
      })
      const unsub2 = jq.on('completed', (data) => {
        if (!resolved && data.jobId === id && win) {
          resolved = true
          win.webContents.send('download:jobDone', data.result)
          unsub(); unsub2()
          cleanup()
          resolve({ jobIds: [id], count: chapters.length, result: data.result })
        }
      })
      const unsub3 = jq.on('failed', (data) => {
        if (!resolved && data.jobId === id && win) {
          resolved = true
          win.webContents.send('download:jobDone', { error: data.error, jobId: id })
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobIds: [id], count: chapters.length, error: data.error })
        }
      })

      // 安全兜底：5分钟后如果还没完成，清理监听器（整本下载可能较长）
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobIds: [id], count: chapters.length })
        }
      }, 300000)
    })

    _pendingDownloads.set(pendingKey, promise)
    return promise
  })

  // --- 下载暂停/恢复 ---
  ipcMain.handle('download:pauseJob', async (_, jobId) => {
    jq.pauseJob(jobId)
    return { success: true }
  })
  ipcMain.handle('download:resumeJob', async (_, jobId) => {
    jq.resumeJob(jobId)
    return { success: true }
  })
  ipcMain.handle('download:getJobStatus', async (_, jobId) => {
    return jq.getJob(jobId)
  })
  ipcMain.handle('download:listQueue', async (_, status = 'all') => {
    return jq.listJobs(status)
  })

  // --- 健康检查 ---
  ipcMain.handle('download:checkHealth', async (_, { comicTitle, sourceUrl }) => {
    try {
      const comicDir = findComicDir(comicTitle, sourceUrl)
      if (!comicDir) {
        return { success: false, error: '未找到本地漫画目录' }
      }
      const health = await checkComicHealth(comicDir)
      return { success: true, ...health }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('download:checkAllHealth', async (_, { limit = 50 } = {}) => {
    try {
      const result = await db.getComics({ page: 1, pageSize: limit || 500, localOnly: true })
      const comics = result.docs || result.data || result
      const issues = []

      for (const comic of comics) {
        if (!comic.local_path || !fs.existsSync(comic.local_path)) continue
        const health = await checkComicHealth(comic.local_path)
        if (!health.healthy) {
          issues.push({
            dirName: path.basename(comic.local_path),
            comicDir: comic.local_path,
            sourceUrl: comic.sourceUrl,
            comicTitle: comic.title,
            ...health
          })
        }
      }

      return {
        success: true,
        totalScanned: issues.length,
        issues
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- 修复 ---
  ipcMain.handle('download:repairChapter', async (_, { comicTitle, chapterIndex, chapterUrl, sourceUrl }) => {
    try {
      const comicDir = findComicDir(comicTitle, sourceUrl)
      if (!comicDir) {
        return { success: false, error: '未找到本地漫画目录' }
      }

      const chDir = findChapterDir(comicDir, chapterIndex, '')
      if (!chDir) {
        return { success: false, error: '未找到章节目录' }
      }

      const src = deps.sources.default
      const pageList = await src.getPageList(chapterUrl, sourceUrl)
      const images = Array.isArray(pageList) ? pageList : pageList.images

      if (!images?.length) {
        return { success: false, error: '无法获取在线图片列表' }
      }

      const mockJob = { cancelled: () => false }

      const result = await downloadChapterImages(
        mockJob,
        images,
        chDir,
        0,
        comicTitle,
        path.basename(chDir),
        { index: chapterIndex, url: chapterUrl },
        sourceUrl,
        (prog) => {
          console.log(`[修复] ${comicTitle} 进度:`, prog)
        }
      )

      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('download:repairComic', async (_, { sourceUrl, deepCheck = false }) => {
    try {
      if (!sourceUrl) return { success: false, error: '缺少 sourceUrl' }
      const q = deps.getJobQueue()
      if (!q) return { success: false, error: '任务队列未初始化' }

      const activeJobs = q.listJobs('active', 200).filter(j =>
        j.type === 'repairComic' && j.payload?.sourceUrl === sourceUrl
      )
      if (activeJobs.length > 0) {
        return { success: false, error: '该漫画已有修复任务在进行中', jobId: activeJobs[0].id }
      }

      const comic = await db.getComicByUrl(sourceUrl)
      if (!comic) return { success: false, error: '未找到漫画' }

      const jobId = q.add('repairComic', {
        sourceUrl,
        comicTitle: comic.title,
        comicDir: comic.local_path,
        deepCheck
      }, { priority: 1 })

      return { success: true, jobId }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- 修复全部 ---
  ipcMain.handle('download:repairAll', async (_, { deepCheck = false } = {}) => {
    try {
      const q = deps.getJobQueue()
      if (!q) return { success: false, error: '任务队列未初始化' }

      const result = await db.getComics({ page: 1, pageSize: 500, localOnly: true })
      const rows = result.docs || result.data || result
      let enqueued = 0
      let skipped = 0

      for (const comic of rows) {
        if (!comic.local_path || !fs.existsSync(comic.local_path)) continue

        const health = await checkComicHealth(comic.local_path)
        if (health.healthy) { skipped++; continue }

        const activeJobs = q.listJobs('active', 200).filter(j =>
          j.type === 'repairComic' && j.payload?.sourceUrl === comic.sourceUrl
        )
        if (activeJobs.length > 0) { skipped++; continue }

        q.add('repairComic', {
          sourceUrl: comic.sourceUrl,
          comicTitle: comic.title,
          comicDir: comic.local_path,
          deepCheck
        }, { priority: 3 })
        enqueued++
      }

      return { success: true, enqueued, skipped }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })
}

module.exports = { register }