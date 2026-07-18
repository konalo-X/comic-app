'use strict'

const { sleep } = require('../utils')

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
      if (cancelled && cancelled()) break
      const ch = chaptersToCheck[i]
      try {
        const pageList = await source.getPageList(ch.url, comic.sourceUrl, cancelled)
        const images = Array.isArray(pageList) ? pageList : (pageList.images || [])
        const h2Name = (!Array.isArray(pageList) && pageList.chapterName) ? pageList.chapterName : ''

        if (ch.url) {
          imageCountUpdates.push({ url: ch.url, image_count: images.length })
        }
        if (h2Name && h2Name.trim() && h2Name.trim() !== ch.name) {
          chapterNameUpdates.push({ index: ch.index, name: h2Name.trim() })
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
      category: detail.category || deriveCategoryFromTags(detail.tags, comic.tags),
      chapters: detail.chapters,
      updateTime: detail.updateTime || comic.updateTime
    }

    await db.upsertComic(enriched)
    return enriched
  }

  return { enrichChapters, enrichComicMetadata, deriveCategoryFromTags }
}

module.exports = { createEnrichService }