'use strict'

const path = require('path')
const fs = require('fs')
const sources = require('../../sources/registry')
const db = require('../../db')
const { sanitizeFilename: sanitize, sleep } = require('../../utils')
const {
  findComicDir, resolveUniqueComicDir, getPrimaryDownloadRoot,
  findChapterDir, getValidChapterImages, getValidChapterImagesCached,
  normalizeUrl
} = require('../downloadPaths')
const { addSyncJob, getJobQueue } = require('./helpers')
const { createSyncService } = require('../../services/syncService')

let _syncService = null
function getSyncService() {
  if (!_syncService) {
    _syncService = createSyncService({ db, sources, jobQueue: getJobQueue() })
  }
  return _syncService
}

async function jobHandlerSync(job, onProgress) {
  const fullSync = job.payload?.fullSync === true
  const service = getSyncService()

  async function cancelSleep(ms) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (job.cancelled()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  const comics = await service.gatherComics({ fullSync })
  if (comics.length === 0) return { enriched: 0, updated: 0, msg: '没有需要同步的漫画' }

  let enriched = 0, updated = 0, failed = 0, skipped = 0, newChapters = 0

  async function syncOneWrapper(comic, i) {
    if (job.cancelled()) return { cancelled: true }

    const SKIP_THRESHOLD_MS = 60 * 60 * 1000
    const lastSyncAt = comic.last_sync_at || 0
    const isRecentlySynced = Date.now() - lastSyncAt < SKIP_THRESHOLD_MS
    const isFavorited = comic.favorited === 1 || comic.favorited === true
    const hasMissingFields = !comic.tags || comic.tags.length === 0
      || !comic.status || !comic.desc || !comic.category
      || !comic.author || comic.chapter_count === 0

    if (!fullSync && !isFavorited && !hasMissingFields && isRecentlySynced) {
      skipped++
      onProgress({ current: i + 1, total: comics.length, title: comic.title, skipped: true })
      if (comic._id) {
        try { await db.markSynced([comic._id]) } catch (e) { console.warn('[Sync] markSynced 失败:', e.message) }
      }
      return { success: true, skipped: true }
    }

    let lastError = null
    const MAX_RETRIES = 3
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await service.syncOneComic(comic, {
          fullSync,
          cancelled: () => job.cancelled(),
          onProgress: (p) => onProgress({ ...p, current: i + 1, total: comics.length })
        })

        if (result.enriched) enriched++
        if (result.updated) updated++
        if (result.newChapterCount) newChapters += result.newChapterCount

        // 自动下载补齐逻辑（胶水代码，保留在 handler）
        if (comic.favorited && result.detail && result.detail.chapters) {
          await _triggerAutoDownload(comic, result.detail, job)
        }

        onProgress({ current: i + 1, total: comics.length, title: comic.title })
        if (comic._id) {
          try { await db.markSynced([comic._id]) } catch (e) { console.warn('[Sync] markSynced 失败:', e.message) }
        }
        return { success: true }
      } catch (e) {
        lastError = e
        const msg = e.message || ''
        const isRetryable = msg.includes('timeout') || msg.includes('ECONNRESET')
          || msg.includes('ERR_CONNECTION_RESET') || msg.includes('ENOTFOUND')
          || msg.includes('EAI_AGAIN') || msg.includes('body timeout')
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const backoffMs = 3000 * (attempt + 1) + Math.random() * 2000
          console.log(`[Sync] ${comic.title} 第 ${attempt + 1} 次尝试失败，${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          await cancelSleep(backoffMs)
        } else {
          break
        }
      }
    }
    failed++
    onProgress({ current: i + 1, total: comics.length, error: lastError?.message })
    return { success: false, error: lastError?.message }
  }

  const SYNC_CONCURRENCY = 3
  const SYNC_DELAY_MS = 2000
  for (let i = 0; i < comics.length; i += SYNC_CONCURRENCY) {
    if (job.cancelled()) return { enriched, updated, failed, skipped, newChapters, msg: '已取消' }
    const batch = comics.slice(i, i + SYNC_CONCURRENCY)
    await Promise.allSettled(batch.map((comic, j) => syncOneWrapper(comic, i + j)))
    if (i + SYNC_CONCURRENCY < comics.length) {
      await cancelSleep(SYNC_DELAY_MS + Math.random() * 1000)
    }
  }
  return { enriched, updated, failed, skipped, newChapters, total: comics.length }
}

async function _triggerAutoDownload(comic, detail, job) {
  const jobQueue = getJobQueue()
  if (!jobQueue?.db) return

  let comicDir = findComicDir(detail.title || comic.title, comic.sourceUrl)
  if (!comicDir) {
    const preferred = path.join(getPrimaryDownloadRoot(), sanitize((detail.title || comic.title || '').trim()))
    comicDir = resolveUniqueComicDir(preferred, comic.sourceUrl)
  }
  const downloadRoot = getPrimaryDownloadRoot()
  const resolvedComicDir = path.resolve(comicDir)
  const resolvedRoot = path.resolve(downloadRoot)
  if (resolvedComicDir === resolvedRoot) {
    console.warn(`[Sync] 漫画目录无效，跳过下载: ${detail.title || comic.title}`)
    return
  }

  const expectedByIndex = new Map()
  try {
    if (comic._id) {
      const chRows = jobQueue.db.prepare('SELECT sort_order, image_count FROM chapters WHERE comic_id=?').all(comic._id)
      for (const r of chRows) {
        if (r.image_count) expectedByIndex.set(r.sort_order, r.image_count)
      }
    }
  } catch (_) {}

  const seenThisRun = new Set()
  const payloads = []
  for (let idx = 0; idx < detail.chapters.length; idx++) {
    const ch = detail.chapters[idx]
    const chUrl = normalizeUrl(ch.url)
    if (chUrl) {
      if (seenThisRun.has(chUrl)) continue
      seenThisRun.add(chUrl)
    }
    if (comicDir) {
      const chDir = findChapterDir(comicDir, ch.name, idx)
      const existingImgs = chDir ? getValidChapterImagesCached(chDir) : []
      const expectedCount = expectedByIndex.get(idx)
      if (expectedCount && existingImgs.length >= expectedCount) continue
      if (!expectedCount && existingImgs.length > 0) continue
    }
    payloads.push({
      comicId: comic._id,
      comicTitle: detail.title || comic.title,
      chapterIndex: idx,
      chapterName: ch.name,
      chapterUrl: ch.url,
      sourceUrl: comic.sourceUrl,
      comicDir
    })
  }

  if (payloads.length > 0) {
    console.log(`[Sync] 为《${detail.title || comic.title}》添加 ${payloads.length} 个下载任务`)
    for (const p of payloads) {
      jobQueue.add('downloadComic', p, { priority: 2, maxRetries: 3 })
    }
  }
}

module.exports = { jobHandlerSync }