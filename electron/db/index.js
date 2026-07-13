'use strict'

const core = require('./core')
const comics = require('./comics')
const chapters = require('./chapters')
const reading = require('./reading')
const downloads = require('./downloads')
const crawl = require('./crawl')
const imp = require('./import')

const exportSources = [core, comics, chapters, reading, downloads, crawl, imp]
const publicApi = {}

for (const source of exportSources) {
  for (const [name, value] of Object.entries(source)) {
    if (name in publicApi) {
      console.warn(`[DB] 导出冲突: "${name}" 被多个模块导出，后者覆盖了前者`)
    }
    publicApi[name] = value
  }
}

module.exports = publicApi