'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, powerMonitor } = require('electron')
const JobQueue = require('../../jobqueue')
const db = require('../../db')
const { shouldSkipAutoTask } = require('../powerStrategy')
const { getGlobalDownloadConcurrency, setGlobalDownloadConcurrency } = require('../downloadPaths')

const {
  deriveCategoryFromTags, enrichChapters, addSyncJob,
  getJobQueue, setJobQueue, getAutoTimers, setAutoTimers
} = require('./helpers')

const { jobHandlerSync } = require('./sync')
const { jobHandlerCrawlAll } = require('./crawl')
const { jobHandlerAutoEnrich, jobHandlerEnrichImageCounts } = require('./enrich')
const { jobHandlerDownloadChapter, jobHandlerDownloadComic } = require('./download')
const { jobHandlerRepairComic, autoRepairDownloadedComics } = require('./repair')
const { jobHandlerExportEpub } = require('./exportEpub')
const {
  JOB_QUEUE, TYPE_CONCURRENCY, AUTO_RETRY, RATE_LIMITS,
  MUTEX_GROUPS, SINGLETON_TYPES
} = require('../../config')

let _jobQueueInitialized = false

function initJobQueue() {
  if (_jobQueueInitialized) {
    console.log('[JobQueue] 已经初始化，跳过重复调用')
    return
  }
  _jobQueueInitialized = true

  let concurrency = JOB_QUEUE.DEFAULT_CONCURRENCY
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (stored.concurrency) concurrency = stored.concurrency
    if (stored.downloadConcurrency) setGlobalDownloadConcurrency(stored.downloadConcurrency)
  } catch {}
  const jobQueue = new JobQueue(db.getRawDB(), {
    concurrency,
    typeConcurrency: {
      downloadChapter: getGlobalDownloadConcurrency() || TYPE_CONCURRENCY.downloadChapter,
      downloadComic: TYPE_CONCURRENCY.downloadComic,
      sync: TYPE_CONCURRENCY.sync,
      crawlAll: TYPE_CONCURRENCY.crawlAll,
      autoEnrich: TYPE_CONCURRENCY.autoEnrich,
      enrichChapters: TYPE_CONCURRENCY.enrichChapters,
      repairComic: TYPE_CONCURRENCY.repairComic,
      exportEpub: TYPE_CONCURRENCY.exportEpub
    },
    singletonTypes: SINGLETON_TYPES,
    autoRetryConfig: AUTO_RETRY
  })
  jobQueue.register('sync', jobHandlerSync)
  jobQueue.register('crawlAll', jobHandlerCrawlAll)
  jobQueue.register('autoEnrich', jobHandlerAutoEnrich)
  jobQueue.register('downloadChapter', jobHandlerDownloadChapter)
  jobQueue.register('downloadComic', jobHandlerDownloadComic)
  jobQueue.register('repairComic', jobHandlerRepairComic)
  jobQueue.register('enrichChapters', jobHandlerEnrichImageCounts)
  jobQueue.register('exportEpub', jobHandlerExportEpub)
  jobQueue.registerMutexGroup('crawl', MUTEX_GROUPS.crawl)
  jobQueue.registerMutexGroup('enrich', MUTEX_GROUPS.enrich)
  jobQueue.rateLimits = RATE_LIMITS
  setJobQueue(jobQueue)
  console.log('[JobQueue] 持久队列已初始化，并发数:', concurrency, ', 章节并发:', getGlobalDownloadConcurrency() || 3)

  function notifyQueueChanged(eventType, data) {
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send('jobQueue:changed', { event: eventType, ...data })
    })
  }
  jobQueue.on('progress', (data) => notifyQueueChanged('progress', data))
  jobQueue.on('completed', (data) => {
    notifyQueueChanged('completed', data)
    if (data.type === 'sync' && data.result && !data.result.cancelled) {
      const updated = data.result.updated || 0
      if (updated > 0) {
        console.log(`[AutoRepair] sync 完成，发现 ${updated} 部漫画有更新，5 分钟后自动检查已下载漫画完整性`)
        // Bug #17 修复: 存引用到模块级变量, stopAutoTasks 时可清理; 回调中加 stopped guard
        if (_autoRepairTimer) clearTimeout(_autoRepairTimer)
        _autoRepairTimer = setTimeout(() => {
          _autoRepairTimer = null
          if (_autoTasksStopped) return
          if (shouldSkipAutoTask()) {
            console.log('[AutoRepair] 系统空闲不足，跳过自动修复')
            return
          }
          autoRepairDownloadedComics().catch(e => {
            console.warn('[AutoRepair] 自动修复失败:', e.message)
          })
        }, 5 * 60 * 1000)
      }
    }
    // autoEnrich 已合并到 sync 任务中，不再自动续排
    // sync 每 15 分钟运行一次，覆盖所有缺字段漫画的补全
    // [自动导出EPUB 2026-10-06] sync 完成(无论有无更新)后, 扫描已完结且全本下完的漫画, 自动入队导出 EPUB
    if (data.type === 'sync' && data.result && !data.result.cancelled) {
      if (_autoEpubTimer) clearTimeout(_autoEpubTimer)
      _autoEpubTimer = setTimeout(() => {
        _autoEpubTimer = null
        if (_autoTasksStopped) return
        if (shouldSkipAutoTask()) {
          console.log('[AutoEpub] 系统空闲不足, 跳过自动导出扫描')
          return
        }
        scanAndEnqueueFinishedEpub().catch(e => {
          console.warn('[AutoEpub] 自动导出扫描失败:', e.message)
        })
      }, 6 * 60 * 1000)
    }
  })
  jobQueue.on('failed', (data) => notifyQueueChanged('failed', data))
  jobQueue.on('paused', (data) => notifyQueueChanged('paused', data))
  jobQueue.on('resumed', (data) => notifyQueueChanged('resumed', data))
  jobQueue.on('enqueued', (data) => notifyQueueChanged('enqueued', data))
  jobQueue.on('cancelled', (data) => notifyQueueChanged('cancelled', data))
  jobQueue.on('retried', (data) => notifyQueueChanged('retried', data))
  jobQueue.on('removed', (data) => notifyQueueChanged('removed', data))
  jobQueue.on('cleared', (data) => notifyQueueChanged('cleared', data))
}

let _autoTasksStarted = false
let _autoRepairTimer = null
let _autoEpubTimer = null

// [自动导出EPUB 2026-10-06] 扫描已完结 + 本地全本下载完成 + 尚无 EPUB 的漫画, 入队 exportEpub 任务
// 入队逻辑与 autoRepair 一致(单例防重、跳过已在队列的), 持久化到 job_queue 可重启续跑
async function scanAndEnqueueFinishedEpub() {
  const jobQueue = getJobQueue()
  if (!jobQueue) { console.log('[AutoEpub] jobQueue 为空, 返回'); return }
  let st = {}
  try {
    const sp = path.join(app.getPath('userData'), 'settings.json')
    if (fs.existsSync(sp)) st = JSON.parse(fs.readFileSync(sp, 'utf-8')) || {}
  } catch (_) {}
  if (st.epubAutoExportEnabled === false) {
    console.log('[AutoEpub] 自动导出未开启, 跳过扫描')
    return
  }
  const { isComicFullyDownloaded } = require('./exportEpub')
  const rows = await db.getComics({ page: 1, pageSize: 100000, localOnly: true }).catch(() => null)
  const comics = (rows && (rows.docs || rows.data)) || rows || []
  let enqueued = 0
  // 已存在 EPUB 的路径判断(直接扫输出目录, 无需新增 db 方法)
  const outDir = (st.epubAutoExportDir && st.epubAutoExportDir.trim()) || app.getPath('downloads')
  const { sanitizeFilename: sanitize } = require('../../utils')
  let existing = new Set()
  try { const fs2 = require('fs'); if (fs2.existsSync(outDir)) { for (const f of fs2.readdirSync(outDir)) { if (f.toLowerCase().endsWith('.epub')) existing.add(f) } } } catch (_) {}
  // 本轮已入队的 sourceUrl(避免同一次扫描内重复 add, 因为 listJobs 不反映本次循环刚加的)
  const seenThisScan = new Set()
  for (const comic of comics) {
    if (!comic.local_path || !comic.sourceUrl) continue
    if (!/已完结/.test(comic.status || '')) continue
    if (!(await isComicFullyDownloaded(comic))) continue
    const epubName = sanitize(comic.title) + '.epub'
    if (existing.has(epubName)) { seenThisScan.add(comic.sourceUrl); continue }
    // 跳过已在队列的(单例) + 本轮已入队的
    if (seenThisScan.has(comic.sourceUrl)) continue
    const active = jobQueue.listJobs('active', 500).filter(j => j.type === 'exportEpub' && j.payload?.sourceUrl === comic.sourceUrl)
    const waiting = jobQueue.listJobs('waiting', 500).filter(j => j.type === 'exportEpub' && j.payload?.sourceUrl === comic.sourceUrl)
    if (active.length || waiting.length) { seenThisScan.add(comic.sourceUrl); continue }
    jobQueue.add('exportEpub', {
      sourceUrl: comic.sourceUrl,
      comicTitle: comic.title,
      comicDir: comic.local_path
    }, { priority: 6, source: 'auto' })
    enqueued++
  }
  if (enqueued > 0) console.log(`[AutoEpub] 已为 ${enqueued} 部已完结漫画创建 EPUB 导出任务`)
  else console.log('[AutoEpub] 无新漫画需要导出 EPUB')
}
let _autoTasksStopped = false

function startAutoTasks() {
  if (_autoTasksStarted) {
    console.log('[Auto] 自动任务已经启动，跳过重复调用')
    return
  }
  _autoTasksStarted = true
  stopAutoTasks()
  _autoTasksStopped = false  // Bug #17: stopAutoTasks 设了 true, 这里重置
  let autoUpdateEnabled = true
  let autoUpdateIntervalHours = 2
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (typeof stored.autoUpdateEnabled === 'boolean') autoUpdateEnabled = stored.autoUpdateEnabled
    if (stored.autoUpdateIntervalHours) autoUpdateIntervalHours = stored.autoUpdateIntervalHours
  } catch {}

  if (!autoUpdateEnabled) {
    console.log('[Auto] 追更已禁用，跳过启动')
    return
  }

  // [增强 2026-08-20] 尊重用户在设置里填的追更间隔,去掉 4 小时强制下限。
  // 之前 Math.max(4, autoUpdateIntervalHours) 会让用户设的 2h 永远不生效。
  // 仅做最小安全兜底(>=15 分钟),防止过短把源站打爆/自己卡死。
  const syncIntervalHours = Math.max(0.25, autoUpdateIntervalHours)
  const syncMs = syncIntervalHours * 60 * 60 * 1000

  const autoTimers = []

  const waitForSyncJob = (jobId, timeoutMs = 30 * 60 * 1000) => {
    const jobQueue = getJobQueue()
    if (!jobQueue) return Promise.resolve()
    return new Promise(resolve => {
      const cleanup = () => { offCompleted(); offFailed() }
      const onJobDone = ({ jobId: completedId }) => {
        if (completedId === jobId) { cleanup(); resolve() }
      }
      const offCompleted = jobQueue.on('completed', onJobDone)
      const offFailed = jobQueue.on('failed', onJobDone)
      setTimeout(() => { cleanup(); resolve() }, timeoutMs)
    })
  }

  const scheduleNextSync = () => {
    autoTimers.push(setTimeout(async () => {
      if (shouldSkipAutoTask('定时同步')) {
        scheduleNextSync()
        return
      }
      const jobId = addSyncJob(3)
      if (!jobId) {
        scheduleNextSync()
        return
      }
      await waitForSyncJob(jobId)
      scheduleNextSync()
    }, syncMs))
  }

  autoTimers.push(setTimeout(async () => {
    if (shouldSkipAutoTask('首次同步')) {
      scheduleNextSync()
      return
    }
    const jobId = addSyncJob(3)
    if (jobId) await waitForSyncJob(jobId, syncMs * 2)
    scheduleNextSync()
  }, 60 * 1000))

  autoTimers.push(setInterval(async () => {
    try {
      const jobQueue = getJobQueue()
      const before = jobQueue.getStats().total
      jobQueue.clear()
      const after = jobQueue.getStats().total
      if (before > after) {
        console.log(`[Auto] 清理 ${before - after} 条历史任务记录`)
      }
    } catch (e) {
      console.warn('[Auto] 清理历史任务记录失败:', e.message)
    }

    try {
      const result = await db.cleanStaleDownloadRecords()
      if (result.deleted > 0) {
        console.log(`[Auto] 清理 ${result.deleted} 条过期下载记录`)
      }
    } catch (e) {
      console.warn('[Auto] 清理过期下载记录失败:', e.message)
    }
  }, 60 * 60 * 1000))

  let lastFullSyncAt = 0
  const IDLE_CHECK_INTERVAL = 30 * 1000
  const IDLE_THRESHOLD_SEC = 5 * 60
  const FULL_SYNC_MIN_INTERVAL = 60 * 60 * 1000

  const idleCheckTimer = setInterval(async () => {
    if (shouldSkipAutoTask('空闲全量同步')) return

    const now = Date.now()
    if (now - lastFullSyncAt < FULL_SYNC_MIN_INTERVAL) return

    try {
      const idleState = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SEC)
      if (idleState !== 'idle') return
    } catch (e) {
      return
    }

    const jobQueue = getJobQueue()
    const activeRows = jobQueue.db.prepare(
      `SELECT type, COUNT(*) as c FROM job_queue WHERE status IN ('waiting','running','active') GROUP BY type`
    ).all()
    const activeByType = {}
    for (const row of activeRows) activeByType[row.type] = row.c
    const activeDownloads = (activeByType.downloadChapter || 0) + (activeByType.downloadComic || 0)
    const activeSync = activeByType.sync || 0
    const activeCrawl = activeByType.crawlAll || 0
    if (activeDownloads > 0 || activeSync > 0 || activeCrawl > 0) return

    const existing = jobQueue.db.prepare(
      `SELECT id FROM job_queue WHERE type = 'sync' AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
    ).get()
    if (existing) return

    lastFullSyncAt = now
    console.log('[Idle Sync] 检测到系统空闲，触发全量同步')
    jobQueue.add('sync', {}, { priority: 4, maxRetries: 3, checkRateLimit: false, source: 'auto' })
  }, IDLE_CHECK_INTERVAL)
  autoTimers.push(idleCheckTimer)

  // [自动导出EPUB 2026-10-06] 启动后 30 秒无条件扫描一次已完结全本漫画，
  // 入队 exportEpub（首启扫描，之后由 sync 完成回调的 _autoEpubTimer 续扫）。
  // 这样即使启动后长时间无 sync 更新，已完结漫画也会逐步被打包成 EPUB。
  autoTimers.push(setTimeout(() => {
    if (_autoTasksStopped) return
    scanAndEnqueueFinishedEpub().catch(e => console.warn('[AutoEpub] 首启扫描失败:', e.message))
  }, 30 * 1000))

  setAutoTimers(autoTimers)

  console.log(`[Auto] 持久队列自动任务已启动（同步间隔 ${syncIntervalHours}h，已合并字段补全）`)
}

function stopAutoTasks() {
  _autoTasksStarted = false
  _autoTasksStopped = true
  // Bug #17 修复: 清理 initJobQueue 中注册的 5min autoRepair 定时器
  if (_autoRepairTimer) { clearTimeout(_autoRepairTimer); _autoRepairTimer = null }
  // [自动导出EPUB 2026-10-06] 清理 autoExport 定时器
  if (_autoEpubTimer) { clearTimeout(_autoEpubTimer); _autoEpubTimer = null }
  const autoTimers = getAutoTimers()
  for (const t of autoTimers) {
    clearTimeout(t)
    clearInterval(t)
  }
  setAutoTimers([])
}

function restartAutoTasks() {
  console.log('[Auto] 重启自动任务')
  startAutoTasks()
}

module.exports = {
  deriveCategoryFromTags,
  enrichChapters,
  addSyncJob,
  jobHandlerSync,
  jobHandlerCrawlAll,
  jobHandlerAutoEnrich,
  jobHandlerEnrichImageCounts,
  jobHandlerDownloadChapter,
  jobHandlerDownloadComic,
  jobHandlerRepairComic,
  initJobQueue,
  startAutoTasks,
  stopAutoTasks,
  restartAutoTasks,
  getJobQueue,
  setJobQueue
}