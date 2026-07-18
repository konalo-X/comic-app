'use strict'

const { sleep } = require('../utils')

function createEnrichService({ db, sources, jobQueue }) {
  async function _sleepWithCancel(ms, cancelledFn) {
    if (!cancelledFn) return sleep(ms)
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cancelledFn()) throw new Error('cancelled')
      await sleep(Math.min(500, ms - (Date.now() - start)))
    }
  }

  async function enrichChapters(comic, chaptersToCheck, source, cancelled) {
    const imageCountUpdates = []
    const chapterNameUpdates = []

    for (let i = 0; i < chaptersToCheck.length; i++) {
      if (cancelled()) break
      const ch = chaptersToCheck[i]
      try {
        const pageList = await source.getPageList(ch.url, cancelled)
        if (pageList && pageList.length > 0) {
          imageCountUpdates.push({ url: ch.url, image_count: pageList.length })
        }
        if (ch.name && db.isChapterNameGeneric(ch.name) && pageList && pageList.length > 0) {
          const enrichedName = await source.getChapterName(ch.url, cancelled)
          if (enrichedName && !db.isChapterNameGeneric(enrichedName)) {
            chapterNameUpdates.push({ index: ch.index, name: enrichedName })
          }
        }
      } catch (e) {
        if (e.message === 'cancelled') break
      }
      if (i < chaptersToCheck.length - 1) {
        await _sleepWithCancel(250, cancelled)
      }
    }

    return { imageCountUpdates, chapterNameUpdates }
  }

  async function enrichComicMetadata(comic, source, cancelled) {
    const detail = await source.getDetail(comic.sourceUrl, cancelled)
    if (!detail) return null

    const enriched = {
      sourceUrl: comic.sourceUrl,
      title: detail.title || comic.title,
      cover: detail.cover || comic.cover,
      author: detail.author,
      status: detail.status,
      desc: detail.desc,
      tags: detail.tags,
      category: detail.category,
      chapters: detail.chapters,
      updateTime: detail.updateTime || comic.updateTime
    }

    await db.upsertComic(enriched)
    return enriched
  }

  return { enrichChapters, enrichComicMetadata }
}

module.exports = { createEnrichService }