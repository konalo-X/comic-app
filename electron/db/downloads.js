'use strict'

const fs = require('fs')
const { ensureDb, insertDownloadRecord } = require('./helpers')

async function saveDownloadRecord(record) {
  const db = ensureDb()
  const { comicId, comicTitle, chapterIndex, chapterName, imagesCount, path: imgPath, status, error } = record
  // 委托给 helpers.insertDownloadRecord 统一实现, 避免分散维护 (保留两个 API 入口)
  const safeChapterIndex = chapterIndex ?? 0
  const chapter = {
    chapterIndex: safeChapterIndex,
    name: chapterName,
    imageCount: imagesCount,
    path: imgPath,
    status,
    error
  }
  insertDownloadRecord(db, comicId || '', comicTitle, chapter, safeChapterIndex, Date.now())
}

async function getDownloadRecords(filter = {}) {
  const db = ensureDb()
  let sql = 'SELECT * FROM download_records'
  const params = []
  const conditions = []
  if (filter.comicId) {
    conditions.push('comic_id = ?')
    params.push(filter.comicId)
  }
  if (filter.comicTitle) {
    conditions.push('comic_title = ?')
    params.push(filter.comicTitle)
  }
  if (filter.chapterIndex !== undefined && filter.chapterIndex !== null) {
    conditions.push('chapter_index = ?')
    params.push(filter.chapterIndex)
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ')
  } else {
    sql += ' ORDER BY downloaded_at DESC LIMIT 200'
  }
  const rows = db.prepare(sql).all(...params)
  return rows.map(v => ({
    id: v.id, comicId: v.comic_id, comicTitle: v.comic_title,
    chapterIndex: v.chapter_index, chapterName: v.chapter_name,
    imagesCount: v.images_count, path: v.path, downloadedAt: v.downloaded_at
  }))
}

async function deleteDownloadRecord(id) {
  const db = ensureDb()
  db.prepare('DELETE FROM download_records WHERE id = ?').run(id)
}

async function cleanStaleDownloadRecords() {
  const db = ensureDb()
  const rows = db.prepare('SELECT id, path FROM download_records WHERE path IS NOT NULL AND path != ""').all()
  let deleted = 0
  for (const row of rows) {
    if (row.path && !fs.existsSync(row.path)) {
      db.prepare('DELETE FROM download_records WHERE id = ?').run(row.id)
      deleted++
    }
  }
  return { deleted, total: rows.length }
}

module.exports = {
  saveDownloadRecord, getDownloadRecords, deleteDownloadRecord, cleanStaleDownloadRecords
}