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
  const untaggedLimit = fullSync ? 10000 : 50
  const imgCountLimit = fullSync ? 10000 : 10
  const missingFieldsLimit = fullSync ? 10000 : 30

  const batch = await db.getFavoritedForSyncBatch(favoritedLimit)
  const untagged = await db.getUntaggedComics(untaggedLimit)
  const needingImgCount = await db.getComicsNeedingImageCountUpdate(imgCountLimit)
  const missingFields = await db.getComicsWithMissingFields(missingFieldsLimit)

  const seen = new Set()
  const comics = []
  for (const c of [...(batch || []), ...(untagged || []), ...(needingImgCount || []), ...(missingFields || [])]) {
    const key = c.sourceUrl || c._id
    if (!seen.has(key)) {
      seen.add(key)
      comics.push(c)
    }
  }

  if (comics.length === 0) return { enriched: 0, updated: 0, msg: '没有需要同步的漫画' }

  let enriched = 0, updated = 0, failed = 0, skipped = 0, newChapters = 0

  // 单本同步调用的超时包装: 防止某本漫画 getDetail/getPageList 半截卡死(即使 _fetch 有 90s 超时,
  // enrichChapters 多章累加也可能无限拖延), 卡住就把这本标失败跳下一本, 不让整轮 sync 堆积到全局超时。
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 (${ms / 1000}s)`)), ms))
    ])

  async function syncOneComicInternal(comic, i) {
    try {
      if (job.cancelled()) return { cancelled: true }
    // 快速跳过：非收藏漫画且字段完整且 1 小时内已同步过
    const SKIP_THRESHOLD_MS = 60 * 60 * 1000 // 1 小时
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

    const source = comic.sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
    const detail = await withTimeout(source.getDetail(comic.sourceUrl), 60 * 1000, 'getDetail')

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
        }
      } // end if (needsEnrich || hasNewChapters)

      // 自动下载补齐: 收藏漫画 + 有源站章节 即触发磁盘缺失章节的自动补齐下载。
      // 独立于 hasNewChapters(否则DB章节与源站同步后永远为false, 缺章漫画永不被下载)。
      if (comic.favorited && detail.chapters) {
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
            if (chUrl) {
              if (seenThisRun.has(chUrl)) continue
              seenThisRun.add(chUrl)
            }
            if (comicDir) {
              // 用磁盘实际文件判断"已下载", 而非DB章节URL集合(已与源站同步, 永远相等)
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
          const { imageCountUpdates, chapterNameUpdates } = await withTimeout(
            enrichChapters(comic, chaptersToCheck, source),
            60 * 1000,
            'enrichChapters'
          )
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
      throw e
    }
  }

  async function syncOneComic(comic, i) {
    if (job.cancelled()) return { cancelled: true }
    let lastError = null
    const MAX_RETRIES = 3
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await syncOneComicInternal(comic, i)
      } catch (e) {
        lastError = e
        const msg = e.message || ''
        const isRetryable = msg.includes('timeout') || msg.includes('ECONNRESET')
          || msg.includes('ERR_CONNECTION_RESET') || msg.includes('ENOTFOUND')
          || msg.includes('EAI_AGAIN') || msg.includes('body timeout')
        if (isRetryable && attempt < MAX_RETRIES - 1) {
          const backoffMs = 3000 * (attempt + 1) + Math.random() * 2000
          console.log(`[Sync] ${comic.title} 第 ${attempt + 1} 次尝试失败，${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          await new Promise(r => setTimeout(r, backoffMs))
        } else {
          break
        }
      }
    }
    failed++
    onProgress({ current: i + 1, total: comics.length, error: lastError.message })
    return { success: false, error: lastError.message }
  }

  const SYNC_CONCURRENCY = 3
  const SYNC_DELAY_MS = 2000
  for (let i = 0; i < comics.length; i += SYNC_CONCURRENCY) {
    if (job.cancelled()) return { enriched, updated, failed, skipped, newChapters, msg: '已取消' }
    const batch = comics.slice(i, i + SYNC_CONCURRENCY)
    await Promise.allSettled(batch.map((comic, j) => syncOneComic(comic, i + j)))
    if (i + SYNC_CONCURRENCY < comics.length) {
      await new Promise(r => setTimeout(r, SYNC_DELAY_MS + Math.random() * 1000))
    }
  }
  return { enriched, updated, failed, skipped, newChapters, total: comics.length }
}

module.exports = { jobHandlerSync }