import Foundation
import SQLite

final class DatabaseManager: @unchecked Sendable {
    static let shared = DatabaseManager()
    private let lock = NSLock()
    private var db: Connection?
    private var dbPathCurrent: String = ""
    
    private init() {}
    
    func getDBPath() -> String {
        let fm = FileManager.default
        let appSupport = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        let dir = (appSupport as NSString).appendingPathComponent("ComicApp")
        if !fm.fileExists(atPath: dir) { try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true) }
        return (dir as NSString).appendingPathComponent("comics.sqlite3")
    }
    
    private func getCandidatePaths() -> [String] {
        let fm = FileManager.default
        var paths: [String] = []
        let appSupport = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        let dir1 = (appSupport as NSString).appendingPathComponent("ComicApp")
        try? fm.createDirectory(atPath: dir1, withIntermediateDirectories: true)
        paths.append((dir1 as NSString).appendingPathComponent("comics.sqlite3"))
        
        let cache = NSSearchPathForDirectoriesInDomains(.cachesDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        let dir2 = (cache as NSString).appendingPathComponent("ComicApp")
        try? fm.createDirectory(atPath: dir2, withIntermediateDirectories: true)
        paths.append((dir2 as NSString).appendingPathComponent("comics.sqlite3"))
        
        let home = NSHomeDirectory()
        let dir3 = (home as NSString).appendingPathComponent(".comic-app-data")
        try? fm.createDirectory(atPath: dir3, withIntermediateDirectories: true)
        paths.append((dir3 as NSString).appendingPathComponent("comics.sqlite3"))
        return paths
    }
    
    func initialize() throws {
        lock.lock()
        defer { lock.unlock() }
        
        var lastErr: Error?
        let candidates = getCandidatePaths()
        for (idx, path) in candidates.enumerated() {
            do {
                self.db = try Connection(path)
                db?.busyTimeout = 10.0
                
                let test = Table("_write_test")
                let idCol = Expression<Int>("id")
                try db?.run(test.create(ifNotExists: true) { t in t.column(idCol, primaryKey: true) })
                try db?.run(test.insert(or: .replace, idCol <- 1))
                try db?.run(test.drop())
                
                try db?.run("PRAGMA journal_mode = WAL")
                try db?.run("PRAGMA synchronous = NORMAL")
                try db?.run("PRAGMA cache_size = -8000")
                try db?.run("PRAGMA foreign_keys = ON")
                try db?.run("PRAGMA busy_timeout = 10000")
                try db?.run("PRAGMA wal_autocheckpoint = 1000")
                
                if idx > 0, let orig = candidates.first, orig != path {
                    migrateFromPath(from: orig, to: path)
                }
                
                self.dbPathCurrent = path
                try createTables()
                try migrate()
                try? rebuildFTSIfEmpty()
                NSLog("[DB] 数据库初始化成功: \(path)")
                return
            } catch {
                lastErr = error
                NSLog("[DB] 候选路径\(idx)失败 \(path): \(error.localizedDescription)")
                self.db = nil
                for suffix in ["", "-wal", "-shm"] {
                    try? FileManager.default.removeItem(atPath: path + suffix)
                }
            }
        }
        if let lastErr { throw lastErr }
        throw NSError(domain: "DB", code: -1, userInfo: [NSLocalizedDescriptionKey: "所有候选数据库路径均不可写"])
    }
    
    private func migrateFromPath(from old: String, to new: String) {
        guard let db else { return }
        let fm = FileManager.default
        guard fm.fileExists(atPath: old) else { return }
        do {
            let escaped = old.replacingOccurrences(of: "'", with: "''")
            try db.run("ATTACH DATABASE '\(escaped)' AS old_db")
            let tables = try db.prepare("SELECT name, sql FROM old_db.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            var excluded = Set<String>()
            for row in tables {
                if let sql = row[1] as? String, sql.lowercased().contains("fts5") {
                    excluded.insert(row[0] as? String ?? "")
                }
            }
            for row in tables {
                guard let name = row[0] as? String else { continue }
                var isExcluded = false
                for ex in excluded {
                    if name == ex || name.starts(with: ex + "_") { isExcluded = true; break }
                }
                if isExcluded { continue }
                let escName = name.replacingOccurrences(of: "\"", with: "\"\"")
                try? db.run("CREATE TABLE IF NOT EXISTS \"\(escName)\" AS SELECT * FROM old_db.\"\(escName)\"")
            }
            let idxRows = try db.prepare("SELECT sql FROM old_db.sqlite_master WHERE type='index' AND sql IS NOT NULL")
            for r in idxRows {
                if let s = r[0] as? String { try? db.run(s) }
            }
            try db.run("DETACH DATABASE old_db")
            NSLog("[DB] 已从\(old)迁移数据")
        } catch {
            NSLog("[DB] 迁移失败（使用新库）: \(error.localizedDescription)")
            try? db.run("DETACH DATABASE old_db")
        }
    }
    
    func connection() throws -> Connection {
        lock.lock()
        defer { lock.unlock() }
        guard let db else { throw NSError(domain: "DB", code: -1, userInfo: [NSLocalizedDescriptionKey: "Database not initialized"]) }
        return db
    }
    
    private func createTables() throws {
        guard let db else { return }
        
        let comics = Table("comics")
        let idCol = Expression<String>("id")
        let sourceIdCol = Expression<String?>("sourceId")
        let sourceUrlCol = Expression<String?>("sourceUrl")
        let titleCol = Expression<String>("title")
        let authorCol = Expression<String?>("author")
        let coverCol = Expression<String?>("cover")
        let localCoverCol = Expression<String?>("localCover")
        let localPathCol = Expression<String?>("localPath")
        let descCol = Expression<String?>("descText")
        let statusCol = Expression<String?>("status")
        let tagsCol = Expression<String?>("tags")
        let categoryCol = Expression<String?>("category")
        let chapterNamesEnrichedCol = Expression<Int>("chapterNamesEnriched")
        let favoritedCol = Expression<Int>("favorited")
        let createdAtCol = Expression<Int64>("createdAt")
        let updatedAtCol = Expression<Int64>("updatedAt")
        let updateTimeCol = Expression<Int64>("updateTime")
        let lastSyncCol = Expression<Int64>("lastSync")
        let lastReadCol = Expression<Int64>("lastRead")
        let updateDeltaCol = Expression<Int>("updateDelta")
        let chapterCountCol = Expression<Int>("chapter_count")
        
        try db.run(comics.create(ifNotExists: true) { t in
            t.column(idCol, primaryKey: true)
            t.column(sourceIdCol)
            t.column(sourceUrlCol, unique: true)
            t.column(titleCol)
            t.column(authorCol)
            t.column(coverCol)
            t.column(localCoverCol)
            t.column(localPathCol)
            t.column(descCol)
            t.column(statusCol)
            t.column(tagsCol)
            t.column(categoryCol)
            t.column(chapterNamesEnrichedCol, defaultValue: 0)
            t.column(favoritedCol, defaultValue: 0)
            t.column(createdAtCol)
            t.column(updatedAtCol)
            t.column(updateTimeCol, defaultValue: 0)
            t.column(lastSyncCol, defaultValue: 0)
            t.column(lastReadCol, defaultValue: 0)
            t.column(updateDeltaCol, defaultValue: 0)
            t.column(chapterCountCol, defaultValue: 0)
        })
        
        try db.run(comics.createIndex(titleCol, ifNotExists: true))
        try db.run(comics.createIndex(authorCol, ifNotExists: true))
        try db.run(comics.createIndex(categoryCol, ifNotExists: true))
        try db.run(comics.createIndex(favoritedCol, ifNotExists: true))
        try db.run(comics.createIndex(updatedAtCol, ifNotExists: true))
        try? db.run("CREATE INDEX IF NOT EXISTS idx_comics_sourceUrl ON comics(sourceUrl)")
        
        let chapters = Table("chapters")
        let cIdCol = Expression<String>("id")
        let cComicIdCol = Expression<String>("comicId")
        let cUrlCol = Expression<String>("url")
        let cNameCol = Expression<String>("name")
        let cOrderCol = Expression<Int>("sortOrder")
        let cImgCountCol = Expression<Int>("imageCount")
        let cCreatedAtCol = Expression<Int64>("createdAt")
        let cUpdatedAtCol = Expression<Int64>("updatedAt")
        
        try db.run(chapters.create(ifNotExists: true) { t in
            t.column(cIdCol, primaryKey: true)
            t.column(cComicIdCol)
            t.column(cUrlCol)
            t.column(cNameCol)
            t.column(cOrderCol)
            t.column(cImgCountCol, defaultValue: 0)
            t.column(cCreatedAtCol)
            t.column(cUpdatedAtCol)
            t.foreignKey(cComicIdCol, references: comics, idCol, delete: .cascade)
        })
        try db.run(chapters.createIndex(cComicIdCol, ifNotExists: true))
        try db.run(chapters.createIndex([cComicIdCol, cOrderCol], ifNotExists: true))
        
        let progress = Table("reading_progress")
        let pIdCol = Expression<String>("id")
        let pComicIdCol = Expression<String>("comicId")
        let pChapterIdxCol = Expression<Int>("chapterIndex")
        let pChapterUrlCol = Expression<String?>("chapterUrl")
        let pPageIdxCol = Expression<Int>("pageIndex")
        let pTotalCol = Expression<Int>("totalPages")
        let pProgressCol = Expression<Double>("progress")
        let pCreatedAtCol = Expression<Int64>("createdAt")
        let pUpdatedAtCol = Expression<Int64>("updatedAt")
        
        try db.run(progress.create(ifNotExists: true) { t in
            t.column(pIdCol, primaryKey: true)
            t.column(pComicIdCol)
            t.column(pChapterIdxCol)
            t.column(pChapterUrlCol)
            t.column(pPageIdxCol)
            t.column(pTotalCol)
            t.column(pProgressCol)
            t.column(pCreatedAtCol)
            t.column(pUpdatedAtCol)
        })
        try db.run(progress.createIndex(pComicIdCol, ifNotExists: true))
        try db.run(progress.createIndex(pUpdatedAtCol, ifNotExists: true))
        
        let downloads = Table("download_records")
        let dIdCol = Expression<String>("id")
        let dComicIdCol = Expression<String>("comicId")
        let dComicTitleCol = Expression<String>("comicTitle")
        let dChapterIdCol = Expression<String>("chapterId")
        let dChapterNameCol = Expression<String>("chapterName")
        let dChapterIndexCol = Expression<Int>("chapterIndex")
        let dChapterUrlCol = Expression<String>("chapterUrl")
        let dPathCol = Expression<String>("path")
        let dCountCol = Expression<Int>("imagesCount")
        let dSizeCol = Expression<Int64>("totalSize")
        let dStatusCol = Expression<String>("status")
        let dCompletedCol = Expression<Int>("completed")
        let dErrorCol = Expression<String?>("error")
        let dDownloadedAtCol = Expression<Int64>("downloadedAt")
        let dCreatedAtCol = Expression<Int64>("createdAt")
        let dUpdatedAtCol = Expression<Int64>("updatedAt")
        
        try db.run(downloads.create(ifNotExists: true) { t in
            t.column(dIdCol, primaryKey: true)
            t.column(dComicIdCol)
            t.column(dComicTitleCol)
            t.column(dChapterIdCol)
            t.column(dChapterNameCol)
            t.column(dChapterIndexCol)
            t.column(dChapterUrlCol)
            t.column(dPathCol)
            t.column(dCountCol, defaultValue: 0)
            t.column(dSizeCol, defaultValue: 0)
            t.column(dStatusCol, defaultValue: "completed")
            t.column(dCompletedCol, defaultValue: 0)
            t.column(dErrorCol)
            t.column(dDownloadedAtCol, defaultValue: 0)
            t.column(dCreatedAtCol)
            t.column(dUpdatedAtCol)
            t.unique(dComicIdCol, dChapterIndexCol)
        })
        try db.run(downloads.createIndex(dComicIdCol, ifNotExists: true))
        try db.run(downloads.createIndex(dComicTitleCol, ifNotExists: true))
        try db.run(downloads.createIndex(dChapterIndexCol, ifNotExists: true))
        
        let crawl = Table("crawl_progress")
        let crId = Expression<String>("id")
        let crUrl = Expression<String>("url")
        let crTitle = Expression<String?>("title")
        let crStatus = Expression<String>("status")
        let crRetry = Expression<Int>("retryCount")
        let crError = Expression<String?>("lastError")
        let crCreated = Expression<Int64>("createdAt")
        let crUpdated = Expression<Int64>("updatedAt")
        try db.run(crawl.create(ifNotExists: true) { t in
            t.column(crId, primaryKey: true)
            t.column(crUrl, unique: true)
            t.column(crTitle)
            t.column(crStatus, defaultValue: "pending")
            t.column(crRetry, defaultValue: 0)
            t.column(crError)
            t.column(crCreated)
            t.column(crUpdated)
        })
        try db.run(crawl.createIndex(crStatus, ifNotExists: true))
        try db.run(crawl.createIndex(crCreated, ifNotExists: true))
        
        let failures = Table("failure_stats")
        let fId = Expression<String>("id")
        let fReason = Expression<String>("reason")
        let fCount = Expression<Int>("count")
        let fUpdated = Expression<Int64>("lastUpdate")
        try db.run(failures.create(ifNotExists: true) { t in
            t.column(fId, primaryKey: true)
            t.column(fReason, unique: true)
            t.column(fCount, defaultValue: 0)
            t.column(fUpdated)
        })
        
        let jobs = Table("job_queue")
        let jIdCol = Expression<String>("id")
        let jTypeCol = Expression<String>("type")
        let jPriorityCol = Expression<Int>("priority")
        let jStatusCol = Expression<String>("status")
        let jPayloadCol = Expression<String>("payload")
        let jResultCol = Expression<String?>("result")
        let jErrorCol = Expression<String?>("error")
        let jProgressCol = Expression<String?>("progress")
        let jProgressTotalCol = Expression<Int>("progress_total")
        let jProgressCurrentCol = Expression<Int>("progress_current")
        let jRetryCol = Expression<Int>("retry_count")
        let jMaxRetryCol = Expression<Int>("max_retries")
        let jTimeoutCol = Expression<Int?>("timeout")
        let jDelayCol = Expression<Int>("delay")
        let jRepeatCol = Expression<Int>("repeat_interval")
        let jLastProgressAtCol = Expression<Int64?>("last_progress_at")
        let jAutoRetryCountCol = Expression<Int>("auto_retry_count")
        let jLastAgedAtCol = Expression<Int64?>("last_aged_at")
        let jSourceCol = Expression<String>("source")
        let jMutexKeyCol = Expression<String?>("mutex_key")
        let jCreatedAtCol = Expression<Int64>("created_at")
        let jUpdatedAtCol = Expression<Int64>("updated_at")
        let jStartedAtCol = Expression<Int64?>("started_at")
        let jCompletedAtCol = Expression<Int64?>("completed_at")
        
        try db.run(jobs.create(ifNotExists: true) { t in
            t.column(jIdCol, primaryKey: true)
            t.column(jTypeCol)
            t.column(jPriorityCol, defaultValue: 2)
            t.column(jStatusCol, defaultValue: "waiting")
            t.column(jPayloadCol)
            t.column(jResultCol)
            t.column(jErrorCol)
            t.column(jProgressCol)
            t.column(jProgressTotalCol, defaultValue: 0)
            t.column(jProgressCurrentCol, defaultValue: 0)
            t.column(jRetryCol, defaultValue: 0)
            t.column(jMaxRetryCol, defaultValue: 3)
            t.column(jTimeoutCol)
            t.column(jDelayCol, defaultValue: 0)
            t.column(jRepeatCol, defaultValue: 0)
            t.column(jLastProgressAtCol)
            t.column(jAutoRetryCountCol, defaultValue: 0)
            t.column(jLastAgedAtCol)
            t.column(jSourceCol, defaultValue: "auto")
            t.column(jMutexKeyCol)
            t.column(jCreatedAtCol)
            t.column(jUpdatedAtCol)
            t.column(jStartedAtCol)
            t.column(jCompletedAtCol)
        })
        try? db.run("CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status)")
        try? db.run("CREATE INDEX IF NOT EXISTS idx_job_queue_type ON job_queue(type)")
        try? db.run("CREATE INDEX IF NOT EXISTS idx_job_queue_priority ON job_queue(priority, created_at)")
        try? db.run("CREATE INDEX IF NOT EXISTS idx_job_queue_completed ON job_queue(completed_at)")
        
        let jf = Table("job_failure_stats")
        let jfId = Expression<Int64>("id")
        let jfReason = Expression<String>("reason")
        let jfCount = Expression<Int>("count")
        let jfLast = Expression<Int64>("last_update")
        try db.run(jf.create(ifNotExists: true) { t in
            t.column(jfId, primaryKey: true)
            t.column(jfReason, unique: true)
            t.column(jfCount, defaultValue: 0)
            t.column(jfLast)
        })
        
        try? createFTS()
    }
    
    private func createFTS() throws {
        guard let db else { return }
        let ftsExistsSQL = "SELECT name FROM sqlite_master WHERE type='table' AND name='comics_fts'"
        let hasFTS = try db.prepare(ftsExistsSQL).makeIterator().next() != nil
        if !hasFTS {
            try db.run("""
                CREATE VIRTUAL TABLE IF NOT EXISTS comics_fts USING fts5(
                    title, author, tags, category, descText,
                    content='comics',
                    content_rowid='rowid',
                    tokenize='unicode61 remove_diacritics 0'
                )
            """)
        }
        let triggerSQLs: [String] = [
            """
            CREATE TRIGGER IF NOT EXISTS comics_fts_insert AFTER INSERT ON comics BEGIN
              INSERT INTO comics_fts(rowid, title, author, tags, category, descText)
              VALUES (new.rowid, new.title, COALESCE(new.author,''), COALESCE(new.tags,''), COALESCE(new.category,''), COALESCE(new.descText,''));
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS comics_fts_delete AFTER DELETE ON comics BEGIN
              INSERT INTO comics_fts(comics_fts, rowid, title, author, tags, category, descText)
              VALUES('delete', old.rowid, old.title, COALESCE(old.author,''), COALESCE(old.tags,''), COALESCE(old.category,''), COALESCE(old.descText,''));
            END
            """,
            """
            CREATE TRIGGER IF NOT EXISTS comics_fts_update AFTER UPDATE ON comics BEGIN
              INSERT INTO comics_fts(comics_fts, rowid, title, author, tags, category, descText)
              VALUES('delete', old.rowid, old.title, COALESCE(old.author,''), COALESCE(old.tags,''), COALESCE(old.category,''), COALESCE(old.descText,''));
              INSERT INTO comics_fts(rowid, title, author, tags, category, descText)
              VALUES (new.rowid, new.title, COALESCE(new.author,''), COALESCE(new.tags,''), COALESCE(new.category,''), COALESCE(new.descText,''));
            END
            """
        ]
        for sql in triggerSQLs { try db.run(sql) }
    }
    
    var dbPath: String {
        return dbPathCurrent
    }
    
    func rebuildFTS() throws {
        guard let db else { return }
        try db.run("DELETE FROM comics_fts")
        try db.run("INSERT INTO comics_fts(rowid, title, author, tags, category, descText) SELECT rowid, title, COALESCE(author,''), COALESCE(tags,''), COALESCE(category,''), COALESCE(descText,'') FROM comics")
        NSLog("[DB] FTS5 强制重建完成")
    }
    
    func vacuum() throws {
        guard let db else { return }
        try db.run("VACUUM")
        NSLog("[DB] VACUUM 完成")
    }
    
    private func rebuildFTSIfEmpty() throws {
        guard let db else { return }
        let ftsStmt = try db.prepare("SELECT COUNT(*) FROM comics_fts")
        var ftsCount: Int64 = 0
        for row in ftsStmt { if let c = row[0] as? Int64 { ftsCount = c } }
        guard ftsCount == 0 else { return }
        let comicStmt = try db.prepare("SELECT COUNT(*) FROM comics")
        var comicCount: Int64 = 0
        for row in comicStmt { if let c = row[0] as? Int64 { comicCount = c } }
        guard comicCount > 0 else { return }
        try db.run("INSERT INTO comics_fts(rowid, title, author, tags, category, descText) SELECT rowid, title, COALESCE(author,''), COALESCE(tags,''), COALESCE(category,''), COALESCE(descText,'') FROM comics")
        NSLog("[DB] FTS5 重建完毕 \(comicCount) 条")
    }
    
    private func migrate() throws {
        guard let db else { return }
        func addColIfMissing(_ table: String, _ name: String, _ def: String) {
            do {
                let rows = try db.prepare("PRAGMA table_info('\(table)')")
                let names = Set(rows.compactMap { $0[1] as? String })
                if !names.contains(name) {
                    try db.run("ALTER TABLE \(table) ADD COLUMN \(name) \(def)")
                    NSLog("[DB Migrate] 新增列 \(table).\(name)")
                }
            } catch {}
        }
        addColIfMissing("comics", "localPath", "TEXT")
        addColIfMissing("comics", "chapterNamesEnriched", "INTEGER DEFAULT 0")
        addColIfMissing("comics", "updateTime", "INTEGER DEFAULT 0")
        addColIfMissing("download_records", "status", "TEXT DEFAULT 'completed'")
        addColIfMissing("download_records", "completed", "INTEGER DEFAULT 0")
        addColIfMissing("download_records", "error", "TEXT")
    }
}