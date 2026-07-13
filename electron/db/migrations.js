'use strict'

const migrations = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
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
        last_sync_at INTEGER DEFAULT 0,
        createdAt INTEGER,
        updatedAt INTEGER
      )`)

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

      db.exec(`CREATE TABLE IF NOT EXISTS failure_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason TEXT UNIQUE,
        count INTEGER DEFAULT 0,
        last_update INTEGER
      )`)

      db.exec('CREATE INDEX IF NOT EXISTS idx_comics_favorited ON comics(favorited)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_comics_category ON comics(category)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_comics_updated ON comics(updatedAt)')
    }
  },

  {
    version: 2,
    name: 'chapters_image_count',
    up(db) {
      const cols = db.pragma('table_info(chapters)')
      if (!cols.some(c => c.name === 'image_count')) {
        db.exec('ALTER TABLE chapters ADD COLUMN image_count INTEGER DEFAULT 0')
      }
    }
  },

  {
    version: 3,
    name: 'comics_extra_columns',
    up(db) {
      const cols = db.pragma('table_info(comics)')
      const names = new Set(cols.map(c => c.name))
      if (!names.has('chapter_names_enriched')) {
        db.exec('ALTER TABLE comics ADD COLUMN chapter_names_enriched INTEGER DEFAULT 0')
      }
      if (!names.has('update_delta')) {
        db.exec('ALTER TABLE comics ADD COLUMN update_delta INTEGER DEFAULT 0')
      }
      if (!names.has('favorited')) {
        db.exec('ALTER TABLE comics ADD COLUMN favorited INTEGER DEFAULT 0')
      }
      if (!names.has('local_path')) {
        db.exec('ALTER TABLE comics ADD COLUMN local_path TEXT')
      }
      if (!names.has('local_cover')) {
        db.exec('ALTER TABLE comics ADD COLUMN local_cover TEXT')
      }
      if (!names.has('last_sync_at')) {
        db.exec('ALTER TABLE comics ADD COLUMN last_sync_at INTEGER DEFAULT 0')
      }
    }
  },

  {
    version: 4,
    name: 'cleanup_empty_sourceUrl',
    up(db) {
      const emptyCheck = db.prepare("SELECT COUNT(*) as c FROM comics WHERE sourceUrl = ''").get()
      if (emptyCheck && emptyCheck.c > 0) {
        db.prepare("UPDATE comics SET sourceUrl = NULL WHERE sourceUrl = ''").run()
      }
    }
  }
]

function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT,
    applied_at INTEGER
  )`)
}

function getAppliedVersions(db) {
  try {
    const rows = db.prepare('SELECT version FROM _migrations ORDER BY version').all()
    return new Set(rows.map(r => r.version))
  } catch {
    return new Set()
  }
}

function applyMigration(db, migration) {
  console.log(`[DB Migration] 应用 v${migration.version}: ${migration.name}`)
  migration.up(db)
  db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
    migration.version, migration.name, Date.now()
  )
  console.log(`[DB Migration] ✓ v${migration.version} 完成`)
}

function runMigrations(db) {
  ensureMigrationsTable(db)
  const applied = getAppliedVersions(db)

  const pending = migrations.filter(m => !applied.has(m.version))
  if (pending.length === 0) {
    console.log('[DB Migration] 数据库已是最新版本')
    return
  }

  console.log(`[DB Migration] 发现 ${pending.length} 个待应用迁移: v${pending.map(m => m.version).join(', v')}`)

  for (const migration of pending) {
    try {
      applyMigration(db, migration)
    } catch (e) {
      console.error(`[DB Migration] ✗ v${migration.version} 失败: ${e.message}`)
      throw e
    }
  }

  console.log(`[DB Migration] 全部完成，当前版本 v${migrations[migrations.length - 1].version}`)
}

module.exports = { runMigrations, migrations }