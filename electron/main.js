'use strict'
const { app, BrowserWindow, ipcMain, powerMonitor, protocol } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const url = require('url')
const sharp = require('sharp')

const crypto = require('crypto')
const sources = require('./sources/registry')
const JobQueue = require('./jobqueue')
const db = require('./db')
const exporter = require('./exporter')
const cache = require('./cache')
const { sanitizeFilename: sanitize, normalizeName, escapeLike } = require('./utils')

const isDev = process.env.NODE_ENV === 'development'

// ============ 图片代理服务器（处理防盗链 + 缓存）============
const PROXY_PORT = 48123
const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`

function getProxyImageUrl(imageUrl, refererUrl) {
  const encodedUrl = Buffer.from(imageUrl || '').toString('base64')
  const encodedRef = Buffer.from(refererUrl || '').toString('base64')
  return `${PROXY_BASE}/img?u=${encodeURIComponent(encodedUrl)}&r=${encodeURIComponent(encodedRef)}`
}

function getLocalProxyUrl(filePath) {
  if (!filePath) return ''
  const cleanPath = String(filePath).replace(/^file:\/\//, '')
  const encoded = Buffer.from(cleanPath).toString('base64')
  return `${PROXY_BASE}/local?p=${encodeURIComponent(encoded)}`
}

const inflightRequests = new Map() // url -> Promise<Buffer>

async function fetchAndCacheImage(imageUrl, refererUrl) {
  // 命中缓存
  const cached = cache.getCachedPath(imageUrl)
  if (cached) {
    return fs.promises.readFile(cached)
  }

  // 去重：同一 URL 正在请求的，共享同一个 Promise
  if (inflightRequests.has(imageUrl)) {
    return inflightRequests.get(imageUrl)
  }

  const src = imageUrl.includes('smtt6') ? sources.get('smtt6') : sources.default
  const p = (async () => {
    try {
      const buf = await src.fetchImage(imageUrl, refererUrl || imageUrl)
      if (buf && buf.length > 0) {
        await cache.setCache(imageUrl, buf)
      }
      return buf
    } finally {
      inflightRequests.delete(imageUrl)
    }
  })()
  inflightRequests.set(imageUrl, p)
  return p
}

function startImageProxyServer() {
  // 占位图 SVG（图片加载失败时返回）
  const placeholderSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
    '<rect fill="#222" width="800" height="600"/>' +
    '<text fill="#666" font-family="sans-serif" font-size="24" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">图片加载失败</text>' +
    '</svg>'
  )

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new url.URL(req.url, PROXY_BASE)

      // 健康检查
      if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
        return
      }

      // 本地文件代理（用于 Vue 前端加载磁盘图片，因为浏览器不允许 http 页面加载 file:// 资源）
      if (parsed.pathname === '/local') {
        const pB64 = decodeURIComponent(parsed.searchParams.get('p') || '')
        const localPath = pB64 ? Buffer.from(pB64, 'base64').toString('utf-8') : ''
        if (!localPath || !fs.existsSync(localPath)) {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
          return
        }
        const ext = path.extname(localPath).toLowerCase()
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' :
                   ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' :
                   ext === '.avif' ? 'image/avif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
        try {
          const stat = fs.statSync(localPath)
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=31536000',
            'X-Source': 'local'
          })
          fs.createReadStream(localPath).pipe(res)
        } catch (e) {
          console.warn(`[Proxy] 读取本地文件失败: ${localPath} -> ${e.message}`)
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
        }
        return
      }

      if (parsed.pathname !== '/img') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const uB64 = decodeURIComponent(parsed.searchParams.get('u') || '')
      const rB64 = decodeURIComponent(parsed.searchParams.get('r') || '')
      const imageUrl = uB64 ? Buffer.from(uB64, 'base64').toString('utf-8') : ''
      const refererUrl = rB64 ? Buffer.from(rB64, 'base64').toString('utf-8') : ''

      if (!imageUrl) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(placeholderSvg)
        return
      }

      // 检查本地缓存（优先）
      const cachedPath = cache.getCachedPath(imageUrl)
      if (cachedPath) {
        const ext = path.extname(imageUrl).toLowerCase().replace(/\?.*/, '') || '.jpg'
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg'
        try {
          const stat = fs.statSync(cachedPath)
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=31536000',
            'X-Cache': 'HIT'
          })
          fs.createReadStream(cachedPath).pipe(res)
          return
        } catch (e) {
          console.warn(`[Proxy] 读取缓存文件失败: ${imageUrl} -> ${e.message}`)
        }
      }

      // 未缓存 → 即时下载并返回
      try {
        const buf = await fetchAndCacheImage(imageUrl, refererUrl)
        if (!buf || buf.length === 0) {
          console.warn(`[Proxy] 图片为空: ${imageUrl}`)
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
          return
        }

        // 根据实际内容设置 Content-Type
        let ct = 'image/jpeg'
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) ct = 'image/png'
        else if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg'
        else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ct = 'image/gif'
        else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf.toString('utf-8', 8, 12) === 'WEBP') ct = 'image/webp'

        console.log(`[Proxy] 图片缓存: ${imageUrl} (${(buf.length/1024).toFixed(1)}KB)`)
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000',
          'X-Cache': 'MISS'
        })
        res.end(buf)
        return
      } catch (e) {
        console.warn(`[Proxy] 图片缓存失败: ${imageUrl} -> ${e.message}`)
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(placeholderSvg)
        return
      }
    } catch (e) {
      console.warn('[Proxy] 请求异常:', req.url, e.message)
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      res.end(placeholderSvg)
    }
  })

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[Proxy] 端口 ${PROXY_PORT} 被占用，尝试下一个...`)
    } else {
      console.warn('[Proxy] 服务器错误:', e.message)
    }
  })

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[Proxy] 图片代理运行在 ${PROXY_BASE}`)
  })
}

// ============ 省电策略 ============
function isBatteryMode() {
  try {
    const status = powerMonitor.getSystemBatteryState()
    return status ? !status.powerSource || status.charging === false : false
  } catch { return false }
}
function isQuietHours() {
  const h = new Date().getHours()
  return h >= 23 || h < 8
}

// ============ 持久作业队列 ============
var jobQueue = null

// 从标签列表中推导出分类
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

async function jobHandlerSync(job, onProgress) {
  // #1 修复：增量同步覆盖全盘书架漫画（轮转），而非只扫最近 20 本
  // 用 getFavoritedForSyncBatch 按 last_sync_at 升序取最久未同步的 favorited 书
  const batch = await db.getFavoritedForSyncBatch(100)
  const untagged = await db.getUntaggedComics(20)
  const needingImgCount = await db.getComicsNeedingImageCountUpdate(10)

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
        await db.upsertComic({
          sourceUrl: comic.sourceUrl, title: comic.title || detail.title,
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
            const comicDir = findComicDir(detail.title || comic.title, comic.sourceUrl)
            const seenThisRun = new Set()
            const payloads = []
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
                  const files = listChapterImages(existingChDir)
                  if (files.length > 0) continue
                }
              }
              const dedupTitle = comic.title || detail.title
              const dup = jobQueue.db.prepare(
                `SELECT id FROM job_queue WHERE type='downloadChapter' AND status IN ('waiting','running')
                 AND payload LIKE ? AND payload LIKE ?`
              ).get(`%"comicTitle":"${escapeLike(dedupTitle.replace(/"/g, '\\"'))}"%`, `%"index":${idx}%`)
              if (dup) continue
              payloads.push({
                comicTitle: dedupTitle,
                chapter: { index: idx, name: ch.name, url: ch.url },
                referer: comic.sourceUrl,
                sourceUrl: comic.sourceUrl,
                coverUrl: detail.cover || comic.cover
              })
            }
            if (payloads.length > 0) {
              jobQueue.addBatch('downloadChapter', payloads, { priority: 1, maxRetries: 3 })
              console.log(`[Sync] 《${comic.title}》新增 ${payloads.length} 章，已加入自动下载队列（按URL去重）`)
            }
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

async function jobHandlerCrawlAll(job, onProgress) {
  const source = sources.default
  let pageNum = 0, totalSaved = 0, totalNew = 0, totalSkipped = 0, totalFailedPages = 0
  let consecutiveEmpty = 0
  const MAX_EMPTY_PAGES = 3
  const MAX_RETRY_PER_PAGE = 5
  const PAGE_DELAY_MIN = 3000
  const PAGE_DELAY_MAX = 6000
  const startUrl = job.payload?.startUrl || `${source.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/1`
  console.log('[crawl] jobHandlerCrawlAll started, startUrl=', startUrl)
  onProgress({ page: 0, total: 0, msg: '初始化爬虫...' })

  // 预热连接（带超时，不阻塞）
  onProgress({ page: 0, total: 0, msg: '正在连接服务器...' })
  try {
    await Promise.race([
      source.search('', 1),
      new Promise((_, reject) => setTimeout(() => reject(new Error('预热超时')), 30000))
    ])
    onProgress({ page: 0, total: 0, msg: '连接成功，开始爬取...' })
  } catch (e) {
    console.warn('[crawl] 预热失败（继续爬取）:', e.message)
    onProgress({ page: 0, total: 0, msg: '服务器响应较慢，继续爬取...' })
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

  while (pageNum < 150) {
    if (job.cancelled()) return { total: totalSaved, pages: pageNum, failed: totalFailedPages, msg: '已取消' }
    pageNum++
    onProgress({ page: pageNum, total: totalSaved, msg: `正在爬取第 ${pageNum} 页...` })

    let items = []
    let pageSuccess = false
    let lastError = null

    for (let retry = 0; retry < MAX_RETRY_PER_PAGE; retry++) {
      if (job.cancelled()) break
      try {
        items = await source.getPopular(pageNum)
        pageSuccess = true
        break
      } catch (e) {
        lastError = e
        const isConnReset = e.message?.includes('ECONNRESET')
        console.warn(`[crawl] 第 ${pageNum} 页第 ${retry + 1} 次尝试失败:`, e.message)
        if (retry < MAX_RETRY_PER_PAGE - 1) {
          // ECONNRESET 增加更长等待
          const waitMs = isConnReset
            ? (retry + 1) * 5000 + Math.random() * 3000
            : (retry + 1) * 2000 + Math.random() * 1000
          console.log(`[crawl] 等待 ${Math.round(waitMs / 1000)} 秒后重试...`)
          await sleep(waitMs)
        }
      }
    }

    if (!pageSuccess) {
      totalFailedPages++
      console.error(`[crawl] 第 ${pageNum} 页失败（已重试 ${MAX_RETRY_PER_PAGE} 次）:`, lastError?.message)
      onProgress({
        page: pageNum, total: totalSaved,
        msg: `第 ${pageNum} 页失败，跳过（已累计失败 ${totalFailedPages} 页）`
      })
      if (totalFailedPages >= 10) {
        console.warn('[crawl] 连续失败页数过多，停止爬取')
        break
      }
      await sleep(PAGE_DELAY_MIN + Math.random() * (PAGE_DELAY_MAX - PAGE_DELAY_MIN))
      continue
    }

    if (items.length > 0) {
      consecutiveEmpty = 0
      const sourceUrls = items.map(i => i.sourceUrl)
      const existingUrls = await db.getExistingSourceUrls(sourceUrls)
      const newItems = items.filter(item => !existingUrls.has(item.sourceUrl))
      const existingItems = items.filter(item => existingUrls.has(item.sourceUrl))
      const skippedItems = existingItems.length
      totalSkipped += skippedItems
      if (newItems.length > 0) {
        const saved = await db.upsertComics(newItems)
        totalSaved += saved.length
        totalNew += newItems.length
      }
      // 更新已有漫画的封面、分类、标题（不覆盖章节数据）
      if (existingItems.length > 0) {
        const updatedMeta = await db.updateComicListMeta(existingItems)
        console.log(`[crawl] 第 ${pageNum} 页：更新 ${updatedMeta} 部已有漫画元数据`)
      }
      onProgress({
        page: pageNum, total: totalSaved,
        msg: `第 ${pageNum} 页：新增 ${newItems.length} 部，跳过 ${skippedItems} 部（累计新增 ${totalNew}）`
      })
    } else {
      consecutiveEmpty++
      console.log(`[crawl] 第 ${pageNum} 页返回 0 条（连续空页 ${consecutiveEmpty}/${MAX_EMPTY_PAGES}）`)
      if (consecutiveEmpty >= MAX_EMPTY_PAGES) {
        console.log('[crawl] 连续空页达到阈值，认为已爬完')
        onProgress({ page: pageNum, total: totalSaved, msg: `已爬完所有可用页面（连续 ${MAX_EMPTY_PAGES} 页为空）` })
        break
      }
      onProgress({
        page: pageNum, total: totalSaved,
        msg: `第 ${pageNum} 页为空（连续 ${consecutiveEmpty}/${MAX_EMPTY_PAGES}），继续尝试...`
      })
    }

    await sleep(PAGE_DELAY_MIN + Math.random() * (PAGE_DELAY_MAX - PAGE_DELAY_MIN))
  }
  console.log('[crawl] finished, pages=', pageNum, 'totalNew=', totalNew, 'skipped=', totalSkipped, 'failedPages=', totalFailedPages)
  return { total: totalSaved, pages: pageNum, skipped: totalSkipped, failed: totalFailedPages, msg: `新增 ${totalNew} 部，跳过 ${totalSkipped} 部，失败 ${totalFailedPages} 页` }
}

async function jobHandlerAutoEnrich(job, onProgress) {
  const result = await jobQueue.add('sync', {}, { priority: 2, maxRetries: 3 })
  return { jobId: result, status: 'dispatched' }
}

/**
 * 统一的「章节增强」函数：一次爬取章节页，同时提取 image_count 和 h2 章节名
 * 避免三个任务对同一个章节页面重复爬取
 * @param {Object} comic 漫画对象（需要 _id, sourceUrl）
 * @param {Array} chaptersToEnrich [{index, name, url}]
 * @param {Object} source 漫画源
 * @returns {Object} { imageCountUpdates: [{url, image_count}], chapterNameUpdates: [{index, name}] }
 */
async function enrichChapters(comic, chaptersToEnrich, source) {
  const imageCountUpdates = []
  const chapterNameUpdates = []
  for (let j = 0; j < chaptersToEnrich.length; j++) {
    try {
      const pageList = await source.getPageList(chaptersToEnrich[j].url, comic.sourceUrl)
      const images = Array.isArray(pageList) ? pageList : (pageList.images || [])
      const h2Name = (!Array.isArray(pageList) && pageList.chapterName) ? pageList.chapterName : ''

      // 1. 图片数
      if (chaptersToEnrich[j].url) {
        imageCountUpdates.push({ url: chaptersToEnrich[j].url, image_count: images.length })
      }
      // 2. h2 章节名（仅当与现有名不同时记录）
      if (h2Name && h2Name.trim() && h2Name.trim() !== chaptersToEnrich[j].name) {
        chapterNameUpdates.push({ index: chaptersToEnrich[j].index, name: h2Name.trim() })
      }
      await new Promise(r => setTimeout(r, 250))
    } catch (chE) {
      // 单章失败不影响整体
    }
  }
  return { imageCountUpdates, chapterNameUpdates }
}

/** 统一的「章节增强」后台任务：渐进式补全 image_count 和升级 h2 章节名
 *  - 找出 image_count = 0 的章节
 *  - 一次爬取同时拿到：图片数 + h2 章节名
 *  - 批量写入数据库，不再分任务重复请求同一页面
 */
async function jobHandlerEnrichImageCounts(job, onProgress) {
  let processed = 0, updated = 0, totalImgUpdated = 0, totalNameUpdated = 0, failed = 0
  const BATCH_SIZE = 8
  const MAX_CHAPTERS_PER_COMIC = 10
  const source = sources.default

  while (true) {
    if (job.cancelled()) return { processed, updated, failed, totalImgUpdated, totalNameUpdated, msg: '已取消' }

    // 优先选「有 image_count = 0 章节」的漫画；如果没有，再选「章节名未升级」的漫画
    let comics = await db.getComicsNeedingImageCountUpdate(BATCH_SIZE)
    const hasImgCountMissing = comics && comics.length > 0
    if (!hasImgCountMissing) {
      // 没有图片数缺失，但可能有章节名未升级的漫画
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
        // 情况 1：有 image_count = 0 的章节 → 补全它们
        // 情况 2：没有缺失，但章节名未升级 → 补前 MAX_CHAPTERS_PER_COMIC 章的章节名
        let chaptersToFix = await db.getChaptersWithoutImageCount(comic._id)
        let usingImgCountList = true
        if (!chaptersToFix || chaptersToFix.length === 0) {
          // 没有 image_count = 0，但可能章节名未升级 → 取前 N 章
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
        const { imageCountUpdates, chapterNameUpdates } = await enrichChapters(comic, batch, source)

        if (imageCountUpdates.length > 0) {
          await db.updateChapterImageCounts(comic._id, imageCountUpdates)
          totalImgUpdated += imageCountUpdates.length
        }
        if (chapterNameUpdates.length > 0 && comic._id) {
          await db.updateChapterNames(comic._id, chapterNameUpdates)
          totalNameUpdated += chapterNameUpdates.length
        }
        // 条件：要么是「补全 image_count 列表」且已补完；要么是「补章节名」且处理了前 N 章
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

/** 离线下载章节 — 持久队列版本 */
async function jobHandlerDownloadChapter(job, onProgress) {
  const { comicTitle, chapter, referer, sourceUrl, coverUrl } = job.payload
  // 优先使用外部磁盘，且如果漫画目录已在任何路径存在就复用
  let comicDir = findComicDir(comicTitle, sourceUrl)
  if (!comicDir) {
    const preferred = path.join(getPrimaryDownloadRoot(), sanitize(comicTitle))
    comicDir = resolveUniqueComicDir(preferred, sourceUrl)
  }
  // 安全检查：如果磁盘未挂载，不要创建本地目录
  const downloadRoot = getPrimaryDownloadRoot()
  if (downloadRoot.startsWith('/Volumes/') && !fs.existsSync(downloadRoot)) {
    throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
  }
  if (!fs.existsSync(comicDir)) fs.mkdirSync(comicDir, { recursive: true })

  // 保存封面（一次性，第一次下载时）
  if (coverUrl && !fs.existsSync(path.join(comicDir, 'cover.webp'))) {
    try {
      const buf = await downloadBuf(coverUrl, sourceUrl || referer)
      await sharp(buf).webp({ quality: 85 }).toFile(path.join(comicDir, 'cover.webp'))
    } catch (e) {
      console.warn(`[下载] 封面保存失败: ${e.message}`)
    }
  }

  // ---------- 防御性校验：章节名是否过于简单（第N话/第N章） ----------
  // 防止因章节名错误导致下载到错误目录
  let actualChapterName = chapter.name
  if (db.isChapterNameGeneric?.(actualChapterName)) {
    console.warn(`[下载] 章节名过于简单 (${actualChapterName})，重新爬取详情页`)
    try {
      const source = sources.get('smtt6') || sources.default
      const detail = await source.getDetail(sourceUrl)
      if (detail.chapters && detail.chapters[chapter.index]) {
        actualChapterName = detail.chapters[chapter.index].name
        console.log(`[下载] 已校正章节名: ${actualChapterName}`)
      }
    } catch (e) {
      console.warn(`[下载] 重新爬取详情页失败: ${e.message}`)
    }
  }

  // ---------- 增强版「已下载检测」：优先扫描磁盘文件 ----------
  const chDirOnDisk = findChapterDir(comicDir, chapter.index, actualChapterName)
  if (chDirOnDisk) {
    const files = listChapterImages(chDirOnDisk)
    if (files.length > 0) {
      console.log(`[下载] 检测到已存在章节（磁盘扫描）: ${comicTitle} › ${actualChapterName} (${files.length} 图)`)
      onProgress({ chapterIdx: chapter.index, current: 0, total: 0, downloaded: 0, done: true, skipped: true })
      // 顺便把记录补回数据库，避免下次重复检测
      try {
        await db.saveDownloadRecord({
          comicId: sourceUrl || comicTitle,
          comicTitle,
          chapterIndex: chapter.index,
          chapterName: actualChapterName,
          imagesCount: files.length,
          path: chDirOnDisk
        })
      } catch (_) {}
      return { success: true, skipped: true, chapter: actualChapterName, chapterDir: chDirOnDisk }
    }
  }
  // 其次走数据库记录（精准查询，避免全表扫描）
  const existingRecords = await db.getDownloadRecords({ comicId: sourceUrl || comicTitle, chapterIndex: chapter.index })
  const already = existingRecords.find(r =>
    (r.comicId === sourceUrl || r.comicId === comicTitle) && r.chapterIndex === chapter.index
  )
  if (already && already.path && fs.existsSync(already.path)) {
    const files = listChapterImages(already.path)
    if (files.length > 0) {
      console.log(`[下载] 跳过已下载章节（DB记录）: ${comicTitle} › ${chapter.name} (${files.length} 图)`)
      onProgress({ chapterIdx: chapter.index, current: 0, total: 0, downloaded: 0, done: true, skipped: true })
      return { success: true, skipped: true, chapter: chapter.name }
    }
  }
  const src = sources.default
  try {
    const pageList = await src.getPageList(chapter.url, referer || sourceUrl)
    const images = Array.isArray(pageList) ? pageList : pageList.images
    // 章节名唯一来源：<h2> 标签，不使用任何兜底值
    const chapterName = Array.isArray(pageList) ? '' : (pageList.chapterName || '')
    if (!images?.length) throw new Error('无图片')
    const folder = sanitize(`${chapter.index + 1}-${chapterName}`)
    const chDir = path.join(comicDir, folder)
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true })

    // 并发下载图片（单章内 5 张并发），按顺序写入磁盘
    const imageConcurrency = 5
    const imageBuffers = new Array(images.length)     // 按索引存 buffer，确保顺序
    let imgIdx = 0
    let completedImg = 0
    const failedImages = []

    async function imgWorker() {
      while (imgIdx < images.length && !job.cancelled()) {
        const j = imgIdx++
        let retries = 0
        let success = false
        while (retries < 3 && !success) {
          try {
            const buf = await downloadBuf(images[j], chapter.url)
            imageBuffers[j] = buf
            success = true
          } catch (e) {
            retries++
            if (retries >= 3) {
              failedImages.push({ index: j + 1, url: images[j], error: e.message })
              imageBuffers[j] = null
              console.warn(`[下载] 图片下载失败 ${comicTitle} › ${chapterName} 第${j + 1}页: ${e.message}`)
            } else {
              await new Promise(r => setTimeout(r, 1000 * (retries + 1)))
            }
          }
        }
        completedImg++
        if (completedImg % 5 === 0) onProgress({ chapterIdx: chapter.index, current: completedImg, total: images.length, downloaded: completedImg })
      }
    }

    const imgWorkers = Array.from({ length: imageConcurrency }, () => imgWorker())
    await Promise.all(imgWorkers)

    if (job.cancelled()) {
      const downloaded = imageBuffers.filter(b => b).length
      return { cancelled: true, downloaded, total: images.length, failedImages }
    }

    // 按顺序把图片写入磁盘（确保 001.webp → 002.webp 的顺序正确）
    let downloaded = 0
    for (let j = 0; j < imageBuffers.length; j++) {
      if (!imageBuffers[j]) continue
      try {
        await sharp(imageBuffers[j]).webp({ quality: 85 }).toFile(path.join(chDir, `${String(j + 1).padStart(3, '0')}.webp`))
        downloaded++
      } catch (e) {
        failedImages.push({ index: j + 1, url: images[j], error: e.message })
        console.warn(`[下载] 图片转换失败 ${comicTitle} › ${chapterName} 第${j + 1}页: ${e.message}`)
      }
    }

    // 记录到数据库
    await db.saveDownloadRecord({
      comicId: sourceUrl, comicTitle, chapterIndex: chapter.index,
      chapterName: chapterName, imagesCount: downloaded, path: chDir
    })
    // 顺便更新章节图片数到 chapters 表（用于同名漫画匹配签名）
    if (sourceUrl) {
      try {
        await db.updateChapterImageCountBySourceUrl(sourceUrl, chapter.index, downloaded)
      } catch (e) {
        console.warn(`[下载] 回写章节图片数失败 ${comicTitle} › ${chapterName}:`, e.message)
      }
    }
    // 标记漫画已下载（设置 local_path）
    if (sourceUrl) {
      try {
        await db.updateComic(sourceUrl, { local_path: comicDir })
      } catch (e) {
        console.warn(`[下载] 设置 local_path 失败 ${comicTitle}:`, e.message)
      }
    }

    // 下载完成后重置 update_delta（如果是新增章节的一部分）
    if (sourceUrl && !failedImages.length) {
      try {
        await db.resetUpdateDelta(sourceUrl)
      } catch (e) {}
    }

    onProgress({ chapterIdx: chapter.index, current: images.length, total: images.length, downloaded, done: true })
    const result = { success: true, downloaded, total: images.length, chapter: chapterName }
    if (failedImages.length > 0) {
      result.failedImages = failedImages
      result.failedCount = failedImages.length
    }
    return result
  } catch (e) {
    throw e
  }
}

async function jobHandlerDownloadComic(job, onProgress) {
  const { comicTitle, chapters, referer, sourceUrl, coverUrl } = job.payload
  const totalChapters = chapters.length
  if (!totalChapters) return { completed: 0, totalChapters: 0 }

  let downloadConcurrency = globalDownloadConcurrency || 3
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (stored.downloadConcurrency) downloadConcurrency = stored.downloadConcurrency
  } catch {}

  // 优先复用已有目录，避免从第一章重新下载
  let comicDir = findComicDir(comicTitle, sourceUrl)
  if (!comicDir) {
    const preferred = path.join(getPrimaryDownloadRoot(), sanitize(comicTitle))
    comicDir = resolveUniqueComicDir(preferred, sourceUrl)
  }
  // 安全检查：如果磁盘未挂载，不要创建本地目录
  const downloadRoot = getPrimaryDownloadRoot()
  if (downloadRoot.startsWith('/Volumes/') && !fs.existsSync(downloadRoot)) {
    throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
  }
  if (!fs.existsSync(comicDir)) fs.mkdirSync(comicDir, { recursive: true })
  let completed = 0
  const usedDirs = new Set()

  const downloadChapter = async (chapter, idx) => {
    if (job.cancelled()) return { cancelled: true }

    const chapterName = chapter.name || `第${idx + 1}章`
    const folder = sanitize(`${idx + 1}-${chapterName}`)
    const chDir = path.join(comicDir, folder)

    const chDirOnDisk = findChapterDir(comicDir, idx, chapterName, usedDirs)
    if (chDirOnDisk) {
      const files = listChapterImages(chDirOnDisk)
      if (files.length > 0) {
        usedDirs.add(chDirOnDisk)
        completed++
        onProgress({ chapter: completed, totalChapters, chapterName })
        try {
          await db.saveDownloadRecord({
            comicId: sourceUrl || comicTitle, comicTitle, chapterIndex: idx,
            chapterName, imagesCount: files.length, path: chDirOnDisk
          })
        } catch (_) {}
        return { success: true, skipped: true, chapter: chapterName }
      }
    }

    const existingRecords = await db.getDownloadRecords({ comicId: sourceUrl || comicTitle, chapterIndex: idx })
    const already = existingRecords.find(r =>
      (r.comicId === sourceUrl || r.comicId === comicTitle) && r.chapterIndex === idx
    )
    if (already && already.path && fs.existsSync(already.path)) {
      const files = listChapterImages(already.path)
      if (files.length > 0) {
        completed++
        onProgress({ chapter: completed, totalChapters, chapterName })
        return { success: true, skipped: true, chapter: chapterName }
      }
    }

    const src = sources.default
    try {
      const pageList = await src.getPageList(chapter.url, referer || sourceUrl)
      const images = Array.isArray(pageList) ? pageList : pageList.images
      const chName = Array.isArray(pageList) ? '' : (pageList.chapterName || '')
      if (!images?.length) throw new Error('无图片')

      const finalChDir = path.join(comicDir, sanitize(`${idx + 1}-${chName}`))
      if (!fs.existsSync(finalChDir)) fs.mkdirSync(finalChDir, { recursive: true })

      // 单章内 5 张图片并发下载，按顺序写入磁盘
      const imageConcurrency = 5
      const imageBuffers = new Array(images.length)
      let imgIdx2 = 0
      let failedImages = []

      async function chapterImgWorker() {
        while (imgIdx2 < images.length && !job.cancelled()) {
          const j = imgIdx2++
          let retries = 0
          let success = false
          while (retries < 3 && !success) {
            try {
              const buf = await downloadBuf(images[j], chapter.url)
              imageBuffers[j] = buf
              success = true
            } catch (e) {
              retries++
              if (retries >= 3) {
                failedImages.push({ index: j + 1, url: images[j], error: e.message })
                imageBuffers[j] = null
                console.warn(`[下载] 图片下载失败 ${comicTitle} › ${chName} 第${j + 1}页: ${e.message}`)
              } else {
                await new Promise(r => setTimeout(r, 1000 * (retries + 1)))
              }
            }
          }
        }
      }

      const chapterImgWorkers = Array.from({ length: imageConcurrency }, () => chapterImgWorker())
      await Promise.all(chapterImgWorkers)

      if (job.cancelled()) {
        const downloaded = imageBuffers.filter(b => b).length
        return { cancelled: true, downloaded, total: images.length, failedImages }
      }

      // 按顺序写入磁盘：虽然图片是并发下载的，但 buffer 已按源索引位置存入 imageBuffers[j]
      // 这里严格按 j=0→N 的顺序写出 001.webp → 002.webp → ...，确保读者看到的顺序与网站一致
      let downloaded = 0
      for (let j = 0; j < imageBuffers.length; j++) {
        if (!imageBuffers[j]) continue
        const outPath = path.join(finalChDir, `${String(j + 1).padStart(3, '0')}.webp`)
        try {
          await sharp(imageBuffers[j]).webp({ quality: 85 }).toFile(outPath)
          downloaded++
        } catch (e) {
          failedImages.push({ index: j + 1, url: images[j], error: e.message })
          console.warn(`[下载] 图片转换失败 ${comicTitle} › ${chName} 第${j + 1}页: ${e.message}`)
        }
      }

      await db.saveDownloadRecord({
        comicId: sourceUrl, comicTitle, chapterIndex: idx,
        chapterName: chName, imagesCount: downloaded, path: finalChDir
      })
      if (sourceUrl) {
        try { await db.updateChapterImageCountBySourceUrl(sourceUrl, idx, downloaded) } catch (_) {}
      }

      completed++
      onProgress({ chapter: completed, totalChapters, chapterName: chName })

      const result = { success: true, downloaded, total: images.length, chapter: chName }
      if (failedImages.length > 0) {
        result.failedImages = failedImages
        result.failedCount = failedImages.length
      }
      return result
    } catch (e) {
      completed++
      onProgress({ chapter: completed, totalChapters, chapterName, error: e.message })
      return { error: e.message, chapter: chapterName }
    }
  }

  let idx = 0
  const results = []

  async function worker() {
    while (idx < chapters.length && !job.cancelled()) {
      const i = idx++
      try {
        const result = await downloadChapter(chapters[i], i)
        results.push(result)
      } catch (e) {
        results.push({ error: e.message, chapter: chapters[i].name })
      }
      // 添加随机延迟（1500-3000ms），避免触发网站反爬
      if (i < chapters.length - 1 && !job.cancelled()) {
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500))
      }
    }
  }

  const workers = Array.from({ length: downloadConcurrency }, () => worker())
  await Promise.all(workers)

  if (sourceUrl) {
    try { await db.updateComic(sourceUrl, { local_path: comicDir }) } catch (_) {}
  }

  return { completed, totalChapters, results }
}

function initJobQueue() {
  let concurrency = 5
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    if (stored.concurrency) concurrency = stored.concurrency
    if (stored.downloadConcurrency) globalDownloadConcurrency = stored.downloadConcurrency
  } catch {}
  jobQueue = new JobQueue(db.getRawDB(), {
    concurrency,
    typeConcurrency: {
      downloadChapter: globalDownloadConcurrency || 3,   // 单章任务并发上限（不同漫画的单章同时下载）
      downloadComic: 1,                                   // 整本下载任务：1 个就够（它内部并发章节）
      sync: 1,
      crawlAll: 1,
      autoEnrich: 1,
      enrichChapterNames: 1,
      enrichImageCounts: 1
    }
  })
  jobQueue.register('sync', jobHandlerSync)
  jobQueue.register('crawlAll', jobHandlerCrawlAll)
  jobQueue.register('autoEnrich', jobHandlerAutoEnrich)
  jobQueue.register('downloadChapter', jobHandlerDownloadChapter)
  jobQueue.register('downloadComic', jobHandlerDownloadComic)
  // 统一：enrichChapterNames 和 enrichImageCounts 都走同一个 handler，不再对同页面重复爬取
  jobQueue.register('enrichChapterNames', jobHandlerEnrichImageCounts)
  jobQueue.register('enrichImageCounts', jobHandlerEnrichImageCounts)
  // 互斥组：爬取类任务同一时间只允许运行一个，避免对同一网站并发请求过多
  jobQueue.registerMutexGroup('crawl', ['sync', 'crawlAll', 'autoEnrich', 'enrichChapterNames', 'enrichImageCounts'])
  // download 互斥组已移除，改为 typeConcurrency 精确控制并发
  // 速率限制：高资源消耗任务避免集中爆发
  jobQueue.rateLimits = {
    // 每 15 分钟最多 1 次全站爬取
    crawlAll: { maxCount: 1, windowMs: 15 * 60 * 1000 },
    // 每 10 分钟最多 1 次 sync（自动+手动合计）
    sync: { maxCount: 1, windowMs: 10 * 60 * 1000 }
  }
  console.log('[JobQueue] 持久队列已初始化，并发数:', concurrency, ', 章节并发:', globalDownloadConcurrency || 3)
}

function shouldSkipAutoTask(taskName) {
  // Mac mini 等桌面设备不需要省电策略
  if (process.platform === 'darwin' && !powerMonitor?.onBatteryPower) {
    return false
  }
  if (isQuietHours()) { console.log(`[Auto] [省电] 深夜时段，跳过 ${taskName}`); return true }
  if (isBatteryMode()) { console.log(`[Auto] [省电] 电池供电，跳过 ${taskName}`); return true }
  return false
}

let autoTimers = []
function startAutoTasks() {
  // 先清理旧的定时器
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

  // 定时同步：补全元数据 + 追更 + 图片数补全（合并为单一任务，每 4-6 小时）
  const syncIntervalHours = Math.max(4, autoUpdateIntervalHours) // 最低 4 小时
  const syncMs = syncIntervalHours * 60 * 60 * 1000

  const scheduleNextSync = () => {
    autoTimers.push(setTimeout(async () => {
      if (shouldSkipAutoTask('定时同步')) {
        scheduleNextSync()
        return
      }
      const jobId = jobQueue.add('sync', {}, { priority: 3 })
      await new Promise(resolve => {
        const cleanup = () => {
          offCompleted()
          offFailed()
        }
        const onJobDone = ({ jobId: completedId }) => {
          if (completedId === jobId) {
            cleanup()
            resolve()
          }
        }
        const offCompleted = jobQueue.on('completed', onJobDone)
        const offFailed = jobQueue.on('failed', onJobDone)
        setTimeout(() => {
          cleanup()
          resolve()
        }, syncMs * 2)
      })
      scheduleNextSync()
    }, syncMs))
  }

  autoTimers.push(setTimeout(async () => {
    if (shouldSkipAutoTask('首次同步')) {
      scheduleNextSync()
      return
    }
    const jobId = jobQueue.add('sync', {}, { priority: 3 })
    await new Promise(resolve => {
      const cleanup = () => {
        offCompleted()
        offFailed()
      }
      const onJobDone = ({ jobId: completedId }) => {
        if (completedId === jobId) {
          cleanup()
          resolve()
        }
      }
      const offCompleted = jobQueue.on('completed', onJobDone)
      const offFailed = jobQueue.on('failed', onJobDone)
      setTimeout(() => {
        cleanup()
        resolve()
      }, syncMs * 2)
    })
    scheduleNextSync()
  }, 60 * 1000))

  // 定时清理：移除已完成/失败/取消的长期任务记录，避免队列表膨胀
  autoTimers.push(setInterval(async () => {
    try {
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
  }, 60 * 60 * 1000)) // 每小时清理一次

  console.log(`[Auto] 持久队列自动任务已启动（同步间隔 ${syncIntervalHours}h，已合并图片数补全）`)
}

function stopAutoTasks() {
  for (const t of autoTimers) {
    clearTimeout(t)
    clearInterval(t)
  }
  autoTimers = []
}

function restartAutoTasks() {
  console.log('[Auto] 重启自动任务')
  startAutoTasks()
}

// ============ 下载管理器（保留原有兼容） ============
class DownloadManager {
  getStatePath(comicDir) { return path.join(comicDir, '.download_state.json') }
  loadState(comicDir, title) {
    const p = this.getStatePath(comicDir)
    try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
    return null
  }
  saveState(comicDir, title, state) {
    try { fs.writeFileSync(this.getStatePath(comicDir), JSON.stringify(state, null, 2)) } catch {}
  }

  async downloadComic(comicData, win) {
    const { title, chapters, referer, cover, sourceUrl } = comicData
    if (!chapters?.length) return { success: false, error: '暂无章节' }

    // 优先复用现有目录，否则落到主路径
    let comicDir = findComicDir(title, sourceUrl)
    if (!comicDir) {
      const preferred = path.join(getPrimaryDownloadRoot(), sanitize(title))
      comicDir = resolveUniqueComicDir(preferred, sourceUrl)
    }
    // 安全检查：如果磁盘未挂载，不要创建本地目录
    const downloadRoot = getPrimaryDownloadRoot()
    if (downloadRoot.startsWith('/Volumes/') && !fs.existsSync(downloadRoot)) {
      throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
    }
    const state = this.loadState(comicDir, title) || {
      comicId: sourceUrl, title, totalChapters: chapters.length,
      completedChapters: [], completedImages: 0, startTime: Date.now()
    }
    if (!fs.existsSync(comicDir)) fs.mkdirSync(comicDir, { recursive: true })

    const src = sources.default
    let successImages = state.completedImages, failedChapters = 0

    if (cover && !state.completedChapters.includes(-1)) {
      const cp = path.join(comicDir, 'cover.webp')
      if (!fs.existsSync(cp)) try { await downloadAndConvert(cover, cp, referer) } catch {}
      state.completedChapters.push(-1)
      this.saveState(comicDir, title, state)
    }

    const usedDirs = new Set()
    for (let i = 0; i < chapters.length; i++) {
      if (state.completedChapters.includes(i)) continue
      const ch = chapters[i]

      // 扫描磁盘：章节是否已存在（带全局去重，避免同一目录被多个章节匹配）
      const chDirOnDisk = findChapterDir(comicDir, i, ch.name, usedDirs)
      if (chDirOnDisk) {
        const files = listChapterImages(chDirOnDisk)
        if (files.length > 0) {
          successImages += files.length
          state.completedChapters.push(i)
          state.completedImages = successImages
          this.saveState(comicDir, title, state)
          usedDirs.add(chDirOnDisk)
          continue
        }
      }

      try {
        const pageList = await src.getPageList(ch.url, referer || sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        const chapterName = Array.isArray(pageList) ? '' : (pageList.chapterName || '')
        if (!images?.length) { failedChapters++; continue }
        const folderName = `${i + 1}-${sanitize(chapterName)}`
        const chDir = path.join(comicDir, folderName)
        if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true })
        if (!state._dirs) state._dirs = {}
        state._dirs[i] = chDir
        let chOk = 0
        for (let j = 0; j < images.length; j++) {
          try {
            const f = `${String(j + 1).padStart(3, '0')}.webp`
            await downloadAndConvert(images[j], path.join(chDir, f), ch.url)
            chOk++
          } catch {}
        }
        successImages += chOk
        state.completedImages = successImages
        state.completedChapters.push(i)
        this.saveState(comicDir, title, state)
        if (win) win.webContents.send('download:progress', {
          chapter: i + 1, totalChapters: chapters.length,
          chapterName: chapterName, images: images.length, successImages,
          chapterSuccess: chOk, chapterFailed: images.length - chOk
        })
      } catch (e) {
        failedChapters++
        console.error(`[下载] 章节 ${ch.name} 失败:`, e.message)
      }
    }
    state.completed = true; state.endTime = Date.now()
    this.saveState(comicDir, title, state)
    if (sourceUrl) {
      try { await db.updateComic(sourceUrl, { local_path: comicDir }) } catch (_) {}
    }
    return { success: true, path: comicDir, successImages, failedChapters }
  }
}
const downloadMgr = new DownloadManager()

// ============ 共用下载路径 ============
// 默认下载路径，可通过设置修改
let EXTERNAL_ROOT = '/Volumes/可移动磁盘/ComicDownloads'
let globalDownloadConcurrency = 3

function getDownloadRoots() {
  const candidates = []
  candidates.push(EXTERNAL_ROOT)
  candidates.push(path.join(app.getPath('documents'), 'comic-downloads'))
  candidates.push(app.getPath('downloads'))
  return candidates
}

function getPrimaryDownloadRoot() {
  return EXTERNAL_ROOT
}

// 归一化章节 URL，用于「按 URL 去重」判断某章是否已下载
// 去掉协议、末尾斜杠、查询参数、www 前缀、锚点，统一小写
function normalizeUrl(u) {
  if (!u) return ''
  try {
    let s = String(u).trim().toLowerCase()
    s = s.replace(/^https?:\/\//, '')
    s = s.replace(/^www\./, '')
    s = s.replace(/[#?].*$/, '')
    s = s.replace(/\/+$/, '')
    return s
  } catch (_) {
    return String(u || '').toLowerCase()
  }
}

const comicDirCache = new Map()
let comicDirCacheTimestamp = 0
const COMIC_DIR_CACHE_TTL = 5 * 60 * 1000

const chapterDirCache = new Map()
let chapterDirCacheTimestamp = 0

function resolveUniqueComicDir(preferredPath, sourceUrl) {
  if (!fs.existsSync(preferredPath)) return preferredPath

  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        if (row?.local_path === preferredPath) return preferredPath
      }
    } catch (_) {}
  }

  let counter = 1
  let candidate
  do {
    candidate = `${preferredPath}_${counter}`
    counter++
  } while (fs.existsSync(candidate))
  return candidate
}

function findComicDir(title, sourceUrl) {
  // 优先通过 sourceUrl 从数据库查 local_path（精确，支持同名漫画不同目录）
  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        if (row?.local_path && fs.existsSync(row.local_path)) {
          return row.local_path
        }
      }
    } catch (_) {}
  }

  const now = Date.now()
  const cacheKey = normalizeName(title)
  
  if (now - comicDirCacheTimestamp < COMIC_DIR_CACHE_TTL && comicDirCache.has(cacheKey)) {
    return comicDirCache.get(cacheKey)
  }

  const candidates = [sanitize(title), title]
  const normTitle = normalizeName(title)

  for (const root of getDownloadRoots()) {
    for (const c of candidates) {
      const p = path.join(root, c)
      if (fs.existsSync(p)) {
        comicDirCache.set(cacheKey, p)
        comicDirCacheTimestamp = now
        return p
      }
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const normDir = normalizeName(e.name)
        if (normDir && normTitle && normDir === normTitle) {
          const p = path.join(root, e.name)
          comicDirCache.set(cacheKey, p)
          comicDirCache.set(normalizeName(e.name), p)
          comicDirCacheTimestamp = now
          return p
        }
      }
    } catch (_) {}
  }
  
  comicDirCache.set(cacheKey, null)
  return null
}

function clearComicDirCache() {
  comicDirCache.clear()
  comicDirCacheTimestamp = 0
  chapterDirCache.clear()
  chapterDirCacheTimestamp = 0
}

function findChapterDir(comicDir, chapterIndex, chapterName, usedDirs) {
  if (!comicDir || !fs.existsSync(comicDir)) return null
  const now = Date.now()
  const cacheKey = `${comicDir}:${chapterIndex}:${chapterName}`
  
  if (now - chapterDirCacheTimestamp < COMIC_DIR_CACHE_TTL && chapterDirCache.has(cacheKey)) {
    const cached = chapterDirCache.get(cacheKey)
    if (cached && fs.existsSync(cached)) return cached
    if (cached === null) return null
  }

  const used = usedDirs || new Set()
  const entries = fs.readdirSync(comicDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !used.has(path.join(comicDir, e.name)))

  // 1) 精确匹配「序号-章节名」格式（最精确，新老版本均覆盖）
  const exactByName = entries.find(e => {
    const m = e.name.match(/^(\d+)-(.*)$/)
    if (!m) return false
    const idx = parseInt(m[1], 10) - 1
    if (idx !== chapterIndex) return false
    const dirChapterName = m[2]
    const normDir = normalizeName(dirChapterName)
    const normName = normalizeName(chapterName)
    if (chapterName === dirChapterName) return true
    if (sanitize(chapterName) === dirChapterName) return true
    if (normDir && normName && normDir === normName) return true
    return false
  })
  if (exactByName) {
      const chPath = path.join(comicDir, exactByName.name)
      const files = listChapterImages(chPath)
      // 精确匹配需要图片数校验：避免用残缺目录跳过新章节
      // （如目录102里有11张第1话的图，但网站第102章可能是新章节）
      // 阈值从15降低到3：大部分漫画章节至少有3页
      if (files.length > 3 || (files.length > 0 && !chapterName)) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }

  // 2) 跨序号按章节名搜索（次优先：章节名比序号更可靠）
  //    处理源站数据错误（同一章节出现在不同编号下）
  //    例如「第1话」同时存在于编号1和编号102下
  if (chapterName) {
    const normName = normalizeName(chapterName)
    const nameOnlyMatch = entries.find(e => {
      const m = e.name.match(/^(\d+)-(.*)$/)
      if (!m) return false
      const dirChapterName = m[2]
      // 排除明显的公告/通知类目录
      const lowName = e.name.toLowerCase()
      if (/休刊|公告|通知|预告|请假|停更|说明/.test(lowName)) return false
      const normDir = normalizeName(dirChapterName)
      if (sanitize(chapterName) === dirChapterName) return true
      if (normDir && normName && normDir === normName) return true
      return false
    })
    if (nameOnlyMatch) {
      const chPath = path.join(comicDir, nameOnlyMatch.name)
      const files = listChapterImages(chPath)
      // 只有在有足够图片时才认为是有效匹配（阈值统一为3，与精确匹配一致）
      if (files.length > 3) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }
  }

  // 3) 只按序号匹配（有章节名校验）
  //    注意：可能匹配到「重复发布的旧章节」（如目录102里是第1话）
  //    需要额外校验：目录章节名和网站章节名是否大致一致
  let exactByIndexValid = false
  const exactByIndex = entries.find(e => {
    const m = e.name.match(/^(\d+)/)
    if (!m) return false
    const idx = parseInt(m[1], 10) - 1
    if (idx !== chapterIndex) return false

    // 额外校验：如果目录章节名和网站章节名差异过大（如「第1话」vs「第101话」），跳过此目录
    const m2 = e.name.match(/^(\d+)-(.*)$/)
    const dirChapterName = m2 ? m2[2] : ''
    if (chapterName && dirChapterName) {
      const dirHasNum = /\d+/.test(dirChapterName) ? parseInt(dirChapterName.match(/\d+/)[0], 10) : null
      const chapterHasNum = /\d+/.test(chapterName) ? parseInt(chapterName.match(/\d+/)[0], 10) : null
      if (dirHasNum !== null && chapterHasNum !== null && Math.abs(dirHasNum - chapterHasNum) > 20) {
        return false
      }
    }
    return true
  })
  if (exactByIndex) {
    const chPath = path.join(comicDir, exactByIndex.name)
    const files = listChapterImages(chPath)
    // 图片数校验：避免用残缺目录跳过新章节（阈值统一为3）
    if (files.length > 3) {
      chapterDirCache.set(cacheKey, chPath)
      chapterDirCacheTimestamp = now
      return chPath
    }
  }

  // 4) 最后一步：按数字前缀排序后取第 chapterIndex 个（兜底）
  //    ⚠️ 注意：此方法在章节编号不连续（如缺101）时可能误匹配，需严格校验
  const numbered = entries
    .filter(e => /^\d+/.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/^(\d+)/)[1], 10)
      const nb = parseInt(b.name.match(/^(\d+)/)[1], 10)
      return na - nb
    })
  if (chapterIndex < numbered.length) {
    const candidate = numbered[chapterIndex]
    const num = parseInt(candidate.name.match(/^(\d+)/)[1], 10)
    // 目录编号和预期序号差距必须 <=2，且有足够图片，才返回（避免误匹配到重复内容）
    if (Math.abs(num - (chapterIndex + 1)) <= 2) {
      const chPath = path.join(comicDir, candidate.name)
      const files = listChapterImages(chPath)
      // 图片数校验（阈值统一为3）
      if (files.length > 3) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }
  }
  chapterDirCache.set(cacheKey, null)
  return null
}

function listChapterImages(chapterDir) {
  if (!chapterDir || !fs.existsSync(chapterDir)) return []
  const files = fs.readdirSync(chapterDir).filter(f =>
    /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i.test(f)
  )
  // 按文件名中的数字前缀排序（数字排序而非字符串排序）
  // 支持 001.webp / 1.webp / image-001.jpg 等各种格式
  files.sort((a, b) => {
    const ma = a.match(/\d+/)
    const mb = b.match(/\d+/)
    const na = ma ? parseInt(ma[0], 10) : 99999
    const nb = mb ? parseInt(mb[0], 10) : 99999
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  })
  return files.map(f => path.join(chapterDir, f))
}

async function downloadAndConvert(url, filePath, referer) {
  for (let i = 0; i < 3; i++) {
    try {
      const buf = await downloadBuf(url, referer)
      await sharp(buf).webp({ quality: 85 }).toFile(filePath)
      return
    } catch (e) { if (i === 2) throw e; await sleep(1000 * (i + 1)) }
  }
}
function downloadBuf(url, referer, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': referer || url, 'Accept': 'image/*'
      }
    }, (res) => {
      if (settled) { res.resume(); return }
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy()
        settled = true
        const redirectUrl = new url.URL(res.headers.location, url).href
        return resolve(downloadBuf(redirectUrl, referer, timeoutMs))
      }
      if (res.statusCode !== 200) {
        req.destroy()
        settled = true
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const c = []
      let resTimeout = setTimeout(() => {
        settled = true
        req.destroy()
        reject(new Error('Response timeout'))
      }, timeoutMs)
      res.on('data', d => {
        clearTimeout(resTimeout)
        resTimeout = setTimeout(() => {
          settled = true
          req.destroy()
          reject(new Error('Response timeout'))
        }, timeoutMs)
        c.push(d)
      })
      res.on('end', () => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        resolve(Buffer.concat(c))
      })
      res.on('error', (e) => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        req.destroy()
        reject(e)
      })
    })
    let reqTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('Request timeout'))
    }, timeoutMs)
    req.on('timeout', () => {
      if (settled) return
      clearTimeout(reqTimeout)
      settled = true
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.on('error', (e) => {
      if (settled) return
      clearTimeout(reqTimeout)
      settled = true
      reject(e)
    })
  })
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ============ Cache Protocol ============
// 协议注册已在 app.whenReady() 中完成（见文件末尾）

// ============ IPC Handlers ============

// --- Sources ---
ipcMain.handle('source:search', async (_, query, sourceId) => {
  if (sourceId && sourceId !== 'all') return sources.get(sourceId).search(query, 1)
  return sources.multiSearch(query)
})
ipcMain.handle('source:getDetail', async (_, url) => {
  const src = url?.includes('smtt6') ? sources.get('smtt6') : sources.default
  return src.getDetail(url)
})
ipcMain.handle('source:getChapters', async (_, url) => {
  const src = url?.includes('smtt6') ? sources.get('smtt6') : sources.default
  return (await src.getDetail(url)).chapters
})
ipcMain.handle('source:getPageList', async (_, chapterUrl, referer) => {
  const src = chapterUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
  const pageList = await src.getPageList(chapterUrl, referer)
  const urls = Array.isArray(pageList) ? pageList : pageList.images
  // 后台异步缓存图片
  if (urls?.length) {
    setImmediate(async () => {
      for (const url of urls) {
        if (cache.hasCache(url)) continue
        try {
          const buf = await src.fetchImage(url, chapterUrl)
          await cache.setCache(url, buf)
        } catch {}
      }
    })
  }
  return urls
})
ipcMain.handle('source:list', async () => sources.getAll().map(s => ({ id: s.id, name: s.name, lang: s.lang })))

// --- Cache-backed page list (立即返回代理 URL，浏览器并发加载) ---
ipcMain.handle('source:getCachedPageList', async (_, chapterUrl, referer) => {
  const src = chapterUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
  const pageList = await src.getPageList(chapterUrl, referer)
  const imageUrls = Array.isArray(pageList) ? pageList : pageList.images
  if (!imageUrls?.length) return imageUrls

  // 立即返回代理 URL 列表（浏览器自己并发加载，不需要等我们下载完）
  const ref = referer || chapterUrl
  const proxyUrls = imageUrls.map(u => getProxyImageUrl(u, ref))

  // 后台异步预缓存（不阻塞返回）
  setImmediate(() => {
    let i = 0
    const workers = []
    const concurrency = 5
    for (let w = 0; w < concurrency; w++) {
      workers.push((async () => {
        while (i < imageUrls.length) {
          const currentIdx = i++
          try {
            if (cache.hasCache(imageUrls[currentIdx])) continue
            await fetchAndCacheImage(imageUrls[currentIdx], ref)
          } catch {}
        }
      })())
    }
    Promise.all(workers).then(() => {
      console.log(`[Cache] 章节预缓存完成: ${imageUrls.length} 张`)
    }).catch(() => {})
  })

  return proxyUrls
})

// --- 全局搜索（本地 + 远程源） ---
ipcMain.handle('search:global', async (_, query, filters = {}) => {
  if (!query?.trim() && Object.keys(filters).length === 0) return { local: [], remote: [] }
  const q = query?.trim().toLowerCase() || ''

  // 1. 本地搜索（支持高级过滤）
  let local = []
  try {
    if (Object.keys(filters).length > 0) {
      // 使用高级搜索
      local = await db.advancedSearch(q, filters)
    } else {
      local = await db.searchComics(q)
    }
  } catch (e) {
    console.warn('[search:global] 本地搜索失败:', e.message)
  }
  
  // 2. 远程搜索（仅基础查询）
  let remote = []
  if (q) {
    try {
      remote = await sources.multiSearch(q)
    } catch {}
  }
  return { local: local || [], remote }
})

// --- 图片缓存管理 ---
ipcMain.handle('cache:stats', () => cache.getStats())
ipcMain.handle('cache:clear', () => { cache.clearCache(); return true })

// --- 磁盘空间查询 ---
ipcMain.handle('disk:getSpace', async (_, dirPath) => {
  try {
    const { getDiskInfo } = require('./utils')
    const info = await getDiskInfo(dirPath || app.getPath('downloads'))
    return { success: true, ...info }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// --- Job Queue ---
ipcMain.handle('job:add', async (_, type, payload, opts) => jobQueue.add(type, payload, opts))
ipcMain.handle('job:cancel', async (_, id) => jobQueue.cancel(id))
ipcMain.handle('job:retry', async (_, id) => jobQueue.retry(id))
ipcMain.handle('job:retryAll', async () => jobQueue.retryAll())
ipcMain.handle('job:clear', async () => jobQueue.clear())
ipcMain.handle('job:list', async (_, status, limit) => jobQueue.listJobs(status, limit))
ipcMain.handle('job:stats', async () => jobQueue.getStats())

// 获取失败统计
ipcMain.handle('job:failureStats', async () => {
  try {
    return jobQueue.getFailureStats()
  } catch (e) {
    console.error('[job:failureStats] 错误:', e.message)
    return []
  }
})
ipcMain.handle('job:get', async (_, id) => jobQueue.getJob(id))

// --- DB ---
ipcMain.handle('db:getComics', async (_, page, pageSize, filters) => db.getComics(page, pageSize, filters))
ipcMain.handle('db:getComicById', async (_, id) => db.getComicById(id))
ipcMain.handle('db:getComicByUrl', async (_, url) => db.getComicByUrl(url))
ipcMain.handle('db:getFavoritedComics', async () => db.getFavoritedComics())
ipcMain.handle('db:clearComics', async () => db.clearAllComics())
ipcMain.handle('db:getComicsCount', async () => db.getComicsCount())
ipcMain.handle('db:getDbPath', async () => db.getDbPath())
ipcMain.handle('db:getChaptersCount', async () => db.getChaptersCount())
ipcMain.handle('db:getImagesCount', async () => db.getImagesCount())
ipcMain.handle('db:getDownloadSize', async () => db.getDownloadSize())
ipcMain.handle('db:getBooksReadCount', async () => db.getBooksReadCount())
ipcMain.handle('db:getChaptersReadCount', async () => db.getChaptersReadCount())
ipcMain.handle('db:getReadingStreak', async () => db.getReadingStreak())
ipcMain.handle('db:getTotalReadTime', async () => db.getTotalReadTime())
ipcMain.handle('db:updateComic', async (_, comicId, changes) => db.updateComic(comicId, changes))
ipcMain.handle('db:cleanupPureLocalComics', async () => db.cleanupPureLocalComics())
ipcMain.handle('db:getCategoryStats', async () => db.getCategoryStats())
ipcMain.handle('db:getAllCategories', async () => db.getAllCategories())
ipcMain.handle('db:searchComics', async (_, q) => db.searchComics(q))

ipcMain.handle('db:setFavorite', async (_, comicId, favorited) => db.setFavorite(comicId, favorited))
ipcMain.handle('db:clearUpdateDelta', async (_, comicId) => db.clearUpdateDelta(comicId))
ipcMain.handle('db:autoScanLocalComics', async (e, paths) => {
  const onProgress = (p) => { try { e.sender.send('scan:progress', p) } catch (_) {} }
  return db.autoScanLocalComics(paths, sources, onProgress)
})

// 批量导入本地漫画（扫描目录、匹配数据库、注册路径）
ipcMain.handle('db:importLocalComics', async (e, dirPath, progressCallback) => {
  // 进度回调包装器
  const onProgress = progressCallback ? (progress) => {
    e.sender.send('import:progress', progress)
  } : null
  
  return db.importLocalComics(dirPath, onProgress)
})

// --- Batch operations ---
ipcMain.handle('batch:delete', async (_, ids) => {
  for (const id of ids) await db.deleteComic(id)
  return { deleted: ids.length }
})
ipcMain.handle('batch:exportEPUB', async (_, ids) => {
  // Placeholder: export each comic as EPUB
  const results = []
  for (const id of ids) {
    const comic = await db.getComicById(id)
    if (comic) results.push({ id, title: comic.title, status: 'queued' })
  }
  return results
})

// --- Data management ---
ipcMain.handle('data:getStats', async () => {
  const count = await db.getComicsCount()
  const catStats = await db.getCategoryStats()
  const records = await db.getDownloadRecords()
  const totalImages = records.reduce((s, r) => s + (r.imagesCount || 0), 0)
  const totalChapters = records.length
  return { totalComics: count, totalCategories: Object.keys(catStats.stats).length, totalChapters, totalImages }
})

// --- Settings ---
ipcMain.handle('settings:get', async () => {
  // 启动时从设置文件加载下载路径
  try {
    const storedPath = path.join(app.getPath('userData'), 'settings.json')
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf-8'))
    if (stored.downloadDir && fs.existsSync(stored.downloadDir)) {
      EXTERNAL_ROOT = stored.downloadDir
    }
  } catch {
    // 使用默认路径
  }

  const defaults = {
    downloadDir: EXTERNAL_ROOT,
    concurrency: 5,
    downloadConcurrency: 3,
    cacheSizeGb: 2,
    batterySaver: false,
    proxyType: 'none',
    proxyHost: '',
    proxyPort: '',
    autoUpdateEnabled: true,
    autoUpdateIntervalHours: 2
  }
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
    return { ...defaults, ...stored }
  } catch { return defaults }
})
ipcMain.handle('settings:save', async (_, settings) => {
  fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2))
  if (jobQueue && settings.concurrency) {
    jobQueue.concurrency = settings.concurrency
  }
  if (settings.downloadConcurrency) {
    globalDownloadConcurrency = settings.downloadConcurrency
    // 动态更新 JobQueue 的章节并发上限，无需重启应用
    if (jobQueue?.updateTypeConcurrency) {
      jobQueue.updateTypeConcurrency({
        downloadChapter: settings.downloadConcurrency
      })
    }
  }
  // 如果下载路径变更，更新 EXTERNAL_ROOT
  if (settings.downloadDir) {
    EXTERNAL_ROOT = settings.downloadDir
  }
  // 追更设置变更后重启自动任务
  if (typeof settings.autoUpdateEnabled === 'boolean' || settings.autoUpdateIntervalHours) {
    restartAutoTasks()
  }
  return true
})

// --- 后台任务状态广播（同步、爬取、补全、下载等） ---
let backgroundTaskState = { tasks: [], lastUpdated: 0 }

function getBackgroundTasks() {
  const tasks = []
  const stats = jobQueue ? jobQueue.getStats() : {}

  const runningJobs = jobQueue ? (jobQueue.listJobs('active', 200) || []) : []
  const waitingJobs = jobQueue ? (jobQueue.listJobs('waiting', 200) || []) : []

  const allJobs = [...runningJobs, ...waitingJobs]

  const typeLabels = {
    sync: { label: '同步追更', icon: 'sync' },
    crawlAll: { label: '全站爬取', icon: 'crawl' },
    autoEnrich: { label: '字段补全', icon: 'enrich' },
    downloadChapter: { label: '下载章节', icon: 'download' },
    downloadComic: { label: '下载漫画', icon: 'download' },
    enrichChapterNames: { label: '补全章节名', icon: 'enrich' },
    enrichImageCounts: { label: '补全图片数', icon: 'enrich' }
  }

  const seenTypes = new Set()
  for (const job of allJobs) {
    const type = job.type
    if (seenTypes.has(type)) continue
    seenTypes.add(type)
    const info = typeLabels[type] || { label: type, icon: 'task' }
    tasks.push({
      type,
      label: info.label,
      icon: info.icon,
      active: runningJobs.filter(j => j.type === type).length,
      waiting: waitingJobs.filter(j => j.type === type).length,
      total: allJobs.filter(j => j.type === type).length
    })
  }

  const settingsConcurrency = (() => {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
      return stored.concurrency || 5
    } catch { return 5 }
  })()

  const settingsDownloadConcurrency = (() => {
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'))
      return stored.downloadConcurrency || 3
    } catch { return 3 }
  })()

  return {
    tasks,
    activeCount: stats.active || 0,
    waitingCount: stats.waiting || 0,
    completedCount: stats.completed || 0,
    failedCount: stats.failed || 0,
    concurrency: settingsConcurrency,
    downloadConcurrency: settingsDownloadConcurrency,
    lastUpdated: Date.now()
  }
}

function broadcastBackgroundTasks() {
  const state = getBackgroundTasks()
  backgroundTaskState = state
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('app:backgroundTasks', state)
  })
}

let globalBackgroundTaskForwarder = null
function ensureGlobalBackgroundTaskForwarder() {
  if (globalBackgroundTaskForwarder) return

  const broadcast = () => broadcastBackgroundTasks()

  const unsubProgress = jobQueue.on('progress', () => broadcast())
  const unsubCompleted = jobQueue.on('completed', () => broadcast())
  const unsubFailed = jobQueue.on('failed', () => broadcast())
  const unsubRetrying = jobQueue.on('retrying', () => broadcast())
  const unsubPaused = jobQueue.on('paused', () => broadcast())
  const unsubResumed = jobQueue.on('resumed', () => broadcast())

  const bgTaskInterval = setInterval(() => broadcast(), 3000)

  globalBackgroundTaskForwarder = () => {
    unsubProgress(); unsubCompleted(); unsubFailed()
    unsubRetrying(); unsubPaused(); unsubResumed()
    clearInterval(bgTaskInterval)
  }
}

ipcMain.handle('app:backgroundTasks', async () => getBackgroundTasks())

// --- 全局爬取进度转发（无论谁触发的爬取，都转发给所有渲染进程） ---
let globalCrawlForwarder = null
function ensureGlobalCrawlForwarder() {
  if (globalCrawlForwarder) return

  // 频道映射：job type → IPC channel prefix
  const channelMap = {
    crawlAll: 'crawl',
    update: 'update',
    enrich: 'enrich',
    enrichChapterNames: 'enrichChapterNames',
    enrichImageCounts: 'enrichImageCounts'
  }

  const unsubProgress = jobQueue.on('progress', (data) => {
    const prefix = channelMap[data.type]
    if (!prefix) return
    console.log(`[job:${data.type}] progress:`, data.page || data.current, data.msg || data.title)
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send(`${prefix}:progress`, data)
    })
  })
  const unsubDone = jobQueue.on('completed', (data) => {
    const prefix = channelMap[data.type]
    if (!prefix) return
    console.log(`[job:${data.type}] completed:`, data.result?.updated, data.result?.total)
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send(`${prefix}:done`, data.result)
    })
  })
  const unsubFailed = jobQueue.on('failed', (data) => {
    const prefix = channelMap[data.type]
    if (!prefix) return
    console.error(`[job:${data.type}] failed:`, data.error)
    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) w.webContents.send(`${prefix}:done`, { error: data.error })
    })
  })
  globalCrawlForwarder = () => { unsubProgress(); unsubDone(); unsubFailed() }
}

// --- Legacy crawl bridge ---
ipcMain.handle('crawl:all', async (event, startUrl) => {
  console.log('[crawl:all] handle called, startUrl=', startUrl)

  // 互斥：检查是否已有 crawlAll 作业在运行或等待中
  const existing = jobQueue.findByType('crawlAll')
  if (existing) {
    console.log('[crawl:all] 已有爬取作业运行中（状态:', existing.status, '），跳过重复请求')
    return { msg: '已有爬取作业运行中', existing: true }
  }

  ensureGlobalCrawlForwarder()

  return new Promise((resolve, reject) => {
    let jobId = null
    const unsubDone = jobQueue.on('completed', (data) => {
      if (jobId && data.jobId === jobId && data.type === 'crawlAll') {
        unsubDone(); unsubFailed()
        resolve(data.result)
      }
    })
    const unsubFailed = jobQueue.on('failed', (data) => {
      if (jobId && data.jobId === jobId && data.type === 'crawlAll') {
        unsubDone(); unsubFailed()
        reject(new Error(data.error || '作业失败'))
      }
    })
    jobId = jobQueue.add('crawlAll', { startUrl }, { priority: 0 })
    console.log('[crawl:all] job added, id=', jobId)
  })
})
ipcMain.handle('crawl:enrich', async (event, force) => {
  return new Promise((resolve, reject) => {
    let jobId = null
    const unsub = jobQueue.on('progress', (data) => {
      if (jobId && data.jobId === jobId) {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrich:progress', data)
        })
      }
    })
    const unsubDone = jobQueue.on('completed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrich:done', data.result)
        })
        resolve(data.result)
      }
    })
    const unsubFailed = jobQueue.on('failed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        reject(new Error(data.error || '作业失败'))
      }
    })
    jobId = jobQueue.add('sync', {}, { priority: 0 })
  })
})
ipcMain.handle('crawl:checkUpdates', async (event) => {
  return new Promise((resolve, reject) => {
    let jobId = null
    const unsub = jobQueue.on('progress', (data) => {
      if (jobId && data.jobId === jobId) {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('update:progress', data)
        })
      }
    })
    const unsubDone = jobQueue.on('completed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('update:done', data.result)
        })
        resolve(data.result)
      }
    })
    const unsubFailed = jobQueue.on('failed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        reject(new Error(data.error || '作业失败'))
      }
    })
    jobId = jobQueue.add('sync', {}, { priority: 0 })
  })
})
ipcMain.handle('crawl:enrichChapterNames', async (event) => {
  return new Promise((resolve, reject) => {
    let jobId = null
    const unsub = jobQueue.on('progress', (data) => {
      if (jobId && data.jobId === jobId) {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrichChapterNames:progress', data)
        })
      }
    })
    const unsubDone = jobQueue.on('completed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrichChapterNames:done', data.result)
        })
        resolve(data.result)
      }
    })
    const unsubFailed = jobQueue.on('failed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        reject(new Error(data.error || '作业失败'))
      }
    })
    jobId = jobQueue.add('enrichChapterNames', {}, { priority: 3 }) // 低优先级，后台运行
  })
})

ipcMain.handle('crawl:enrichImageCounts', async (event) => {
  return new Promise((resolve, reject) => {
    let jobId = null
    const unsub = jobQueue.on('progress', (data) => {
      if (jobId && data.jobId === jobId) {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrichImageCounts:progress', data)
        })
      }
    })
    const unsubDone = jobQueue.on('completed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('enrichImageCounts:done', data.result)
        })
        resolve(data.result)
      }
    })
    const unsubFailed = jobQueue.on('failed', (data) => {
      if (jobId && data.jobId === jobId) {
        unsub(); unsubDone(); unsubFailed()
        reject(new Error(data.error || '作业失败'))
      }
    })
    jobId = jobQueue.add('enrichImageCounts', {}, { priority: 4 }) // 最低优先级，后台慢慢跑
  })
})

// --- Reading Progress ---
ipcMain.handle('progress:save', async (_, data) => db.saveReadingProgress(data.comicId, data.chapterIndex, data.chapterUrl, data.pageIndex, data.totalPages))
ipcMain.handle('progress:get', async (_, comicId) => db.getReadingProgress(comicId))
ipcMain.handle('progress:history', async (_, limit) => db.getAllReadingHistory(limit))
ipcMain.handle('progress:delete', async (_, comicId) => db.deleteReadingProgress(comicId))

// --- Comic Detail ---
ipcMain.handle('detail:getComicById', async (_, id) => db.getComicById(id))
ipcMain.handle('detail:enrichComic', async (_, sourceUrl) => {
  try {
    console.log('[detail:enrichComic] step1: get source')
    const source = sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
    console.log('[detail:enrichComic] step2: getDetail')
    const detail = await source.getDetail(sourceUrl)
    console.log('[detail:enrichComic] step3: getComicByUrl')
    const existing = await db.getComicByUrl(sourceUrl)
    console.log('[detail:enrichComic] step4: upsertComic')
    const category = detail.category || deriveCategoryFromTags(detail.tags, existing?.tags)
    const result = await db.upsertComic({
      sourceUrl,
      title: detail.title || '',
      cover: detail.cover || '',
      author: detail.author || '',
      status: detail.status || '',
      desc: detail.desc || '',
      tags: detail.tags || [],
      category,
      updateTime: detail.updateTime || null,
      chapters: detail.chapters || []
    })
    console.log('[detail:enrichComic] step5: enrichChapters')
    const comicId = result?._id
    const chaptersToEnrich = (detail.chapters || []).slice(0, 5)
      .map((ch, i) => ({ index: i, name: ch.name, url: ch.url }))
    if (chaptersToEnrich.length > 0) {
      try {
        const { imageCountUpdates, chapterNameUpdates } = await enrichChapters({ _id: comicId, sourceUrl }, chaptersToEnrich, source)
        if (comicId && imageCountUpdates.length > 0) {
          await db.updateChapterImageCounts(comicId, imageCountUpdates)
        }
        if (comicId && chapterNameUpdates.length > 0) {
          await db.updateChapterNames(comicId, chapterNameUpdates)
        }
      } catch (e) {
        console.warn(`[detail:enrichComic] 章节增强失败:`, e.message)
      }
    }
    const updated = await db.getComicByUrl(sourceUrl)

    const changed = []
    if (!existing?.desc && updated?.desc) changed.push('简介')
    if (!existing?.author && updated?.author) changed.push('作者')
    if (!existing?.status && updated?.status) changed.push('状态')
    if (!existing?.category && updated?.category) changed.push('分类')
    if ((!existing?.tags || existing.tags.length === 0) && updated?.tags?.length) changed.push('标签')
    if (updated?.chapters?.length > (existing?.chapters?.length || 0)) changed.push('章节列表')

    return { success: true, comic: updated, changed }
  } catch (e) {
    console.error('[detail:enrichComic] error:', e.message)
    return { success: false, error: e.message }
  }
})

// 自动补全：一次爬取详情页，把所有字段（简介/分类/作者/状态/章节数）一次性写入数据库
ipcMain.handle('detail:autoEnrichAll', async () => {
  try {
    console.log('[Auto Enrich] 开始补全漫画字段（一次性）...')
    
    const comics = await db.getComicsWithMissingFields()
    console.log(`[Auto Enrich] 找到 ${comics.length} 本字段不完整的漫画`)
    
    if (comics.length === 0) {
      return { success: true, enrichedCount: 0, message: '所有漫画字段已完整' }
    }
    
    let enrichedCount = 0
    const errors = []
    const CONCURRENCY = 5

    for (let i = 0; i < comics.length; i += CONCURRENCY) {
      const batch = comics.slice(i, i + CONCURRENCY)

      const promises = batch.map(async (comic, j) => {
        try {
          await new Promise(resolve => setTimeout(resolve, j * 1000))
          const source = comic.sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
          const detail = await source.getDetail(comic.sourceUrl)
          
          // 爬一次详情页，把所有字段一次性写入数据库
          const category = detail.category || deriveCategoryFromTags(detail.tags, comic.tags)
          await db.upsertComic({
            sourceUrl: comic.sourceUrl,
            title: detail.title || comic.title,
            cover: detail.cover || comic.cover,
            author: detail.author || '',
            status: detail.status || '',
            desc: detail.desc || '',
            tags: detail.tags || [],
            category,
            updateTime: detail.updateTime || null,
            chapters: detail.chapters || []
          })
          
          enrichedCount++
        } catch (e) {
          errors.push({ title: comic.title, error: e.message })
        }
      })
      
      await Promise.all(promises)
      
      if (i + CONCURRENCY < comics.length) {
        console.log(`[Auto Enrich] 进度: ${enrichedCount}/${comics.length}, 等待2秒...`)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    
    console.log(`[Auto Enrich] 完成! 成功: ${enrichedCount}/${comics.length}`)
    
    return {
      success: true,
      enrichedCount,
      totalCount: comics.length,
      errors: errors.length > 0 ? errors : undefined
    }

  } catch (e) {
    console.error('[Auto Enrich] 异常:', e.message)
    return { success: false, error: e.message }
  }
})

// ---------- 防御：扫描章节名过简的漫画 ----------
ipcMain.handle('detail:scanGenericChapters', async () => {
  try {
    const comics = await db.getComicsWithGenericChapterNames(50)
    return { success: true, comics, count: comics.length }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

ipcMain.handle('detail:enrichAllGenericChapters', async () => {
  try {
    const comics = await db.getComicsWithGenericChapterNames(200)
    if (comics.length === 0) {
      return { success: true, enrichedCount: 0, skippedCount: 0, message: '没有需要修复的漫画' }
    }
    let enrichedCount = 0
    let skippedCount = 0 // 网站本身就是简单命名，跳过
    const errors = []
    for (const comic of comics) {
      try {
        const source = sources.get('smtt6') || sources.default
        const detail = await source.getDetail(comic.sourceUrl)
        if (detail.chapters && detail.chapters.length > 0) {
          // 检查爬取到的章节名是否仍是占位符格式
          const stillGeneric = detail.chapters.some(ch => db.isChapterNameGeneric?.(ch.name))
          if (stillGeneric) {
            // 网站本身就是简单命名，不需要修复
            console.log(`[enrich] ${comic.title}: 网站章节名本身就是简单格式，跳过`)
            skippedCount++
          } else {
            // 爬取到了真实章节名，写入数据库
            await db.upsertComic({
              sourceUrl: comic.sourceUrl,
              title: detail.title || comic.title,
              cover: detail.cover,
              author: detail.author || '',
              status: detail.status || '',
              desc: detail.desc || '',
              tags: detail.tags || [],
              category: detail.category,
              updateTime: detail.updateTime || null,
              chapters: detail.chapters
            })
            enrichedCount++
          }
        }
        await new Promise(r => setTimeout(r, 800))
      } catch (e) {
        errors.push({ title: comic.title, error: e.message })
      }
    }
    return {
      success: true,
      enrichedCount,
      skippedCount, // 网站本身就是简单命名
      total: comics.length,
      errors: errors.length > 0 ? errors : undefined
    }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// --- Download ---
ipcMain.handle('download:comic', async (_, comicData) => {
  const win = BrowserWindow.getAllWindows()[0]
  return downloadMgr.downloadComic(comicData, win)
})
ipcMain.handle('download:listLocal', async () => db.getDownloadRecords())
ipcMain.handle('download:deleteLocal', async (_, id) => db.deleteDownloadRecord(id))
// 获取漫画的最高已下载章节索引（返回已下载的章节数，增量更新从这一位置开始）
ipcMain.handle('download:getHighestDownloadedIndex', async (_, { comicTitle, sourceUrl, totalChapters }) => {
  // ⚠️ 重要：磁盘目录的数字前缀 = 网站列表的序号，不是章节号
  // 例如「100-第99話」表示：网站第 100 个条目，内容是「第99話」
  // 所以不能用目录编号直接作为「从第几章开始下载」
  // 正确做法：后端对每个章节逐个检测是否已下载，检测到已存在则跳过
  let diskChapterCount = 0
  const comicDir = findComicDir(comicTitle, sourceUrl)
  if (comicDir) {
    try {
      const dirEntries = fs.readdirSync(comicDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
      diskChapterCount = dirEntries.length
    } catch (_) {}
  }
  return {
    diskChapterCount,
    diskDir: comicDir || null
  }
})

// 返回已下载章节的 0-based 索引数组
ipcMain.handle('download:getLocalChapterIndices', async (_, { comicTitle, sourceUrl }) => {
  const comicDir = findComicDir(comicTitle, sourceUrl)
  if (!comicDir) return []
  try {
    const entries = fs.readdirSync(comicDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
    const indices = []
    for (const e of entries) {
      const m = e.name.match(/^(\d+)-/)
      if (m) indices.push(parseInt(m[1], 10) - 1)
    }
    return indices
  } catch (_) { return [] }
})

// --- 获取已下载章节的本地图片路径（增强：也扫描磁盘文件） ---
// 返回：图片的 HTTP 代理 URL 数组（因为 Vue 页面跑在 http://localhost:5173，无法直接加载 file://）
ipcMain.handle('download:getLocalChapterImages', async (_, comicId, chapterIndex, comicTitle) => {
  const records = await db.getDownloadRecords()

  // 1. 优先用 comicId 精确匹配（数据库 id 或 sourceUrl）
  if (comicId) {
    const record = records.find(r => r.comicId === comicId && r.chapterIndex === chapterIndex)
    if (record && record.path && fs.existsSync(record.path)) {
      const files = listChapterImages(record.path)
      if (files.length > 0) return files.map(f => getLocalProxyUrl(f))
    }
  }

  // 2. 用 comicTitle + chapterIndex 匹配（用于本地扫描的、没有 sourceUrl 的漫画）
  if (comicTitle) {
    const record = records.find(r => r.comicTitle === comicTitle && r.chapterIndex === chapterIndex)
    if (record && record.path && fs.existsSync(record.path)) {
      const files = listChapterImages(record.path)
      if (files.length > 0) return files.map(f => getLocalProxyUrl(f))
    }
  }

  // 3. 扫描磁盘所有路径（优先外部磁盘）
  if (comicTitle) {
    const cDir = findComicDir(comicTitle, comicId)
    if (cDir) {
      const chDir = findChapterDir(cDir, chapterIndex, '')
      if (chDir) {
        const files = listChapterImages(chDir)
        if (files.length > 0) return files.map(f => getLocalProxyUrl(f))
      }
    }
  }
  return null
})

// --- 离线下载（队列版） ---
ipcMain.handle('download:queueChapter', async (event, opts) => {
  const { comicTitle, chapter, referer, sourceUrl, coverUrl } = opts
  const win = BrowserWindow.fromWebContents(event.sender)
  const id = jobQueue.add('downloadChapter', { comicTitle, chapter, referer, sourceUrl, coverUrl }, { priority: 0 })
  const unsub = jobQueue.on('progress', (data) => {
    if (data.jobId === id && win) win.webContents.send('download:jobProgress', data)
  })
  const unsub2 = jobQueue.on('completed', (data) => {
    if (data.jobId === id && win) { win.webContents.send('download:jobDone', data.result); unsub(); unsub2() }
  })
  return { jobId: id }
})
ipcMain.handle('download:queueAllChapters', async (event, opts) => {
  const { comicTitle, chapters, referer, sourceUrl, coverUrl } = opts
  const win = BrowserWindow.fromWebContents(event.sender)
  // 整本漫画作为单个 downloadComic 任务入队（它内部并发下载章节）
  const id = jobQueue.add('downloadComic', {
    comicTitle, chapters, referer, sourceUrl, coverUrl
  }, { priority: 1 })
  const unsub = jobQueue.on('progress', (data) => {
    if (data.jobId === id && win) win.webContents.send('download:jobProgress', data)
  })
  const unsub2 = jobQueue.on('completed', (data) => {
    if (data.jobId === id && win) { win.webContents.send('download:jobDone', data.result); unsub(); unsub2() }
  })
  return { jobIds: [id], count: chapters.length }
})

// --- 下载暂停/恢复 ---
ipcMain.handle('download:pauseJob', async (_, jobId) => {
  jobQueue.pauseJob(jobId)
  return { success: true }
})
ipcMain.handle('download:resumeJob', async (_, jobId) => {
  jobQueue.resumeJob(jobId)
  return { success: true }
})
ipcMain.handle('download:getJobStatus', async (_, jobId) => {
  return jobQueue.getJob(jobId)
})
ipcMain.handle('download:listQueue', async (_, status = 'all') => {
  return jobQueue.listJobs(status)
})

// --- Export ---
ipcMain.handle('export:toCBZ', async (_, opts) => exporter.toCBZ(opts))
ipcMain.handle('export:toEPUB', async (_, opts) => exporter.toEPUB(opts))

// --- 列出已下载的漫画（供 EpubGen.vue 使用，多路径合并） ---
ipcMain.handle('export:listDownloads', async () => {
  const roots = getDownloadRoots()
  const seen = new Set()
  const comics = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dirKey = `${root}/${e.name}`
      if (seen.has(dirKey)) continue
      seen.add(dirKey)
      const comicDir = path.join(root, e.name)
      const chEntries = fs.readdirSync(comicDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^\d+-/.test(d.name))
      let cover = null
      const coverPath = path.join(comicDir, 'cover.webp')
      if (fs.existsSync(coverPath)) cover = 'file://' + coverPath
      comics.push({
        id: e.name,
        title: e.name,
        cover,
        meta: `${chEntries.length} 章`,
        chapterCount: chEntries.length,
        sourceDir: comicDir
      })
    }
  }
  return comics
})

// --- 从下载目录一键导出（多路径查找） ---
ipcMain.handle('export:fromDownload', async (_, { comicTitle, format, chapters: clientChapters, meta, volumeMode, chaptersPerVolume, imageQuality: imgQuality }) => {
  const root = findComicDir(comicTitle) || path.join(getPrimaryDownloadRoot(), sanitize(comicTitle))
  if (!fs.existsSync(root)) throw new Error(`下载目录不存在: ${root}`)

  // 如果前端传了章节列表，直接使用；否则扫描磁盘
  let chapters = clientChapters
  if (!chapters || !chapters.length) {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    chapters = entries
      .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
      .sort((a, b) => {
        const na = parseInt(a.name.match(/^\d+/)[0], 10)
        const nb = parseInt(b.name.match(/^\d+/)[0], 10)
        return na - nb
      })
      .map((d, i) => ({ name: d.name.replace(/^\d+-/, ''), dir: path.join(root, d.name), index: i }))
  } else {
    // 将前端传的章节索引转换为真实路径
    chapters = chapters.map(ch => {
      const folderName = `${ch.index + 1}-${sanitize(ch.name)}`
      return { name: ch.name, dir: path.join(root, folderName), index: ch.index }
    })
  }

  if (!chapters.length) throw new Error('没有已下载的章节')

  const outputPath = path.join(app.getPath('downloads'), `${sanitize(comicTitle)}.${format}`)
  const opts = {
    sourceDir: root,
    outputPath,
    title: comicTitle,
    chapters,
    onProgress: (p) => console.log(`[导出] ${comicTitle}: ${p.current}/${p.total}`),
    meta: meta || undefined
  }

  // EPUB 分卷支持
  if (format === 'epub' && volumeMode !== 'single') {
    opts.chaptersPerVolume = chaptersPerVolume || 50
  }
  // EPUB 图片质量
  if (format === 'epub' && imgQuality) {
    opts.imageQuality = imgQuality
  }

  if (format === 'epub') {
    const result = await exporter.toEPUB(opts)
    // 分卷时 result 是数组
    if (Array.isArray(result)) {
      return { success: true, paths: result, volumeCount: result.length }
    }
    return { success: true, path: result }
  } else {
    const result = await exporter.toCBZ(opts)
    return { success: true, path: result }
  }
})

// --- 检查 EPUB 是否已生成 ---
ipcMain.handle('export:checkEpubExists', async (_, comicTitle) => {
  const epubPath = path.join(app.getPath('downloads'), `${sanitize(comicTitle)}.epub`)
  return fs.existsSync(epubPath)
})

// --- 获取已下载漫画的章节列表（供 EpubGen.vue 章节选择使用，多路径查找） ---
ipcMain.handle('export:getDownloadChapters', async (_, comicTitle) => {
  const root = findComicDir(comicTitle)
  if (!root || !fs.existsSync(root)) return []
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
    .sort()
  return entries.map((d, i) => {
    const folderName = d.name
    const name = folderName.replace(/^\d+-/, '')
    let imageCount = 0
    try {
      imageCount = fs.readdirSync(path.join(root, folderName))
        .filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f)).length
    } catch {}
    return { index: i, name, folderName, imageCount }
  })
})

// --- Window management ---
function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 680, minWidth: 900, minHeight: 400,
    resizable: true, frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#FFF8F0',
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true
    }
  })
  // 隐藏 macOS traffic light 按钮（红黄绿圆点），使用自定义窗口按钮
  if (process.platform === 'darwin') {
    try { win.setWindowButtonVisibility(false) } catch (_) {}
  }
  win.on('maximize', () => win.webContents.send('window:maximize-change', true))
  win.on('unmaximize', () => win.webContents.send('window:maximize-change', false))
  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle('app:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.handle('app:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  if (w.isMaximized()) w.unmaximize(); else w.maximize()
})
ipcMain.handle('app:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
ipcMain.handle('app:isMaximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w?.isMaximized() || false
})
ipcMain.handle('app:toggleFullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return false
  const next = !w.isFullScreen()
  w.setFullScreen(next)
  return next
})
ipcMain.handle('app:isFullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w?.isFullScreen() || false
})
ipcMain.handle('app:exitFullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w && w.isFullScreen()) w.setFullScreen(false)
})

// ============ 本地漫画导入 API ============

ipcMain.handle('import:scanComics', async (_, dirPath) => {
  return db.scanLocalComics(dirPath)
})

ipcMain.handle('import:commitComic', async (_, { comic, sourceUrl }) => {
  const targetRoot = EXTERNAL_ROOT
  const preferred = path.join(targetRoot, sanitize(comic.title))
  const destDir = resolveUniqueComicDir(preferred, sourceUrl)
  return db.importLocalComic(comic, targetRoot, sourceUrl, destDir)
})

ipcMain.handle('import:matchSource', async (_, title) => {
  const source = sources.get('smtt6') || sources.default
  const results = await source.search(title, 1)
  if (results && results.length > 0) {
    const matches = results.filter(r => r.title.includes(title) || title.includes(r.title))
    return matches.length > 0 ? matches[0] : results[0]
  }
  return null
})

// 弹出文件夹选择对话框
ipcMain.handle('import:pickDirectory', async (e) => {
  const { dialog } = require('electron')
  const win = BrowserWindow.fromWebContents(e.sender)
  const result = await dialog.showOpenDialog(win, {
    title: '选择包含漫画的目录',
    properties: ['openDirectory'],
    defaultPath: require('os').homedir()
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// 扫描主下载目录（同时扫描多个候选路径）
ipcMain.handle('import:scanPrimaryDownload', async () => {
  const roots = getDownloadRoots()
  const existingRoots = roots.filter(r => fs.existsSync(r))
  if (existingRoots.length === 0) return []

  let allComics = []
  for (const root of existingRoots) {
    try {
      const comics = await db.scanLocalComics(root)
      for (const c of comics) {
        if (!allComics.find(x => x.title === c.title)) {
          allComics.push(c)
        }
      }
    } catch (e) {
      console.warn(`扫描下载目录失败 (${root}):`, e.message)
    }
  }
  return allComics
})

// 直接注册到数据库，不复制文件
ipcMain.handle('import:registerExisting', async (_, { comic, sourceUrl }) => {
  return db.registerExistingDownload(comic, sourceUrl)
})

// 批量检查扫描到的漫画是否已存在于数据库中
ipcMain.handle('import:checkExistingInDB', async (_, comicTitles) => {
  return db.checkExistingByTitle(comicTitles)
})

// ============ 磁盘文件名修复：将老版本目录名对齐到当前项目 sanitize() 规则 ============

function _normName(s) {
  // 与全局 normalizeName 保持一致（只保留 CJK/字母/数字）
  return normalizeName(s)
}

/** 在数据库中查找标题与磁盘目录名 normalize 后一致的漫画（返回 comic 数据 + 章节列表） */
async function _matchComicInDB(dirName) {
  const raw = db.getRawDB()
  if (!raw) return null
  const normDir = _normName(dirName)
  if (!normDir) return null

  // 1) 先直接从 download_records 里按 comic_title 匹配
  try {
    const r1 = raw.exec('SELECT DISTINCT comic_id, comic_title FROM download_records')
    if (r1.length > 0) {
      for (const row of r1[0].values) {
        const [comicId, comicTitle] = row
        if (_normName(String(comicTitle || '')) === normDir) {
          // 找到对应漫画的章节信息
          const r2 = raw.exec(
            'SELECT name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order',
            [comicId]
          )
          const chapters = r2.length > 0 ? r2[0].values.map(v => ({ name: v[0], index: v[1] })) : []
          return { comicId, title: comicTitle, chapters }
        }
      }
    }
  } catch (_) {}

  // 2) 再从 comics 主表中按 title 匹配
  try {
    const r3 = raw.exec('SELECT id, title FROM comics')
    if (r3.length > 0) {
      for (const row of r3[0].values) {
        const [comicId, title] = row
        if (_normName(String(title || '')) === normDir) {
          const r4 = raw.exec(
            'SELECT name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order',
            [comicId]
          )
          const chapters = r4.length > 0 ? r4[0].values.map(v => ({ name: v[0], index: v[1] })) : []
          return { comicId, title, chapters }
        }
      }
    }
  } catch (_) {}
  return null
}

/** 安全地重命名目录：目标已存在则加 -fix 后缀避免冲突 */
function _safeRename(src, dst) {
  if (src === dst) return dst
  if (!fs.existsSync(src)) return null
  let final = dst
  let i = 1
  while (fs.existsSync(final)) {
    final = `${dst}-fix${i}`
    i++
  }
  try {
    fs.renameSync(src, final)
    return final
  } catch (e) {
    console.warn(`[fixDisk] 重命名失败: ${src} -> ${final}: ${e.message}`)
    return null
  }
}

/**
 * 扫描 EXTERNAL_ROOT，对每个漫画目录：
 *   - 如果目录名不符合 sanitize(数据库标题)，则重命名
 *   - 对每个章节目录，如果不符合 `序号-sanitize(章节名)`，则重命名
 * 返回统计报告
 */
ipcMain.handle('cache:fixDiskNames', async () => {
  if (!fs.existsSync(EXTERNAL_ROOT)) {
    return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
  }

  db.initDB()

  const report = {
    scannedDirs: 0,
    matchedComics: 0,
    unmatchedDirs: [],
    renamedComicDirs: [],
    renamedChapterDirs: [],
    skippedChapterDirs: [],
    errors: []
  }

  try {
    const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      report.scannedDirs++

      const dirName = entry.name
      const oldPath = path.join(EXTERNAL_ROOT, dirName)

      // 尝试在数据库中匹配
      const matched = await _matchComicInDB(dirName)
      if (!matched) {
        report.unmatchedDirs.push(dirName)
        continue
      }
      report.matchedComics++

      // --- 修复漫画目录名 ---
      const expectedComicDir = sanitize(matched.title)
      const expectedComicPath = path.join(EXTERNAL_ROOT, expectedComicDir)
      let currentComicPath = oldPath

      if (dirName !== expectedComicDir) {
        const renamed = _safeRename(oldPath, expectedComicPath)
        if (renamed) {
          currentComicPath = renamed
          report.renamedComicDirs.push({
            old: dirName,
            new: expectedComicDir
          })
        } else {
          report.errors.push(`漫画目录重命名失败: ${dirName}`)
        }
      }

      // --- 修复章节目录名 ---
      try {
        const chEntries = fs.readdirSync(currentComicPath, { withFileTypes: true })
        const chapterDirs = chEntries
          .filter(e => e.isDirectory())
          .map(e => e.name)

        for (const chDirName of chapterDirs) {
          // 解析开头的序号
          const m = chDirName.match(/^(\d+)/)
          if (!m) continue
          const chIdx = parseInt(m[1], 10) - 1

          // 在章节列表中查找对应序号的章节（数据库的 sort_order 从 0 开始）
          const dbChapter = matched.chapters.find(c => c.index === chIdx)
          if (!dbChapter) {
            report.skippedChapterDirs.push(`${matched.title}/${chDirName}`)
            continue
          }

          const expectedChapterDir = `${chIdx + 1}-${sanitize(dbChapter.name)}`
          if (chDirName !== expectedChapterDir) {
            const oldChPath = path.join(currentComicPath, chDirName)
            const newChPath = path.join(currentComicPath, expectedChapterDir)
            const renamed = _safeRename(oldChPath, newChPath)
            if (renamed) {
              report.renamedChapterDirs.push({
                comic: matched.title,
                old: chDirName,
                new: expectedChapterDir
              })
            } else {
              report.errors.push(`章节目录重命名失败: ${matched.title}/${chDirName}`)
            }
          }
        }
      } catch (e) {
        report.errors.push(`扫描 ${matched.title} 章节失败: ${e.message}`)
      }
    }
  } catch (e) {
    report.errors.push(`扫描根目录失败: ${e.message}`)
  }

  return { success: true, report }
})

// ============ 扫描磁盘提取老版本漫画/章节命名（用于对比分析） ============
ipcMain.handle('cache:scanDiskNames', async () => {
  if (!fs.existsSync(EXTERNAL_ROOT)) {
    return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
  }

  const result = {
    root: EXTERNAL_ROOT,
    totalComics: 0,
    comics: []
  }

  try {
    const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      result.totalComics++

      const comicDir = path.join(EXTERNAL_ROOT, entry.name)
      const chDirs = []
      let imageCount = 0
      let hasCover = false

      try {
        const chEntries = fs.readdirSync(comicDir, { withFileTypes: true })
        for (const ch of chEntries) {
          if (ch.isDirectory()) {
            // 统计该章节内的图片数
            let chImgs = 0
            try {
              const files = fs.readdirSync(path.join(comicDir, ch.name))
              chImgs = files.filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f)).length
            } catch (_) {}
            chDirs.push({ name: ch.name, imageCount: chImgs })
            imageCount += chImgs
          } else if (ch.isFile() && ch.name === 'cover.webp') {
            hasCover = true
          }
        }
      } catch (_) {}

      result.comics.push({
        dirName: entry.name,
        chapterCount: chDirs.length,
        totalImages: imageCount,
        hasCover,
        chapters: chDirs
      })
    }
  } catch (e) {
    return { success: false, error: e.message }
  }

  return { success: true, result }
})

// ============ 对比分析：磁盘老版本命名 vs 源站真实命名 ============
ipcMain.handle('cache:analyzeDiskNames', async (_, limit = 20) => {
  if (!fs.existsSync(EXTERNAL_ROOT)) {
    return { success: false, error: `目录不存在: ${EXTERNAL_ROOT}` }
  }

  const source = sources.get('smtt6') || sources.default
  const analysis = {
    total: 0,
    matched: 0,
    unmatched: [],
    samples: []
  }

  try {
    const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
    const comicDirs = entries.filter(e => e.isDirectory()).map(e => e.name)
    analysis.total = comicDirs.length

    // 随机取几个有代表性的目录去查源站
    const sampleDirs = comicDirs.slice(0, limit)

    for (const dirName of sampleDirs) {
      try {
        // 用磁盘目录名去源站搜索
        const searchResults = await source.search(dirName, 1)
        if (!searchResults || searchResults.length === 0) {
          analysis.unmatched.push(dirName)
          continue
        }

        // 取第一个最匹配的结果
        const bestMatch = searchResults[0]
        analysis.matched++

        // 获取该漫画的章节详情
        const detail = await source.getDetail(bestMatch.url)
        const realChapters = (detail?.chapters || []).slice(0, 15) // 只取前15章对比

        // 读取磁盘上的章节目录名
        const chDirsOnDisk = fs.readdirSync(path.join(EXTERNAL_ROOT, dirName), { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .slice(0, 15)

        // 对比分析章节名
        const chapterComparison = []
        for (let i = 0; i < Math.min(realChapters.length, chDirsOnDisk.length); i++) {
          const realChapter = realChapters[i]
          const diskChapter = chDirsOnDisk[i]

          // 从磁盘章节名中提取「序号后的章节名部分」
          const diskMatch = diskChapter.match(/^\d+-(.*)$/)
          const diskChapterName = diskMatch ? diskMatch[1] : diskChapter

          // 当前项目 sanitize 后的章节名
          const currentSanitized = sanitize(realChapter.name)

          chapterComparison.push({
            index: i + 1,
            realName: realChapter.name,
            diskName: diskChapterName,
            currentSanitized,
            // 关键：对比磁盘上的与当前项目是否一致
            matchesCurrent: diskChapterName === currentSanitized,
            // 磁盘与原始章节名的差异
            differsFromReal: diskChapterName !== realChapter.name
          })
        }

        analysis.samples.push({
          diskDirName: dirName,
          realComicTitle: bestMatch.title,
          realComicUrl: bestMatch.url,
          currentSanitized: sanitize(bestMatch.title),
          comicDirMatchesCurrent: dirName === sanitize(bestMatch.title),
          chapters: chapterComparison
        })

      } catch (e) {
        analysis.unmatched.push(`${dirName} (错误: ${e.message})`)
      }
    }
  } catch (e) {
    return { success: false, error: e.message }
  }

  return { success: true, analysis }
})

ipcMain.handle('window:getSize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  return w ? w.getSize() : [1200, 800]
})
ipcMain.handle('window:setSize', (e, w, h) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (win) win.setSize(w, h)
})
ipcMain.handle('window:openPath', (e, p) => require('electron').shell.openPath(p))

// ============ App Lifecycle ============
app.commandLine.appendSwitch('ignore-certificate-errors')
app.whenReady().then(async () => {
  // 启动图片代理服务器（优先于缓存注册）
  startImageProxyServer()

  // 注册自定义协议（必须在 app.ready 后）
  protocol.registerFileProtocol('comic-cache', (request, callback) => {
    try {
      const filePath = decodeURIComponent(request.url.replace('comic-cache://', ''))
      callback({ path: path.join(cache.CACHE_ROOT || app.getPath('userData'), 'cache', filePath) })
    } catch {
      callback({ statusCode: 404 })
    }
  })

  db.initDB()
  console.log('[DB] SQLite 数据库就绪')
  await cache.warmup()
  console.log('[Cache] 图片缓存就绪')
  initJobQueue()
  createWindow()
  
  // 启动时自动扫描本地漫画（如果配置了）
  setTimeout(async () => {
    try {
      // 直接读取 settings.json
      const settingsPath = path.join(app.getPath('userData'), 'settings.json')
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (settings.autoScanOnStartup && settings.autoScanPaths && settings.autoScanPaths.length > 0) {
          console.log('[AutoScan] 启动自动扫描，路径:', settings.autoScanPaths)
          const result = await db.autoScanLocalComics(settings.autoScanPaths, sources)
          console.log(`[AutoScan] 完成: 扫描 ${result.total} 本，新增 ${result.imported} 本，联网匹配 ${result.matched} 本`)
        } else {
          console.log('[AutoScan] 未配置自动扫描或路径为空')
        }
      }
    } catch (e) {
      console.warn('[AutoScan] 自动扫描失败:', e.message)
    }
  }, 5000)  // 延迟 5 秒，等 app 完全启动
  
  ensureGlobalCrawlForwarder()
  ensureGlobalBackgroundTaskForwarder()
  startAutoTasks()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})