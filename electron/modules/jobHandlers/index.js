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

let _jobQueueInitialized = false

function initJobQueue() {
  if (_jobQueueInitialized) {
    console.log('[JobQueue] 已经初始化，跳过重复调用')
    return
  }
  _jobQueueInitialized = true

  let concurrency = 5
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (stored.concurrency) concurrency = stored.concurrency
    if (stored.downloadConcurrency) setGlobalDownloadConcurrency(stored.downloadConcurrency)
  } catch {}
  const jobQueue = new JobQueue(db.getRawDB(), {
    concurrency,
    typeConcurrency: {
      downloadChapter: getGlobalDownloadConcurrency() || 3,
      downloadComic: 1,
      sync: 1,
      crawlAll: 1,
      autoEnrich: 1,
      enrichChapters: 1,
      repairComic: 1
    },
    singletonTypes: ['sync', 'crawlAll', 'autoEnrich', 'enrichChapters', 'repairComic'],
    autoRetryConfig: {
      downloadChapter: { delay: 5 * 60 * 1000, maxAutoRetries: 5, backoff: 1.5 },
      downloadComic: { delay: 10 * 60 * 1000, maxAutoRetries: 3, backoff: 2 },
      sync: { delay: 30 * 60 * 1000, maxAutoRetries: 3, backoff: 2 },
      autoEnrich: { delay: 30 * 60 * 1000, maxAutoRetries: 3, backoff: 2 },
      repairComic: { delay: 60 * 60 * 1000, maxAutoRetries: 2, backoff: 2 },
      enrichChapters: { delay: 30 * 60 * 1000, maxAutoRetries: 3, backoff: 2 }
    }
  })
  jobQueue.register('sync', jobHandlerSync)
  jobQueue.register('crawlAll', jobHandlerCrawlAll)
  jobQueue.register('autoEnrich', jobHandlerAutoEnrich)
  jobQueue.register('downloadChapter', jobHandlerDownloadChapter)
  jobQueue.register('downloadComic', jobHandlerDownloadComic)
  jobQueue.register('repairComic', jobHandlerRepairComic)
  jobQueue.register('enrichChapters', jobHandlerEnrichImageCounts)
  jobQueue.registerMutexGroup('crawl', ['sync', 'crawlAll', 'repairComic'])
  // autoEnrich / enrichChapters 是轻量元数据补全，不和 sync 互斥(否则自动续排会饿死 sync)
  jobQueue.registerMutexGroup('enrich', ['autoEnrich', 'enrichChapters'])
  jobQueue.rateLimits = {
    crawlAll: { maxCount: 1, windowMs: 15 * 60 * 1000 },
    sync: { maxCount: 1, windowMs: 10 * 60 * 1000 }
  }
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
        setTimeout(() => {
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
  })
  jobQueue.on('failed', (data) => notifyQueueChanged('failed', data))
  jobQueue.on('paused', (data) => notifyQueueChanged('paused', data))
  jobQueue.on('resumed', (data) => notifyQueueChanged('resumed', data))
  jobQueue.on('enqueued', (data) => notifyQueueChanged('enqueued', data))
  jobQueue.on('cancelled', (data) => notifyQueueChanged('cancelled', data))
  jobQueue.on('retried', (data) => notifyQueueChanged('retried', data))
}

let _autoTasksStarted = false

function startAutoTasks() {
  if (_autoTasksStarted) {
    console.log('[Auto] 自动任务已经启动，跳过重复调用')
    return
  }
  _autoTasksStarted = true
  stopAutoTasks()
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

  const syncIntervalHours = Math.max(4, autoUpdateIntervalHours)
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
    jobQueue.add('sync', {}, { priority: 3, maxRetries: 3, checkRateLimit: false })
  }, IDLE_CHECK_INTERVAL)
  autoTimers.push(idleCheckTimer)

  setAutoTimers(autoTimers)

  console.log(`[Auto] 持久队列自动任务已启动（同步间隔 ${syncIntervalHours}h，已合并字段补全）`)
}

function stopAutoTasks() {
  _autoTasksStarted = false
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