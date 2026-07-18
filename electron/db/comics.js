'use strict'

const core = require('./core')
const { ensureDb, loadChapterList, mapRows, buildWhereClause, buildOrderClause, buildComicQuery } = require('./helpers')

const COMIC_SELECT_FIELDS = [
  'id', 'sourceUrl', 'title', 'cover', 'local_cover', 'author', 'status', 'desc_text', 'tags', 'category',
  'updateTime', 'chapter_count', 'update_delta', 'favorited', 'createdAt', 'updatedAt', 'local_path'
].join(', ')

const COMIC_SELECT_FIELDS_PREFIXED = [
  'comics.id', 'comics.sourceUrl', 'comics.title', 'comics.cover', 'comics.local_cover', 'comics.author', 'comics.status', 'comics.desc_text', 'comics.tags', 'comics.category',
  'comics.updateTime', 'comics.chapter_count', 'comics.update_delta', 'comics.favorited', 'comics.createdAt', 'comics.updatedAt', 'comics.local_path'
].join(', ')

// COUNT 缓存：避免每次翻页都 COUNT(*) 全表扫描
const _countCache = new Map()
const COUNT_CACHE_TTL = 30 * 1000

function _getCachedCount(cacheKey, db, whereClause, params) {
  const cached = _countCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < COUNT_CACHE_TTL) {
    return cached.count
  }
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM comics ${whereClause}`).get(...params)
  const count = countRow ? countRow.c : 0
  _countCache.set(cacheKey, { count, ts: Date.now() })
  return count
}

function mapRowsToComics(rows, opts = {}) {
  return mapRows(rows, row => core.rowToComic(row, opts))
}

function loadComicsWithChapters(db, rows, opts = {}) {
  const docs = mapRowsToComics(rows, opts)
  if (docs.length === 0) return docs

  const comicIds = docs.map(doc => doc._id)
  const placeholders = comicIds.map(() => '?').join(',')
  const chRows = db.prepare(
    `SELECT comic_id, name, url FROM chapters WHERE comic_id IN (${placeholders}) ORDER BY sort_order`
  ).all(...comicIds)

  const chapterMap = {}
  for (const row of chRows) {
    if (!chapterMap[row.comic_id]) chapterMap[row.comic_id] = []
    chapterMap[row.comic_id].push({ name: row.name, url: row.url })
  }

  for (const doc of docs) {
    doc.chapters = chapterMap[doc._id] || []
  }

  return docs
}

function _upsertComicInternal(comic, now) {
  _countCache.clear()
  const db = core.getDB()
  const existing = db.prepare(
    `SELECT id, title, cover, tags, category, chapter_count, author, status, desc_text, update_delta, favorited FROM comics WHERE sourceUrl = ?`
  ).get(comic.sourceUrl)

  const tags = Array.isArray(comic.tags) ? comic.tags.join(',') : (comic.tags || '')
  const chapters = Array.isArray(comic.chapters) ? comic.chapters : []
  const chCount = chapters.length

  if (existing) {
    const id = existing.id
    const existingTitle = existing.title || ''
    const existingCover = existing.cover || ''
    const existingTags = existing.tags || ''
    const existingCategory = existing.category || ''
    const existingChCount = existing.chapter_count || 0
    const existingAuthor = existing.author || ''
    const existingStatus = existing.status || ''
    const existingDesc = existing.desc_text || ''
    const existingDelta = existing.update_delta || 0
    const existingFavorited = existing.favorited || 0

    const finalTitle = (comic.title && comic.title.trim()) || existingTitle
    const finalCover = comic.cover || existingCover
    const finalTags = tags || existingTags
    const finalCategory = (comic.category || '') || existingCategory
    const finalChCount = chCount > 0 ? chCount : existingChCount
    const finalAuthor = (comic.author || '') || existingAuthor
    const finalStatus = (comic.status || '') || existingStatus
    const finalDesc = (comic.desc || '') || existingDesc
    let newDelta = existingDelta
    if (chCount > 0 && chCount > existingChCount) {
      newDelta = chCount - existingChCount
    }

    db.prepare(`UPDATE comics SET
      title=?, cover=?, local_cover=COALESCE(?, local_cover),
      author=?, status=?, desc_text=?, tags=?, category=?,
      updateTime=COALESCE(?, updateTime), chapter_count=?,
      update_delta=?, favorited=?,
      chapter_names_enriched=CASE WHEN ? > ? THEN 0 ELSE chapter_names_enriched END,
      local_path=COALESCE(NULLIF(?, ''), local_path), updatedAt=?
      WHERE id=?`).run(
      finalTitle, finalCover, comic.local_cover || null,
      finalAuthor, finalStatus,
      finalDesc, finalTags, finalCategory,
      comic.updateTime ? Number(comic.updateTime) : null,
      finalChCount, newDelta, comic.favorited !== undefined ? comic.favorited : existingFavorited,
      chCount, existingChCount, comic.local_path || null, now, id
    )
    if (chCount > 0) {
      const existingRows = db.prepare('SELECT url, name, sort_order, image_count FROM chapters WHERE comic_id=?').all(id)
      const existingMap = new Map()
      const existingImageCounts = new Map()
      for (const r of existingRows) {
        if (r.url) {
          existingMap.set(r.url, r)
          if (r.image_count > 0) existingImageCounts.set(r.url, r.image_count)
        }
      }
      const newUrls = new Set()
      const updateStmt = db.prepare('UPDATE chapters SET name=?, sort_order=?, image_count=? WHERE comic_id=? AND url=?')
      const insertStmt = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order, image_count) VALUES (?,?,?,?,?)')
      const deleteStmt = db.prepare('DELETE FROM chapters WHERE comic_id=? AND url=?')

      const chapterOps = db.transaction(() => {
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i]
          const chUrl = ch.url || ''
          if (!chUrl) continue
          newUrls.add(chUrl)
          const preservedCount = existingImageCounts.get(chUrl) || 0
          const finalImageCount = ch.image_count || preservedCount
          const existing = existingMap.get(chUrl)
          if (existing) {
            if (existing.name !== (ch.name || '') || existing.sort_order !== i || existing.image_count !== finalImageCount) {
              updateStmt.run(ch.name || '', i, finalImageCount, id, chUrl)
            }
          } else {
            insertStmt.run(id, ch.name || '', chUrl, i, finalImageCount)
          }
        }
        for (const url of existingMap.keys()) {
          if (!newUrls.has(url)) {
            deleteStmt.run(id, url)
          }
        }
      })
      chapterOps()
    }
    return { ...comic, _id: id, updatedAt: now, updateDelta: newDelta }
  } else {
    const id = comic.id || core.idGen()
    db.prepare(`INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, comic.sourceUrl, comic.title || '', comic.cover || '', null,
      comic.author || '',
      comic.status || '', comic.desc || '', tags, comic.category || '',
      comic.updateTime ? Number(comic.updateTime) : null,
      chCount, 0, comic.favorited || 0, now, now,
      null
    )
    const insertCh = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order, image_count) VALUES (?,?,?,?,?)')
    const insertAll = db.transaction(() => {
      for (let i = 0; i < chapters.length; i++) {
        insertCh.run(id, chapters[i].name || '', chapters[i].url || '', i, chapters[i].image_count || 0)
      }
    })
    insertAll()
    return { ...comic, _id: id, createdAt: now, updatedAt: now, updateDelta: 0 }
  }
}

async function upsertComic(comic) {
  ensureDb()
  const now = Date.now()
  return _upsertComicInternal(comic, now)
}

async function upsertComics(list) {
  ensureDb()
  const now = Date.now()
  const db = core.getDB()
  const results = []
  const batchTransaction = db.transaction(() => {
    for (const item of list) {
      const saved = _upsertComicInternal(item, now)
      results.push(saved)
    }
  })
  batchTransaction()
  return results
}

async function getExistingSourceUrls(sourceUrls) {
  const db = ensureDb()
  if (!sourceUrls || sourceUrls.length === 0) return new Set()
  const placeholders = sourceUrls.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT sourceUrl FROM comics WHERE sourceUrl IN (${placeholders})`
  ).all(...sourceUrls)
  const set = new Set()
  rows.forEach(r => set.add(r.sourceUrl))
  return set
}

async function getComics(pageOrOpts = 1, pageSizeOrFallback = 24, filtersOrFallback = {}) {
  let page, pageSize, filters
  if (typeof pageOrOpts === 'object' && pageOrOpts !== null) {
    const { page: p, pageSize: ps, ...rest } = pageOrOpts
    page = p || 1
    pageSize = ps || 24
    filters = rest
  } else {
    page = pageOrOpts || 1
    pageSize = pageSizeOrFallback || 24
    filters = filtersOrFallback || {}
  }
  const db = ensureDb()
  const { whereClause, params } = buildWhereClause({
    ...filters,
    ftsEnabled: core.getFts5Available()
  })
  const cacheKey = JSON.stringify({ whereClause, params })
  const total = _getCachedCount(cacheKey, db, whereClause, params)

  const offset = (page - 1) * pageSize
  const { joinClause, orderBy } = buildOrderClause(filters)

  const selectFields = joinClause ? COMIC_SELECT_FIELDS_PREFIXED : COMIC_SELECT_FIELDS

  const rows = buildComicQuery({
    db,
    selectFields,
    whereClause,
    params,
    joinClause,
    orderBy,
    limit: pageSize,
    offset,
    mapper: row => row
  })

  const docs = loadComicsWithChapters(db, rows, { skipEpubCheck: true })

  return { docs, total, page, pageSize }
}

async function getComicByUrl(url) {
  const db = ensureDb()
  const row = db.prepare(
    `SELECT ${COMIC_SELECT_FIELDS} FROM comics WHERE sourceUrl = ?`
  ).get(url)
  if (!row) return null
  const doc = core.rowToComic(row)
  doc.chapters = loadChapterList(db, doc._id)
  return doc
}

async function getComicById(id) {
  const db = ensureDb()
  const row = db.prepare(
    `SELECT ${COMIC_SELECT_FIELDS} FROM comics WHERE id = ?`
  ).get(id)
  if (!row) return null
  const doc = core.rowToComic(row)
  doc.chapters = loadChapterList(db, doc._id)
  return doc
}

async function getAllComics(page = 1, pageSize = 24) {
  return getComics(page, pageSize)
}

async function getUntaggedComics(limit = 50) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT ${COMIC_SELECT_FIELDS}
     FROM comics WHERE tags = '' OR tags IS NULL OR status = '' OR status IS NULL OR desc_text = '' OR desc_text IS NULL OR category = '' OR category IS NULL
     ORDER BY createdAt DESC LIMIT ?`
  ).all(limit)
  return loadComicsWithChapters(db, rows)
}

async function getFavoritedForSyncBatch(limit = 100) {
  const db = ensureDb()
  // 降频策略: 连载中/状态未知的漫画每轮都扫;
  // 已完结的漫画不会再更新, 只有超过 30 天没同步才扫一次(偶尔校验缺图/补字段)。
  const STALE_MS = 30 * 24 * 60 * 60 * 1000
  const finishedCutoff = Date.now() - STALE_MS
  const rows = db.prepare(
    `SELECT ${COMIC_SELECT_FIELDS}
     FROM comics WHERE favorited = 1
       AND (
         status IS NULL OR status = '' OR status NOT LIKE '%完结%'
         OR COALESCE(last_sync_at, 0) < ?
       )
     ORDER BY COALESCE(last_sync_at, 0) ASC, updatedAt DESC LIMIT ?`
  ).all(finishedCutoff, limit)
  return loadComicsWithChapters(db, rows)
}

async function markSynced(ids) {
  const db = ensureDb()
  if (!ids || ids.length === 0) return 0
  const now = Date.now()
  const stmt = db.prepare('UPDATE comics SET last_sync_at = ? WHERE id = ?')
  const tx = db.transaction(() => { for (const id of ids) stmt.run(now, id) })()
  return ids.length
}

async function getSerializedComics(limit = 500) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT ${COMIC_SELECT_FIELDS}
     FROM comics WHERE (status LIKE '%连载%' OR status = '' OR status IS NULL)
     ORDER BY updatedAt DESC LIMIT ?`
  ).all(limit)
  return loadComicsWithChapters(db, rows)
}

async function getAllComicUrls(limit = 1000) {
  const db = ensureDb()
  const rows = db.prepare(
    'SELECT sourceUrl, title, cover, updateTime FROM comics ORDER BY updatedAt DESC LIMIT ?'
  ).all(limit)
  return rows.map(r => ({
    sourceUrl: r.sourceUrl, title: r.title, cover: r.cover, updateTime: r.updateTime != null ? String(r.updateTime) : ''
  }))
}

async function deleteComic(id) {
  const db = ensureDb()
  db.prepare('DELETE FROM reading_progress WHERE comic_id=?').run(id)
  db.prepare('DELETE FROM download_records WHERE comic_id=?').run(id)
  db.prepare('DELETE FROM chapters WHERE comic_id=?').run(id)
  db.prepare('DELETE FROM comics WHERE id=?').run(id)
}

async function clearAllComics() {
  const db = ensureDb()
  db.prepare('DELETE FROM chapters').run()
  db.prepare('DELETE FROM comics').run()
}

async function cleanupPureLocalComics() {
  const db = ensureDb()
  const rows = db.prepare("SELECT id, title FROM comics WHERE sourceUrl IS NULL").all()
  if (!rows || rows.length === 0) {
    return { deletedCount: 0, titles: [] }
  }
  const titles = []
  const deleteCh = db.prepare('DELETE FROM chapters WHERE comic_id=?')
  const deleteCo = db.prepare('DELETE FROM comics WHERE id=?')
  const cleanup = db.transaction(() => {
    for (const comic of rows) {
      deleteCh.run(comic.id)
      deleteCo.run(comic.id)
      titles.push(comic.title)
    }
  })
  cleanup()
  console.log(`[DB] 清理纯本地漫画: 删除 ${rows.length} 本`)
  return { deletedCount: rows.length, titles }
}

async function getComicsCount() {
  const db = ensureDb()
  const r = db.prepare('SELECT COUNT(*) as c FROM comics').get()
  return r ? r.c : 0
}

async function getComicsWithMissingFields(limit) {
  const db = ensureDb()
  const limitSql = limit ? ` LIMIT ${Number(limit)}` : ''
  const rows = db.prepare(`SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path 
    FROM comics 
    WHERE (desc_text IS NULL OR desc_text = '' 
        OR category IS NULL OR category = '' 
        OR author IS NULL OR author = '' 
        OR status IS NULL OR status = '' 
        OR chapter_count = 0 OR chapter_count IS NULL) 
      AND sourceUrl IS NOT NULL AND sourceUrl != ''
    ORDER BY updatedAt DESC${limitSql}`).all()
  return rows.map(core.rowToComic)
}

async function getAllCategories() {
  const db = ensureDb()
  const rows = db.prepare("SELECT DISTINCT category FROM comics WHERE category IS NOT NULL AND category != '' ORDER BY category").all()
  return rows.map(v => v.category)
}

async function getCategoryStats() {
  const db = ensureDb()
  const rows = db.prepare("SELECT category, COUNT(*) as cnt FROM comics WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY cnt DESC").all()
  const stats = {}
  for (const v of rows) {
    stats[v.category] = v.cnt
  }
  const untaggedRow = db.prepare("SELECT COUNT(*) as c FROM comics WHERE category IS NULL OR category = ''").get()
  const totalRow = db.prepare('SELECT COUNT(*) as c FROM comics').get()
  return {
    stats,
    untagged: untaggedRow ? untaggedRow.c : 0,
    total: totalRow ? totalRow.c : 0
  }
}

async function updateComic(id, changes = {}) {
  const db = ensureDb()
  if (!id || typeof changes !== 'object' || Object.keys(changes).length === 0) return false
  if (typeof changes.isFavorite !== 'undefined') {
    return setFavorite(id, changes.isFavorite)
  }

  const fields = []
  const values = []
  const mapping = {
    title: 'title', cover: 'cover', author: 'author', status: 'status',
    desc_text: 'desc_text', tags: 'tags', category: 'category',
    updateTime: 'updateTime', chapter_count: 'chapter_count',
    update_delta: 'update_delta', favorited: 'favorited',
    local_path: 'local_path', local_cover: 'local_cover'
  }

  for (const [key, value] of Object.entries(changes)) {
    const field = mapping[key] || key
    if (Object.prototype.hasOwnProperty.call(mapping, field)) {
      fields.push(`${field} = ?`)
      values.push(field === 'favorited' ? (value ? 1 : 0) : value)
    }
  }
  if (!fields.length) return false
  values.push(id, id)
  db.prepare(`UPDATE comics SET ${fields.join(', ')} WHERE id = ? OR sourceUrl = ?`).run(...values)
  return true
}

async function setFavorite(comicId, favorited) {
  const db = ensureDb()
  db.prepare('UPDATE comics SET favorited = ? WHERE id = ? OR sourceUrl = ?').run(favorited ? 1 : 0, comicId, comicId)
  return true
}

async function clearUpdateDelta(comicId) {
  const db = ensureDb()
  db.prepare('UPDATE comics SET update_delta = 0 WHERE id = ?').run(comicId)
}

async function resetUpdateDelta(sourceUrl) {
  const db = ensureDb()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  db.prepare('UPDATE comics SET update_delta = 0, updatedAt = ? WHERE id = ?').run(Date.now(), row.id)
  return 1
}

async function getFavoritedComics() {
  const db = ensureDb()
  const rows = db.prepare(`SELECT ${COMIC_SELECT_FIELDS} FROM comics WHERE favorited = 1 ORDER BY updatedAt DESC`).all()
  return loadComicsWithChapters(db, rows)
}

async function searchComics(query) {
  const db = ensureDb()
  try {
    const rows = buildComicQuery({
      db,
      selectFields: `${COMIC_SELECT_FIELDS} FROM comics_fts f JOIN comics c ON c.rowid = f.rowid`,
      whereClause: 'WHERE comics_fts MATCH ?',
      params: [`"${String(query).replace(/"/g, '""')}"`],
      orderBy: 'rank',
      limit: 30,
      mapper: row => core.rowToComic(row, { skipEpubCheck: true })
    })
    return rows.length > 0 ? rows : []
  } catch {
    const rows = buildComicQuery({
      db,
      selectFields: COMIC_SELECT_FIELDS,
      whereClause: 'WHERE title LIKE ? OR author LIKE ? OR tags LIKE ?',
      params: [`%${query}%`, `%${query}%`, `%${query}%`],
      orderBy: 'updatedAt DESC',
      limit: 30,
      mapper: row => core.rowToComic(row, { skipEpubCheck: true })
    })
    return rows
  }
}

async function advancedSearch(query, filters = {}) {
  const db = ensureDb()

  const searchFilters = {
    ...filters,
    search: query,
    ftsEnabled: core.getFts5Available()
  }
  const { whereClause, params } = buildWhereClause(searchFilters)

  try {
    const rows = buildComicQuery({
      db,
      selectFields: COMIC_SELECT_FIELDS,
      whereClause,
      params,
      orderBy: 'updatedAt DESC',
      limit: 30,
      mapper: row => core.rowToComic(row, { skipEpubCheck: true })
    })
    return rows
  } catch (e) {
    console.warn('[DB] 高级搜索失败:', e.message)
    if (query) return searchComics(query)
    return []
  }
}

module.exports = {
  _upsertComicInternal,
  upsertComic, upsertComics, getExistingSourceUrls,
  getComics, getComicByUrl, getComicById, getAllComics,
  getUntaggedComics, getFavoritedForSyncBatch, markSynced,
  getSerializedComics, getAllComicUrls,
  deleteComic, clearAllComics, cleanupPureLocalComics,
  getComicsCount, getComicsWithMissingFields,
  getAllCategories, getCategoryStats,
  updateComic, setFavorite, clearUpdateDelta, resetUpdateDelta,
  getFavoritedComics,
  searchComics, advancedSearch
}