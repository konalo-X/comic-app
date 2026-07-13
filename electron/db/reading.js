'use strict'

const fs = require('fs')
const core = require('./core')
const { ensureDb } = require('./helpers')

async function saveReadingProgress(comicId, chapterIndex, chapterUrl, pageIndex, totalPages) {
  const db = ensureDb()
  const progress = totalPages > 0 ? (pageIndex + 1) / totalPages : 0
  db.prepare(`INSERT OR REPLACE INTO reading_progress
    (id, comic_id, chapter_index, chapter_url, page_index, total_pages, progress, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    comicId, comicId, chapterIndex, chapterUrl || '', pageIndex, totalPages, progress, Date.now()
  )
}

async function getReadingProgress(comicId) {
  const db = ensureDb()
  const row = db.prepare('SELECT * FROM reading_progress WHERE comic_id = ? LIMIT 1').get(comicId)
  if (!row) return null
  return {
    id: row.id, comicId: row.comic_id, chapterIndex: row.chapter_index,
    chapterUrl: row.chapter_url, pageIndex: row.page_index, totalPages: row.total_pages,
    progress: row.progress, updatedAt: row.updated_at
  }
}

async function getAllReadingHistory(limit = 20) {
  const db = ensureDb()
  const rows = db.prepare(`SELECT rp.*, c.id as cid, c.sourceUrl, c.title, c.cover, c.author, c.status, c.tags
    FROM reading_progress rp
    LEFT JOIN comics c ON c.id = rp.comic_id OR c.sourceUrl = rp.comic_id
    ORDER BY rp.updated_at DESC LIMIT ?`).all(limit)
  return rows.map(v => {
    const comicId = v.comic_id
    const comic = v.cid ? { id: v.cid, sourceUrl: v.sourceUrl, title: v.title, cover: v.cover, author: v.author, status: v.status, tags: v.tags } : null
    return {
      progress: { comicId, chapterIndex: v.chapter_index, chapterUrl: v.chapter_url, pageIndex: v.page_index, totalPages: v.total_pages, pct: v.progress, updatedAt: v.updated_at },
      comic
    }
  })
}

async function deleteReadingProgress(comicId) {
  const db = ensureDb()
  db.prepare('DELETE FROM reading_progress WHERE comic_id = ?').run(comicId)
  return true
}

async function getChaptersCount() {
  const db = ensureDb()
  const r = db.prepare('SELECT COUNT(*) as c FROM chapters').get()
  return r ? r.c : 0
}

async function getImagesCount() {
  const db = ensureDb()
  const r = db.prepare('SELECT SUM(image_count) as s FROM chapters').get()
  return r ? (r.s || 0) : 0
}

async function getDownloadSize() {
  ensureDb()
  const rows = db.prepare("SELECT DISTINCT path FROM download_records WHERE path IS NOT NULL AND path != ''").all()
  const paths = rows.map(v => v.path).filter(Boolean)
  let total = 0
  for (const p of paths) {
    if (!fs.existsSync(p)) continue
    const stat = fs.statSync(p)
    if (stat.isDirectory()) {
      total += core.getDirectorySize(p)
    } else if (stat.isFile()) {
      total += stat.size
    }
  }
  return total
}

async function getBooksReadCount() {
  const db = ensureDb()
  const r = db.prepare('SELECT COUNT(DISTINCT comic_id) as c FROM reading_progress').get()
  return r ? r.c : 0
}

async function getChaptersReadCount() {
  const db = ensureDb()
  const r = db.prepare('SELECT COUNT(*) as c FROM reading_progress').get()
  return r ? r.c : 0
}

async function getReadingStreak() {
  const db = ensureDb()
  const rows = db.prepare("SELECT DISTINCT DATE(updated_at / 1000, 'unixepoch', 'localtime') as d FROM reading_progress ORDER BY d DESC").all()
  const dates = rows.map(v => String(v.d))
  if (!dates.length) return 0

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  let streak = 0
  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today)
    checkDate.setDate(checkDate.getDate() - i)
    const dateStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`
    if (dates.includes(dateStr)) {
      streak += 1
    } else {
      break
    }
  }
  return streak
}

async function getTotalReadTime() {
  const chapters = await getChaptersReadCount()
  const minutes = chapters * 10
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

module.exports = {
  saveReadingProgress, getReadingProgress, getAllReadingHistory,
  deleteReadingProgress,
  getChaptersCount, getImagesCount, getDownloadSize,
  getBooksReadCount, getChaptersReadCount, getReadingStreak, getTotalReadTime
}