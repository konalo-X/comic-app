'use strict'

const { sleep } = require('../utils')

function createCrawlService({ db, sources, jobQueue }) {
  const source = sources.default

  async function _sleepWithCancel(ms, cancelledFn) {
    if (!cancelledFn) return sleep(ms)
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cancelledFn()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  async function crawlAll({ resumePage = 0, startUrl, onProgress, cancelled }) {
    const MAX_EMPTY_PAGES = 3
    const MAX_RETRY_PER_PAGE = 5
    const PAGE_DELAY_MIN = 3000
    const PAGE_DELAY_MAX = 6000

    let pageNum = resumePage
    let totalSaved = 0, totalNew = 0, totalSkipped = 0, totalFailedPages = 0
    let consecutiveEmpty = 0
    let knownTotalPages = 0
    let reportedTotalCount = 0

    const baseUrl = startUrl || `${source.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/1`

    onProgress({ page: 0, total: 0, msg: '正在连接服务器...' })
    await _warmup(source, cancelled, onProgress)

    while (pageNum < (knownTotalPages || 150)) {
      if (cancelled()) return { total: totalSaved, pages: pageNum, cancelled: true }

      pageNum++
      onProgress({ page: pageNum, total: totalSaved, msg: `正在爬取第 ${pageNum} 页...` })

      const result = await _fetchPage(source, pageNum, cancelled, MAX_RETRY_PER_PAGE)
      if (result === null) {
        totalFailedPages++
        if (totalFailedPages >= 10) break
        await _sleepWithCancel(PAGE_DELAY_MIN + Math.random() * (PAGE_DELAY_MAX - PAGE_DELAY_MIN), cancelled)
        continue
      }

      const { items, totalPages, totalCount } = result

      if (totalPages > 0) knownTotalPages = totalPages
      if (totalCount > 0) reportedTotalCount = totalCount

      if (pageNum === 1 && (reportedTotalCount > 0 || knownTotalPages > 0)) {
        console.log(`[crawlService] 网站报告：共 ${reportedTotalCount} 部漫画，${knownTotalPages} 页`)
      }

      if (items.length > 0) {
        consecutiveEmpty = 0
        const { saved, skipped, newCount } = await _saveComics(db, items)
        totalSaved += saved
        totalNew += newCount
        totalSkipped += skipped
        onProgress({ page: pageNum, total: totalSaved, msg: `第 ${pageNum} 页：新增 ${newCount} 部，跳过 ${skipped} 部（累计新增 ${totalNew}）` })
      } else {
        consecutiveEmpty++
        if (consecutiveEmpty >= MAX_EMPTY_PAGES) {
          onProgress({ page: pageNum, total: totalSaved, msg: '已爬完所有可用页面' })
          break
        }
        onProgress({ page: pageNum, total: totalSaved, msg: `第 ${pageNum} 页为空（${consecutiveEmpty}/${MAX_EMPTY_PAGES}）` })
      }

      await _sleepWithCancel(PAGE_DELAY_MIN + Math.random() * (PAGE_DELAY_MAX - PAGE_DELAY_MIN), cancelled)
    }

    return { total: totalSaved, pages: pageNum, skipped: totalSkipped, failed: totalFailedPages, reportedTotal: reportedTotalCount, reportedPages: knownTotalPages }
  }

  async function _warmup(source, cancelled, onProgress) {
    let warmupTimer = null
    try {
      await Promise.race([
        source.search('', 1, cancelled),
        new Promise((_, reject) => { warmupTimer = setTimeout(() => reject(new Error('预热超时')), 30000) })
      ])
      onProgress({ page: 0, total: 0, msg: '连接成功，开始爬取...' })
    } catch (e) {
      onProgress({ page: 0, total: 0, msg: '服务器响应较慢，继续爬取...' })
    } finally {
      if (warmupTimer) clearTimeout(warmupTimer)
    }
  }

  async function _fetchPage(source, pageNum, cancelled, maxRetries) {
    for (let retry = 0; retry < maxRetries; retry++) {
      if (cancelled()) return null
      try {
        const result = await source.getPopular(pageNum, cancelled)
        const items = (result && Array.isArray(result.items)) ? result.items : (result || [])
        return { items, totalPages: result?.totalPages || 0, totalCount: result?.totalCount || 0 }
      } catch (e) {
        if (e.message === 'cancelled') return null
        const isConnReset = e.message?.includes('ECONNRESET')
        console.warn(`[crawlService] 第 ${pageNum} 页第 ${retry + 1} 次失败:`, e.message)
        if (retry < maxRetries - 1) {
          const waitMs = isConnReset ? (retry + 1) * 5000 + Math.random() * 3000 : (retry + 1) * 2000 + Math.random() * 1000
          await _sleepWithCancel(waitMs, cancelled)
        }
      }
    }
    return null
  }

  async function _saveComics(db, items) {
    const sourceUrls = items.map(i => i.sourceUrl)
    const existingUrls = await db.getExistingSourceUrls(sourceUrls)
    const newItems = items.filter(item => !existingUrls.has(item.sourceUrl))
    const existingItems = items.filter(item => existingUrls.has(item.sourceUrl))

    let saved = 0, skipped = existingItems.length

    if (newItems.length > 0) {
      const results = await db.upsertComics(newItems)
      saved = results.length
    }
    if (existingItems.length > 0) {
      await db.updateComicListMeta(existingItems)
    }

    return { saved, skipped, newCount: newItems.length }
  }

  return { crawlAll }
}

module.exports = { createCrawlService }