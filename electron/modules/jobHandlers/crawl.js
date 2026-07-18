'use strict'

const sources = require('../../sources/registry')
const db = require('../../db')
const { createCrawlService } = require('../../services/crawlService')

let _crawlService = null

function getCrawlService() {
  if (!_crawlService) {
    _crawlService = createCrawlService({ db, sources, jobQueue: null })
  }
  return _crawlService
}

async function jobHandlerCrawlAll(job, onProgress) {
  const service = getCrawlService()
  const result = await service.crawlAll({
    resumePage: job.payload?.page ?? 0,
    startUrl: job.payload?.startUrl,
    onProgress,
    cancelled: () => job.cancelled()
  })

  if (result.cancelled) return { total: result.total, pages: result.pages, msg: '已取消' }

  return {
    total: result.total,
    pages: result.pages,
    skipped: result.skipped,
    failed: result.failed,
    reportedTotal: result.reportedTotal,
    reportedPages: result.reportedPages,
    msg: `新增 ${result.total - result.skipped} 部，跳过 ${result.skipped} 部，失败 ${result.failed} 页`
  }
}

module.exports = { jobHandlerCrawlAll }