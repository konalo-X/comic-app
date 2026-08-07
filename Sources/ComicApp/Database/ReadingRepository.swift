import Foundation
import SQLite

final class ReadingRepository: @unchecked Sendable {
    static let shared = ReadingRepository()
    private init() {}
    
    private let progress = Table("reading_progress")
    private let downloads = Table("download_records")
    private let crawl = Table("crawl_progress")
    private let failures = Table("failure_stats")
    private let comics = Table("comics")
    private let chapters = Table("chapters")
    
    private let pIdCol = Expression<String>("id")
    private let pComicIdCol = Expression<String>("comicId")
    private let pChapterIdxCol = Expression<Int>("chapterIndex")
    private let pChapterUrlCol = Expression<String?>("chapterUrl")
    private let pPageIdxCol = Expression<Int>("pageIndex")
    private let pTotalCol = Expression<Int>("totalPages")
    private let pProgressCol = Expression<Double>("progress")
    private let pCreatedAtCol = Expression<Int64>("createdAt")
    private let pUpdatedAtCol = Expression<Int64>("updatedAt")
    
    private let dIdCol = Expression<String>("id")
    private let dComicIdCol = Expression<String>("comicId")
    private let dComicTitleCol = Expression<String>("comicTitle")
    private let dChapterIdCol = Expression<String>("chapterId")
    private let dChapterNameCol = Expression<String>("chapterName")
    private let dChapterIndexCol = Expression<Int>("chapterIndex")
    private let dChapterUrlCol = Expression<String>("chapterUrl")
    private let dPathCol = Expression<String>("path")
    private let dCountCol = Expression<Int>("imagesCount")
    private let dSizeCol = Expression<Int64>("totalSize")
    private let dStatusCol = Expression<String>("status")
    private let dCompletedCol = Expression<Int>("completed")
    private let dErrorCol = Expression<String?>("error")
    private let dDownloadedAtCol = Expression<Int64>("downloadedAt")
    private let dCreatedAtCol = Expression<Int64>("createdAt")
    private let dUpdatedAtCol = Expression<Int64>("updatedAt")
    
    private let crId = Expression<String>("id")
    private let crUrl = Expression<String>("url")
    private let crTitle = Expression<String?>("title")
    private let crStatus = Expression<String>("status")
    private let crRetry = Expression<Int>("retryCount")
    private let crError = Expression<String?>("lastError")
    private let crCreated = Expression<Int64>("createdAt")
    private let crUpdated = Expression<Int64>("updatedAt")
    
    private let fId = Expression<String>("id")
    private let fReason = Expression<String>("reason")
    private let fCount = Expression<Int>("count")
    private let fUpdated = Expression<Int64>("lastUpdate")
    
    private let comicsIdCol = Expression<String>("id")
    private let comicsTitleCol = Expression<String>("title")
    private let cComicIdCol = Expression<String>("comicId")
    private let cImgCountCol = Expression<Int>("imageCount")
    
    func saveProgress(_ p: ReadingProgress) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if let existing = try db.pluck(progress.filter(pComicIdCol == p.comicId)) {
            let oldId = try existing.get(pIdCol)
            try db.run(progress.filter(pIdCol == oldId).update(
                pChapterIdxCol <- p.chapterIndex,
                pChapterUrlCol <- p.chapterUrl,
                pPageIdxCol <- p.pageIndex,
                pTotalCol <- p.totalPages,
                pProgressCol <- p.progress,
                pUpdatedAtCol <- now
            ))
            try? ComicRepository.shared.setLastRead(id: p.comicId)
            return
        }
        var created = p
        created.id = UUID().uuidString
        created.createdAt = now
        created.updatedAt = now
        try db.run(progress.insert(
            pIdCol <- created.id,
            pComicIdCol <- created.comicId,
            pChapterIdxCol <- created.chapterIndex,
            pChapterUrlCol <- created.chapterUrl,
            pPageIdxCol <- created.pageIndex,
            pTotalCol <- created.totalPages,
            pProgressCol <- created.progress,
            pCreatedAtCol <- created.createdAt,
            pUpdatedAtCol <- created.updatedAt
        ))
        try? ComicRepository.shared.setLastRead(id: p.comicId)
    }
    
    func getProgress(comicId: String) throws -> ReadingProgress? {
        let db = try DatabaseManager.shared.connection()
        guard let row = try db.pluck(progress.filter(pComicIdCol == comicId)) else { return nil }
        return ReadingProgress(
            id: try row.get(pIdCol),
            comicId: try row.get(pComicIdCol),
            chapterIndex: try row.get(pChapterIdxCol),
            chapterUrl: try row.get(pChapterUrlCol),
            pageIndex: try row.get(pPageIdxCol),
            totalPages: try row.get(pTotalCol),
            progress: try row.get(pProgressCol),
            createdAt: try row.get(pCreatedAtCol),
            updatedAt: try row.get(pUpdatedAtCol)
        )
    }
    
    func deleteProgress(comicId: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(progress.filter(pComicIdCol == comicId).delete())
    }
    
    func recentHistory(limit: Int = 200) throws -> [ReadingProgress] {
        let db = try DatabaseManager.shared.connection()
        var arr: [ReadingProgress] = []
        for row in try db.prepare(progress.order(pUpdatedAtCol.desc).limit(limit)) {
            arr.append(ReadingProgress(
                id: try row.get(pIdCol),
                comicId: try row.get(pComicIdCol),
                chapterIndex: try row.get(pChapterIdxCol),
                chapterUrl: try row.get(pChapterUrlCol),
                pageIndex: try row.get(pPageIdxCol),
                totalPages: try row.get(pTotalCol),
                progress: try row.get(pProgressCol),
                createdAt: try row.get(pCreatedAtCol),
                updatedAt: try row.get(pUpdatedAtCol)
            ))
        }
        return arr
    }
    
    func allHistory() throws -> [ReadingProgress] {
        try recentHistory(limit: 100000)
    }
    
    func chaptersReadCount() throws -> Int {
        let db = try DatabaseManager.shared.connection()
        return try db.scalar(progress.count)
    }
    
    func booksReadCount() throws -> Int {
        let db = try DatabaseManager.shared.connection()
        let done = progress.filter(pProgressCol >= 0.95)
        return try db.scalar(done.select(pComicIdCol.distinct).count)
    }
    
    func imagesReadCount() throws -> Int {
        let db = try DatabaseManager.shared.connection()
        var total: Int = 0
        for row in try db.prepare(progress.select(pTotalCol, pProgressCol)) {
            let pages = (try? row.get(pTotalCol)) ?? 0
            let prog = (try? row.get(pProgressCol)) ?? 0
            total += Int(Double(pages) * prog)
        }
        return total
    }
    
    func computeStreakDays() -> (current: Int, longest: Int) {
        guard let all = try? recentHistory(limit: 10000), !all.isEmpty else { return (0, 0) }
        var daySet = Set<Int>()
        for p in all {
            let sec = Double(p.updatedAt / 1000)
            let cal = Calendar(identifier: .gregorian)
            let comps = cal.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: sec))
            if let y = comps.year, let m = comps.month, let d = comps.day {
                daySet.insert(y * 10000 + m * 100 + d)
            }
        }
        var sortedDays = daySet.sorted(by: >)
        var current = 0
        var longest = 0
        var run = 0
        var prevDay: Int?
        let cal = Calendar(identifier: .gregorian)
        let todayComps = cal.dateComponents([.year, .month, .day], from: Date())
        let todayKey = (todayComps.year ?? 0) * 10000 + (todayComps.month ?? 0) * 100 + (todayComps.day ?? 0)
        if let first = sortedDays.first {
            if first != todayKey {
                let diff = daysBetween(first, todayKey)
                if diff > 1 { sortedDays.insert(todayKey, at: 0) }
            }
        }
        for d in sortedDays {
            if let p = prevDay {
                if daysBetween(p, d) == 1 { run += 1 }
                else { longest = max(longest, run); run = 1 }
            } else {
                run = 1
            }
            prevDay = d
        }
        longest = max(longest, run)
        if sortedDays.contains(todayKey) { current = run } else { current = 0 }
        return (current, longest)
    }
    
    private func daysBetween(_ a: Int, _ b: Int) -> Int {
        let ya = a / 10000; let ma = (a % 10000) / 100; let da = a % 100
        let yb = b / 10000; let mb = (b % 10000) / 100; let db = b % 100
        var compsA = DateComponents(); compsA.year = ya; compsA.month = ma; compsA.day = da
        var compsB = DateComponents(); compsB.year = yb; compsB.month = mb; compsB.day = db
        let cal = Calendar(identifier: .gregorian)
        guard let dA = cal.date(from: compsA), let dB = cal.date(from: compsB) else { return Int.max }
        return abs(cal.dateComponents([.day], from: dA, to: dB).day ?? 0)
    }
    
    func totalReadTimeMs() -> Int64 {
        return 0
    }
    
    func readingStats() throws -> ReadingStats {
        let streak = computeStreakDays()
        var s = ReadingStats()
        s.booksReadCount = (try? booksReadCount()) ?? 0
        s.chaptersReadCount = (try? chaptersReadCount()) ?? 0
        s.imagesReadCount = (try? imagesReadCount()) ?? 0
        s.totalReadTimeMs = totalReadTimeMs()
        s.currentStreakDays = streak.current
        s.longestStreakDays = streak.longest
        s.history = (try? recentHistory(limit: 200)) ?? []
        return s
    }
    
    func downloadStats() throws -> DownloadStats {
        let db = try DatabaseManager.shared.connection()
        var stats = DownloadStats()
        stats.totalRecords = (try? db.scalar(downloads.count)) ?? 0
        stats.totalComics = (try? db.scalar(downloads.select(dComicIdCol.distinct).count)) ?? 0
        for row in try db.prepare(downloads.select(dSizeCol, dCountCol)) {
            stats.totalSizeBytes += (try? row.get(dSizeCol)) ?? 0
            stats.totalImages += (try? row.get(dCountCol)) ?? 0
        }
        return stats
    }
    
    func addDownload(_ rec: DownloadRecord) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var r = rec
        r.id = UUID().uuidString
        r.createdAt = now
        r.updatedAt = now
        r.downloadedAt = now
        let existing = try? db.pluck(downloads.filter(dComicIdCol == r.comicId && dChapterIndexCol == r.chapterIndex))
        if let row = existing {
            r.id = try row.get(dIdCol)
            try updateDownload(r)
            return
        }
        try db.run(downloads.insert(
            dIdCol <- r.id,
            dComicIdCol <- r.comicId,
            dComicTitleCol <- r.comicTitle,
            dChapterIdCol <- r.chapterId,
            dChapterNameCol <- r.chapterName,
            dChapterIndexCol <- r.chapterIndex,
            dChapterUrlCol <- r.chapterUrl,
            dPathCol <- r.path,
            dCountCol <- r.imagesCount,
            dSizeCol <- r.totalSize,
            dStatusCol <- r.status.rawValue,
            dCompletedCol <- r.completed,
            dErrorCol <- r.error,
            dDownloadedAtCol <- r.downloadedAt,
            dCreatedAtCol <- r.createdAt,
            dUpdatedAtCol <- r.updatedAt
        ))
    }
    
    func updateDownload(_ rec: DownloadRecord) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(downloads.filter(dIdCol == rec.id).update(
            dComicTitleCol <- rec.comicTitle,
            dChapterNameCol <- rec.chapterName,
            dChapterIndexCol <- rec.chapterIndex,
            dChapterUrlCol <- rec.chapterUrl,
            dPathCol <- rec.path,
            dCountCol <- rec.imagesCount,
            dSizeCol <- rec.totalSize,
            dStatusCol <- rec.status.rawValue,
            dCompletedCol <- rec.completed,
            dErrorCol <- rec.error,
            dUpdatedAtCol <- now
        ))
    }
    
    func getDownloadRecords(comicId: String) throws -> [DownloadRecord] {
        let db = try DatabaseManager.shared.connection()
        return try db.prepare(downloads.filter(dComicIdCol == comicId).order(dChapterIndexCol.asc))
            .map { try mapDownload($0) }
    }
    
    func getDownloadRecord(chapterId: String) throws -> DownloadRecord? {
        let db = try DatabaseManager.shared.connection()
        guard let row = try db.pluck(downloads.filter(dChapterIdCol == chapterId)) else { return nil }
        return try mapDownload(row)
    }
    
    func getDownloadRecord(comicId: String, chapterIndex: Int) throws -> DownloadRecord? {
        let db = try DatabaseManager.shared.connection()
        guard let row = try db.pluck(downloads.filter(dComicIdCol == comicId && dChapterIndexCol == chapterIndex)) else { return nil }
        return try mapDownload(row)
    }
    
    func listDownloadRecords() throws -> [DownloadRecord] {
        let db = try DatabaseManager.shared.connection()
        return try db.prepare(downloads.order(dUpdatedAtCol.desc)).map { try mapDownload($0) }
    }
    
    func deleteDownloadRecord(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(downloads.filter(dIdCol == id).delete())
    }
    
    func deleteDownloadRecord(comicId: String, chapterIndex: Int) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(downloads.filter(dComicIdCol == comicId && dChapterIndexCol == chapterIndex).delete())
    }
    
    func cleanStaleDownloadRecords() throws {
        let fm = FileManager.default
        for r in try listDownloadRecords() {
            if !fm.fileExists(atPath: r.path) {
                var updated = r
                updated.status = .missing
                try updateDownload(updated)
            }
        }
    }
    
    func getHighestDownloadedIndex(comicId: String?, comicTitle: String, sourceUrl: String?) -> Int {
        let db = try? DatabaseManager.shared.connection()
        guard let db else { return -1 }
        do {
            let q: Table
            if let cid = comicId {
                q = downloads.filter(dComicIdCol == cid)
            } else if let url = sourceUrl, let comic = try? ComicRepository.shared.getBySourceUrl(url) {
                q = downloads.filter(dComicIdCol == comic.id)
            } else {
                q = downloads.filter(dComicTitleCol == comicTitle)
            }
            let idxCol = dChapterIndexCol
            let maxRaw = try db.scalar(q.select(idxCol.max))
            if let m = maxRaw { return m }
        } catch {}
        return -1
    }
    
    func getLocalChapterImages(comicId: String, chapterIndex: Int, comicTitle: String) -> [URL] {
        guard let rec = try? getDownloadRecord(comicId: chapterIndex >= 0 ? comicId : "", chapterIndex: chapterIndex) ??
                (try? listDownloadRecords().first { $0.comicTitle == comicTitle && $0.chapterIndex == chapterIndex }) else { return [] }
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(atPath: rec.path) else { return [] }
        var files: [URL] = []
        while let name = enumerator.nextObject() as? String {
            let ext = (name as NSString).pathExtension.lowercased()
            if ["jpg", "jpeg", "png", "webp", "bmp", "gif"].contains(ext) {
                files.append(URL(fileURLWithPath: (rec.path as NSString).appendingPathComponent(name)))
            }
        }
        files.sort { $0.lastPathComponent < $1.lastPathComponent }
        return files
    }
    
    func getLocalChapterIndices(comicId: String, comicTitle: String, sourceUrl: String?) throws -> [Int] {
        let records: [DownloadRecord]
        if let url = sourceUrl, let comic = try? ComicRepository.shared.getBySourceUrl(url) {
            records = try getDownloadRecords(comicId: comic.id)
        } else if !comicId.isEmpty {
            records = try getDownloadRecords(comicId: comicId)
        } else {
            records = try listDownloadRecords().filter { $0.comicTitle == comicTitle }
        }
        return records.map { $0.chapterIndex }.sorted()
    }
    
    func checkChapterHealth(comicId: String, chapterIndex: Int, comicTitle: String, expectedImageCount: Int) -> HealthCheckResult {
        let fm = FileManager.default
        guard let rec = try? getDownloadRecord(comicId: chapterIndex >= 0 ? comicId : "", chapterIndex: chapterIndex) ??
                (try? listDownloadRecords().first { $0.comicTitle == comicTitle && $0.chapterIndex == chapterIndex }) else {
            return HealthCheckResult(
                comicId: comicId, comicTitle: comicTitle,
                chapterIndex: chapterIndex, chapterName: nil,
                level: .missing, detail: "未找到下载记录"
            )
        }
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: rec.path, isDirectory: &isDir), isDir.boolValue else {
            return HealthCheckResult(
                comicId: rec.comicId, comicTitle: rec.comicTitle,
                chapterIndex: rec.chapterIndex, chapterName: rec.chapterName,
                level: .missing, detail: "章节目录不存在"
            )
        }
        let files = getLocalChapterImages(comicId: rec.comicId, chapterIndex: rec.chapterIndex, comicTitle: rec.comicTitle)
        if expectedImageCount > 0, files.count < expectedImageCount {
            return HealthCheckResult(
                comicId: rec.comicId, comicTitle: rec.comicTitle,
                chapterIndex: rec.chapterIndex, chapterName: rec.chapterName,
                level: .corrupted, detail: "图片数量不符：\(files.count)/\(expectedImageCount)"
            )
        }
        if files.isEmpty {
            return HealthCheckResult(
                comicId: rec.comicId, comicTitle: rec.comicTitle,
                chapterIndex: rec.chapterIndex, chapterName: rec.chapterName,
                level: .corrupted, detail: "章节目录无图片"
            )
        }
        for f in files {
            let sz = (try? f.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if sz < 500 {
                return HealthCheckResult(
                    comicId: rec.comicId, comicTitle: rec.comicTitle,
                    chapterIndex: rec.chapterIndex, chapterName: rec.chapterName,
                    level: .corrupted, detail: "可疑小文件：\(f.lastPathComponent) (\(sz)B)"
                )
            }
        }
        return HealthCheckResult(
            comicId: rec.comicId, comicTitle: rec.comicTitle,
            chapterIndex: rec.chapterIndex, chapterName: rec.chapterName,
            level: .ok, detail: "OK"
        )
    }
    
    func checkComicHealth(sourceUrl: String, deepCheck: Bool) throws -> [HealthCheckResult] {
        guard let comic = try ComicRepository.shared.getBySourceUrl(sourceUrl) else { return [] }
        let records = try getDownloadRecords(comicId: comic.id)
        var results: [HealthCheckResult] = []
        let chs = Dictionary(uniqueKeysWithValues: comic.chapters.map { ($0.sortOrder, $0) })
        for r in records {
            let expected = chs[r.chapterIndex]?.imageCount ?? r.imagesCount
            results.append(checkChapterHealth(
                comicId: comic.id, chapterIndex: r.chapterIndex,
                comicTitle: comic.title, expectedImageCount: expected
            ))
            if !deepCheck, results.count > 5 { break }
        }
        return results
    }
    
    func checkAllHealth(limit: Int = 50) throws -> [HealthCheckResult] {
        var results: [HealthCheckResult] = []
        let all = try listDownloadRecords().prefix(limit)
        for r in all {
            let res = checkChapterHealth(
                comicId: r.comicId, chapterIndex: r.chapterIndex,
                comicTitle: r.comicTitle, expectedImageCount: r.imagesCount
            )
            if res.level != .ok { results.append(res) }
            if results.count >= limit { break }
        }
        return results
    }
    
    // --- Crawl Progress ---
    func initCrawlQueue(urls: [(url: String, title: String?)]) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for (url, title) in urls {
            do {
                try db.run(crawl.insert(
                    crId <- UUID().uuidString,
                    crUrl <- url,
                    crTitle <- title,
                    crStatus <- "pending",
                    crRetry <- 0,
                    crCreated <- now,
                    crUpdated <- now
                ))
            } catch {}
        }
    }
    
    func getNextPendingUrl(limit: Int = 50) throws -> [CrawlProgress] {
        let db = try DatabaseManager.shared.connection()
        var arr: [CrawlProgress] = []
        for row in try db.prepare(crawl.filter(crStatus == "pending").order(crCreated.asc).limit(limit)) {
            arr.append(CrawlProgress(
                id: try row.get(crId),
                url: try row.get(crUrl),
                title: try? row.get(crTitle),
                status: try row.get(crStatus),
                retryCount: try row.get(crRetry),
                lastError: try? row.get(crError),
                createdAt: try row.get(crCreated),
                updatedAt: try row.get(crUpdated)
            ))
        }
        return arr
    }
    
    func updateCrawlStatus(url: String, status: String, retryCount: Int? = nil, lastError: String? = nil, title: String? = nil) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var setters: [Setter] = [crStatus <- status, crUpdated <- now]
        if let r = retryCount { setters.append(crRetry <- r) }
        if let e = lastError { setters.append(crError <- e) }
        if let t = title { setters.append(crTitle <- t) }
        try db.run(crawl.filter(crUrl == url).update(setters))
    }
    
    func getCrawlStats() throws -> (total: Int, pending: Int, success: Int, failed: Int, errors: [(String, Int)]) {
        let db = try DatabaseManager.shared.connection()
        let total = try db.scalar(crawl.count)
        let pending = try db.scalar(crawl.filter(crStatus == "pending").count)
        let success = try db.scalar(crawl.filter(crStatus == "success").count)
        let failed = try db.scalar(crawl.filter(crStatus == "failed").count)
        var errors: [(String, Int)] = []
        for row in try db.prepare(crawl.select(crError).filter(crError != nil)) {
            if let e = try? row.get(crError) { errors.append((e, 1)) }
        }
        return (total, pending, success, failed, errors)
    }
    
    // --- Failure stats ---
    func recordFailure(reason: String) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let key = String(reason.prefix(200))
        if let row = try db.pluck(failures.filter(fReason == key)) {
            let current = try row.get(fCount)
            try db.run(failures.filter(fReason == key).update(fCount <- current + 1, fUpdated <- now))
        } else {
            try db.run(failures.insert(
                fId <- UUID().uuidString,
                fReason <- key,
                fCount <- 1,
                fUpdated <- now
            ))
        }
    }
    
    func getFailureStats(limit: Int = 50) throws -> [FailureStat] {
        let db = try DatabaseManager.shared.connection()
        var arr: [FailureStat] = []
        for row in try db.prepare(failures.order(fCount.desc).limit(limit)) {
            arr.append(FailureStat(
                id: try row.get(fId),
                reason: try row.get(fReason),
                count: try row.get(fCount),
                lastUpdate: try row.get(fUpdated)
            ))
        }
        return arr
    }
    
    private func mapDownload(_ row: Row) throws -> DownloadRecord {
        let statusRaw: String = (try? row.get(dStatusCol)) ?? DownloadStatus.completed.rawValue
        let completed: Int = (try? row.get(dCompletedCol)) ?? 0
        let err: String? = try? row.get(dErrorCol)
        let downloadedAt: Int64 = (try? row.get(dDownloadedAtCol)) ?? (try? row.get(dCreatedAtCol)) ?? 0
        return DownloadRecord(
            id: try row.get(dIdCol),
            comicId: try row.get(dComicIdCol),
            comicTitle: try row.get(dComicTitleCol),
            chapterId: try row.get(dChapterIdCol),
            chapterName: try row.get(dChapterNameCol),
            chapterIndex: try row.get(dChapterIndexCol),
            chapterUrl: try row.get(dChapterUrlCol),
            path: try row.get(dPathCol),
            imagesCount: try row.get(dCountCol),
            totalSize: try row.get(dSizeCol),
            status: DownloadStatus(rawValue: statusRaw) ?? .completed,
            completed: completed,
            error: err,
            createdAt: try row.get(dCreatedAtCol),
            updatedAt: try row.get(dUpdatedAtCol),
            downloadedAt: downloadedAt
        )
    }
}