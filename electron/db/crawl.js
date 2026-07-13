'use strict'

const { ensureDb } = require('./helpers')

async function initCrawlQueue(urls) {
  const db = ensureDb()
  const stmt = db.prepare('INSERT OR IGNORE INTO crawl_progress (url, status, created_at) VALUES (?, ?, ?)')
  const insertAll = db.transaction(() => {
    for (const item of urls) {
      const url = typeof item === 'string' ? item : item.url
      stmt.run(url, 'pending', Date.now())
    }
  })
  insertAll()
}

async function getNextPendingUrl() {
  const db = ensureDb()
  const row = db.prepare(`SELECT url, title FROM crawl_progress 
    WHERE status = 'pending' 
    OR (status = 'failed' AND retry_count < 3) 
    ORDER BY created_at ASC LIMIT 1`).get()
  if (!row) return null
  return { url: row.url, title: row.title }
}

async function updateCrawlStatus(url, status, error = null) {
  const db = ensureDb()
  const existing = db.prepare('SELECT retry_count FROM crawl_progress WHERE url = ?').get(url)
  const retryCount = existing ? existing.retry_count : 0
  db.prepare(`UPDATE crawl_progress SET status = ?, retry_count = ?, last_error = ?, updated_at = ? WHERE url = ?`).run(
    status, retryCount + (status === 'failed' ? 1 : 0), error, Date.now(), url
  )
}

async function getCrawlStats() {
  const db = ensureDb()
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM crawl_progress GROUP BY status').all()
  const stats = {}
  for (const row of rows) {
    stats[row.status] = row.count
  }
  stats.total = (stats.pending || 0) + (stats.crawling || 0) + (stats.done || 0) + (stats.failed || 0) + (stats.failed_permanent || 0)
  return stats
}

async function recordFailureReason(reason) {
  const db = ensureDb()
  const existing = db.prepare('SELECT count FROM failure_stats WHERE reason = ?').get(reason)
  const count = existing ? existing.count : 0
  db.prepare('INSERT OR REPLACE INTO failure_stats (reason, count, last_update) VALUES (?, ?, ?)').run(reason, count + 1, Date.now())
}

async function updateComicListMeta(list) {
  const db = ensureDb()
  const now = Date.now()
  let count = 0
  const updateWithTime = db.prepare(`UPDATE comics SET title=?, cover=?, category=COALESCE(NULLIF(?, ''), category), updateTime=MAX(COALESCE(updateTime,0),?), updatedAt=? WHERE id=?`)
  const updateWithoutTime = db.prepare(`UPDATE comics SET title=?, cover=?, category=COALESCE(NULLIF(?, ''), category), updatedAt=? WHERE id=?`)
  for (const item of list) {
    const existing = db.prepare('SELECT id FROM comics WHERE sourceUrl = ?').get(item.sourceUrl)
    if (existing) {
      const newUpdateTime = item.updateTime ? Number(item.updateTime) : null
      if (newUpdateTime && newUpdateTime > 0) {
        updateWithTime.run(item.title || '', item.cover || '', item.category || '', newUpdateTime, now, existing.id)
      } else {
        updateWithoutTime.run(item.title || '', item.cover || '', item.category || '', now, existing.id)
      }
      count++
    }
  }
  return count
}

module.exports = {
  initCrawlQueue, getNextPendingUrl, updateCrawlStatus, getCrawlStats,
  recordFailureReason, updateComicListMeta
}