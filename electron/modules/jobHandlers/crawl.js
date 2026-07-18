'use strict'

const sources = require('../../sources/registry')
const db = require('../../db')
const { sleep } = require('../../utils')

async function jobHandlerCrawlAll(job, onProgress) {
  const source = sources.default
  let pageNum = 0, totalSaved = 0, totalNew = 0, totalSkipped = 0, totalFailedPages = 0
  let consecutiveEmpty = 0
  let knownTotalPages = 0
  let reportedTotalCount = 0
  const MAX_EMPTY_PAGES = 3
  const MAX_RETRY_PER_PAGE = 5
  const PAGE_DELAY_MIN = 3000
  const PAGE_DELAY_MAX = 6000
  const savedPage = job.payload?.page ?? 0
  pageNum = savedPage
  const startUrl = job.payload?.startUrl || `${source.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/1`
  console.log('[crawl] jobHandlerCrawlAll started, startUrl=', startUrl, 'resumePage=', pageNum)
  onProgress({ page: 0, total: 0, msg: '初始化爬虫...' })

  onProgress({ page: 0, total: 0, msg: '正在连接服务器...' })
  try {
    await Promise.race([
      source.search('', 1, job.cancelled),
      new Promise((_, reject) => setTimeout(() => reject(new Error('预热超时')), 30000))
    ])
    onProgress({ page: 0, total: 0, msg: '连接成功，开始爬取...' })
  } catch (e) {
    console.warn('[crawl] 预热失败（继续爬取）:', e.message)
    onProgress({ page: 0, total: 0, msg: '服务器响应较慢，继续爬取...' })
  }

  while (pageNum < (knownTotalPages || 150)) {
    if (job.cancelled()) return { total: totalSaved, pages: pageNum, failed: totalFailedPages, msg: '已取消' }
    pageNum++
    onProgress({ page: pageNum, total: totalSaved, msg: `正在爬取第 ${pageNum} 页...` })

    let items = []
    let pageSuccess = false
    let lastError = null

    for (let retry = 0; retry < MAX_RETRY_PER_PAGE; retry++) {
      if (job.cancelled()) break
      try {
        const result = await source.getPopular(pageNum, job.cancelled)
        if (result && Array.isArray(result.items)) {
          items = result.items
          if (result.totalPages > 0) {
            knownTotalPages = result.totalPages
            reportedTotalCount = result.totalCount || 0
          }
        } else {
          items = result || []
        }
        pageSuccess = true
        break
      } catch (e) {
        if (e.message === 'cancelled') break
        lastError = e
        const isConnReset = e.message?.includes('ECONNRESET')
        console.warn(`[crawl] 第 ${pageNum} 页第 ${retry + 1} 次尝试失败:`, e.message)
        if (retry < MAX_RETRY_PER_PAGE - 1) {
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

    // 第一页：打印网站报告的总漫画数和总页数
    if (pageNum === 1 && (reportedTotalCount > 0 || knownTotalPages > 0)) {
      console.log(`[crawl] 网站报告：共 ${reportedTotalCount} 部漫画，${knownTotalPages} 页`)
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
  console.log('[crawl] finished, pages=', pageNum, 'totalNew=', totalNew, 'skipped=', totalSkipped, 'failedPages=', totalFailedPages, 'reportedTotal=', reportedTotalCount, 'reportedPages=', knownTotalPages)
  return { total: totalSaved, pages: pageNum, skipped: totalSkipped, failed: totalFailedPages, reportedTotal: reportedTotalCount, reportedPages: knownTotalPages, msg: `新增 ${totalNew} 部，跳过 ${totalSkipped} 部，失败 ${totalFailedPages} 页` }
}

module.exports = { jobHandlerCrawlAll }