'use strict'

const { sleep } = require('../utils')

function createRepairService({ db, sources, jobQueue }) {
  async function _sleepWithCancel(ms, cancelledFn) {
    if (!cancelledFn) return sleep(ms)
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cancelledFn()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  async function repairComic(comic, { cancelled, onProgress }) {
    const chapters = comic.chapters || []
    const problemChapters = []

    for (let i = 0; i < chapters.length; i++) {
      if (cancelled()) return { repaired: problemChapters.length, cancelled: true }
      const ch = chapters[i]
      if (!ch.path || ch.imageCount === 0) {
        problemChapters.push({ index: i, name: ch.name, url: ch.url })
      }
    }

    let repaired = 0
    for (let pi = 0; pi < problemChapters.length; pi++) {
      if (cancelled()) return { repaired, cancelled: true }
      const ch = problemChapters[pi]

      try {
        const source = sources.default
        const pageList = await source.getPageList(ch.url, cancelled)
        if (pageList && pageList.length > 0) {
          await db.updateChapterImageCountBySourceUrl(comic.sourceUrl, ch.index, pageList.length)
          repaired++
        }
      } catch (e) {
        if (e.message === 'cancelled') return { repaired, cancelled: true }
      }

      onProgress({ current: pi + 1, total: problemChapters.length, msg: `修复: ${ch.name}` })

      if (pi < problemChapters.length - 1) {
        await _sleepWithCancel(1500 + Math.random() * 1500, cancelled)
      }
    }

    return { repaired, total: problemChapters.length }
  }

  return { repairComic }
}

module.exports = { createRepairService }