import Foundation
import SQLite

struct ComicListResult {
    let items: [Comic]
    let total: Int
}

final class ComicRepository: @unchecked Sendable {
    static let shared = ComicRepository()
    private init() {}
    
    private let comics = Table("comics")
    private let chapters = Table("chapters")
    
    private let idCol = Expression<String>("id")
    private let sourceIdCol = Expression<String?>("sourceId")
    private let sourceUrlCol = Expression<String?>("sourceUrl")
    private let titleCol = Expression<String>("title")
    private let authorCol = Expression<String?>("author")
    private let coverCol = Expression<String?>("cover")
    private let localCoverCol = Expression<String?>("localCover")
    private let descCol = Expression<String?>("descText")
    private let statusCol = Expression<String?>("status")
    private let tagsCol = Expression<String?>("tags")
    private let categoryCol = Expression<String?>("category")
    private let favoritedCol = Expression<Int>("favorited")
    private let createdAtCol = Expression<Int64>("createdAt")
    private let updatedAtCol = Expression<Int64>("updatedAt")
    private let lastSyncCol = Expression<Int64>("lastSync")
    private let lastReadCol = Expression<Int64>("lastRead")
    private let updateDeltaCol = Expression<Int>("updateDelta")
    private let chapterCountCol = Expression<Int>("chapter_count")
    
    private let cIdCol = Expression<String>("id")
    private let cComicIdCol = Expression<String>("comicId")
    private let cUrlCol = Expression<String>("url")
    private let cNameCol = Expression<String>("name")
    private let cOrderCol = Expression<Int>("sortOrder")
    private let cImgCountCol = Expression<Int>("imageCount")
    private let cCreatedAtCol = Expression<Int64>("createdAt")
    private let cUpdatedAtCol = Expression<Int64>("updatedAt")
    
    func list(page: Int, pageSize: Int, favorited: Bool?, category: String?, search: String?, sortBy: String, sortDesc: Bool) throws -> ComicListResult {
        let db = try DatabaseManager.shared.connection()
        var query = comics
        if let fav = favorited { query = query.filter(favoritedCol == (fav ? 1 : 0)) }
        if let cat = category, !cat.isEmpty { query = query.filter(categoryCol == cat) }
        if let s = search, !s.isEmpty {
            query = query.filter(
                titleCol.like("%\(s)%")
                || (authorCol ?? "").like("%\(s)%")
                || (tagsCol ?? "").like("%\(s)%")
                || (categoryCol ?? "").like("%\(s)%")
                || (descCol ?? "").like("%\(s)%")
            )
        }
        let total = try db.scalar(query.count)
        
        let ordered: Table
        switch sortBy {
        case "title":
            ordered = sortDesc ? query.order(titleCol.desc) : query.order(titleCol.asc)
        case "chapter_count":
            ordered = sortDesc ? query.order(chapterCountCol.desc) : query.order(chapterCountCol.asc)
        case "createdAt":
            ordered = sortDesc ? query.order(createdAtCol.desc) : query.order(createdAtCol.asc)
        default:
            ordered = sortDesc ? query.order(updatedAtCol.desc) : query.order(updatedAtCol.asc)
        }
        let limit = pageSize
        let offset = max(0, (page - 1) * pageSize)
        var rows: [Comic] = []
        for row in try db.prepare(ordered.limit(limit, offset: offset)) {
            rows.append(try mapComic(row, db: db, includeChapters: false))
        }
        return ComicListResult(items: rows, total: total)
    }
    
    func allCategories() throws -> [String] {
        let db = try DatabaseManager.shared.connection()
        var cats: Set<String> = []
        for row in try db.prepare(comics.select(categoryCol).filter(categoryCol != nil)) {
            if let c = try? row.get(categoryCol), !c.isEmpty { cats.insert(c) }
        }
        return cats.sorted()
    }
    
    func get(id: String) throws -> Comic? {
        let db = try DatabaseManager.shared.connection()
        guard let row = try db.pluck(comics.filter(idCol == id)) else { return nil }
        return try mapComic(row, db: db, includeChapters: true)
    }
    
    func getBySourceUrl(_ url: String) throws -> Comic? {
        let db = try DatabaseManager.shared.connection()
        guard let row = try db.pluck(comics.filter(sourceUrlCol == url)) else { return nil }
        return try mapComic(row, db: db, includeChapters: true)
    }
    
    @discardableResult
    func upsert(_ comic: Comic, chaptersInput: [Chapter]? = nil) throws -> Comic {
        let db = try DatabaseManager.shared.connection()
        var existingRow: Row?
        if let sourceUrl = comic.sourceUrl, !sourceUrl.isEmpty {
            existingRow = try db.pluck(comics.filter(sourceUrlCol == sourceUrl))
        } else if !comic.id.isEmpty {
            existingRow = try db.pluck(comics.filter(idCol == comic.id))
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var merged = comic
        if let row = existingRow {
            merged.id = try row.get(idCol)
            merged.favorited = try row.get(favoritedCol)
            merged.createdAt = try row.get(createdAtCol)
            merged.lastSync = now
            let oldCount = try row.get(chapterCountCol)
            if let chs = chaptersInput { merged.chapterCount = chs.count; merged.updateDelta = max(0, chs.count - oldCount) }
            else { merged.updateDelta = 0 }
            let setters: [Setter] = [
                sourceIdCol <- merged.sourceId,
                sourceUrlCol <- merged.sourceUrl,
                titleCol <- merged.title,
                authorCol <- merged.author,
                coverCol <- merged.cover,
                localCoverCol <- merged.localCover,
                descCol <- merged.descText,
                statusCol <- merged.status,
                tagsCol <- merged.tags,
                categoryCol <- merged.category,
                favoritedCol <- merged.favorited,
                updatedAtCol <- now,
                lastSyncCol <- now,
                updateDeltaCol <- merged.updateDelta,
                chapterCountCol <- merged.chapterCount
            ]
            try db.run(comics.filter(idCol == merged.id).update(setters))
        } else {
            if merged.id.isEmpty { merged.id = UUID().uuidString }
            merged.createdAt = now
            merged.updatedAt = now
            merged.lastSync = now
            if let chs = chaptersInput { merged.chapterCount = chs.count }
            try db.run(comics.insert(
                idCol <- merged.id,
                sourceIdCol <- merged.sourceId,
                sourceUrlCol <- merged.sourceUrl,
                titleCol <- merged.title,
                authorCol <- merged.author,
                coverCol <- merged.cover,
                localCoverCol <- merged.localCover,
                descCol <- merged.descText,
                statusCol <- merged.status,
                tagsCol <- merged.tags,
                categoryCol <- merged.category,
                favoritedCol <- merged.favorited,
                createdAtCol <- merged.createdAt,
                updatedAtCol <- merged.updatedAt,
                lastSyncCol <- merged.lastSync,
                lastReadCol <- merged.lastRead,
                updateDeltaCol <- merged.updateDelta,
                chapterCountCol <- merged.chapterCount
            ))
        }
        if let chs = chaptersInput {
            let existing = try getChapters(comicId: merged.id)
            let existingMap = Dictionary(existing.map { ($0.url, $0) }, uniquingKeysWith: { a, _ in a })
            for (order, ch) in chs.enumerated() {
                var c = ch
                c.comicId = merged.id
                c.sortOrder = order
                if let old = existingMap[c.url] {
                    c.id = old.id
                    c.createdAt = old.createdAt
                    c.imageCount = max(c.imageCount, old.imageCount)
                    try db.run(chapters.filter(cIdCol == c.id).update(
                        cNameCol <- c.name,
                        cOrderCol <- c.sortOrder,
                        cImgCountCol <- c.imageCount,
                        cUpdatedAtCol <- now
                    ))
                } else {
                    c.id = c.id.isEmpty ? UUID().uuidString : c.id
                    c.createdAt = now
                    c.updatedAt = now
                    try db.run(chapters.insert(
                        cIdCol <- c.id,
                        cComicIdCol <- c.comicId,
                        cUrlCol <- c.url,
                        cNameCol <- c.name,
                        cOrderCol <- c.sortOrder,
                        cImgCountCol <- c.imageCount,
                        cCreatedAtCol <- c.createdAt,
                        cUpdatedAtCol <- c.updatedAt
                    ))
                }
            }
            merged.chapterCount = chs.count
        }
        return merged
    }
    
    func setFavorite(id: String, favorited: Bool) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(comics.filter(idCol == id).update(favoritedCol <- (favorited ? 1 : 0), updatedAtCol <- now))
    }
    
    func setLastRead(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(comics.filter(idCol == id).update(lastReadCol <- now, updatedAtCol <- now))
    }
    
    func delete(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(comics.filter(idCol == id).delete())
    }
    
    func getChapters(comicId: String) throws -> [Chapter] {
        let db = try DatabaseManager.shared.connection()
        var arr: [Chapter] = []
        for row in try db.prepare(chapters.filter(cComicIdCol == comicId).order(cOrderCol.asc)) {
            arr.append(Chapter(
                id: try row.get(cIdCol),
                comicId: try row.get(cComicIdCol),
                url: try row.get(cUrlCol),
                name: try row.get(cNameCol),
                sortOrder: try row.get(cOrderCol),
                imageCount: try row.get(cImgCountCol),
                createdAt: try row.get(cCreatedAtCol),
                updatedAt: try row.get(cUpdatedAtCol)
            ))
        }
        return arr
    }
    
    func updateChapterImageCount(comicId: String, sortOrder: Int, imageCount: Int, name: String? = nil) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var setters: [Setter] = [cImgCountCol <- imageCount, cUpdatedAtCol <- now]
        if let n = name { setters.append(cNameCol <- n) }
        try db.run(chapters.filter(cComicIdCol == comicId && cOrderCol == sortOrder).update(setters))
    }
    
    private func mapComic(_ row: Row, db: Connection, includeChapters: Bool) throws -> Comic {
        var c = Comic(
            id: try row.get(idCol),
            sourceId: try row.get(sourceIdCol),
            sourceUrl: try row.get(sourceUrlCol),
            title: try row.get(titleCol),
            author: try row.get(authorCol),
            cover: try row.get(coverCol),
            localCover: try row.get(localCoverCol),
            descText: try row.get(descCol),
            status: try row.get(statusCol),
            tags: try row.get(tagsCol),
            category: try row.get(categoryCol),
            favorited: try row.get(favoritedCol),
            createdAt: try row.get(createdAtCol),
            updatedAt: try row.get(updatedAtCol),
            lastSync: try row.get(lastSyncCol),
            lastRead: try row.get(lastReadCol),
            updateDelta: try row.get(updateDeltaCol),
            chapterCount: try row.get(chapterCountCol)
        )
        if includeChapters {
            c.chapters = []
            for r in try db.prepare(chapters.filter(cComicIdCol == c.id).order(cOrderCol.asc)) {
                c.chapters.append(Chapter(
                    id: try r.get(cIdCol),
                    comicId: try r.get(cComicIdCol),
                    url: try r.get(cUrlCol),
                    name: try r.get(cNameCol),
                    sortOrder: try r.get(cOrderCol),
                    imageCount: try r.get(cImgCountCol),
                    createdAt: try r.get(cCreatedAtCol),
                    updatedAt: try r.get(cUpdatedAtCol)
                ))
            }
            c.chapterCount = c.chapters.count
        }
        return c
    }
}