'use strict'

const { sleep, deriveCategoryFromTags, normalizeUrl } = require('../utils')

function createSyncService({ db, sources, jobQueue }) {
  async function _sleepWithCancel(ms, cancelledFn) {
    if (!cancelledFn) return sleep(ms)
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cancelledFn()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  async function gatherComics({ fullSync }) {
    const favoritedLimit = fullSync ? 10000 : 100
    const untaggedLimit = fullSync ? 10000 : 50
    const imgCountLimit = fullSync ? 10000 : 10
    const missingFieldsLimit = fullSync ? 10000 : 30

    const [batch, untagged, needingImgCount, missingFields] = await Promise.all([
      db.getFavoritedForSyncBatch(favoritedLimit),
      db.getUntaggedComics(untaggedLimit),
      db.getComicsNeedingImageCountUpdate(imgCountLimit),
      db.getComicsWithMissingFields(missingFieldsLimit)
    ])

    const seen = new Set()
    const comics = []
    for (const c of [...(batch || []), ...(untagged || []), ...(needingImgCount || []), ...(missingFields || [])]) {
      const key = c.sourceUrl || c._id
      if (!seen.has(key)) {
        seen.add(key)
        comics.push(c)
      }
    }
    return comics
  }

  async function syncOneComic(comic, { fullSync, cancelled, onProgress }) {
    const source = comic.sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default

    const detail = await _withTimeout(
      source.getDetail(comic.sourceUrl, cancelled),
      150 * 1000,
      'getDetail'
    )

    const needsEnrich = !comic.tags || comic.tags.length === 0
      || !comic.status || !comic.desc || !comic.category

    const localUrls = new Set((comic.chapters || []).map(c => normalizeUrl(c.url)).filter(Boolean))
    const remoteUrls = new Set((detail.chapters || []).map(c => normalizeUrl(c.url)).filter(Boolean))
    const hasNewChapters = remoteUrls.size > localUrls.size ||
      [...remoteUrls].some(u => !localUrls.has(u))

    let enriched = false, updated = false, newChapterCount = 0

    if (needsEnrich || hasNewChapters) {
      const category = detail.category || deriveCategoryFromTags(detail.tags, comic.tags)
      const finalTitle = detail.title?.trim() || comic.title
      await db.upsertComic({
        sourceUrl: comic.sourceUrl, title: finalTitle,
        cover: detail.cover || comic.cover, author: detail.author,
        status: detail.status, desc: detail.desc, tags: detail.tags,
        category, chapters: detail.chapters,
        updateTime: detail.updateTime || comic.updateTime
      })
      if (needsEnrich) enriched = true
      if (hasNewChapters) {
        updated = true
        newChapterCount = [...remoteUrls].filter(u => !localUrls.has(u)).length
      }
    }

    // ============ Bug 修复 (2026-08-17): 每轮 sync 后归零 + 以磁盘回填 ============
    // A) update_delta 归零(仅当本轮无新章节时): 之前只在"单章下载完成且完整"时
    //    resetUpdateDelta, 但常驻下载 worker 缺失会导致 sync 任务 waiting、reset
    //    不触发, 于是 delta 在多次 sync 间保留旧值 → 看上去"每天都有新增 134话"(重复计数)。
    //    修复: 本轮 sync 处理完该漫画后, 若没有发现新章节(hasNewChapters=false),
    //    说明 delta 是旧值/扫描残留, 直接归零; 若确有新章则保留 delta 交给下载
    //    worker 在下载完整后再归零(保持原语义, 不抹掉"待读新章"提示)。
    if (!hasNewChapters) {
      try { await db.resetUpdateDelta(comic.sourceUrl) } catch (_) {}
    }

    // B) image_count 以磁盘为准回填: 覆盖之前只写"源站应有数"导致的失真,
    //    让 DB 与磁盘一致, 既可用于"是否真下载"判断, 也避免 0 图章被无限当待补扫描。
    const localPath = comic.local_path || (comic.localPath)
    if (localPath) {
      try { await db.reconcileImageCounts(comic._id || comic.id, localPath) } catch (_) {}
    }

    return { enriched, updated, newChapterCount, detail, hasNewChapters, needsEnrich }
  }

  async function runBatch({ comics, fullSync, cancelled, onProgress, syncOneFn }) {
    const SYNC_CONCURRENCY = 3
    const SYNC_DELAY_MS = 2000

    let enriched = 0, updated = 0, failed = 0, skipped = 0, newChapters = 0

    for (let i = 0; i < comics.length; i += SYNC_CONCURRENCY) {
      if (cancelled()) return { enriched, updated, failed, skipped, newChapters, cancelled: true }

      const batch = comics.slice(i, i + SYNC_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map((comic, j) => syncOneFn(comic, i + j, { fullSync, cancelled, onProgress }))
      )

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          if (r.value.enriched) enriched++
          if (r.value.updated) updated++
          if (r.value.newChapterCount) newChapters += r.value.newChapterCount
          if (r.value.skipped) skipped++
        } else {
          failed++
        }
      }

      if (i + SYNC_CONCURRENCY < comics.length) {
        await _sleepWithCancel(SYNC_DELAY_MS + Math.random() * 1000, cancelled)
      }
    }

    return { enriched, updated, failed, skipped, newChapters, total: comics.length }
  }

  async function _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms / 1000}s)`)), ms)
      promise.then(
        (val) => { clearTimeout(timer); resolve(val) },
        (err) => { clearTimeout(timer); reject(err) }
      )
    })
  }

  return { gatherComics, syncOneComic, runBatch }
}

module.exports = { createSyncService }