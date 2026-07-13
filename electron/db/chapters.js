'use strict'

const { ensureDb, loadChapterList } = require('./helpers')

async function updateChapterImageCounts(comicId, chaptersWithCounts) {
  const db = ensureDb()
  if (!chaptersWithCounts || chaptersWithCounts.length === 0) return
  const updateStmt = db.prepare('UPDATE chapters SET image_count = ? WHERE comic_id = ? AND url = ?')
  const updateAll = db.transaction(() => {
    for (const ch of chaptersWithCounts) {
      if (ch.url) {
        updateStmt.run(ch.image_count || 0, comicId, ch.url)
      }
    }
  })
  updateAll()
  return chaptersWithCounts.length
}

async function updateChapterImageCountBySourceUrl(sourceUrl, chapterIndex, imageCount) {
  const db = ensureDb()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  db.prepare('UPDATE chapters SET image_count = ? WHERE comic_id = ? AND sort_order = ?').run(
    imageCount || 0, row.id, chapterIndex
  )
  return 1
}

async function getComicsNeedingImageCountUpdate(batchSize) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT DISTINCT c.id, c.sourceUrl, c.title, c.chapter_count
     FROM comics c
     INNER JOIN chapters ch ON ch.comic_id = c.id
     WHERE (ch.image_count IS NULL OR ch.image_count = 0) AND ch.url IS NOT NULL AND ch.url != ''
     ORDER BY c.chapter_count DESC, c.id
     LIMIT ?`
  ).all(batchSize)
  return rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count
  }))
}

async function getChaptersWithoutImageCount(comicId) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT sort_order, name, url FROM chapters WHERE comic_id = ? AND (image_count IS NULL OR image_count = 0) AND url IS NOT NULL AND url != '' ORDER BY sort_order`
  ).all(comicId)
  return rows.map(r => ({
    index: r.sort_order,
    name: r.name,
    url: r.url
  }))
}

function isChapterNameGeneric(name) {
  if (!name) return true
  const trimmed = String(name).trim()
  const genericPatterns = [
    /^第\s*\d+\s*[话話章回集]$/,
    /^ch(apter)?\s*\d+$/i,
    /^episode\s*\d+$/i,
    /^ep\s*\d+$/i
  ]
  return genericPatterns.some(p => p.test(trimmed))
}

async function getComicsWithGenericChapterNames(batchSize = 10) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT DISTINCT c.id, c.sourceUrl, c.title, c.chapter_count, c.chapter_names_enriched
     FROM comics c
     INNER JOIN chapters ch ON ch.comic_id = c.id
     WHERE c.chapter_count > 0
       AND c.sourceUrl IS NOT NULL AND c.sourceUrl != ''
       AND (
         ch.name IS NULL OR ch.name = ''
         OR ch.name GLOB '第*[0-9]*话'
         OR ch.name GLOB '第*[0-9]*話'
         OR ch.name GLOB '第*[0-9]*章'
         OR ch.name GLOB '第*[0-9]*回'
         OR ch.name GLOB '第*[0-9]*集'
       )
     ORDER BY c.chapter_count DESC
     LIMIT ?`
  ).all(batchSize)
  return rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count || 0,
    chapter_names_enriched: r.chapter_names_enriched || 0
  }))
}

async function getComicsNeedingChapterNameEnrichment(batchSize = 10) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT id, sourceUrl, title, chapter_count, chapter_names_enriched
     FROM comics
     WHERE chapter_count > 0 AND (chapter_names_enriched = 0 OR chapter_names_enriched IS NULL)
     ORDER BY chapter_count DESC
     LIMIT ?`
  ).all(batchSize)
  const docs = rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count || 0,
    chapter_names_enriched: r.chapter_names_enriched || 0
  }))
  for (const doc of docs) {
    doc.chapters = loadChapterList(db, doc._id)
  }
  return docs
}

async function updateChapterName(comicId, sortOrder, newName) {
  const db = ensureDb()
  db.prepare('UPDATE chapters SET name = ? WHERE comic_id = ? AND sort_order = ?').run(newName || '', comicId, sortOrder)
}

async function updateChapterNames(comicId, updates) {
  const db = ensureDb()
  if (!updates || updates.length === 0) return 0
  const updateStmt = db.prepare('UPDATE chapters SET name = ? WHERE comic_id = ? AND sort_order = ?')
  const updateAll = db.transaction(() => {
    for (const u of updates) {
      updateStmt.run(u.name || '', comicId, u.index)
    }
  })
  updateAll()
  return updates.length
}

async function markComicChaptersEnriched(comicId) {
  const db = ensureDb()
  db.prepare('UPDATE comics SET chapter_names_enriched = 1, updatedAt = ? WHERE id = ?').run(Date.now(), comicId)
}

module.exports = {
  updateChapterImageCounts, updateChapterImageCountBySourceUrl,
  getComicsNeedingImageCountUpdate, getChaptersWithoutImageCount,
  isChapterNameGeneric, getComicsWithGenericChapterNames,
  getComicsNeedingChapterNameEnrichment,
  updateChapterName, updateChapterNames, markComicChaptersEnriched
}