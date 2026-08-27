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

  // --- Bug 11 跨任务去重: 复用 prepared statement，避免每次解析 SQL ---
  let _stmtFindDupComicJobs = null
  let _stmtFindDupChapterJobs = null

  // 查询同源（sourceUrl 或 comicTitle）已存在的 downloadComic 任务
  const _findDupComicJobs = (sourceUrl, comicTitle) => {
    if (!_stmtFindDupComicJobs) {
      _stmtFindDupComicJobs = jq.db.prepare(
        `SELECT id, payload FROM job_queue WHERE type='downloadComic'
         AND status IN ('waiting','running','active','paused')
         AND (json_extract(payload, '$.sourceUrl') = ? OR json_extract(payload, '$.comicTitle') = ?)`
      )
    }
    return _stmtFindDupComicJobs.all(sourceUrl, comicTitle)
  }

  // 查询同源已存在的 downloadChapter 任务，返回其覆盖的 chapter.url 集合
  const _findDupChapterJobUrls = (sourceUrl, comicTitle) => {
    if (!_stmtFindDupChapterJobs) {
      _stmtFindDupChapterJobs = jq.db.prepare(
        `SELECT id, payload FROM job_queue WHERE type='downloadChapter'
         AND status IN ('waiting','running','active','paused')
         AND (json_extract(payload, '$.sourceUrl') = ? OR json_extract(payload, '$.comicTitle') = ?)`
      )
    }
    const rows = _stmtFindDupChapterJobs.all(sourceUrl, comicTitle)
    const urls = new Set()
    for (const row of rows) {
      try {
        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
        const url = payload?.chapter?.url
        if (url) urls.add(url)
      } catch (_) {}
    }
    return urls
  }

  // --- Bug 10 + Bug 11: downloadComic 任务入队核心逻辑 ---
  // download:comic 与 download:queueAllChapters 共用，复用 jobQueue 的并发/取消/速率限制/进度通道；
  // 入队前排除已被单独 downloadChapter 任务覆盖的章节，避免重复下载与磁盘写入冲突。
  const _enqueueDownloadComicJob = async (opts, win) => {
    let { comicTitle, chapters, referer, sourceUrl, coverUrl } = opts

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
      return Promise.resolve({ jobIds: [dup.id], count: chapters.length, skipped: true })
    }

    // Bug 11 方案B: 从 downloadComic 的 chapters 数组中排除已有 downloadChapter 任务覆盖的章节
    const dupChapterUrls = _findDupChapterJobUrls(sourceUrl, comicTitle)
    let filteredChapters = chapters
    if (dupChapterUrls.size > 0) {
      filteredChapters = chapters.filter(c => !dupChapterUrls.has(c.url))
      if (filteredChapters.length < chapters.length) {
        console.log(`[queueAllChapters] 漫画《${comicTitle}》排除 ${chapters.length - filteredChapters.length} 个已被单独下载任务覆盖的章节`)
      }
      if (filteredChapters.length === 0) {
        console.log(`[queueAllChapters] 漫画《${comicTitle}》所有章节均已有单独下载任务，跳过整本下载`)
        return Promise.resolve({ jobIds: [], count: 0, skipped: true, reason: 'all_chapters_covered_by_single_tasks' })
      }
    }

    const comicDir = await resolveComicDirForPayload(comicTitle, sourceUrl)

    // 防重：如果同一漫画已有正在进行的整本下载请求，复用现有 Promise
    const pendingKey = `comic:${sourceUrl || comicTitle}`
    if (_pendingDownloads.has(pendingKey)) {
      console.log(`[queueAllChapters] 已有相同请求在进行中，复用现有 Promise: ${pendingKey}`)
      return _pendingDownloads.get(pendingKey)
    }

    const id = jq.add('downloadComic', {
      comicTitle, chapters: filteredChapters, referer, sourceUrl, coverUrl, comicDir
    }, { priority: 0, source: 'manual' })
    console.log(`[queueAllChapters] 创建任务: id=${id}, comicTitle=${comicTitle}, chapters=${filteredChapters.length}, comicDir=${comicDir}`)

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
          resolve({ jobIds: [id], count: filteredChapters.length, result: data.result })
        }
      })
      const unsub3 = jq.on('failed', (data) => {
        if (!resolved && data.jobId === id && win) {
          resolved = true
          win.webContents.send('download:jobDone', { error: data.error, jobId: id })
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobIds: [id], count: filteredChapters.length, error: data.error })
        }
      })

      // 安全兜底：5分钟后如果还没完成，清理监听器（整本下载可能较长）
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          unsub(); unsub2(); unsub3()
          cleanup()
          resolve({ jobIds: [id], count: filteredChapters.length })
        }
      }, 300000)
    })

    _pendingDownloads.set(pendingKey, promise)
    return promise
  }

  // --- Download ---
  // Bug 10: download:comic 已废弃（前端不再调用，仅保留向后兼容）
  // 内部转调 queueAllChapters 逻辑，复用 jobQueue 的并发/取消/速率限制/进度通道
  ipcMain.handle('download:comic', async (_, comicData) => {
    const win = BrowserWindow.getAllWindows()[0]
    // 适配老 API 入参: comicData {title, chapters, referer, cover, sourceUrl}
    // → queueAllChapters 入参 {comicTitle, chapters, referer, sourceUrl, coverUrl}
    const opts = {
      comicTitle: comicData?.title,
      chapters: comicData?.chapters,
      referer: comicData?.referer,
      sourceUrl: comicData?.sourceUrl,
      coverUrl: comicData?.cover
    }
    return _enqueueDownloadComicJob(opts, win)
  })
  ipcMain.handle('download:listLocal', async () => db.getDownloadRecords())
  ipcMain.handle('download:deleteLocal', async (_, id) => db.deleteDownloadRecord(id))
  ipcMain.handle('download:getHighestDownloadedIndex', async (_, { comicTitle, sourceUrl, totalChapters }) => {
    let diskChapterCount = 0
    const comicDir = await findComicDir(comicTitle, sourceUrl)
    if (comicDir) {
      try {
        const dirEntries = (await fs.promises.readdir(comicDir, { withFileTypes: true }))
          .filter(e => e.isDirectory())
        diskChapterCount = dirEntries.length
      } catch (_) {}
    }
    return {
      diskChapterCount,
      diskDir: comicDir || null
    }
  })

  ipcMain.handle('download:getLocalChapterIndices', async (_, { comicId, comicTitle, sourceUrl }) => {
    // Bug #40 修复: 原来只扫描本地目录名 "N-xxx" 判断已下载章节, 存在 3 个坑:
    //  1) 同名多本漫画 findComicDir 标题 fallback 会串到另一本目录
    //  2) 目录名排序号和 DB chapters.sort_order 不是同一权威源
    //  3) download_records 表 status=success 其实已经是最准确的判断依据
    // 改为: 优先通过 comicId/sourceUrl 查 comics→chapters→download_records 三级联查,
    // 同时兜底再校验一下本地目录是否真的有图(防 DB 有记录但磁盘被手动删文件)。
    try {
      const raw = db.getRawDB()
      const fs = require('fs')
      const path = require('path')
      const { getValidChapterImages } = require('../utils/chapterImages')

      let comicRow = null
      if (raw) {
        if (comicId) {
          comicRow = raw.prepare('SELECT id, local_path, sourceUrl, title FROM comics WHERE id = ?').get(comicId)
        }
        if (!comicRow && sourceUrl) {
          comicRow = raw.prepare('SELECT id, local_path, sourceUrl, title FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        }
        if (!comicRow && comicTitle) {
          // 同名多本不做标题兜底挑一本, 避免误判
          const rows = raw.prepare(
            'SELECT id, local_path, sourceUrl, title FROM comics WHERE title = ? LIMIT 2'
          ).all(comicTitle)
          if (rows.length === 1) comicRow = rows[0]
        }
      }

      if (comicRow) {
        const indices = new Set()
        // 方案 A: download_records.status = 'success' 且本地目录确实有图
        if (raw) {
          const recs = raw.prepare(
            `SELECT chapter_index, path, images_count, status, completed
             FROM download_records WHERE comic_id = ?`
          ).all(comicRow.id)
          for (const r of recs) {
            if (r.status !== 'success') continue
            let healthy = false
            if (r.path && (await downloadPaths.existsAsync(r.path))) {
              const imgs = (await getValidChapterImages?.(r.path)) || []
              if (imgs.length >= 2 || (r.images_count && imgs.length >= Math.min(2, r.images_count))) {
                healthy = true
              } else if (imgs.length > 0) {
                // 有图就算数 (少于 min 也可能是短篇或已裁剪)
                healthy = true
              }
            }
            if (healthy) {
              indices.add(Number(r.chapter_index))
              continue
            }
            // 目录缺失 → 再通过 DB 章节 sort_order 映射
            if (r.chapter_index != null) indices.add(Number(r.chapter_index))
          }
        }
        if (indices.size > 0) return [...indices]
      }

      // 兜底: 本地目录扫描 (兼容历史上 DB 缺失但磁盘有文件的情况)
      const comicDir = await findComicDir(comicTitle, sourceUrl)
      if (!comicDir) return []
      try {
        const entries = (await fs.promises.readdir(comicDir, { withFileTypes: true }))
          .filter(e => e.isDirectory())
        const indices = []
        for (const e of entries) {
          const m = e.name.match(/^(\d+)-/)
          if (m) indices.push(parseInt(m[1], 10) - 1)
        }
        return indices
      } catch (_) { return [] }
    } catch (e) {
      console.warn('[getLocalChapterIndices] 失败:', e.message)
      return []
    }
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
      if (record && record.path && (await downloadPaths.existsAsync(record.path))) {
        const validFiles = await getValidChapterImages(record.path)
        if (validFiles.length > 0) return validFiles.map(f => getLocalProxyUrl(f))
      }
    }

    if (comicTitle) {
      const cDir = await findComicDir(comicTitle, comicId)
      if (cDir) {
        const chDir = await findChapterDir(cDir, chapterIndex, '')
        if (chDir) {
          const validFiles = await getValidChapterImages(chDir)
          if (validFiles.length > 0) return validFiles.map(f => getLocalProxyUrl(f))
        }
      }
    }
    return null
  })

  // --- 辅助函数 ---
  async function resolveComicDirForPayload(comicTitle, sourceUrl) {
    return await resolveComicDir(comicTitle, sourceUrl, null)
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

    // Bug 11: 检查是否已有同源 downloadComic 任务覆盖该章节，避免重复下载
    const coveredJobs = _findDupComicJobs(sourceUrl, comicTitle)
    for (const row of coveredJobs) {
      let payload
      try {
        payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
      } catch (_) { continue }
      const chaptersInJob = Array.isArray(payload?.chapters) ? payload.chapters : []
      if (chaptersInJob.some(c => c?.url === chapter.url)) {
        console.log(`[queueChapter] 章节 ${chapter.url} 已被整本下载任务(${row.id.substring(0,8)})覆盖，跳过创建`)
        return { jobId: row.id, skipped: true, reason: 'covered_by_downloadComic' }
      }
    }

    const comicDir = await resolveComicDirForPayload(comicTitle, sourceUrl)

    // 防重：如果同一章节已有正在进行的请求，复用现有 Promise
    const pendingKey = `chapter:${sourceUrl}:${chapter.index}`
    if (_pendingDownloads.has(pendingKey)) {
      console.log(`[queueChapter] 已有相同请求在进行中，复用现有 Promise: ${pendingKey}`)
      return _pendingDownloads.get(pendingKey)
    }

    const id = jq.add('downloadChapter', { comicTitle, chapter, referer, sourceUrl, coverUrl, comicDir }, { priority: 0, source: 'manual' })

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
    // Bug 10: 复用 _enqueueDownloadComicJob（与 download:comic 共用同一入队逻辑）
    // Bug 11: 在 _enqueueDownloadComicJob 内部排除已被 downloadChapter 任务覆盖的章节
    const win = BrowserWindow.fromWebContents(event.sender)
    return _enqueueDownloadComicJob(opts, win)
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
      const comicDir = await findComicDir(comicTitle, sourceUrl)
      if (!comicDir) {
        return { success: false, error: '未找到本地漫画目录' }
      }
      const health = await checkComicHealth(comicDir)
      return { success: true, ...health }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // [增强 2026-08-20] 全局健康检查:扫描所有已下载漫画,汇总坏章节/空图/缺图,
  // 产出结构化报告(供前端 HealthReport 面板展示),并落盘到日志目录便于回溯。
  ipcMain.handle('download:checkAllHealth', async (_, { limit = 50 } = {}) => {
    try {
      const result = await db.getComics({ page: 1, pageSize: limit || 500, localOnly: true })
      const comics = result.docs || result.data || result
      const issues = []
      let scanned = 0
      let healthyCount = 0
      let emptyCount = 0
      let corruptCount = 0
      let missingCoverCount = 0
      let badChapterCount = 0

      for (const comic of comics) {
        if (!comic.local_path || !(await downloadPaths.existsAsync(comic.local_path))) continue
        scanned++
        const health = await checkComicHealth(comic.local_path)
        if (health.healthy) { healthyCount++; continue }
        if (health.missingCover) missingCoverCount++
        const badChapters = (health.chapters || []).filter(c => !c.healthy)
        badChapterCount += badChapters.length
        for (const ch of badChapters) {
          emptyCount += ch.emptyCount || 0
          corruptCount += ch.corruptCount || 0
        }
        issues.push({
          dirName: path.basename(comic.local_path),
          comicDir: comic.local_path,
          sourceUrl: comic.sourceUrl,
          comicTitle: comic.title,
          totalChapters: health.totalChapters,
          totalIssues: health.totalIssues,
          missingCover: health.missingCover,
          badChapters: badChapters.map(c => ({
            dirName: c.dirName,
            chapterIndex: c.chapterIndex,
            emptyCount: c.emptyCount || 0,
            corruptCount: c.corruptCount || 0,
            gapCount: c.gapCount || 0,
            missingCount: c.missingCount || 0
          }))
        })
      }

      const summary = {
        scanned,
        healthyCount,
        problemCount: issues.length,
        missingCoverCount,
        badChapterCount,
        emptyCount,
        corruptCount
      }

      // 落盘报告(便于回溯 + 微信通知时附摘要)
      let reportPath = null
      try {
        const logDir = path.join(app.getPath('userData'), 'logs')
        await fs.promises.mkdir(logDir, { recursive: true })
        reportPath = path.join(logDir, `health-report-${Date.now()}.json`)
        await fs.promises.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, issues }, null, 2))
      } catch (_) {}

      return {
        success: true,
        summary,
        totalScanned: issues.length,
        issues,
        reportPath
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // [增强 2026-08-20] 轻量健康概览:只返回汇总数字,不逐本扫描(供状态栏/通知用)
  ipcMain.handle('download:healthSummary', async () => {
    try {
      const result = await db.getComics({ page: 1, pageSize: 500, localOnly: true })
      const comics = result.docs || result.data || result
      let total = 0, withLocal = 0
      for (const c of comics) { total++; if (c.local_path && (await downloadPaths.existsAsync(c.local_path))) withLocal++ }
      return { success: true, totalComics: total, localComics: withLocal }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- 修复 ---
  ipcMain.handle('download:repairChapter', async (_, { comicTitle, chapterIndex, chapterUrl, sourceUrl }) => {
    try {
      const comicDir = await findComicDir(comicTitle, sourceUrl)
      if (!comicDir) {
        return { success: false, error: '未找到本地漫画目录' }
      }

      const chDir = await findChapterDir(comicDir, chapterIndex, '')
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
      }, { priority: 1, source: 'manual' })

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
        if (!comic.local_path || !(await downloadPaths.existsAsync(comic.local_path))) continue

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
        }, { priority: 2, source: 'manual' })
        enqueued++
      }

      return { success: true, enqueued, skipped }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })
}

module.exports = { register }