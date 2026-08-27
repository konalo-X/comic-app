'use strict'

const fs = require('fs')
const { ensureDb, insertDownloadRecord } = require('./helpers')
const { existsAsync } = require('../modules/downloadPaths')

// comic_id 归一化: 下载/同步链路里历史上会用 sourceUrl(http...) 当 comic_id 写记录,
// 导致同一本漫画在 download_records 里出现 URL 型 + 内部 c_ 型两套重复记录。
// 这里统一在写入入口把 URL 解析成内部 comics.id, 从根上杜绝重复。
// 解析失败(找不到对应漫画)时保持原值, 避免丢记录。
function normalizeComicId(db, comicId) {
  if (!comicId || typeof comicId !== 'string') return comicId
  if (!/^https?:\/\//i.test(comicId)) return comicId // 已是内部 id, 原样返回
  try {
    const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(comicId)
    if (row && row.id) return row.id
  } catch (_) {}
  return comicId
}

async function saveDownloadRecord(record) {
  const db = ensureDb()
  const { comicId: rawComicId, comicTitle, chapterIndex, chapterName, imagesCount, path: imgPath, status, error } = record
  const comicId = normalizeComicId(db, rawComicId)
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
    // 查询侧同样归一化: 调用方可能传 sourceUrl, 而记录已统一存内部 id。
    // 为兼容历史遗留的 URL 型记录, 两个 id 都查。
    const nid = normalizeComicId(db, filter.comicId)
    if (nid !== filter.comicId) {
      conditions.push('comic_id IN (?, ?)')
      params.push(nid, filter.comicId)
    } else {
      conditions.push('comic_id = ?')
      params.push(filter.comicId)
    }
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
    if (row.path && !(await existsAsync(row.path))) {
      db.prepare('DELETE FROM download_records WHERE id = ?').run(row.id)
      deleted++
    }
  }
  return { deleted, total: rows.length }
}

module.exports = {
  saveDownloadRecord, getDownloadRecords, deleteDownloadRecord, cleanStaleDownloadRecords,
  normalizeComicId
}