'use strict'

const { sleep } = require('../utils')

function createDownloadService({ db, sources, jobQueue }) {
  async function _sleepWithCancel(ms, cancelledFn) {
    if (!cancelledFn) return sleep(ms)
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cancelledFn()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  async function downloadChapter({ comicTitle, chapter, referer, sourceUrl, coverUrl, comicDir, cancelled, onProgress }) {
    const source = sources.default
    const pageList = await source.getPageList(chapter.url, cancelled)

    if (!pageList || pageList.length === 0) {
      return { success: false, error: '获取图片列表失败' }
    }

    const total = pageList.length
    let downloaded = 0

    for (let i = 0; i < total; i++) {
      if (cancelled()) return { success: false, cancelled: true, downloaded }

      try {
        const imgData = await source.getImage(pageList[i], referer, cancelled)
        downloaded++
        onProgress({ current: i + 1, total, chapter: chapter.name })
      } catch (e) {
        if (e.message === 'cancelled') return { success: false, cancelled: true, downloaded }
      }

      if (i < total - 1) {
        await _sleepWithCancel(500 + Math.random() * 1000, cancelled)
      }
    }

    return { success: true, downloaded, total }
  }

  return { downloadChapter }
}

module.exports = { createDownloadService }