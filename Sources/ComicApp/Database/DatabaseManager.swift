import Foundation
import SQLite

final class DatabaseManager: @unchecked Sendable {
    static let shared = DatabaseManager()
    private let lock = NSLock()
    private var db: Connection?
    
    private init() {}
    
    func getDBPath() -> String {
        let fm = FileManager.default
        let appSupport = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first ?? NSTemporaryDirectory()
        let dir = (appSupport as NSString).appendingPathComponent("ComicApp")
        if !fm.fileExists(atPath: dir) { try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true) }
        return (dir as NSString).appendingPathComponent("comics.sqlite3")
    }
    
    func initialize() throws {
        lock.lock()
        defer { lock.unlock() }
        let path = getDBPath()
        self.db = try Connection(path)
        db?.busyTimeout = 5.0
        try createTables()
        try migrate()
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
        
        do { try db.run(comics.addColumn(localPathCol)) } catch {}
        do { try db.run(comics.addColumn(chapterNamesEnrichedCol, defaultValue: 0)) } catch {}
        do { try db.run(comics.addColumn(updateTimeCol, defaultValue: 0)) } catch {}
        
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
            t.column(dChapterIdCol, unique: true)
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
        
        let jobs = Table("jobs")
        let jIdCol = Expression<String>("id")
        let jTypeCol = Expression<String>("type")
        let jStatusCol = Expression<String>("status")
        let jPayloadCol = Expression<String>("payload")
        let jProgressCol = Expression<Double>("progress")
        let jMessageCol = Expression<String?>("message")
        let jErrorCol = Expression<String?>("error")
        let jPriorityCol = Expression<Int>("priority")
        let jRetryCol = Expression<Int>("retryCount")
        let jMaxRetryCol = Expression<Int>("maxRetries")
        let jCreatedAtCol = Expression<Int64>("createdAt")
        let jUpdatedAtCol = Expression<Int64>("updatedAt")
        
        try db.run(jobs.create(ifNotExists: true) { t in
            t.column(jIdCol, primaryKey: true)
            t.column(jTypeCol)
            t.column(jStatusCol)
            t.column(jPayloadCol)
            t.column(jProgressCol, defaultValue: 0)
            t.column(jMessageCol)
            t.column(jErrorCol)
            t.column(jPriorityCol, defaultValue: 5)
            t.column(jRetryCol, defaultValue: 0)
            t.column(jMaxRetryCol, defaultValue: 3)
            t.column(jCreatedAtCol)
            t.column(jUpdatedAtCol)
        })
        try db.run(jobs.createIndex(jStatusCol, ifNotExists: true))
        try db.run(jobs.createIndex(jPriorityCol, ifNotExists: true))
        
        try? createFTS()
    }
    
    private func createFTS() throws {
        guard let db else { return }
        let fts = VirtualTable("comics_fts")
        try db.run(fts.create(.FTS5(
            FTS5Config()
                .column(Expression<String>("id"))
                .column(Expression<String>("title"))
                .column(Expression<String>("author"))
                .column(Expression<String>("tags"))
                .column(Expression<String>("category"))
                .column(Expression<String>("descText"))
        ), ifNotExists: true))
    }
    
    private func migrate() throws {
    }
}