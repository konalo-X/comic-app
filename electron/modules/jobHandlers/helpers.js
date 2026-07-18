'use strict'

const { createEnrichService } = require('../../services/enrichService')

let jobQueue = null
let autoTimers = []
let _enrichService = null

function getEnrichService() {
  if (!_enrichService) {
    _enrichService = createEnrichService({ db: require('../../db'), sources: require('../../sources/registry'), jobQueue })
  }
  return _enrichService
}

// 兼容旧接口，转发到 service 层
function deriveCategoryFromTags(...tagSources) {
  return getEnrichService().deriveCategoryFromTags(...tagSources)
}

async function enrichChapters(comic, chaptersToEnrich, source, cancelledFn = null) {
  return getEnrichService().enrichChapters(comic, chaptersToEnrich, source, cancelledFn)
}

function addSyncJob(priority = 3) {
  if (!jobQueue || !jobQueue.db) {
    console.warn('[Sync] 队列未初始化，无法添加 sync 任务')
    return null
  }
  try {
    const existing = jobQueue.db.prepare(
      `SELECT id, priority FROM job_queue WHERE type = 'sync' AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
    ).get()
    if (existing) {
      if (priority >= existing.priority) {
        console.log(`[Sync] 已有 sync 任务在等待/执行中 (priority=${existing.priority})，跳过重复创建（新 priority=${priority}）`)
        return existing.id
      }
      console.log(`[Sync] 抢占: 新任务 priority=${priority} 替换现有 priority=${existing.priority}`)
      jobQueue.cancel(existing.id)
    }
  } catch (e) {
    console.warn('[Sync] 检查已有 sync 任务失败:', e.message)
  }
  const checkRateLimit = priority >= 2
  // sync 单轮可能扫多本漫画(每本 getDetail 最多 150s + enrichChapters 最多 240s),
  // 给宽松总超时避免慢源站时整轮被截断(默认 5min 太短)。
  return jobQueue.add('sync', {}, { priority, maxRetries: 3, checkRateLimit, timeout: 60 * 60 * 1000 })
}

function getJobQueue() {
  return jobQueue
}

function setJobQueue(q) {
  jobQueue = q
}

function getAutoTimers() {
  return autoTimers
}

function setAutoTimers(timers) {
  autoTimers = timers
}

module.exports = {
  deriveCategoryFromTags,
  enrichChapters,
  addSyncJob,
  getJobQueue,
  setJobQueue,
  getAutoTimers,
  setAutoTimers
}