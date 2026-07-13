'use strict'

const core = require('./core')

function ensureDb() {
  const db = core.getDB()
  if (!db) core.initDB()
  return core.getDB()
}

function loadChapterList(db, comicId) {
  const chRows = db.prepare('SELECT name, url, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(comicId)
  return chRows.map(r => ({ name: r.name, url: r.url, sort_order: r.sort_order }))
}

function loadChaptersWithDetails(db, comicId) {
  return db.prepare('SELECT name, url, image_count, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(comicId)
}

function normalizeComicTitle(value) {
  return String(value || '')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[_\-+/\\]+/g, ' ')
    .replace(/[^\w\u4e00-\u9fff]+/g, '')
    .trim()
}

function buildChapterInsertPayload(comicId, chapter, index, options = {}) {
  const payload = {
    comicId,
    name: chapter.name || '',
    url: chapter.url || '',
    sortOrder: chapter.sortOrder ?? chapter.index ?? index
  }

  if (options.includeImageCount) {
    payload.imageCount = chapter.imageCount || chapter.image_count || 0
  }

  return payload
}

function buildDownloadRecordPayload(comicId, comicTitle, chapter, index, downloadedAt) {
  return {
    comicId,
    comicTitle: comicTitle || '',
    chapterIndex: chapter.chapterIndex ?? chapter.index ?? index,
    chapterName: chapter.name || '',
    imagesCount: chapter.imageCount || chapter.imagesCount || chapter.image_count || 0,
    path: chapter.path || '',
    downloadedAt
  }
}

function buildDownloadRecordPayloads(comicId, comicTitle, chapters, downloadedAt) {
  return chapters.map((chapter, index) => buildDownloadRecordPayload(comicId, comicTitle, chapter, index, downloadedAt))
}

function insertChapterRow(db, comicId, chapter, index, options = {}) {
  const payload = buildChapterInsertPayload(comicId, chapter, index, options)
  const columns = ['comic_id', 'name', 'url', 'sort_order']
  const values = [payload.comicId, payload.name, payload.url, payload.sortOrder]

  if (options.includeImageCount) {
    columns.push('image_count')
    values.push(payload.imageCount)
  }

  const stmt = db.prepare(`INSERT INTO chapters (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
  stmt.run(...values)
  return payload
}

function runInTransaction(db, executor) {
  if (!db || typeof executor !== 'function') return null
  const tx = db.transaction(executor)
  return tx()
}

function insertDownloadRecord(db, comicId, comicTitle, chapter, index, downloadedAt) {
  const payload = buildDownloadRecordPayload(comicId, comicTitle, chapter, index, downloadedAt)
  const stmt = db.prepare('INSERT INTO download_records (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at) VALUES (?,?,?,?,?,?,?)')
  stmt.run(payload.comicId, payload.comicTitle, payload.chapterIndex, payload.chapterName, payload.imagesCount, payload.path, payload.downloadedAt)
  return payload
}

function findExistingComicMatch(rows, title) {
  if (!rows || !Array.isArray(rows) || !title) return null

  const normalizedTitle = normalizeComicTitle(title)
  if (!normalizedTitle) return null

  for (const row of rows) {
    if (!row || !row.title) continue

    const rowTitle = normalizeComicTitle(row.title)
    if (rowTitle === normalizedTitle) {
      return { row, matchType: 'title-exact' }
    }

    if (rowTitle && normalizedTitle && rowTitle.toLowerCase() === normalizedTitle.toLowerCase()) {
      return { row, matchType: 'title-fuzzy' }
    }

    const rowNorm = rowTitle.toLowerCase()
    const targetNorm = normalizedTitle.toLowerCase()
    if (rowNorm && targetNorm && (rowNorm.includes(targetNorm) || targetNorm.includes(rowNorm))) {
      if (rowNorm.length > 2 && targetNorm.length > 2) {
        return { row, matchType: 'title-contains' }
      }
    }
  }

  return null
}

function mapRows(rows, mapper) {
  if (!Array.isArray(rows)) return []
  if (typeof mapper !== 'function') return rows
  return rows.map(mapper)
}

function buildWhereClause(filters = {}) {
  const conditions = []
  const params = []

  if (filters.category && filters.category !== 'all') {
    if (filters.category === '__untagged__') {
      conditions.push("(category IS NULL OR category = '')")
    } else {
      conditions.push('category = ?')
      params.push(filters.category)
    }
  }

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'completed') {
      conditions.push("(status LIKE '%完结%' OR status LIKE '%已完结%')")
    } else if (filters.status === 'serialized') {
      conditions.push("(status LIKE '%连载%' OR status = '' OR status IS NULL)")
    }
  }

  if (filters.tag && filters.tag !== 'all') {
    conditions.push('tags LIKE ?')
    params.push(`%${filters.tag}%`)
  }

  if (filters.search) {
    if (filters.ftsEnabled) {
      const ftsQuery = `"${String(filters.search).replace(/"/g, '""')}"`
      conditions.push('rowid IN (SELECT rowid FROM comics_fts WHERE comics_fts MATCH ?)')
      params.push(ftsQuery)
    } else {
      conditions.push('(title LIKE ? OR author LIKE ? OR tags LIKE ?)')
      const like = `%${filters.search}%`
      params.push(like, like, like)
    }
  }

  if (filters.localOnly) {
    conditions.push("(local_path IS NOT NULL AND local_path != '')")
  }

  if (filters.onlineOnly) {
    conditions.push("(local_path IS NULL OR local_path = '')")
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

function buildOrderClause(filters = {}) {
  let orderBy = 'CASE WHEN update_delta > 0 THEN 0 ELSE 1 END, updatedAt DESC, updateTime DESC, createdAt DESC'
  let joinClause = ''

  if (filters.sort === 'time') {
    orderBy = 'updatedAt DESC, updateTime DESC, createdAt DESC'
  } else if (filters.sort === 'hits') {
    joinClause = 'LEFT JOIN (SELECT comic_id, MAX(updated_at) as last_read FROM reading_progress GROUP BY comic_id) rp ON rp.comic_id = comics.id'
    orderBy = 'CASE WHEN rp.last_read IS NOT NULL THEN 0 ELSE 1 END, rp.last_read DESC, updatedAt DESC, createdAt DESC'
  } else if (filters.sort === 'update') {
    orderBy = 'update_delta DESC, updatedAt DESC, createdAt DESC'
  }

  return { joinClause, orderBy }
}

function buildComicQuery({ db, selectFields, whereClause = '', params = [], joinClause = '', orderBy = '', limit, offset, mapper, fromClause = 'comics' }) {
  const fromSection = [fromClause, joinClause].filter(Boolean).join(' ')
  const sql = `SELECT ${selectFields} FROM ${fromSection} ${whereClause} ${orderBy ? `ORDER BY ${orderBy}` : ''} ${limit != null ? 'LIMIT ?' : ''} ${offset != null ? 'OFFSET ?' : ''}`.trim()
  const queryParams = [...params]
  if (limit != null) queryParams.push(limit)
  if (offset != null) queryParams.push(offset)

  const rows = db.prepare(sql).all(...queryParams)
  if (typeof mapper === 'function') {
    return rows.map(mapper)
  }
  return rows
}

module.exports = {
  ensureDb,
  loadChapterList,
  loadChaptersWithDetails,
  normalizeComicTitle,
  buildChapterInsertPayload,
  buildDownloadRecordPayload,
  buildDownloadRecordPayloads,
  insertChapterRow,
  runInTransaction,
  insertDownloadRecord,
  mapRows,
  buildWhereClause,
  buildOrderClause,
  buildComicQuery,
  findExistingComicMatch
}