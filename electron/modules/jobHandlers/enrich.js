'use strict'

const sources = require('../../sources/registry')
const db = require('../../db')
const { createEnrichService } = require('../../services/enrichService')

let _enrichService = null
function getEnrichService() {
  if (!_enrichService) {
    _enrichService = createEnrichService({ db, sources, jobQueue: null })
  }
  return _enrichService
}

async function jobHandlerAutoEnrich(job, onProgress) {
  const service = getEnrichService()
  const AUTO_ENRICH_BATCH = 20
  const comics = await db.getComicsWithMissingFields(AUTO_ENRICH_BATCH)
  const total = comics.length
  if (total === 0) return { enrichedCount: 0, totalCount: 0, msg: '所有漫画字段已完整' }

  let enrichedCount = 0
  const errors = []
  const BATCH_SIZE = 3
  const BATCH_DELAY_MIN = 2000
  const BATCH_DELAY_MAX = 3000

  for (let i = 0; i < total; i += BATCH_SIZE) {
    if (job.cancelled()) return { enrichedCount, totalCount: total, cancelled: true, errors }

    const batch = comics.slice(i, i + BATCH_SIZE)
    const promises = batch.map(async (comic, j) => {
      if (job.cancelled()) return
      try {
        if (j > 0) {
          const delay = j * 1000
          const start = Date.now()
          while (Date.now() - start < delay) {
            if (job.cancelled()) return
            await new Promise(r => setTimeout(r, Math.min(500, delay - (Date.now() - start))))
          }
        }
        const source = comic.sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
        await service.enrichComicMetadata(comic, source, job.cancelled)
        enrichedCount++
        onProgress({ current: i + j + 1, total, msg: comic.title })
      } catch (e) {
        errors.push({ title: comic.title, error: e.message })
      }
    })

    await Promise.all(promises)
    onProgress({ current: Math.min(i + BATCH_SIZE, total), total, msg: `已完成 ${Math.min(i + BATCH_SIZE, total)}/${total}` })

    if (i + BATCH_SIZE < total) {
      const delay = BATCH_DELAY_MIN + Math.random() * (BATCH_DELAY_MAX - BATCH_DELAY_MIN)
      const start = Date.now()
      while (Date.now() - start < delay) {
        if (job.cancelled()) break
        await new Promise(r => setTimeout(r, Math.min(500, delay - (Date.now() - start))))
      }
    }
  }

  return { enrichedCount, totalCount: total, errors: errors.length > 0 ? errors : undefined }
}

async function jobHandlerEnrichImageCounts(job, onProgress) {
  const service = getEnrichService()
  let processed = 0, updated = 0, totalImgUpdated = 0, totalNameUpdated = 0, failed = 0
  const BATCH_SIZE = 8
  const MAX_CHAPTERS_PER_COMIC = 10
  const source = sources.default

  while (true) {
    if (job.cancelled()) return { processed, updated, failed, totalImgUpdated, totalNameUpdated, msg: '已取消' }

    let comics = await db.getComicsNeedingImageCountUpdate(BATCH_SIZE)
    const hasImgCountMissing = comics && comics.length > 0
    if (!hasImgCountMissing) {
      comics = await db.getComicsNeedingChapterNameEnrichment(BATCH_SIZE)
    }
    if (!comics || comics.length === 0) {
      console.log('[章节增强] 没有更多需要处理的漫画')
      break
    }

    for (let c = 0; c < comics.length; c++) {
      if (job.cancelled()) break
      const comic = comics[c]
      console.log(`[章节增强] 处理: ${comic.title} (${comic.chapter_count} 章)`)

      try {
        let chaptersToFix = await db.getChaptersWithoutImageCount(comic._id)
        let usingImgCountList = true
        if (!chaptersToFix || chaptersToFix.length === 0) {
          if (comic.chapters && comic.chapters.length > 0) {
            chaptersToFix = comic.chapters.slice(0, MAX_CHAPTERS_PER_COMIC).map((ch, i) => ({
              index: ch.index !== undefined ? ch.index : i,
              name: ch.name || '',
              url: ch.url || ''
            })).filter(ch => ch.url)
            usingImgCountList = false
          }
        }
        if (!chaptersToFix || chaptersToFix.length === 0) {
          console.log(`  └─ 跳过：没有需要处理的章节`)
          try { await db.markComicChaptersEnriched(comic._id) } catch (e) {}
          processed++
          continue
        }
        const batch = chaptersToFix.slice(0, MAX_CHAPTERS_PER_COMIC)
        const { imageCountUpdates, chapterNameUpdates } = await service.enrichChapters(comic, batch, source, job.cancelled)

        if (imageCountUpdates.length > 0) {
          await db.updateChapterImageCounts(comic._id, imageCountUpdates)
          totalImgUpdated += imageCountUpdates.length
        }
        if (chapterNameUpdates.length > 0 && comic._id) {
          await db.updateChapterNames(comic._id, chapterNameUpdates)
          totalNameUpdated += chapterNameUpdates.length
        }
        if ((usingImgCountList && batch.length >= chaptersToFix.length) || (!usingImgCountList && batch.length > 0)) {
          try { await db.markComicChaptersEnriched(comic._id) } catch (e) {}
        }
        if (imageCountUpdates.length > 0 || chapterNameUpdates.length > 0) updated++
        processed++

        onProgress({
          current: processed,
          total: comics.length,
          title: comic.title,
          updatedCount: imageCountUpdates.length,
          nameUpdated: chapterNameUpdates.length,
          remaining: usingImgCountList ? Math.max(0, chaptersToFix.length - batch.length) : 0
        })
      } catch (e) {
        console.error(`[章节增强] 漫画失败 ${comic.title}:`, e.message)
        failed++
      }
    }

    if (comics.length < BATCH_SIZE) break
  }

  return { processed, updated, failed, totalImgUpdated, totalNameUpdated,
    msg: `完成，图片数更新 ${totalImgUpdated} 章，章节名升级 ${totalNameUpdated} 章` }
}

module.exports = { jobHandlerAutoEnrich, jobHandlerEnrichImageCounts }