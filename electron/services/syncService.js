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