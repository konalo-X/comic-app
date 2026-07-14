'use strict'

const path = require('path')
const fs = require('fs')
const sources = require('../../sources/registry')
const db = require('../../db')
const { sanitizeFilename: sanitize } = require('../../utils')
const {
  findComicDir, resolveUniqueComicDir, getPrimaryDownloadRoot,
  findChapterDir, getValidChapterImages, getValidChapterImagesCached,
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
    // getDetail 包装超时: 单次 _fetch 本身 90s(TIMEOUT), 旧值 60s 会在一次请求还没跑完就提前中断,
    // 导致源站慢时大批漫画被误判超时。提到 150s: 允许一次完整 90s 请求 + 一次快重试。
    const detail = await withTimeout(source.getDetail(comic.sourceUrl), 150 * 1000, 'getDetail')

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
          const jobQueue = getJobQueue()
          // 源站应有多少图: 从 db chapters.image_count 取(对齐 sort_order=idx)
          // 无 image_count 的章无法精确判断完整性, 宁可多读盘也不误标 success
          // 注意: 必须用 jobQueue.db (底层 better-sqlite3 句柄), db 业务模块无 .prepare
          const expectedByIndex = new Map()
          try {
            if (comic._id && jobQueue?.db) {
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
              // 一级快筛: 优先用 download_records 的 per-chapter 成功标记判断已下载,
              // 命中则跳过磁盘 sharp 校验(99%的章已完整, 避免每本每章每图都读盘)
              // comic_id 存的是 sourceUrl (见 download.js 落库)
              let dbRecord = null
              try {
                const recs = await db.getDownloadRecords({ comicId: comic.sourceUrl, chapterIndex: idx })
                dbRecord = recs.find(r => r.status === 'success' && (r.imagesCount || 0) > 0)
              } catch (_) {}
              if (dbRecord) {
                // 信任条件: 记录的张数必须 == 源站应有张数(若有 image_count), 否则重新校验磁盘
                // 防止历史脏数据(旧逻辑把"磁盘有多少记多少")永久掩盖缺图
                const trustedExp = expectedByIndex.get(idx) || 0
                if (trustedExp > 0 && dbRecord.imagesCount === trustedExp) {
                  continue
                }
                // 无 image_count 或张数不符: 落到磁盘实际文件校验(防损坏/缺图/脏数据)
              }
              // 快筛未命中(无记录/记录失败)才落到磁盘实际文件判断"已下载"
              const existingChDir = findChapterDir(comicDir, idx, ch.name)
              if (existingChDir) {
                // 二级校验: 用 per-image sharp 缓存, 仅新增/修改/损坏的图才真 sharp;
                // 命中缓存的图(曾 sharp 过 OK 且未变)不再解析图头。
                // 主人要求: success 必须建立在「不缺图 且 每张都真 sharp 过 OK」之上。
                const { validFiles, allVerified } = await getValidChapterImagesCached(existingChDir)
                const expected = expectedByIndex.get(idx) || 0
                if (validFiles.length > 0) {
                  // 完整性判定(满足主人要求: 不缺图 且 每张都正常):
                  // - 有 image_count: 磁盘有效图数必须 == 应有多少图
                  // - 无 image_count: 无法确认完整, 不标 success(下次仍校验, 但不会被永久遗漏)
                  // - allVerified: 每张图都必须真做过 sharp 校验且 OK(不能只靠数量推断)
                  const countOk = expected > 0 ? (validFiles.length === expected) : false
                  const isComplete = countOk && allVerified
                  if (process.env.COMIC_DEBUG_SYNC) console.log(`[DBG] ${comic.title} idx=${idx} '${ch.name}' valid=${validFiles.length} expected=${expected} allVerified=${allVerified} isComplete=${isComplete}`)
                  if (isComplete) {
                    // 懒补全: 读盘确认完整后补写 download_records,
                    // 下次 sync 快筛即可命中跳过, 不再逐图读盘(本地导入漫画无记录故需此步)
                    try {
                      await db.saveDownloadRecord({
                        comicId: comic.sourceUrl,
                        comicTitle: comic.title || detail.title || '',
                        chapterIndex: idx,
                        chapterName: ch.name,
                        imagesCount: validFiles.length,
                        path: existingChDir
                      })
                    } catch (_) {}
                    continue
                  }
                  // validFiles>0 但不完整(缺图/损坏): 不标 success, 落到下方补下载
                }
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
          // enrichChapters 串行循环, 每章 getPageList 最多 90s + 250ms 间隔。
          // 固定 240s 盖不住多章慢源(10章最坏 900s), 改为按章数动态: 每章 100s + 下限 240s。
          const enrichTimeoutMs = Math.max(240, chaptersToCheck.length * 100) * 1000
          const { imageCountUpdates, chapterNameUpdates } = await withTimeout(
            enrichChapters(comic, chaptersToCheck, source),
            enrichTimeoutMs,
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
      // 单本漫画同步失败(某章 getDetail/校验/IO 异常)不应拖垮整轮 sync:
      // 记日志并标记该本失败, 让其进入重试池, 但继续处理后续漫画。
      console.warn(`[Sync] 漫画《${comic.title || comic.sourceUrl}》单本同步异常, 标记失败继续: ${e.message}`)
      try { await db.markSyncFailed([comic._id]) } catch (_) {}
      return { success: false, error: e.message }
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