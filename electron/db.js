'use strict'
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const Database = require('better-sqlite3')
const { sanitizeFilename, normalizeName, normalizeTitle } = require('./utils')

let _downloadsDir = null
function getDownloadsDir() {
  if (_downloadsDir) return _downloadsDir
  try {
    _downloadsDir = require('electron').app.getPath('downloads')
  } catch {
    _downloadsDir = path.join(require('os').homedir(), 'Downloads')
  }
  return _downloadsDir
}

let db = null
let dbPath = ''

function dbFile() {
  if (dbPath) return dbPath
  const isElectronMain = process.type === 'browser'
  if (isElectronMain) {
    const { app } = require('electron')
    dbPath = path.join(app.getPath('userData'), 'comics.sqlite')
  } else {
    dbPath = path.join(__dirname, '..', 'comics.sqlite')
  }
  return dbPath
}

function initDB() {
  const file = dbFile()
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  db = new Database(file, {
    // WAL mode for better concurrent read/write performance
    // verbose: process.env.NODE_ENV === 'development' ? console.log : null
  })

  // Performance pragmas
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.pragma('cache_size = -8000')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')
  db.pragma('wal_autocheckpoint = 1000')

  // 主表
  db.exec(`CREATE TABLE IF NOT EXISTS comics (
    id TEXT PRIMARY KEY,
    sourceUrl TEXT UNIQUE,
    title TEXT,
    cover TEXT,
    local_cover TEXT,
    author TEXT,
    status TEXT,
    desc_text TEXT,
    tags TEXT,
    category TEXT,
    updateTime INTEGER,
    chapter_count INTEGER DEFAULT 0,
    chapter_names_enriched INTEGER DEFAULT 0,
    update_delta INTEGER DEFAULT 0,
    favorited INTEGER DEFAULT 0,
    local_path TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  )`)

  // 章节子表
  db.exec(`CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comic_id TEXT,
    name TEXT,
    url TEXT,
    sort_order INTEGER,
    image_count INTEGER DEFAULT 0,
    FOREIGN KEY (comic_id) REFERENCES comics(id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_chapters_comic ON chapters(comic_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters(comic_id, sort_order)')

  // 迁移：为老数据库添加列
  try {
    const chCols = db.pragma('table_info(chapters)')
    const chNames = chCols.map(c => c.name)
    if (!chNames.includes('image_count')) {
      db.exec('ALTER TABLE chapters ADD COLUMN image_count INTEGER DEFAULT 0')
      console.log('[DB] 迁移：添加 chapters.image_count 列')
    }
  } catch (e) {
    console.warn('[DB] chapters.image_count 迁移失败（可能已存在）:', e.message)
  }

  try {
    const cols = db.pragma('table_info(comics)')
    const names = cols.map(c => c.name)
    if (!names.includes('chapter_names_enriched')) {
      db.exec('ALTER TABLE comics ADD COLUMN chapter_names_enriched INTEGER DEFAULT 0')
      console.log('[DB] 迁移：添加 chapter_names_enriched 列')
    }
    if (!names.includes('update_delta')) {
      db.exec('ALTER TABLE comics ADD COLUMN update_delta INTEGER DEFAULT 0')
      console.log('[DB] 迁移：添加 update_delta 列')
    }
    if (!names.includes('favorited')) {
      db.exec('ALTER TABLE comics ADD COLUMN favorited INTEGER DEFAULT 0')
      console.log('[DB] 迁移：添加 favorited 列')
    }
    if (!names.includes('local_path')) {
      db.exec('ALTER TABLE comics ADD COLUMN local_path TEXT')
      console.log('[DB] 迁移：添加 local_path 列')
    }
    if (!names.includes('local_cover')) {
      db.exec('ALTER TABLE comics ADD COLUMN local_cover TEXT')
      console.log('[DB] 迁移：添加 local_cover 列')
    }
    if (!names.includes('last_sync_at')) {
      db.exec('ALTER TABLE comics ADD COLUMN last_sync_at INTEGER DEFAULT 0')
      console.log('[DB] 迁移：添加 last_sync_at 列')
    }
  } catch (e) {
    console.warn('[DB] 迁移失败（可能已存在）:', e.message)
  }

  // 清理：把 sourceUrl 为空字符串的记录改为 NULL
  try {
    const emptyCheck = db.prepare("SELECT COUNT(*) as c FROM comics WHERE sourceUrl = ''").get()
    if (emptyCheck && emptyCheck.c > 0) {
      db.prepare("UPDATE comics SET sourceUrl = NULL WHERE sourceUrl = ''").run()
      console.log(`[DB] 清理 ${emptyCheck.c} 条 sourceUrl='' 的记录（避免 UNIQUE 约束冲突）`)
    }
  } catch (e) {
    console.warn('[DB] sourceUrl 清理失败:', e.message)
  }

  // 阅读进度表
  db.exec(`CREATE TABLE IF NOT EXISTS reading_progress (
    id TEXT PRIMARY KEY,
    comic_id TEXT,
    chapter_index INTEGER DEFAULT 0,
    chapter_url TEXT,
    page_index INTEGER DEFAULT 0,
    total_pages INTEGER DEFAULT 0,
    progress REAL DEFAULT 0,
    updated_at INTEGER,
    FOREIGN KEY (comic_id) REFERENCES comics(id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_progress_comic ON reading_progress(comic_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_progress_updated ON reading_progress(updated_at)')

  // 离线下载记录表
  db.exec(`CREATE TABLE IF NOT EXISTS download_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comic_id TEXT,
    comic_title TEXT,
    chapter_index INTEGER,
    chapter_name TEXT,
    images_count INTEGER DEFAULT 0,
    path TEXT,
    downloaded_at INTEGER,
    UNIQUE(comic_id, chapter_index)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_download_comic ON download_records(comic_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_download_title ON download_records(comic_title)')

  // 爬取进度表
  db.exec(`CREATE TABLE IF NOT EXISTS crawl_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    title TEXT,
    status TEXT DEFAULT 'pending',
    retry_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at INTEGER,
    updated_at INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_progress(status)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_crawl_created ON crawl_progress(created_at)')

  // 失败统计表
  db.exec(`CREATE TABLE IF NOT EXISTS failure_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reason TEXT UNIQUE,
    count INTEGER DEFAULT 0,
    last_update INTEGER
  )`)

  // FTS5 全文搜索（带同步触发器）
  let fts5Available = false
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS comics_fts USING fts5(
      title, author, tags, content='comics', content_rowid='rowid'
    )`)

    // 触发器：INSERT 时自动同步 FTS5
    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_insert AFTER INSERT ON comics BEGIN
      INSERT INTO comics_fts(rowid, title, author, tags) VALUES (new.rowid, new.title, new.author, new.tags);
    END`)

    // 触发器：DELETE 时自动同步 FTS5
    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_delete AFTER DELETE ON comics BEGIN
      INSERT INTO comics_fts(comics_fts, rowid, title, author, tags) VALUES('delete', old.rowid, old.title, old.author, old.tags);
    END`)

    // 触发器：UPDATE 时自动同步 FTS5
    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_update AFTER UPDATE ON comics BEGIN
      INSERT INTO comics_fts(comics_fts, rowid, title, author, tags) VALUES('delete', old.rowid, old.title, old.author, old.tags);
      INSERT INTO comics_fts(rowid, title, author, tags) VALUES (new.rowid, new.title, new.author, new.tags);
    END`)

    // 重建 FTS5 索引（已有数据）
    const ftsCount = db.prepare('SELECT COUNT(*) as c FROM comics_fts').get()
    if (!ftsCount || ftsCount.c === 0) {
      const comicCount = db.prepare('SELECT COUNT(*) as c FROM comics').get()
      if (comicCount && comicCount.c > 0) {
        console.log(`[DB] 重建 FTS5 索引（${comicCount.c} 条记录）...`)
        db.exec("INSERT INTO comics_fts(rowid, title, author, tags) SELECT rowid, title, author, tags FROM comics")
        console.log('[DB] FTS5 索引重建完成')
      }
    }

    fts5Available = true
    console.log('[DB] FTS5 全文搜索已启用')
  } catch (e) {
    console.warn('[DB] FTS5 不可用，降级到 LIKE 搜索:', e.message)
  }

  // 性能索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_comics_favorited ON comics(favorited)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_comics_category ON comics(category)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_comics_updated ON comics(updatedAt)')

  // 尝试从旧的 NeDB 迁移
  migrateFromNeDB()

  return db
}

function migrateFromNeDB() {
  const nedbPath = dbFile().replace('.sqlite', '.db')
  const bakPath = nedbPath + '.bak'
  if (!fs.existsSync(nedbPath)) return

  const count = db.prepare('SELECT COUNT(*) as c FROM comics').get()
  if (count && count.c > 0) return

  console.log('[DB] 检测到旧版 NeDB 数据库，开始迁移...')
  const content = fs.readFileSync(nedbPath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim())

  let migrated = 0
  const insertComic = db.prepare(`INSERT OR IGNORE INTO comics
    (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertChapter = db.prepare(`INSERT INTO chapters (comic_id, name, url, sort_order, image_count)
    VALUES (?, ?, ?, ?, ?)`)

  const migrateAll = db.transaction(() => {
    for (const line of lines) {
      try {
        const doc = JSON.parse(line)
        const tags = Array.isArray(doc.tags) ? doc.tags.join(',') : (doc.tags || '')
        const chapters = Array.isArray(doc.chapters) ? doc.chapters : []
        const chCount = chapters.length

        const id = doc._id || doc.sourceUrl || `migrated_${Date.now()}_${Math.random()}`
        let migratedUpdateTime = null
        if (doc.updateTime) {
          if (typeof doc.updateTime === 'number') {
            migratedUpdateTime = doc.updateTime
          } else {
            const s = String(doc.updateTime)
            const m = s.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/)
            if (m) {
              const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
              if (!isNaN(t)) migratedUpdateTime = t
            }
          }
        }
        insertComic.run(
          id,
          doc.sourceUrl || '',
          doc.title || '',
          doc.cover || '',
          null,
          doc.author || '',
          doc.status || '',
          doc.desc || '',
          tags,
          doc.category || '',
          migratedUpdateTime,
          chCount,
          0,
          doc.favorited ? 1 : 0,
          doc.createdAt || Date.now(),
          doc.updatedAt || Date.now(),
          null
        )

        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i]
          insertChapter.run(id, ch.name || '', ch.url || '', i, 0)
        }

        migrated++
      } catch (e) {
        // skip bad lines
      }
    }
  })

  migrateAll()

  try { fs.renameSync(nedbPath, bakPath) } catch (e) {}
  console.log(`[DB] 迁移完成：${migrated} 部漫画`)
}

// better-sqlite3 使用 WAL 模式自动持久化，不需要手动 save
function save() {
  // no-op: WAL mode handles persistence automatically
}

function idGen() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

// ---------- 公开 API ----------

function _upsertComicInternal(comic, now) {
  const existing = db.prepare(
    `SELECT id, tags, category, chapter_count, author, status, desc_text, update_delta, favorited FROM comics WHERE sourceUrl = ?`
  ).get(comic.sourceUrl)

  const tags = Array.isArray(comic.tags) ? comic.tags.join(',') : (comic.tags || '')
  const chapters = Array.isArray(comic.chapters) ? comic.chapters : []
  const chCount = chapters.length

  if (existing) {
    const id = existing.id
    const existingTags = existing.tags || ''
    const existingCategory = existing.category || ''
    const existingChCount = existing.chapter_count || 0
    const existingAuthor = existing.author || ''
    const existingStatus = existing.status || ''
    const existingDesc = existing.desc_text || ''
    const existingDelta = existing.update_delta || 0
    const existingFavorited = existing.favorited || 0

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
      comic.title || '', comic.cover || '', comic.local_cover || null,
      finalAuthor, finalStatus,
      finalDesc, finalTags, finalCategory,
      comic.updateTime ? Number(comic.updateTime) : null,
      finalChCount, newDelta, comic.favorited !== undefined ? comic.favorited : existingFavorited,
      chCount, existingChCount, comic.local_path || null, now, id
    )
    if (chCount > 0) {
      db.prepare('DELETE FROM chapters WHERE comic_id=?').run(id)
      const insertCh = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order, image_count) VALUES (?,?,?,?,?)')
      const insertAll = db.transaction(() => {
        for (let i = 0; i < chapters.length; i++) {
          insertCh.run(id, chapters[i].name || '', chapters[i].url || '', i, chapters[i].image_count || 0)
        }
      })
      insertAll()
    }
    return { ...comic, _id: id, updatedAt: now, updateDelta: newDelta }
  } else {
    const id = comic.id || idGen()
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
  if (!db) initDB()
  const now = Date.now()
  const result = _upsertComicInternal(comic, now)
  return result
}

async function updateChapterImageCounts(comicId, chaptersWithCounts) {
  if (!db) initDB()
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
  if (!db) initDB()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  db.prepare('UPDATE chapters SET image_count = ? WHERE comic_id = ? AND sort_order = ?').run(
    imageCount || 0, row.id, chapterIndex
  )
  return 1
}

async function getComicsNeedingImageCountUpdate(batchSize) {
  if (!db) initDB()
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
  if (!db) initDB()
  const rows = db.prepare(
    `SELECT sort_order, name, url FROM chapters WHERE comic_id = ? AND (image_count IS NULL OR image_count = 0) AND url IS NOT NULL AND url != '' ORDER BY sort_order`
  ).all(comicId)
  return rows.map(r => ({
    index: r.sort_order,
    name: r.name,
    url: r.url
  }))
}

async function upsertComics(list) {
  if (!db) initDB()
  const now = Date.now()
  const results = []
  for (const item of list) {
    const saved = _upsertComicInternal(item, now)
    results.push(saved)
  }
  return results
}

async function getExistingSourceUrls(sourceUrls) {
  if (!db) initDB()
  if (!sourceUrls || sourceUrls.length === 0) return new Set()
  const placeholders = sourceUrls.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT sourceUrl FROM comics WHERE sourceUrl IN (${placeholders})`
  ).all(...sourceUrls)
  const set = new Set()
  rows.forEach(r => set.add(r.sourceUrl))
  return set
}

function rowToComic(row, opts = {}) {
  const result = {
    _id: row.id,
    sourceUrl: row.sourceUrl,
    title: row.title,
    cover: row.cover,
    local_cover: row.local_cover,
    local_path: row.local_path,
    author: row.author,
    status: row.status,
    desc: row.desc_text,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    category: row.category,
    updateTime: row.updateTime != null ? String(row.updateTime) : '',
    chapter_count: row.chapter_count || 0,
    updateDelta: row.update_delta || 0,
    favorited: !!row.favorited,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
  if (opts.skipEpubCheck) {
    result.epubExists = false
  } else {
    const epubPath = path.join(getDownloadsDir(), `${sanitizeFilename(row.title)}.epub`)
    result.epubExists = fs.existsSync(epubPath)
  }
  return result
}

async function getComics(page = 1, pageSize = 24, filters = {}) {
  if (!db) initDB()
  let where = []
  let params = []

  if (filters.category && filters.category !== 'all') {
    if (filters.category === '__untagged__') {
      where.push("(category IS NULL OR category = '')")
    } else {
      where.push('category = ?')
      params.push(filters.category)
    }
  }

  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'completed') {
      where.push("(status LIKE '%完结%' OR status LIKE '%已完结%')")
    } else if (filters.status === 'serialized') {
      where.push("(status LIKE '%连载%' OR status = '' OR status IS NULL)")
    }
  }

  if (filters.tag && filters.tag !== 'all') {
    where.push('tags LIKE ?')
    params.push(`%${filters.tag}%`)
  }

  if (filters.search) {
    if (fts5Available) {
      // FTS5 全文搜索（比 LIKE 快 10-100x）
      const ftsQuery = `"${filters.search.replace(/"/g, '""')}"`
      where.push(`rowid IN (SELECT rowid FROM comics_fts WHERE comics_fts MATCH ?)`)
      params.push(ftsQuery)
    } else {
      where.push('(title LIKE ? OR author LIKE ? OR tags LIKE ?)')
      const like = `%${filters.search}%`
      params.push(like, like, like)
    }
  }

  if (filters.localOnly) {
    where.push("(local_path IS NOT NULL AND local_path != '')")
  }

  if (filters.onlineOnly) {
    where.push("(local_path IS NULL OR local_path = '')")
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
  const countRow = db.prepare(`SELECT COUNT(*) as c FROM comics ${whereClause}`).get(...params)
  const total = countRow ? countRow.c : 0

  const offset = (page - 1) * pageSize
  let orderBy = 'CASE WHEN update_delta > 0 THEN 0 ELSE 1 END, updatedAt DESC, updateTime DESC, createdAt DESC'
  let joinClause = ''
  if (filters.sort === 'time') {
    orderBy = 'updatedAt DESC, updateTime DESC, createdAt DESC'
  } else if (filters.sort === 'hits') {
    joinClause = 'LEFT JOIN (SELECT comic_id, MAX(updated_at) as last_read FROM reading_progress GROUP BY comic_id) rp ON rp.comic_id = comics.id OR rp.comic_id = comics.sourceUrl'
    orderBy = 'rp.last_read DESC NULLS LAST, updatedAt DESC, createdAt DESC'
  } else if (filters.sort === 'update') {
    orderBy = 'update_delta DESC, updatedAt DESC, createdAt DESC'
  }

  const rows = db.prepare(
    `SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path
     FROM comics ${joinClause} ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)

  const docs = rows.map(row => rowToComic(row, { skipEpubCheck: true }))

  if (docs.length > 0) {
    const comicIds = docs.map(d => d._id)
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
  }

  return { docs, total, page, pageSize }
}

async function getComicByUrl(url) {
  if (!db) initDB()
  const row = db.prepare(
    'SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path FROM comics WHERE sourceUrl = ?'
  ).get(url)
  if (!row) return null
  const doc = rowToComic(row)
  const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
  doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  return doc
}

async function getComicById(id) {
  if (!db) initDB()
  const row = db.prepare(
    'SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path FROM comics WHERE id = ?'
  ).get(id)
  if (!row) return null
  const doc = rowToComic(row)
  const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
  doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  return doc
}

async function getAllComics(page = 1, pageSize = 24) {
  return getComics(page, pageSize)
}

async function getUntaggedComics(limit = 50) {
  if (!db) initDB()
  const rows = db.prepare(
    `SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path
     FROM comics WHERE tags = '' OR tags IS NULL OR status = '' OR status IS NULL OR desc_text = '' OR desc_text IS NULL OR category = '' OR category IS NULL
     ORDER BY createdAt DESC LIMIT ?`
  ).all(limit)
  const comics = rows.map(rowToComic)
  for (const doc of comics) {
    const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
    doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  }
  return comics
}

async function getFavoritedForSyncBatch(limit = 100) {
  if (!db) initDB()
  // 轮转：优先取最久未同步的书架漫画，保证全盘 favorited 书都能被追更检查
  const rows = db.prepare(
    `SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path
     FROM comics WHERE favorited = 1
     ORDER BY COALESCE(last_sync_at, 0) ASC, updatedAt DESC LIMIT ?`
  ).all(limit)
  const comics = rows.map(rowToComic)
  for (const doc of comics) {
    const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
    doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  }
  return comics
}

async function markSynced(ids) {
  if (!db) initDB()
  if (!ids || ids.length === 0) return 0
  const now = Date.now()
  const stmt = db.prepare('UPDATE comics SET last_sync_at = ? WHERE id = ?')
  const tx = db.transaction(() => { for (const id of ids) stmt.run(now, id) })()
  return ids.length
}



async function getSerializedComics(limit = 500) {
  if (!db) initDB()
  const rows = db.prepare(
    `SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path
     FROM comics WHERE (status LIKE '%连载%' OR status = '' OR status IS NULL)
     ORDER BY updatedAt DESC LIMIT ?`
  ).all(limit)
  const comics = rows.map(rowToComic)
  for (const doc of comics) {
    const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
    doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  }
  return comics
}

async function getAllComicUrls(limit = 1000) {
  if (!db) initDB()
  const rows = db.prepare(
    'SELECT sourceUrl, title, cover, updateTime FROM comics ORDER BY updatedAt DESC LIMIT ?'
  ).all(limit)
  return rows.map(r => ({
    sourceUrl: r.sourceUrl, title: r.title, cover: r.cover, updateTime: r.updateTime != null ? String(r.updateTime) : ''
  }))
}

async function deleteComic(id) {
  if (!db) initDB()
  db.prepare('DELETE FROM chapters WHERE comic_id=?').run(id)
  db.prepare('DELETE FROM comics WHERE id=?').run(id)
}

async function clearAllComics() {
  if (!db) initDB()
  db.prepare('DELETE FROM chapters').run()
  db.prepare('DELETE FROM comics').run()
}

async function cleanupPureLocalComics() {
  if (!db) initDB()
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
  if (!db) initDB()
  const r = db.prepare('SELECT COUNT(*) as c FROM comics').get()
  return r ? r.c : 0
}

async function getComicsWithMissingFields(limit) {
  if (!db) initDB()
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
  return rows.map(rowToComic)
}

async function getAllCategories() {
  if (!db) initDB()
  const rows = db.prepare("SELECT DISTINCT category FROM comics WHERE category IS NOT NULL AND category != '' ORDER BY category").all()
  return rows.map(v => v.category)
}

async function getCategoryStats() {
  if (!db) initDB()
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

async function getDbPath() {
  return dbFile()
}

async function getChaptersCount() {
  if (!db) initDB()
  const r = db.prepare('SELECT COUNT(*) as c FROM chapters').get()
  return r ? r.c : 0
}

async function getImagesCount() {
  if (!db) initDB()
  const r = db.prepare('SELECT SUM(image_count) as s FROM chapters').get()
  return r ? (r.s || 0) : 0
}

function getDirectorySize(dirPath) {
  let total = 0
  if (!fs.existsSync(dirPath)) return 0
  for (const entry of fs.readdirSync(dirPath)) {
    const entryPath = path.join(dirPath, entry)
    try {
      const stat = fs.statSync(entryPath)
      if (stat.isDirectory()) {
        total += getDirectorySize(entryPath)
      } else if (stat.isFile()) {
        total += stat.size
      }
    } catch (e) {
      console.warn('[DB] 读取文件大小失败:', entryPath, e.message)
    }
  }
  return total
}

async function getDownloadSize() {
  if (!db) initDB()
  const rows = db.prepare("SELECT DISTINCT path FROM download_records WHERE path IS NOT NULL AND path != ''").all()
  const paths = rows.map(v => v.path).filter(Boolean)
  let total = 0
  for (const p of paths) {
    if (!fs.existsSync(p)) continue
    const stat = fs.statSync(p)
    if (stat.isDirectory()) {
      total += getDirectorySize(p)
    } else if (stat.isFile()) {
      total += stat.size
    }
  }
  return total
}

async function getBooksReadCount() {
  if (!db) initDB()
  const r = db.prepare('SELECT COUNT(DISTINCT comic_id) as c FROM reading_progress').get()
  return r ? r.c : 0
}

async function getChaptersReadCount() {
  if (!db) initDB()
  const r = db.prepare('SELECT COUNT(*) as c FROM reading_progress').get()
  return r ? r.c : 0
}

async function getReadingStreak() {
  if (!db) initDB()
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

async function updateComic(id, changes = {}) {
  if (!db) initDB()
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

// ========== 全文搜索 ==========

async function searchComics(query) {
  if (!db) initDB()
  try {
    const ftsQuery = `"${query.replace(/"/g, '""')}"`
    const rows = db.prepare(`SELECT c.id, c.sourceUrl, c.title, c.cover, c.local_cover, c.author, c.status, c.desc_text, c.tags, c.category, c.updateTime, c.chapter_count, c.update_delta, c.favorited, c.createdAt, c.updatedAt, c.local_path FROM comics_fts f JOIN comics c ON c.rowid = f.rowid
      WHERE comics_fts MATCH ? ORDER BY rank LIMIT 30`).all(ftsQuery)
    if (rows.length === 0) return []
    return rows.map(row => rowToComic(row, { skipEpubCheck: true }))
  } catch {
    const q = `%${query}%`
    const rows = db.prepare(`SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path FROM comics
      WHERE title LIKE ? OR author LIKE ? OR tags LIKE ?
      ORDER BY updatedAt DESC LIMIT 30`).all(q, q, q)
    return rows.map(row => rowToComic(row, { skipEpubCheck: true }))
  }
}

async function advancedSearch(query, filters = {}) {
  if (!db) initDB()

  const conditions = []
  const params = []

  if (query) {
    if (fts5Available) {
      const ftsQuery = `"${query.replace(/"/g, '""')}"`
      conditions.push(`rowid IN (SELECT rowid FROM comics_fts WHERE comics_fts MATCH ?)`)
      params.push(ftsQuery)
    } else {
      const q = `%${query}%`
      conditions.push('(title LIKE ? OR author LIKE ? OR tags LIKE ?)')
      params.push(q, q, q)
    }
  }

  if (filters.tag) {
    conditions.push('tags LIKE ?')
    params.push(`%${filters.tag}%`)
  }

  if (filters.author) {
    conditions.push('author LIKE ?')
    params.push(`%${filters.author}%`)
  }

  if (filters.status) {
    conditions.push('status LIKE ?')
    params.push(`%${filters.status}%`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sql = `SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path FROM comics
    ${whereClause}
    ORDER BY updatedAt DESC LIMIT 30`

  try {
    const rows = db.prepare(sql).all(...params)
    if (rows.length === 0) return []
    return rows.map(row => rowToComic(row, { skipEpubCheck: true }))
  } catch (e) {
    console.warn('[DB] 高级搜索失败:', e.message)
    if (query) return searchComics(query)
    return []
  }
}

// ========== 阅读进度 ==========

async function saveReadingProgress(comicId, chapterIndex, chapterUrl, pageIndex, totalPages) {
  if (!db) initDB()
  const progress = totalPages > 0 ? (pageIndex + 1) / totalPages : 0
  db.prepare(`INSERT OR REPLACE INTO reading_progress
    (id, comic_id, chapter_index, chapter_url, page_index, total_pages, progress, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    comicId, comicId, chapterIndex, chapterUrl || '', pageIndex, totalPages, progress, Date.now()
  )
}

async function getReadingProgress(comicId) {
  if (!db) initDB()
  const row = db.prepare('SELECT * FROM reading_progress WHERE comic_id = ? LIMIT 1').get(comicId)
  if (!row) return null
  return {
    id: row.id, comicId: row.comic_id, chapterIndex: row.chapter_index,
    chapterUrl: row.chapter_url, pageIndex: row.page_index, totalPages: row.total_pages,
    progress: row.progress, updatedAt: row.updated_at
  }
}

async function getAllReadingHistory(limit = 20) {
  if (!db) initDB()
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
  if (!db) initDB()
  db.prepare('DELETE FROM reading_progress WHERE comic_id = ?').run(comicId)
  return true
}

async function setFavorite(comicId, favorited) {
  if (!db) initDB()
  db.prepare('UPDATE comics SET favorited = ? WHERE id = ? OR sourceUrl = ?').run(favorited ? 1 : 0, comicId, comicId)
  return true
}

async function clearUpdateDelta(comicId) {
  if (!db) initDB()
  db.prepare('UPDATE comics SET update_delta = 0 WHERE id = ?').run(comicId)
}

async function getFavoritedComics() {
  if (!db) initDB()
  const rows = db.prepare(`SELECT id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, createdAt, updatedAt, local_path
    FROM comics WHERE favorited = 1 ORDER BY updatedAt DESC`).all()
  const list = rows.map(rowToComic)
  for (const doc of list) {
    const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
    doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  }
  return list
}

function getRawDB() { return db }

// ========== 离线下载记录 ==========

async function saveDownloadRecord(record) {
  if (!db) initDB()
  const { comicId, comicTitle, chapterIndex, chapterName, imagesCount, path: imgPath } = record
  db.prepare(`INSERT OR REPLACE INTO download_records
    (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    comicId || '', comicTitle || '', chapterIndex ?? 0, chapterName || '', imagesCount || 0, imgPath || '', Date.now()
  )
}

async function getDownloadRecords(filter = {}) {
  if (!db) initDB()
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
  if (!db) initDB()
  db.prepare('DELETE FROM download_records WHERE id = ?').run(id)
}

async function cleanStaleDownloadRecords() {
  if (!db) initDB()
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

// ========== 章节名升级 ==========

/**
 * 检查漫画的章节名是否过于简单（如「第N话」），需要重新爬取详情页
 * 用于防御章节名不正确导致的下载目录错乱 bug
 */
function isChapterNameGeneric(name) {
  if (!name) return true
  const trimmed = String(name).trim()
  // 占位符模式：第N话、第N章、第N話、chN、episodeN 等
  const genericPatterns = [
    /^第\s*\d+\s*[话話章回集]$/,
    /^ch(apter)?\s*\d+$/i,
    /^episode\s*\d+$/i,
    /^ep\s*\d+$/i
  ]
  return genericPatterns.some(p => p.test(trimmed))
}

async function getComicsWithGenericChapterNames(batchSize = 10) {
  if (!db) initDB()
  // 使用章节名模式匹配而非长度，更精确
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
  if (!db) initDB()
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
    const chRows = db.prepare('SELECT name, url FROM chapters WHERE comic_id = ? ORDER BY sort_order').all(doc._id)
    doc.chapters = chRows.map(r => ({ name: r.name, url: r.url }))
  }
  return docs
}

async function updateChapterName(comicId, sortOrder, newName) {
  if (!db) initDB()
  db.prepare('UPDATE chapters SET name = ? WHERE comic_id = ? AND sort_order = ?').run(newName || '', comicId, sortOrder)
}

async function updateChapterNames(comicId, updates) {
  if (!db) initDB()
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
  if (!db) initDB()
  db.prepare('UPDATE comics SET chapter_names_enriched = 1, updatedAt = ? WHERE id = ?').run(Date.now(), comicId)
}

async function resetUpdateDelta(sourceUrl) {
  if (!db) initDB()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  db.prepare('UPDATE comics SET update_delta = 0, updatedAt = ? WHERE id = ?').run(Date.now(), row.id)
  return 1
}

// ========== 爬取进度管理 ==========

async function initCrawlQueue(urls) {
  if (!db) initDB()
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
  if (!db) initDB()
  const row = db.prepare(`SELECT url, title FROM crawl_progress 
    WHERE status = 'pending' 
    OR (status = 'failed' AND retry_count < 3) 
    ORDER BY created_at ASC LIMIT 1`).get()
  if (!row) return null
  return { url: row.url, title: row.title }
}

async function updateCrawlStatus(url, status, error = null) {
  if (!db) initDB()
  const existing = db.prepare('SELECT retry_count FROM crawl_progress WHERE url = ?').get(url)
  const retryCount = existing ? existing.retry_count : 0
  db.prepare(`UPDATE crawl_progress SET status = ?, retry_count = ?, last_error = ?, updated_at = ? WHERE url = ?`).run(
    status, retryCount + (status === 'failed' ? 1 : 0), error, Date.now(), url
  )
}

async function getCrawlStats() {
  if (!db) initDB()
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM crawl_progress GROUP BY status').all()
  const stats = {}
  for (const row of rows) {
    stats[row.status] = row.count
  }
  stats.total = (stats.pending || 0) + (stats.crawling || 0) + (stats.done || 0) + (stats.failed || 0) + (stats.failed_permanent || 0)
  return stats
}

async function recordFailureReason(reason) {
  if (!db) initDB()
  const existing = db.prepare('SELECT count FROM failure_stats WHERE reason = ?').get(reason)
  const count = existing ? existing.count : 0
  db.prepare('INSERT OR REPLACE INTO failure_stats (reason, count, last_update) VALUES (?, ?, ?)').run(reason, count + 1, Date.now())
}

// 爬取列表页时更新已有漫画的元数据
async function updateComicListMeta(list) {
  if (!db) initDB()
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

// ========== 本地漫画导入 ==========

async function checkExistingByTitle(titles) {
  if (!db) initDB()
  if (!titles || titles.length === 0) return {}

  const allComics = db.prepare('SELECT id, title, sourceUrl FROM comics').all()
  if (allComics.length === 0) {
    const result = {}
    for (const t of titles) result[t] = false
    return result
  }

  const dbComics = allComics.map(({ id, title, sourceUrl }) => ({
    id, title, sourceUrl,
    normTitle: normalizeName(title)
  }))

  const result = {}
  for (const title of titles) {
    const norm = normalizeName(title)
    let matched = false
    for (const c of dbComics) {
      if (c.title === title) { matched = true; break }
      if (c.normTitle && norm && c.normTitle === norm) { matched = true; break }
      if (c.normTitle && norm && (c.normTitle.includes(norm) || norm.includes(c.normTitle))) {
        if (c.normTitle.length > 2 && norm.length > 2) { matched = true; break }
      }
    }
    result[title] = matched
  }
  return result
}

async function scanLocalComics(dirPath) {
  if (!fs.existsSync(dirPath)) return []

  const IMG_EXT = /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i
  const chapterDirPattern = /(^\d+-)|(^第\d+)|(^(ch(apter)?[_\-]?)?\d+)/i
  const MAX_COMICS = 50000
  const MAX_CHAPTERS_PER_COMIC = 2000

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const comics = []

  const sortByNumber = (arr) => {
    const getIdx = (name) => {
      const m = name.match(/\d+/)
      return m ? parseInt(m[0], 10) : 99999
    }
    return arr.sort((a, b) => {
      const ia = getIdx(typeof a === 'string' ? a : a.name)
      const ib = getIdx(typeof b === 'string' ? b : b.name)
      if (ia !== ib) return ia - ib
      return (typeof a === 'string' ? a : a.name).localeCompare(typeof b === 'string' ? b : b.name)
    })
  }

  const yieldEvery = 20
  let processedCount = 0

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (comics.length >= MAX_COMICS) break

    const comicDir = path.join(dirPath, e.name)
    let subs
    try {
      subs = await fs.promises.readdir(comicDir, { withFileTypes: true })
    } catch { continue }

    let chapterDirs = subs.filter(d => d.isDirectory() && chapterDirPattern.test(d.name))
    if (chapterDirs.length === 0) {
      const candidates = []
      for (const d of subs) {
        if (!d.isDirectory()) continue
        const chDir = path.join(comicDir, d.name)
        try {
          const files = await fs.promises.readdir(chDir)
          if (files.some(f => IMG_EXT.test(f))) candidates.push(d)
        } catch {}
      }
      chapterDirs = candidates
    }
    if (chapterDirs.length === 0) continue
    if (chapterDirs.length > MAX_CHAPTERS_PER_COMIC) {
      chapterDirs = sortByNumber(chapterDirs).slice(0, MAX_CHAPTERS_PER_COMIC)
    }
    sortByNumber(chapterDirs)

    const chapters = []
    for (let idx = 0; idx < chapterDirs.length; idx++) {
      const d = chapterDirs[idx]
      const chDir = path.join(comicDir, d.name)
      let imageFiles
      try {
        imageFiles = (await fs.promises.readdir(chDir)).filter(f => IMG_EXT.test(f))
      } catch { continue }
      sortByNumber(imageFiles)
      const cleanName = d.name
        .replace(/^\d+-/, '')
        .replace(/^第(\d+)[話话章回集卷]/, '第$1话')
        .replace(/^ch(apter)?[_\-]?/, '')
      chapters.push({
        name: cleanName || `第${idx + 1}章`,
        imageCount: imageFiles.length,
        path: chDir
      })
    }
    if (chapters.length === 0) continue

    let cover = null
    const coverPath = path.join(comicDir, 'cover.webp')
    if (fs.existsSync(coverPath)) {
      cover = coverPath
    }

    comics.push({
      title: e.name,
      coverPath: cover,
      chapters,
      totalImages: chapters.reduce((s, c) => s + c.imageCount, 0)
    })

    processedCount++
    if (processedCount % yieldEvery === 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  return comics
}

async function importLocalComic(comic, targetRoot, sourceUrl, destDir) {
  const titleDir = destDir || path.join(targetRoot, sanitizeFilename(comic.title))
  if (!fs.existsSync(titleDir)) fs.mkdirSync(titleDir, { recursive: true })

  if (comic.coverPath) {
    const srcPath = comic.coverPath.replace('file://', '')
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(titleDir, 'cover.webp'))
    }
  }

  let dbChapters = []
  for (let i = 0; i < comic.chapters.length; i++) {
    const ch = comic.chapters[i]
    const folderName = `${i + 1}-${sanitizeFilename(ch.name)}`
    const destDir = path.join(titleDir, folderName)
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

    const srcFiles = fs.readdirSync(ch.path).filter(f => /\.(webp|jpg|png)$/i.test(f)).sort()
    for (const f of srcFiles) {
      fs.copyFileSync(path.join(ch.path, f), path.join(destDir, f))
    }

    dbChapters.push({ name: ch.name, url: '', index: i })
  }

  const now = Date.now()
  const id = sourceUrl || crypto.randomUUID()
  if (sourceUrl) {
    const existing = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (existing) {
      db.prepare('UPDATE comics SET chapter_count=?, updatedAt=?, favorited=1 WHERE id=?').run(comic.chapters.length, now, existing.id)
      db.prepare('DELETE FROM chapters WHERE comic_id=?').run(existing.id)
      const insertCh = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order) VALUES (?,?,?,?)')
      const insertAll = db.transaction(() => {
        for (let i = 0; i < dbChapters.length; i++) {
          insertCh.run(existing.id, dbChapters[i].name, '', i)
        }
      })
      insertAll()
    } else {
      const coverOnDisk = path.join(titleDir, 'cover.webp')
      const localCoverPath = fs.existsSync(coverOnDisk) ? coverOnDisk : (comic.coverPath || '')
      db.prepare('INSERT OR IGNORE INTO comics (id, sourceUrl, title, cover, local_cover, status, chapter_count, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id, sourceUrl || null, comic.title, '', localCoverPath, '连载中', comic.chapters.length, 1, targetRoot, now, now
      )
      const insertCh = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order) VALUES (?,?,?,?)')
      const insertAll = db.transaction(() => {
        for (let i = 0; i < dbChapters.length; i++) {
          insertCh.run(id, dbChapters[i].name, '', i)
        }
      })
      insertAll()
    }
  } else {
    const coverOnDisk2 = path.join(titleDir, 'cover.webp')
    const localCoverPath2 = fs.existsSync(coverOnDisk2) ? coverOnDisk2 : (comic.coverPath || '')
    db.prepare('INSERT OR IGNORE INTO comics (id, sourceUrl, title, cover, local_cover, status, chapter_count, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, null, comic.title, '', localCoverPath2, '连载中', comic.chapters.length, 1, targetRoot, now, now
    )
    const insertCh = db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order) VALUES (?,?,?,?)')
    const insertAll = db.transaction(() => {
      for (let i = 0; i < dbChapters.length; i++) {
        insertCh.run(id, dbChapters[i].name, '', i)
      }
    })
    insertAll()
  }

  for (const ch of dbChapters) {
    const folderName = `${ch.index + 1}-${sanitizeFilename(ch.name)}`
    db.prepare('INSERT INTO download_records (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at) VALUES (?,?,?,?,?,?,?)').run(
      sourceUrl || id, comic.title, ch.index, ch.name, comic.chapters[ch.index].imageCount, path.join(titleDir, folderName), now
    )
  }

  return { success: true, title: comic.title, chapterCount: comic.chapters.length }
}

async function registerExistingDownload(comic, sourceUrl) {
  if (!db) initDB()
  const now = Date.now()

  const existing = await getDownloadRecords({ comicTitle: comic.title })
  const existingKeys = new Set(existing.map(r => `${r.comicTitle}-${r.chapterIndex}`))

  let finalComicId = null
  let matchedBy = null
  let wasFavoritedBefore = false

  if (sourceUrl) {
    const r1 = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (r1) {
      finalComicId = r1.id
      wasFavoritedBefore = !!r1.favorited
      matchedBy = 'sourceUrl'
    }
  }

  if (!finalComicId) {
    const normTitle = normalizeName(comic.title)
    const allComics = db.prepare('SELECT id, title, favorited FROM comics').all()
    for (const row of allComics) {
      if (row.title === comic.title) {
        finalComicId = row.id
        wasFavoritedBefore = !!row.favorited
        matchedBy = 'title-exact'
        break
      }
      if (normalizeName(row.title) === normTitle) {
        finalComicId = row.id
        wasFavoritedBefore = !!row.favorited
        matchedBy = 'title-fuzzy'
        break
      }
      const normDb = normalizeName(row.title)
      if (normDb && normTitle && (normDb.includes(normTitle) || normTitle.includes(normDb))) {
        if (normDb.length > 2 && normTitle.length > 2) {
          finalComicId = row.id
          wasFavoritedBefore = !!row.favorited
          matchedBy = 'title-contains'
          break
        }
      }
    }
  }

  if (!finalComicId) {
    finalComicId = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    matchedBy = 'new'
  }

  const chapters = Array.isArray(comic.chapters) ? comic.chapters : []
  const coverValue = comic.coverPath || null
  const localCover = coverValue

  let comicInserted = false
  if (matchedBy === 'new') {
    try {
      db.prepare('INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        finalComicId, sourceUrl || null, comic.title, null, localCover, '', '连载中', '', '', '', null, chapters.length, 0, 1, comic.localPath || null, now, now)
      comicInserted = true
      wasFavoritedBefore = false
    } catch (err) {
      console.error(`[DB] registerExistingDownload INSERT《${comic.title}》失败:`, err.message)
      matchedBy = 'title-exact-fallback'
      db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(cover, ?), local_cover = COALESCE(local_cover, ?), favorited = 1, local_path = COALESCE(local_path, ?), updatedAt = ? WHERE title = ?').run(
        chapters.length, null, localCover, comic.localPath || null, now, comic.title)
    }
  } else {
    const effectiveSourceUrl = sourceUrl || (() => {
      const r = db.prepare('SELECT sourceUrl FROM comics WHERE id = ?').get(finalComicId)
      return r ? r.sourceUrl : null
    })()
    db.prepare('UPDATE comics SET chapter_count = ?, local_cover = COALESCE(NULLIF(local_cover, \'\'), ?), sourceUrl = COALESCE(NULLIF(sourceUrl, \'\'), ?), favorited = 1, local_path = COALESCE(local_path, ?), updatedAt = ? WHERE id = ?').run(
      chapters.length, localCover, effectiveSourceUrl || null, comic.localPath || null, now, finalComicId)
  }

  const existingChapters = db.prepare('SELECT sort_order FROM chapters WHERE comic_id = ?').all(finalComicId)
  const existingChapterOrders = new Set(existingChapters.map(v => v.sort_order))

  let registeredCount = 0
  let skippedCount = 0
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    if (!existingChapterOrders.has(i)) {
      db.prepare('INSERT INTO chapters (comic_id, name, url, sort_order, image_count) VALUES (?,?,?,?,?)').run(
        finalComicId, ch.name || '', '', i, ch.imageCount || 0)
    }

    const key = `${comic.title}-${i}`
    if (existingKeys.has(key)) {
      skippedCount++
    } else {
      db.prepare('INSERT INTO download_records (comic_id, comic_title, chapter_index, chapter_name, images_count, path, downloaded_at) VALUES (?,?,?,?,?,?,?)').run(
        finalComicId, comic.title, i, ch.name || '', ch.imageCount || 0, ch.path || '', now)
      registeredCount++
    }
  }

  const verifyRow = db.prepare('SELECT favorited, updatedAt FROM comics WHERE id = ?').get(finalComicId)
  let verifiedFavorited = false
  if (verifyRow) {
    verifiedFavorited = !!verifyRow.favorited
  }

  const isNewlyFavorited = verifiedFavorited && !wasFavoritedBefore
  console.log(`[DB] 注册《${comic.title}》: matchedBy=${matchedBy}, registered=${registeredCount}章, skipped=${skippedCount}章, favorited=${verifiedFavorited} (was=${wasFavoritedBefore}, newly=${isNewlyFavorited}), id=${finalComicId.substring(0,30)}`)

  return {
    success: true, title: comic.title, chapterCount: chapters.length,
    registeredCount, skippedCount, matchedBy, comicId: finalComicId,
    wasFavoritedBefore, isNewlyFavorited, newlyInserted: comicInserted
  }
}

async function matchComicOnline(comic, sources) {
  if (!comic || !comic.title || !sources) return null
  const normTitle = normalizeTitle(comic.title)
  if (!normTitle || normTitle.length < 2) return null

  const searchKeyword = normalizeTitle(comic.title).substring(0, 30)
  let searchResults = []
  try {
    searchResults = await sources.multiSearch(searchKeyword, 1)
  } catch (e) {
    console.warn(`[matchOnline] 搜索《${comic.title}》失败:`, e.message)
    return null
  }

  if (!searchResults || searchResults.length === 0) {
    try {
      searchResults = await sources.multiSearch(comic.title, 1)
    } catch (e2) {
      return null
    }
    if (!searchResults || searchResults.length === 0) return null
  }

  const first = searchResults[0]
  if (normalizeTitle(first.title) === normTitle) {
    console.log(`[matchOnline] 《${comic.title}》精确匹配到: ${first.title}`)
    return { sourceUrl: first.sourceUrl, matchScore: 100, matchedTitle: first.title }
  }

  let bestMatch = null
  let bestScore = 0
  for (const item of searchResults.slice(0, 10)) {
    const normItem = normalizeTitle(item.title)
    if (!normItem) continue
    if (normItem === normTitle) {
      return { sourceUrl: item.sourceUrl, matchScore: 100, matchedTitle: item.title }
    }
    if (normItem.includes(normTitle) || normTitle.includes(normItem)) {
      const lenDiff = Math.abs(normItem.length - normTitle.length)
      if (lenDiff <= 10) {
        const score = Math.max(80 - lenDiff * 3, 50)
        if (score > bestScore) {
          bestScore = score
          bestMatch = { sourceUrl: item.sourceUrl, matchScore: score, matchedTitle: item.title }
        }
      }
    }
  }

  if (bestMatch) {
    console.log(`[matchOnline] 《${comic.title}》模糊匹配到: ${bestMatch.matchedTitle} (score=${bestMatch.matchScore})`)
    return bestMatch
  }

  return null
}

async function autoScanLocalComics(paths, sources, onProgress) {
  if (!paths || paths.length === 0) return { total: 0, matched: 0, imported: 0, skipped: 0 }
  if (!db) initDB()

  let totalScanned = 0
  let totalMatched = 0
  let totalImported = 0
  let totalSkipped = 0

  // 预加载数据库中的漫画，优先用已有的 sourceUrl（避免不必要的搜索）
  const dbComics = db.prepare('SELECT title, sourceUrl FROM comics').all()
  const dbComicByTitle = new Map()
  for (const c of dbComics) {
    const normTitle = normalizeName(c.title)
    if (c.sourceUrl) {
      dbComicByTitle.set(c.title, c.sourceUrl)
      if (normTitle) dbComicByTitle.set(normTitle, c.sourceUrl)
    }
  }
  console.log(`[autoScan] 数据库中有 ${dbComics.length} 本漫画，${dbComicByTitle.size} 个有 sourceUrl`)

  for (const scanPath of paths) {
    if (!fs.existsSync(scanPath)) {
      console.warn(`[autoScan] 路径不存在: ${scanPath}`)
      continue
    }
    if (onProgress) onProgress({ text: `扫描: ${scanPath}`, pct: 0 })

    const comics = await scanLocalComics(scanPath)
    totalScanned += comics.length

    if (onProgress) onProgress({ text: `找到 ${comics.length} 本漫画`, pct: 10, total: comics.length })

    for (let i = 0; i < comics.length; i++) {
      const comic = comics[i]
      let sourceUrl = null
      let matchMethod = 'none'

      // 方法1：优先用数据库中已有的 sourceUrl（按书名精确匹配）
      if (dbComicByTitle.has(comic.title)) {
        sourceUrl = dbComicByTitle.get(comic.title)
        matchMethod = 'db-sourceUrl'
      } else {
        // 方法2：数据库模糊匹配
        const normTitle = normalizeName(comic.title)
        if (normTitle && dbComicByTitle.has(normTitle)) {
          sourceUrl = dbComicByTitle.get(normTitle)
          matchMethod = 'db-sourceUrl-fuzzy'
        }
      }

      // 方法3：数据库有这本漫画但没有 sourceUrl，或者数据库中完全没有 → 才去搜索
      if (!sourceUrl) {
        const match = await matchComicOnline(comic, sources)
        if (match) {
          sourceUrl = match.sourceUrl
          matchMethod = 'online-search'
        }
      }

      if (sourceUrl) {
        totalMatched++
        comic.localPath = scanPath
        const result = await registerExistingDownload(comic, sourceUrl)
        if (result.newlyInserted || result.registeredCount > 0) {
          totalImported++
        } else {
          totalSkipped++
        }
      } else {
        // 即使没有 sourceUrl，也用 null 注册（有本地路径即可）
        comic.localPath = scanPath
        const result = await registerExistingDownload(comic, null)
        if (result && (result.newlyInserted || result.registeredCount > 0)) {
          totalImported++
        } else {
          totalSkipped++
        }
      }

      if (onProgress) {
        onProgress({
          text: `处理: ${comic.title} (${matchMethod})`,
          pct: 10 + Math.round((i + 1) / comics.length * 90),
          current: i + 1, total: comics.length,
          matched: totalMatched, imported: totalImported, skipped: totalSkipped
        })
      }
    }
  }

  return { total: totalScanned, matched: totalMatched, imported: totalImported, skipped: totalSkipped }
}

async function importLocalComics(dirPath, onProgress) {
  if (!fs.existsSync(dirPath)) {
    throw new Error('目录不存在: ' + dirPath)
  }

  if (onProgress) {
    onProgress({ text: '正在扫描目录...', pct: 0, imported: 0, total: 0 })
  }

  const comics = await scanLocalComics(dirPath)

  if (onProgress) {
    onProgress({ text: `扫描完成，找到 ${comics.length} 本漫画`, pct: 10, imported: 0, total: comics.length })
  }

  if (comics.length === 0) {
    return { imported: 0, skipped: 0, failed: 0 }
  }

  let imported = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < comics.length; i++) {
    const comic = comics[i]

    try {
      const matched = await matchComicByTitle(comic.title)
      if (matched) {
        const localPath = path.join(dirPath, comic.title)
        db.prepare('UPDATE comics SET local_path = ? WHERE id = ?').run(localPath, matched.id)
        skipped++
      } else {
        comic.localPath = path.join(dirPath, comic.title)
        await registerExistingDownload(comic, null)
        imported++
      }
    } catch (e) {
      failed++
      console.error(`[Import] 导入失败: ${comic.title}`, e)
    }

    if (onProgress) {
      const pct = Math.round(10 + (i + 1) / comics.length * 90)
      onProgress({ text: `正在导入: ${comic.title}`, pct, imported, skipped, failed, total: comics.length })
    }
  }

  if (onProgress) {
    onProgress({ text: `导入完成！成功 ${imported} 本，跳过 ${skipped} 本，失败 ${failed} 本`, pct: 100, imported, skipped, failed, total: comics.length })
  }

  return { imported, skipped, failed }
}

async function matchComicByTitle(title) {
  if (!db) initDB()

  let row = db.prepare('SELECT id, title, sourceUrl FROM comics WHERE title = ?').get(title)
  if (row) return { id: row.id, title: row.title, sourceUrl: row.sourceUrl }

  const normalize = (s) => s.replace(/[\s\u3000]+/g, ' ').trim()
  const normTitle = normalize(title)

  const all = db.prepare('SELECT id, title, sourceUrl FROM comics').all()
  for (const r of all) {
    if (normalize(r.title) === normTitle) {
      return { id: r.id, title: r.title, sourceUrl: r.sourceUrl }
    }
  }

  return null
}

module.exports = {
  initDB,
  upsertComic, updateChapterImageCounts, updateChapterImageCountBySourceUrl,
  getComicsNeedingImageCountUpdate, getChaptersWithoutImageCount,
  upsertComics, getComics, getAllComics, getUntaggedComics, getSerializedComics,
  getFavoritedForSyncBatch, markSynced,
  getAllComicUrls, getComicByUrl, getComicById, deleteComic, clearAllComics,
  cleanupPureLocalComics, getComicsCount, getComicsWithMissingFields,
  getAllCategories, getCategoryStats, searchComics, advancedSearch, getRawDB,
  saveReadingProgress, getReadingProgress, getAllReadingHistory,
  deleteReadingProgress, setFavorite, clearUpdateDelta, getFavoritedComics,
  getDbPath, getChaptersCount, getImagesCount, getDownloadSize,
  getBooksReadCount, getChaptersReadCount, getReadingStreak, getTotalReadTime,
  updateComic, saveDownloadRecord, getDownloadRecords, deleteDownloadRecord,
  cleanStaleDownloadRecords,
  scanLocalComics, importLocalComic, registerExistingDownload,
  checkExistingByTitle, getComicsNeedingChapterNameEnrichment,
  getComicsWithGenericChapterNames, isChapterNameGeneric,
  updateChapterName, updateChapterNames, markComicChaptersEnriched, getExistingSourceUrls,
  updateComicListMeta, autoScanLocalComics, matchComicOnline, importLocalComics,
  initCrawlQueue, getNextPendingUrl, updateCrawlStatus, getCrawlStats,
  recordFailureReason
}