import Foundation
import SQLite

final class ReadingRepository: @unchecked Sendable {
    static let shared = ReadingRepository()
    private init() {}
    
    private let progress = Table("reading_progress")
    private let downloads = Table("downloads")
    
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
    private let dCreatedAtCol = Expression<Int64>("createdAt")
    private let dUpdatedAtCol = Expression<Int64>("updatedAt")
    
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
    
    func addDownload(_ rec: DownloadRecord) throws {
        let db = try DatabaseManager.shared.connection()
        var r = rec
        r.id = UUID().uuidString
        r.createdAt = Int64(Date().timeIntervalSince1970 * 1000)
        r.updatedAt = r.createdAt
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
            dCreatedAtCol <- r.createdAt,
            dUpdatedAtCol <- r.updatedAt
        ))
    }
    
    func updateDownload(_ rec: DownloadRecord) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(downloads.filter(dChapterIdCol == rec.chapterId).update(
            dComicTitleCol <- rec.comicTitle,
            dChapterNameCol <- rec.chapterName,
            dChapterIndexCol <- rec.chapterIndex,
            dChapterUrlCol <- rec.chapterUrl,
            dPathCol <- rec.path,
            dCountCol <- rec.imagesCount,
            dSizeCol <- rec.totalSize,
            dStatusCol <- rec.status.rawValue,
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
    
    func listDownloadRecords() throws -> [DownloadRecord] {
        let db = try DatabaseManager.shared.connection()
        return try db.prepare(downloads.order(dUpdatedAtCol.desc)).map { try mapDownload($0) }
    }
    
    func deleteDownloadRecord(chapterId: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(downloads.filter(dChapterIdCol == chapterId).delete())
    }
    
    private func mapDownload(_ row: Row) throws -> DownloadRecord {
        let statusRaw: String = (try? row.get(dStatusCol)) ?? DownloadStatus.completed.rawValue
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
            createdAt: try row.get(dCreatedAtCol),
            updatedAt: try row.get(dUpdatedAtCol)
        )
    }
}