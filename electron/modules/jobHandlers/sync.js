'use strict'

const path = require('path')
const fs = require('fs')
const sources = require('../../sources/registry')
const db = require('../../db')
const { sanitizeFilename: sanitize } = require('../../utils')
const {
  findComicDir, resolveUniqueComicDir, getPrimaryDownloadRoot,
  findChapterDir, getValidChapterImages,
  normalizeUrl
} = require('../downloadPaths')
const { deriveCategoryFromTags, enrichChapters, addSyncJob, getJobQueue } = require('./helpers')

async function jobHandlerSync(job, onProgress) {
  const fullSync = job.payload?.fullSync === true
  const favoritedLimit = fullSync ? 10000 : 100
  const untaggedLimit = fullSync ? 10000 : 20
  const imgCountLimit = fullSync ? 10000 : 10

  const batch = await db.getFavoritedForSyncBatch(favoritedLimit)
  const untagged = await db.getUntaggedComics(untaggedLimit)
  const needingImgCount = await db.getComicsNeedingImageCountUpdate(imgCountLimit)

  const seen = new Set()
  const comics = []
  for (const c of [...(batch || []), ...(untagged || []), ...(needingImgCount || [])]) {
    const key = c.sourceUrl || c._id
    if (!seen.has(key)) {
      seen.add(key)
      comics.push(c)
    }
  }

  if (comics.length === 0) return { enriched: 0, updated: 0, msg: '没有需要同步的漫画' }

  let enriched = 0, updated = 0, failed = 0, newChapters = 0

  async function syncOneComic(comic, i) {
    if (job.cancelled()) return { cancelled: true }
    try {
      const source = comic.sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
      const detail = await source.getDetail(comic.sourceUrl)

      const needsEnrich = !comic.tags || comic.tags.length === 0
        || !comic.status || !comic.desc || !comic.category
      const localUrls = new Set((comic.chapters || []).map(c => normalizeUrl(c.url)).filter(Boolean))
      const remoteUrls = new Set((detail.chapters || []).map(c => normalizeUrl(c.url)).filter(Boolean))
      const hasNewChapters = remoteUrls.size > localUrls.size ||
        [...remoteUrls].some(u => !localUrls.has(u))

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
        if (needsEnrich) enriched++
        if (hasNewChapters) {
          updated++
          newChapters += [...remoteUrls].filter(u => !localUrls.has(u)).length
          if (comic.favorited && detail.chapters) {
            const alreadyDownloadedUrls = new Set(
              (comic.chapters || [])
                .map(c => normalizeUrl(c.url))
                .filter(Boolean)
            )
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
            } else if (resolvedComicDir !== resolvedRoot) {
              const seenThisRun = new Set()
              const payloads = []
              const jobQueue = getJobQueue()
              for (let idx = 0; idx < detail.chapters.length; idx++) {
                const ch = detail.chapters[idx]
                const chUrl = normalizeUrl(ch.url)
                if (chUrl && alreadyDownloadedUrls.has(chUrl)) continue
                if (chUrl) {
                  if (seenThisRun.has(chUrl)) continue
                  seenThisRun.add(chUrl)
                }
                if (comicDir) {
                  const existingChDir = findChapterDir(comicDir, idx, ch.name)
                  if (existingChDir) {
                    const validFiles = await getValidChapterImages(existingChDir)
                    if (validFiles.length > 0) continue
                  }
                }
                let dedupTitle = (comic.title || detail.title || '').trim()
                if (!dedupTitle) {
                  if (comic.sourceUrl) {
                    try {
                      const url = new URL(comic.sourceUrl)
                      const pathParts = url.pathname.split('/').filter(Boolean)
                      const lastPart = pathParts[pathParts.length - 1]
                      if (lastPart) {
                        dedupTitle = lastPart.replace(/\.html?$/, '').replace(/[-_]/g, ' ')
                      }
                    } catch (_) {}
                  }
                  if (!dedupTitle) {
                    console.warn(`[Sync] 跳过无标题漫画的自动下载: sourceUrl=${comic.sourceUrl}, chapter=${ch.name || idx}`)
                    continue
                  }
                }
                if (!dedupTitle || dedupTitle === '未命名漫画') {
                  console.warn(`[Sync] 跳过未命名漫画的自动下载: sourceUrl=${comic.sourceUrl}`)
                  continue
                }
                const dup = jobQueue.db.prepare(
                  `SELECT id FROM job_queue WHERE type='downloadChapter' AND status IN ('waiting','running','active')
                   AND json_extract(payload, '$.comicTitle') = ? AND json_extract(payload, '$.chapter.index') = ?`
                ).get(dedupTitle, idx)
                if (dup) continue
                payloads.push({
                  comicTitle: dedupTitle,
                  chapter: { index: idx, name: ch.name || `第${idx + 1}章`, url: ch.url },
                  referer: comic.sourceUrl,
                  sourceUrl: comic.sourceUrl,
                  coverUrl: detail.cover || comic.cover,
                  comicDir
                })
              }
              if (payloads.length > 0) {
                jobQueue.addBatch('downloadChapter', payloads, { priority: 2, maxRetries: 3 })
                console.log(`[Sync] 《${comic.title}》新增 ${payloads.length} 章，已加入自动下载队列（按URL去重）`)
              }
            }
          }
        }
        } // end if (needsEnrich || hasNewChapters)

      if (comic._id) {
        try {
          const MAX_CHAPTERS_PER_UPDATE = 10
          let chaptersToCheck = []
          const missing = await db.getChaptersWithoutImageCount(comic._id)
          if (missing && missing.length > 0) {
            chaptersToCheck = missing.slice(0, MAX_CHAPTERS_PER_UPDATE)
          }
          if (chaptersToCheck.length === 0) {
            chaptersToCheck = (detail.chapters || []).slice(0, 3)
              .map((ch, i) => ({ index: i, name: ch.name, url: ch.url }))
          }
          const { imageCountUpdates, chapterNameUpdates } = await enrichChapters(comic, chaptersToCheck, source)
          if (imageCountUpdates.length > 0) {
            await db.updateChapterImageCounts(comic._id, imageCountUpdates)
          }
          if (chapterNameUpdates.length > 0) {
            await db.updateChapterNames(comic._id, chapterNameUpdates)
          }
        } catch (e) {
          console.warn(`[Sync] 获取 ${comic.title} 章节信息失败:`, e.message)
        }
      }

      onProgress({ current: i + 1, total: comics.length, title: detail.title || comic.title })
      if (comic._id) {
        try { await db.markSynced([comic._id]) } catch (e) { console.warn('[Sync] markSynced 失败:', e.message) }
      }
      return { success: true }
    } catch (e) {
      failed++
      onProgress({ current: i + 1, total: comics.length, error: e.message })
      return { success: false, error: e.message }
    }
  }

  const SYNC_CONCURRENCY = 3
  const SYNC_DELAY_MS = 2000
  for (let i = 0; i < comics.length; i += SYNC_CONCURRENCY) {
    if (job.cancelled()) return { enriched, updated, failed, newChapters, msg: '已取消' }
    const batch = comics.slice(i, i + SYNC_CONCURRENCY)
    await Promise.allSettled(batch.map((comic, j) => syncOneComic(comic, i + j)))
    if (i + SYNC_CONCURRENCY < comics.length) {
      await new Promise(r => setTimeout(r, SYNC_DELAY_MS + Math.random() * 1000))
    }
  }
  return { enriched, updated, failed, newChapters, total: comics.length }
}

module.exports = { jobHandlerSync }