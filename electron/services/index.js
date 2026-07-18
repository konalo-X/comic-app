'use strict'

const db = require('../db')
const sources = require('../sources/registry')
const { createCrawlService } = require('./crawlService')
const { createSyncService } = require('./syncService')
const { createEnrichService } = require('./enrichService')
const { createDownloadService } = require('./downloadService')
const { createRepairService } = require('./repairService')

function initServices(jobQueue) {
  const crawl = createCrawlService({ db, sources, jobQueue })
  const sync = createSyncService({ db, sources, jobQueue })
  const enrich = createEnrichService({ db, sources, jobQueue })
  const download = createDownloadService({ db, sources, jobQueue })
  const repair = createRepairService({ db, sources, jobQueue })

  return { crawl, sync, enrich, download, repair }
}

module.exports = { initServices }