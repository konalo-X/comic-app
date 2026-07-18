'use strict'

const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')
const { sanitizeFilename, normalizeName, normalizeTitle } = require('../utils')
const { runMigrations } = require('./migrations')

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
let fts5Available = false

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

  db = new Database(file)

  function testWrite(database) {
    try {
      database.exec('CREATE TABLE IF NOT EXISTS _write_test (id INTEGER PRIMARY KEY)')
      database.exec('INSERT OR REPLACE INTO _write_test (id) VALUES (1)')
      database.exec('DROP TABLE _write_test')
      return true
    } catch (e) {
      return false
    }
  }

  let canWrite = testWrite(db)

  if (!canWrite) {
    console.warn('[DB] 数据库不可写（可能是 macOS App Management 限制），创建新数据库文件')
    try { db.close() } catch (_) {}

    const { app: electronApp } = require('electron')
    const candidates = [
      path.join(electronApp.getPath('cache'), 'comics.sqlite'),
      path.join(dir, 'data', 'comics.sqlite'),
      path.join(require('os').homedir(), '.comic-app-data', 'comics.sqlite'),
    ]

    let migrated = false
    for (const newFile of candidates) {
      const newDir = path.dirname(newFile)
      try {
        fs.mkdirSync(newDir, { recursive: true })
        console.log(`[DB] 尝试创建目录: ${newDir} ✓`)
      } catch (e) {
        console.warn(`[DB] 创建目录失败 ${newDir}: ${e.message}`)
      }
      for (const suffix of ['-wal', '-shm', '']) {
        try { fs.unlinkSync(newFile + suffix) } catch (_) {}
      }
      try {
        db = new Database(newFile)
        db.pragma('journal_mode = WAL')
        console.log(`[DB] 新数据库创建成功: ${newFile}`)

        try {
          const escapedFile = String(file).replace(/'/g, "''")
          db.exec(`ATTACH DATABASE '${escapedFile}' AS old_db`)
          const allOldTables = db.prepare("SELECT name, sql FROM old_db.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
          const fts5Excluded = new Set()
          for (const t of allOldTables) {
            if (t.sql && t.sql.includes('USING fts5')) {
              fts5Excluded.add(t.name)
            }
          }
          for (const t of allOldTables) {
            for (const ftsName of fts5Excluded) {
              if (t.name === ftsName || t.name.startsWith(ftsName + '_')) {
                fts5Excluded.add(t.name)
              }
            }
          }
          for (const { name } of allOldTables) {
            if (fts5Excluded.has(name)) continue
            const escapedName = String(name).replace(/"/g, '""')
            db.exec(`CREATE TABLE IF NOT EXISTS "${escapedName}" AS SELECT * FROM old_db."${escapedName}"`)
          }
          const indexes = db.prepare("SELECT sql FROM old_db.sqlite_master WHERE type='index' AND sql IS NOT NULL").all()
          for (const { sql } of indexes) {
            try { db.exec(sql) } catch (_) {}
          }
          const triggers = db.prepare("SELECT sql FROM old_db.sqlite_master WHERE type='trigger' AND sql IS NOT NULL AND sql NOT LIKE '%comics_fts%'").all()
          for (const { sql } of triggers) {
            try { db.exec(sql) } catch (_) {}
          }
          db.exec('DETACH DATABASE old_db')
          console.log(`[DB] 数据已迁移到新数据库（跳过 FTS5 虚拟表，将由 initDB 重建）`)
        } catch (e) {
          console.warn('[DB] 数据迁移失败（将使用空数据库）:', e.message)
        }

        dbPath = newFile
        migrated = true
        break
      } catch (e) {
        console.warn(`[DB] ${newFile} 创建失败: ${e.message}`)
      }
    }

    if (!migrated) {
      throw new Error('无法创建可写的数据库文件，请检查目录权限')
    }
    canWrite = true
  } else {
    try {
      db.pragma('journal_mode = WAL')
    } catch (e) {
      console.warn('[DB] WAL 模式失败，使用 DELETE 模式:', e.message)
      try { db.pragma('journal_mode = DELETE') } catch (_) {}
    }
  }

  try {
    db.pragma('synchronous = FULL')
    db.pragma('cache_size = -8000')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 10000')
    db.pragma('wal_autocheckpoint = 1000')
  } catch (e) {
    console.warn('[DB] 部分性能 pragma 失败（可忽略）:', e.message)
  }

  runMigrations(db)

  try {
    const existingFts = db.prepare("SELECT sql FROM sqlite_master WHERE name='comics_fts'").get()
    if (existingFts && existingFts.sql && !existingFts.sql.includes('USING fts5')) {
      console.warn('[DB] comics_fts 存在但非 FTS5 虚拟表，正在删除重建...')
      for (const suffix of ['_data', '_idx', '_docsize', '_config']) {
        db.exec(`DROP TABLE IF EXISTS comics_fts${suffix}`)
      }
      db.exec('DROP TABLE IF EXISTS comics_fts')
    }

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS comics_fts USING fts5(
      title, author, tags, content='comics', content_rowid='rowid'
    )`)

    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_insert AFTER INSERT ON comics BEGIN
      INSERT INTO comics_fts(rowid, title, author, tags) VALUES (new.rowid, new.title, new.author, new.tags);
    END`)

    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_delete AFTER DELETE ON comics BEGIN
      INSERT INTO comics_fts(comics_fts, rowid, title, author, tags) VALUES('delete', old.rowid, old.title, old.author, old.tags);
    END`)

    db.exec(`CREATE TRIGGER IF NOT EXISTS comics_fts_update AFTER UPDATE ON comics BEGIN
      INSERT INTO comics_fts(comics_fts, rowid, title, author, tags) VALUES('delete', old.rowid, old.title, old.author, old.tags);
      INSERT INTO comics_fts(rowid, title, author, tags) VALUES (new.rowid, new.title, new.author, new.tags);
    END`)

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

function save() {}

function idGen() {
  return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
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
  // 默认不检查 epub（避免列表查询时逐本扫描磁盘），需要时显式传 checkEpub: true
  if (opts.checkEpub) {
    try {
      const epubPath = path.join(getDownloadsDir(), `${sanitizeFilename(row.title)}.epub`)
      result.epubExists = fs.existsSync(epubPath)
    } catch (_) {
      result.epubExists = false
    }
  } else {
    result.epubExists = false
  }
  return result
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

function getDB() { return db }
function setDB(instance) { db = instance }
function getDbPath() { return dbFile() }
function getFts5Available() { return fts5Available }
function setFts5Available(val) { fts5Available = val }
function getRawDB() { return db }

module.exports = {
  initDB, save, idGen, rowToComic, getDirectorySize,
  getDB, setDB, getDbPath, getFts5Available, setFts5Available, getRawDB,
  getDownloadsDir, sanitizeFilename, normalizeName, normalizeTitle
}