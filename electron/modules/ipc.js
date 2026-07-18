'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { sanitizeFilename: sanitize, normalizeName, getDiskInfo } = require('../utils')

const downloadIpc = require('./ipc/download')
const crawlIpc = require('./ipc/crawl')
const exportIpc = require('./ipc/export')
const importIpc = require('./ipc/import')
const { checkForUpdates, downloadUpdate, quitAndInstall } = require('./updater')

function registerAllIPC(deps) {
  const {
    app, BrowserWindow, ipcMain, dialog, shell,
    db, sources, exporter, cache,
    getJobQueue,
    downloadMgr,
    downloadPaths,
    imageProxy,
    jobHandlers,
    isDev,
    getExternalRoot, setExternalRoot,
    getGlobalDownloadConcurrency, setGlobalDownloadConcurrency,
    createWindow
  } = deps

  const jobQueue = { get current() { return getJobQueue() } }
  const jq = new Proxy(jobQueue, {
    get(target, prop) {
      const q = target.current
      return q ? q[prop] : undefined
    }
  })

  const { findComicDir, getValidChapterImages, getPrimaryDownloadRoot, getDownloadRoots } = downloadPaths
  const { getProxyImageUrl, getLocalProxyUrl, fetchAndCacheImage } = imageProxy

  // 注入 jq 到 deps 中供子模块使用
  const extendedDeps = { ...deps, jq }

  // 注册子模块
  const { ensureGlobalCrawlForwarder } = crawlIpc.register(extendedDeps)
  downloadIpc.register(extendedDeps)
  exportIpc.register(extendedDeps)
  const { _matchComicInDB } = importIpc.register(extendedDeps)

  // ============ IPC Handlers ============

  // --- Sources ---
  ipcMain.handle('source:search', async (_, query, sourceId) => {
    if (sourceId && sourceId !== 'all') return sources.get(sourceId).search(query, 1)
    return sources.multiSearch(query)
  })
  ipcMain.handle('source:getDetail', async (_, url) => {
    const src = url?.includes('smtt6') ? sources.get('smtt6') : sources.default
    return src.getDetail(url)
  })
  ipcMain.handle('source:getChapters', async (_, url) => {
    const src = url?.includes('smtt6') ? sources.get('smtt6') : sources.default
    return (await src.getDetail(url)).chapters
  })
  ipcMain.handle('source:getPageList', async (_, chapterUrl, referer) => {
    const src = chapterUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
    const pageList = await src.getPageList(chapterUrl, referer)
    const urls = Array.isArray(pageList) ? pageList : pageList.images
    if (urls?.length) {
      setImmediate(async () => {
        for (const url of urls) {
          if (cache.hasCache(url)) continue
          try {
            const buf = await src.fetchImage(url, chapterUrl)
            await cache.setCache(url, buf)
          } catch {}
        }
      })
    }
    return urls
  })
  ipcMain.handle('source:list', async () => sources.getAll().map(s => ({ id: s.id, name: s.name, lang: s.lang })))

  ipcMain.handle('source:getCachedPageList', async (_, chapterUrl, referer) => {
    const src = chapterUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
    const pageList = await src.getPageList(chapterUrl, referer)
    const imageUrls = Array.isArray(pageList) ? pageList : pageList.images
    if (!imageUrls?.length) return imageUrls

    const ref = referer || chapterUrl
    const proxyUrls = imageUrls.map(u => getProxyImageUrl(u, ref))

    setImmediate(() => {
      let i = 0
      const workers = []
      const concurrency = 5
      for (let w = 0; w < concurrency; w++) {
        workers.push((async () => {
          while (i < imageUrls.length) {
            const currentIdx = i++
            try {
              if (cache.hasCache(imageUrls[currentIdx])) continue
              await fetchAndCacheImage(imageUrls[currentIdx], ref)
            } catch {}
          }
        })())
      }
      Promise.all(workers).then(() => {
        console.log(`[Cache] 章节预缓存完成: ${imageUrls.length} 张`)
      }).catch(() => {})
    })

    return proxyUrls
  })

  // --- 全局搜索 ---
  ipcMain.handle('search:global', async (_, query, filters = {}) => {
    if (!query?.trim() && Object.keys(filters).length === 0) return { local: [], remote: [] }
    const q = query?.trim().toLowerCase() || ''

    let local = []
    try {
      if (Object.keys(filters).length > 0) {
        local = await db.advancedSearch(q, filters)
      } else {
        local = await db.searchComics(q)
      }
    } catch (e) {
      console.warn('[search:global] 本地搜索失败:', e.message)
    }

    let remote = []
    if (q) {
      try { remote = await sources.multiSearch(q) } catch {}
    }
    return { local: local || [], remote }
  })

  ipcMain.handle('cache:stats', () => cache.getStats())
  ipcMain.handle('cache:clear', () => { cache.clearCache(); return true })

  ipcMain.handle('disk:getSpace', async (_, dirPath) => {
    try {
      const info = await getDiskInfo(dirPath || app.getPath('downloads'))
      return { success: true, ...info }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- Job Queue ---
  ipcMain.handle('job:add', async (_, type, payload, opts) => jq.add(type, payload, opts))
  ipcMain.handle('job:cancel', async (_, id) => jq.cancel(id))
  ipcMain.handle('job:retry', async (_, id) => jq.retry(id))
  ipcMain.handle('job:retryAll', async () => jq.retryAll())
  ipcMain.handle('job:clear', async () => jq.clear())
  ipcMain.handle('job:list', async (_, status, limit) => jq.listJobs(status, limit))
  ipcMain.handle('job:stats', async () => jq.getStats())

  ipcMain.handle('job:failureStats', async () => {
    try {
      return jq.getFailureStats()
    } catch (e) {
      console.error('[job:failureStats] 错误:', e.message)
      return []
    }
  })
  ipcMain.handle('job:get', async (_, id) => jq.getJob(id))

  // --- DB ---
  ipcMain.handle('db:getComics', async (_, page, pageSize, filters) => {
    try {
      const result = await db.getComics(page, pageSize, filters)
      return result
    } catch (e) {
      console.error(`[DB] getComics 失败: page=${page}, pageSize=${pageSize}, filters=${JSON.stringify(filters)}, error=${e.message}`)
      throw e
    }
  })
  ipcMain.handle('db:getComicById', async (_, id) => db.getComicById(id))
  ipcMain.handle('db:getComicByUrl', async (_, url) => db.getComicByUrl(url))
  ipcMain.handle('db:getFavoritedComics', async () => db.getFavoritedComics())
  ipcMain.handle('db:clearComics', async () => db.clearAllComics())
  ipcMain.handle('db:getComicsCount', async () => db.getComicsCount())
  ipcMain.handle('db:getDbPath', async () => db.getDbPath())
  ipcMain.handle('db:getChaptersCount', async () => db.getChaptersCount())
  ipcMain.handle('db:getImagesCount', async () => db.getImagesCount())
  ipcMain.handle('db:getDownloadSize', async () => db.getDownloadSize())
  ipcMain.handle('db:getBooksReadCount', async () => db.getBooksReadCount())
  ipcMain.handle('db:getChaptersReadCount', async () => db.getChaptersReadCount())
  ipcMain.handle('db:getReadingStreak', async () => db.getReadingStreak())
  ipcMain.handle('db:getTotalReadTime', async () => db.getTotalReadTime())
  ipcMain.handle('db:updateComic', async (_, comicId, changes) => db.updateComic(comicId, changes))
  ipcMain.handle('db:cleanupPureLocalComics', async () => db.cleanupPureLocalComics())
  ipcMain.handle('db:getCategoryStats', async () => db.getCategoryStats())
  ipcMain.handle('db:getAllCategories', async () => db.getAllCategories())
  ipcMain.handle('db:searchComics', async (_, q) => db.searchComics(q))

  ipcMain.handle('debug:getJobDetails', async () => {
    const rows = jq.db.prepare(
      `SELECT id, type, status, payload FROM job_queue WHERE status IN ('waiting','running','active') ORDER BY created_at DESC`
    ).all()
    return rows.map(row => {
      let parsed = null
      try { if (row.payload) parsed = JSON.parse(row.payload) } catch (e) {}
      return {
        id: row.id.substring(0, 8),
        type: row.type,
        status: row.status,
        payload: parsed
      }
    })
  })

  ipcMain.handle('db:setFavorite', async (_, comicId, favorited) => db.setFavorite(comicId, favorited))
  ipcMain.handle('db:clearUpdateDelta', async (_, comicId) => db.clearUpdateDelta(comicId))
  ipcMain.handle('db:autoScanLocalComics', async (e, paths) => {
    const onProgress = (p) => { try { e.sender.send('scan:progress', p) } catch (_) {} }
    return db.autoScanLocalComics(paths, sources, onProgress)
  })

  ipcMain.handle('db:importLocalComics', async (e, dirPath, progressCallback) => {
    const onProgress = progressCallback ? (progress) => {
      e.sender.send('import:progress', progress)
    } : null
    return db.importLocalComics(dirPath, onProgress)
  })

  // --- Batch operations ---
  ipcMain.handle('batch:delete', async (_, ids) => {
    for (const id of ids) await db.deleteComic(id)
    return { deleted: ids.length }
  })
  ipcMain.handle('batch:exportEPUB', async (_, ids) => {
    const results = []
    for (const id of ids) {
      const comic = await db.getComicById(id)
      if (comic) results.push({ id, title: comic.title, status: 'queued' })
    }
    return results
  })

  // --- Data management ---
  ipcMain.handle('data:getStats', async () => {
    const count = await db.getComicsCount()
    const catStats = await db.getCategoryStats()
    const records = await db.getDownloadRecords()
    const totalImages = records.reduce((s, r) => s + (r.imagesCount || 0), 0)
    const totalChapters = records.length
    return { totalComics: count, totalCategories: Object.keys(catStats.stats).length, totalChapters, totalImages }
  })

  // --- Settings ---
  ipcMain.handle('settings:get', async () => {
    const defaults = {
      downloadDir: getExternalRoot(),
      concurrency: 5,
      downloadConcurrency: 3,
      cacheSizeGb: 2,
      batterySaver: false,
      proxyType: 'none',
      proxyHost: '',
      proxyPort: '',
      autoUpdateEnabled: true,
      autoUpdateIntervalHours: 2
    }
    try {
      const stored = getCachedSettings()
      // 首次获取时确保缓存已填充
      if (Object.keys(stored).length === 0) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
          cachedSettings = raw
          if (raw.downloadDir && fs.existsSync(raw.downloadDir)) {
            setExternalRoot(raw.downloadDir)
          }
          return { ...defaults, ...raw }
        } catch { return defaults }
      }
      if (stored.downloadDir && fs.existsSync(stored.downloadDir)) {
        setExternalRoot(stored.downloadDir)
      }
      return { ...defaults, ...stored }
    } catch { return defaults }
  })
  ipcMain.handle('settings:save', async (_, settings) => {
    fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2))
    // 更新缓存
    cachedSettings = settings
    if (getJobQueue() && settings.concurrency) {
      jq.concurrency = settings.concurrency
    }
    if (settings.downloadConcurrency) {
      setGlobalDownloadConcurrency(settings.downloadConcurrency)
      if (getJobQueue()?.updateTypeConcurrency) {
        jq.updateTypeConcurrency({
          downloadChapter: settings.downloadConcurrency
        })
      }
    }
    if (settings.downloadDir) {
      setExternalRoot(settings.downloadDir)
    }
    if (typeof settings.autoUpdateEnabled === 'boolean' || settings.autoUpdateIntervalHours) {
      jobHandlers.restartAutoTasks()
    }
    return true
  })

  // 缓存 settings 避免每次广播时都读取文件
  let cachedSettings = null
  function getCachedSettings() {
    if (!cachedSettings) {
      try {
        cachedSettings = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
      } catch { cachedSettings = {} }
    }
    return cachedSettings
  }
  function invalidateSettingsCache() { cachedSettings = null }

  // --- 后台任务状态广播 ---
  let backgroundTaskState = { tasks: [], lastUpdated: 0 }

  function getBackgroundTasks() {
    const tasks = []
    const stats = getJobQueue() ? jq.getStats() : {}
    // 注意: jq.listJobs('active') 内部查的是 status IN(waiting,running,active,paused),
    // 会把 waiting 也算进来。footer 的“运行中”必须只统计真正 running/active 的,
    // 否则与 waiting 重叠导致显示 “运行中 199 / 等待 199” 这种假相等。
    // 改用按类型聚合的真实计数(不受 limit 截断)。
    const q = getJobQueue()
    const countByTypeStatus = (statuses) => {
      if (!q || !q.db) return {}
      try {
        const placeholders = statuses.map(() => '?').join(',')
        const rows = q.db.prepare(
          `SELECT type, count(*) AS n FROM job_queue WHERE status IN (${placeholders}) GROUP BY type`
        ).all(...statuses)
        const m = {}
        for (const r of rows) m[r.type] = r.n
        return m
      } catch (_) { return {} }
    }
    const activeByType = countByTypeStatus(['running', 'active'])
    const waitingByType = countByTypeStatus(['waiting'])

    const typeLabels = {
      sync: { label: '同步追更', icon: 'sync' },
      crawlAll: { label: '全站爬取', icon: 'crawl' },
      autoEnrich: { label: '字段补全', icon: 'enrich' },
      downloadChapter: { label: '下载章节', icon: 'download' },
      downloadComic: { label: '下载漫画', icon: 'download' },
      enrichChapters: { label: '章节增强', icon: 'enrich' },
      repairComic: { label: '修复漫画', icon: 'task' }
    }

    const seenTypes = new Set()
    for (const type of new Set([...Object.keys(activeByType), ...Object.keys(waitingByType)])) {
      if (seenTypes.has(type)) continue
      seenTypes.add(type)
      const active = activeByType[type] || 0
      const waiting = waitingByType[type] || 0
      if (active === 0 && waiting === 0) continue
      const info = typeLabels[type] || { label: type, icon: 'task' }
      tasks.push({
        type,
        label: info.label,
        icon: info.icon,
        active,
        waiting,
        total: active + waiting
      })
    }

    const settings = getCachedSettings()
    const settingsConcurrency = settings.concurrency || 5
    const settingsDownloadConcurrency = settings.downloadConcurrency || 3

    return {
      tasks,
      activeCount: stats.active || 0,
      waitingCount: stats.waiting || 0,
      completedCount: stats.completed || 0,
      failedCount: stats.failed || 0,
      concurrency: settingsConcurrency,
      downloadConcurrency: settingsDownloadConcurrency,
      lastUpdated: Date.now()
    }
  }

  function broadcastBackgroundTasks() {
    const state = getBackgroundTasks()
    backgroundTaskState = state
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('app:backgroundTasks', state)
    })
  }

  let globalBackgroundTaskForwarder = null
  function ensureGlobalBackgroundTaskForwarder() {
    if (globalBackgroundTaskForwarder) return

    const broadcast = () => broadcastBackgroundTasks()

    const unsubProgress = jq.on('progress', () => broadcast())
    const unsubCompleted = jq.on('completed', () => broadcast())
    const unsubFailed = jq.on('failed', () => broadcast())
    const unsubRetrying = jq.on('retrying', () => broadcast())
    const unsubPaused = jq.on('paused', () => broadcast())
    const unsubResumed = jq.on('resumed', () => broadcast())

    const bgTaskInterval = setInterval(() => broadcast(), 3000)

    globalBackgroundTaskForwarder = () => {
      unsubProgress(); unsubCompleted(); unsubFailed()
      unsubRetrying(); unsubPaused(); unsubResumed()
      clearInterval(bgTaskInterval)
    }
  }

  ipcMain.handle('app:backgroundTasks', async () => getBackgroundTasks())

  // ============ 自动更新 ============
  ipcMain.handle('update:check', async () => checkForUpdates())
  ipcMain.handle('update:download', async () => { downloadUpdate(); return true })
  ipcMain.handle('update:install', async () => { quitAndInstall(); return true })

  const { getProxyPort } = require('../utils/proxyUrl')
  ipcMain.on('proxy:getPort', (event) => {
    event.returnValue = getProxyPort()
  })

  // 捕获渲染进程错误
  ipcMain.on('renderer:error', (_, data) => {
    console.error('[Renderer Error]', data.type || 'error', data.message, data.stack || '')
  })

  // --- Reading Progress ---
  ipcMain.handle('progress:save', async (_, data) => db.saveReadingProgress(data.comicId, data.chapterIndex, data.chapterUrl, data.pageIndex, data.totalPages))
  ipcMain.handle('progress:get', async (_, comicId) => db.getReadingProgress(comicId))
  ipcMain.handle('progress:history', async (_, limit) => db.getAllReadingHistory(limit))
  ipcMain.handle('progress:delete', async (_, comicId) => db.deleteReadingProgress(comicId))

  ipcMain.handle('detail:getComicById', async (_, id) => db.getComicById(id))

  // --- Window management ---
  ipcMain.handle('app:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('app:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) { w.isMaximized() ? w.unmaximize() : w.maximize() }
  })
  ipcMain.handle('app:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle('app:isMaximized', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w ? w.isMaximized() : false
  })
  ipcMain.handle('app:toggleFullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.setFullScreen(!w.isFullScreen())
  })
  ipcMain.handle('app:isFullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w ? w.isFullScreen() : false
  })
  ipcMain.handle('app:exitFullscreen', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w) w.setFullScreen(false)
  })

  ipcMain.handle('window:getSize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return w ? w.getSize() : [1200, 800]
  })
  ipcMain.handle('window:setSize', (e, w, h) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.setSize(w, h)
  })
  ipcMain.handle('window:openPath', (e, p) => shell.openPath(p))

  // --- 清理重复任务 ---
  ipcMain.handle('job:cleanupDuplicateDownloads', async () => {
    try {
      const raw = jq.db
      if (!raw) return { success: false, error: '队列数据库未初始化' }

      const rows = raw.prepare(
        `SELECT id, payload FROM job_queue 
         WHERE type = 'downloadComic' AND status = 'waiting'
         ORDER BY created_at DESC`
      ).all()

      const seen = new Map()
      const toCancel = []

      for (const row of rows) {
        let payload
        try { payload = JSON.parse(row.payload || '{}') } catch (e) { payload = {} }
        const comicTitle = payload.comicTitle
        const sourceUrl = payload.sourceUrl
        const key = sourceUrl || comicTitle

        if (!key) continue

        if (seen.has(key)) {
          toCancel.push(row.id)
        } else {
          seen.set(key, row.id)
        }
      }

      let cancelled = 0
      for (const jobId of toCancel) {
        try {
          jq.cancel(jobId)
          cancelled++
        } catch (e) {
          console.warn(`[Cleanup] 取消任务失败 ${jobId}:`, e.message)
        }
      }

      return {
        success: true,
        totalChecked: rows.length,
        duplicatesFound: toCancel.length,
        cancelled
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('job:cleanupDuplicateSyncs', async () => {
    try {
      const raw = jq.db
      if (!raw) return { success: false, error: '队列数据库未初始化' }

      const rows = raw.prepare(
        `SELECT id, payload FROM job_queue 
         WHERE type = 'sync' AND status = 'waiting'
         ORDER BY created_at DESC`
      ).all()

      if (rows.length <= 1) {
        return { success: true, message: '没有重复的 sync 任务', total: rows.length, cancelled: 0 }
      }

      const toCancel = rows.slice(1).map(r => r.id)
      let cancelled = 0
      for (const jobId of toCancel) {
        try {
          jq.cancel(jobId)
          cancelled++
        } catch (e) {
          console.warn(`[Cleanup] 取消 sync 任务失败 ${jobId}:`, e.message)
        }
      }

      return {
        success: true,
        total: rows.length,
        cancelled,
        kept: rows[0]?.id || null
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- 磁盘文件名修复 ---
  function _safeRename(src, dst) {
    if (src === dst) return dst
    if (!fs.existsSync(src)) return null
    let final = dst
    let i = 1
    while (fs.existsSync(final)) {
      final = `${dst}-fix${i}`
      i++
    }
    try {
      fs.renameSync(src, final)
      return final
    } catch (e) {
      console.warn(`[fixDisk] 重命名失败: ${src} -> ${final}: ${e.message}`)
      return null
    }
  }

  ipcMain.handle('cache:fixDiskNames', async () => {
    const EXTERNAL_ROOT = getExternalRoot()
    if (!fs.existsSync(EXTERNAL_ROOT)) {
      return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
    }

    db.initDB()

    const report = {
      scannedDirs: 0,
      matchedComics: 0,
      unmatchedDirs: [],
      renamedComicDirs: [],
      renamedChapterDirs: [],
      skippedChapterDirs: [],
      errors: []
    }

    try {
      const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        report.scannedDirs++

        const dirName = entry.name
        const oldPath = path.join(EXTERNAL_ROOT, dirName)

        const matched = await _matchComicInDB(dirName)
        if (!matched) {
          report.unmatchedDirs.push(dirName)
          continue
        }
        report.matchedComics++

        const expectedComicDir = sanitize(matched.title)
        const expectedComicPath = path.join(EXTERNAL_ROOT, expectedComicDir)
        let currentComicPath = oldPath

        if (dirName !== expectedComicDir) {
          const renamed = _safeRename(oldPath, expectedComicPath)
          if (renamed) {
            currentComicPath = renamed
            report.renamedComicDirs.push({
              old: dirName,
              new: expectedComicDir
            })
          } else {
            report.errors.push(`漫画目录重命名失败: ${dirName}`)
          }
        }

        try {
          const chEntries = fs.readdirSync(currentComicPath, { withFileTypes: true })
          const chapterDirs = chEntries
            .filter(e => e.isDirectory())
            .map(e => e.name)

          for (const chDirName of chapterDirs) {
            const m = chDirName.match(/^(\d+)/)
            if (!m) continue
            const chIdx = parseInt(m[1], 10) - 1

            const dbChapter = matched.chapters.find(c => c.index === chIdx)
            if (!dbChapter) {
              report.skippedChapterDirs.push(`${matched.title}/${chDirName}`)
              continue
            }

            const expectedChapterDir = `${chIdx + 1}-${sanitize(dbChapter.name)}`
            if (chDirName !== expectedChapterDir) {
              const oldChPath = path.join(currentComicPath, chDirName)
              const newChPath = path.join(currentComicPath, expectedChapterDir)
              const renamed = _safeRename(oldChPath, newChPath)
              if (renamed) {
                report.renamedChapterDirs.push({
                  comic: matched.title,
                  old: chDirName,
                  new: expectedChapterDir
                })
              } else {
                report.errors.push(`章节目录重命名失败: ${matched.title}/${chDirName}`)
              }
            }
          }
        } catch (e) {
          report.errors.push(`扫描 ${matched.title} 章节失败: ${e.message}`)
        }
      }
    } catch (e) {
      report.errors.push(`扫描根目录失败: ${e.message}`)
    }

    return { success: true, report }
  })

  ipcMain.handle('cache:scanDiskNames', async () => {
    const EXTERNAL_ROOT = getExternalRoot()
    if (!fs.existsSync(EXTERNAL_ROOT)) {
      return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
    }

    const result = {
      root: EXTERNAL_ROOT,
      totalComics: 0,
      comics: []
    }

    try {
      const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        result.totalComics++

        const comicDir = path.join(EXTERNAL_ROOT, entry.name)
        const chDirs = []
        let imageCount = 0
        let hasCover = false

        try {
          const chEntries = fs.readdirSync(comicDir, { withFileTypes: true })
          for (const ch of chEntries) {
            if (ch.isDirectory()) {
              let chImgs = 0
              try {
                const files = fs.readdirSync(path.join(comicDir, ch.name))
                chImgs = files.filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f)).length
              } catch (_) {}
              chDirs.push({ name: ch.name, imageCount: chImgs })
              imageCount += chImgs
            } else if (ch.isFile() && ch.name === 'cover.webp') {
              hasCover = true
            }
          }
        } catch (_) {}

        result.comics.push({
          dirName: entry.name,
          chapterCount: chDirs.length,
          totalImages: imageCount,
          hasCover,
          chapters: chDirs
        })
      }
    } catch (e) {
      return { success: false, error: e.message }
    }

    return { success: true, result }
  })

  ipcMain.handle('cache:analyzeDiskNames', async (_, limit = 20) => {
    const EXTERNAL_ROOT = getExternalRoot()
    if (!fs.existsSync(EXTERNAL_ROOT)) {
      return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
    }

    const source = sources.get('smtt6') || sources.default
    const analysis = {
      total: 0,
      matched: 0,
      unmatched: [],
      samples: []
    }

    try {
      const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
      const comicDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
      analysis.total = comicDirs.length

      const sampleDirs = comicDirs.slice(0, limit)

      for (const dirName of sampleDirs) {
        try {
          const searchResults = await source.search(dirName, 1)
          if (!searchResults || searchResults.length === 0) {
            analysis.unmatched.push(dirName)
            continue
          }

          const bestMatch = searchResults[0]
          analysis.matched++

          const detail = await source.getDetail(bestMatch.url)
          const realChapters = (detail?.chapters || []).slice(0, 15)

          const chDirsOnDisk = fs.readdirSync(path.join(EXTERNAL_ROOT, dirName), { withFileTypes: true })
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .slice(0, 15)

          const chapterComparison = []
          for (let i = 0; i < Math.min(realChapters.length, chDirsOnDisk.length); i++) {
            const realChapter = realChapters[i]
            const diskChapter = chDirsOnDisk[i]

            const diskMatch = diskChapter.match(/^\d+-(.*)$/)
            const diskChapterName = diskMatch ? diskMatch[1] : diskChapter

            const currentSanitized = sanitize(realChapter.name)

            chapterComparison.push({
              index: i + 1,
              realName: realChapter.name,
              diskName: diskChapterName,
              currentSanitized,
              matchesCurrent: diskChapterName === currentSanitized,
              differsFromReal: diskChapterName !== realChapter.name
            })
          }

          analysis.samples.push({
            diskDirName: dirName,
            realComicTitle: bestMatch.title,
            realComicUrl: bestMatch.url,
            currentSanitized: sanitize(bestMatch.title),
            comicDirMatchesCurrent: dirName === sanitize(bestMatch.title),
            chapters: chapterComparison
          })

        } catch (e) {
          analysis.unmatched.push(`${dirName} (错误: ${e.message})`)
        }
      }
    } catch (e) {
      return { success: false, error: e.message }
    }

    return { success: true, analysis }
  })

  ipcMain.handle('disk:organizeOrphanChapters', async () => {
    try {
      const root = getPrimaryDownloadRoot()
      if (!fs.existsSync(root)) {
        return { success: false, error: `目录不存在: ${root}` }
      }

      const result = {
        scanned: 0,
        orphanChapters: [],
        moved: 0,
        errors: []
      }

      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        result.scanned++

        const dirName = entry.name
        const dirPath = path.join(root, dirName)

        const isChapterFormat = /^\d+-/.test(dirName)
        if (!isChapterFormat) continue

        try {
          const subEntries = fs.readdirSync(dirPath, { withFileTypes: true })
          const hasSubDirs = subEntries.some(e => e.isDirectory())
          if (hasSubDirs) continue

          const chapterMatch = dirName.match(/^(\d+)-(.*)$/)
          if (!chapterMatch) continue
          const chapterIndex = parseInt(chapterMatch[1], 10) - 1
          const chapterName = chapterMatch[2]

          const raw = db.getRawDB()
          let matchedComic = null

          if (raw) {
            const chapterRows = raw.prepare(
              `SELECT c.id, c.title, c.sourceUrl, ch.name, ch.sort_order 
               FROM chapters ch 
               JOIN comics c ON ch.comic_id = c.id 
               WHERE ch.name = ? OR ch.name LIKE ?`
            ).all(chapterName, `%${chapterName}%`)
            if (chapterRows && chapterRows.length > 0) {
              matchedComic = chapterRows[0]
            }
          }

          if (matchedComic && matchedComic.title) {
            const comicDir = path.join(root, sanitize(matchedComic.title))
            if (!fs.existsSync(comicDir)) {
              fs.mkdirSync(comicDir, { recursive: true })
            }
            const targetPath = path.join(comicDir, dirName)

            if (fs.existsSync(targetPath)) {
              result.errors.push(`目标已存在，跳过: ${dirName} -> ${matchedComic.title}`)
              continue
            }

            fs.renameSync(dirPath, targetPath)
            result.moved++
            result.orphanChapters.push({
              oldPath: dirPath,
              newPath: targetPath,
              comicTitle: matchedComic.title,
              chapterName
            })
          } else {
            result.orphanChapters.push({
              oldPath: dirPath,
              comicTitle: null,
              chapterName,
              reason: '未找到匹配漫画'
            })
          }
        } catch (e) {
          result.errors.push(`处理失败 ${dirName}: ${e.message}`)
        }
      }

      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('db:cleanupUnnamedComics', async () => {
    try {
      const raw = db.getRawDB()
      if (!raw) return { success: false, error: '数据库未初始化' }

      const unnamedRows = raw.prepare(
        `SELECT id, sourceUrl, title, favorited FROM comics WHERE title = '未命名漫画' OR title = '' OR title IS NULL`
      ).all()

      const results = {
        totalFound: unnamedRows.length,
        deleted: 0,
        skipped: 0,
        details: []
      }

      for (const row of unnamedRows) {
        try {
          const hasRecords = raw.prepare(
            'SELECT COUNT(*) as c FROM download_records WHERE comic_id = ?'
          ).get(row.id)
          const recordCount = hasRecords?.c || 0

          const hasChapters = raw.prepare(
            'SELECT COUNT(*) as c FROM chapters WHERE comic_id = ?'
          ).get(row.id)
          const chapterCount = hasChapters?.c || 0

          if (row.sourceUrl && chapterCount > 0) {
            results.details.push({
              id: row.id,
              title: row.title,
              action: 'skipped_has_chapters',
              reason: `有 ${chapterCount} 个章节，保留并从源站重新获取标题`,
              sourceUrl: row.sourceUrl
            })
            results.skipped++
            try {
              const source = row.sourceUrl.includes('smtt6') ? sources.get('smtt6') : sources.default
              source.getDetail(row.sourceUrl).then(detail => {
                if (detail?.title?.trim()) {
                  raw.prepare('UPDATE comics SET title = ? WHERE id = ?').run(detail.title.trim(), row.id)
                  console.log(`[Cleanup] 已修复标题: ${detail.title.trim()}`)
                }
              }).catch(() => {})
            } catch (_) {}
            continue
          }

          raw.prepare('DELETE FROM chapters WHERE comic_id = ?').run(row.id)
          raw.prepare('DELETE FROM download_records WHERE comic_id = ?').run(row.id)
          raw.prepare('DELETE FROM comics WHERE id = ?').run(row.id)
          results.deleted++
          results.details.push({
            id: row.id,
            title: row.title || '(空)',
            action: 'deleted',
            reason: recordCount > 0 ? `有 ${recordCount} 条下载记录但无标题，已清理` : '无内容，已删除'
          })
        } catch (e) {
          results.details.push({
            id: row.id,
            title: row.title || '(空)',
            action: 'error',
            reason: e.message
          })
        }
      }

      return { success: true, ...results }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  return {
    broadcastBackgroundTasks,
    ensureGlobalBackgroundTaskForwarder,
    ensureGlobalCrawlForwarder,
    createWindow
  }
}

module.exports = { registerAllIPC }