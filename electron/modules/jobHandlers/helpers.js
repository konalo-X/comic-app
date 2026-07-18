'use strict'

let jobQueue = null
let autoTimers = []

const VALID_CATEGORIES = ['日漫', '韩漫', '真人', '3D漫画', '同性']

function deriveCategoryFromTags(...tagSources) {
  for (const tags of tagSources) {
    if (!tags) continue
    const list = Array.isArray(tags) ? tags : String(tags).split(',')
    for (const tag of list) {
      const t = tag.trim()
      if (!t) continue
      const match = VALID_CATEGORIES.find(cat => t.includes(cat) || cat.includes(t))
      if (match) return match.includes('3D') ? '3D漫画' : match
    }
  }
  return ''
}

async function enrichChapters(comic, chaptersToEnrich, source, cancelledFn = null) {
  const imageCountUpdates = []
  const chapterNameUpdates = []
  for (let j = 0; j < chaptersToEnrich.length; j++) {
    if (cancelledFn && cancelledFn()) break
    try {
      const pageList = await source.getPageList(chaptersToEnrich[j].url, comic.sourceUrl, cancelledFn)
      const images = Array.isArray(pageList) ? pageList : (pageList.images || [])
      const h2Name = (!Array.isArray(pageList) && pageList.chapterName) ? pageList.chapterName : ''

      if (chaptersToEnrich[j].url) {
        imageCountUpdates.push({ url: chaptersToEnrich[j].url, image_count: images.length })
      }
      if (h2Name && h2Name.trim() && h2Name.trim() !== chaptersToEnrich[j].name) {
        chapterNameUpdates.push({ index: chaptersToEnrich[j].index, name: h2Name.trim() })
      }
      await new Promise(r => {
        const t = setTimeout(r, 250)
        if (cancelledFn) {
          const check = setInterval(() => {
            if (cancelledFn()) {
              clearTimeout(t)
              clearInterval(check)
              r()
            }
          }, 100)
        }
      })
    } catch (chE) {}
  }
  return { imageCountUpdates, chapterNameUpdates }
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