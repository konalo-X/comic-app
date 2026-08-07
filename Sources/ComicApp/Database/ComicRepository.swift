import Foundation
import SQLite

struct ComicListResult {
    let items: [Comic]
    let total: Int
}

struct AdvancedSearchFilters {
    var query: String?
    var category: String?
    var tag: String?
    var status: String?
    var sourceId: String?
    var favorited: Bool?
    var minChapterCount: Int?
    var sortBy: String = "updatedAt"
    var sortDesc: Bool = true
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
    private let localPathCol = Expression<String?>("localPath")
    private let descCol = Expression<String?>("descText")
    private let statusCol = Expression<String?>("status")
    private let tagsCol = Expression<String?>("tags")
    private let categoryCol = Expression<String?>("category")
    private let chapterNamesEnrichedCol = Expression<Int>("chapterNamesEnriched")
    private let favoritedCol = Expression<Int>("favorited")
    private let createdAtCol = Expression<Int64>("createdAt")
    private let updatedAtCol = Expression<Int64>("updatedAt")
    private let updateTimeCol = Expression<Int64>("updateTime")
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
        var f = AdvancedSearchFilters()
        f.query = search
        f.category = category
        f.favorited = favorited
        f.sortBy = sortBy
        f.sortDesc = sortDesc
        return try advancedSearch(filters: f, page: page, pageSize: pageSize)
    }
    
    func advancedSearch(filters: AdvancedSearchFilters, page: Int = 1, pageSize: Int = 50) throws -> ComicListResult {
        let db = try DatabaseManager.shared.connection()
        var query = comics
        
        if let q = filters.query, !q.isEmpty {
            query = query.filter(
                titleCol.like("%\(q)%")
                || (authorCol ?? "").like("%\(q)%")
                || (tagsCol ?? "").like("%\(q)%")
                || (categoryCol ?? "").like("%\(q)%")
                || (descCol ?? "").like("%\(q)%")
            )
        }
        if let cat = filters.category, !cat.isEmpty { query = query.filter(categoryCol == cat) }
        if let tag = filters.tag, !tag.isEmpty { query = query.filter((tagsCol ?? "").like("%\(tag)%")) }
        if let st = filters.status, !st.isEmpty { query = query.filter(statusCol == st) }
        if let sid = filters.sourceId, !sid.isEmpty { query = query.filter(sourceIdCol == sid) }
        if let fav = filters.favorited { query = query.filter(favoritedCol == (fav ? 1 : 0)) }
        if let mc = filters.minChapterCount { query = query.filter(chapterCountCol >= mc) }
        
        let total = try db.scalar(query.count)
        
        let ordered: Table
        switch filters.sortBy {
        case "title":
            ordered = filters.sortDesc ? query.order(titleCol.desc) : query.order(titleCol.asc)
        case "chapter_count":
            ordered = filters.sortDesc ? query.order(chapterCountCol.desc) : query.order(chapterCountCol.asc)
        case "createdAt":
            ordered = filters.sortDesc ? query.order(createdAtCol.desc) : query.order(createdAtCol.asc)
        case "lastRead":
            ordered = filters.sortDesc ? query.order(lastReadCol.desc) : query.order(lastReadCol.asc)
        case "favorited":
            ordered = filters.sortDesc ? query.order(favoritedCol.desc, updatedAtCol.desc) : query.order(favoritedCol.asc, updatedAtCol.asc)
        default:
            ordered = filters.sortDesc ? query.order(updatedAtCol.desc) : query.order(updatedAtCol.asc)
        }
        let limit = pageSize
        let offset = max(0, (page - 1) * pageSize)
        var rows: [Comic] = []
        for row in try db.prepare(ordered.limit(limit, offset: offset)) {
            rows.append(try mapComic(row, db: db, includeChapters: false))
        }
        return ComicListResult(items: rows, total: total)
    }
    
    func allCategories() throws -> [CategoryStat] {
        let db = try DatabaseManager.shared.connection()
        var map: [String: Int] = [:]
        for row in try db.prepare(comics.select(categoryCol).filter(categoryCol != nil)) {
            if let c = try? row.get(categoryCol), !c.isEmpty {
                let separators = CharacterSet(charactersIn: ",，、/")
                let parts = c.components(separatedBy: separators).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                for p in parts { map[p, default: 0] += 1 }
            }
        }
        return map.map { CategoryStat(name: $0.key, count: $0.value) }.sorted { $0.count > $1.count }
    }
    
    func allTags() throws -> [CategoryStat] {
        let db = try DatabaseManager.shared.connection()
        var map: [String: Int] = [:]
        for row in try db.prepare(comics.select(tagsCol).filter(tagsCol != nil)) {
            if let t = try? row.get(tagsCol), !t.isEmpty {
                let separators = CharacterSet(charactersIn: ",，、/")
                let parts = t.components(separatedBy: separators).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                for p in parts { map[p, default: 0] += 1 }
            }
        }
        return map.map { CategoryStat(name: $0.key, count: $0.value) }.sorted { $0.count > $1.count }
    }
    
    func untaggedComicCount() throws -> Int {
        let db = try DatabaseManager.shared.connection()
        return try db.scalar(comics.filter(tagsCol == nil || (tagsCol ?? "") == "").count)
    }
    
    func totalCount() throws -> Int {
        let db = try DatabaseManager.shared.connection()
        return try db.scalar(comics.count)
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
    
    func getExistingSourceUrls(_ urls: [String]) throws -> Set<String> {
        guard !urls.isEmpty else { return [] }
        let db = try DatabaseManager.shared.connection()
        var set = Set<String>()
        for url in urls {
            if let row = try? db.pluck(comics.select(sourceUrlCol).filter(sourceUrlCol == url)) {
                let value: String? = try? row.get(sourceUrlCol)
                if let val = value, !val.isEmpty {
                    set.insert(val)
                }
            }
        }
        return set
    }
    
    func favoritedComics(sortBy: String = "lastRead") throws -> [Comic] {
        var f = AdvancedSearchFilters()
        f.favorited = true
        f.sortBy = sortBy
        f.sortDesc = true
        let r = try advancedSearch(filters: f, page: 1, pageSize: 10000)
        return r.items
    }
    
    func allComics(pageSize: Int = 1000) throws -> [Comic] {
        let f = AdvancedSearchFilters()
        let r = try advancedSearch(filters: f, page: 1, pageSize: pageSize)
        return r.items
    }
    
    func getComicsWithMissingFields() throws -> [Comic] {
        let db = try DatabaseManager.shared.connection()
        let query = comics.filter(
            (coverCol == nil || (coverCol ?? "") == "")
            || (authorCol == nil || (authorCol ?? "") == "")
            || (tagsCol == nil || (tagsCol ?? "") == "")
            || (descCol == nil || (descCol ?? "") == "")
        )
        var arr: [Comic] = []
        for row in try db.prepare(query.order(updatedAtCol.desc)) {
            arr.append(try mapComic(row, db: db, includeChapters: false))
        }
        return arr
    }
    
    func comicsNeedingChapterNameEnrichment() throws -> [Comic] {
        let db = try DatabaseManager.shared.connection()
        let query = comics.filter(chapterNamesEnrichedCol == 0).order(updatedAtCol.desc)
        var arr: [Comic] = []
        for row in try db.prepare(query) {
            arr.append(try mapComic(row, db: db, includeChapters: true))
        }
        return arr
    }
    
    func comicsWithGenericChapterNames(genericMatch: (String) -> Bool) throws -> [Comic] {
        let db = try DatabaseManager.shared.connection()
        let allChapters = Table("chapters")
        let all = try db.prepare(allChapters)
        var comicIdsWithGeneric = Set<String>()
        for r in all {
            let name = (try? r.get(cNameCol)) ?? ""
            if genericMatch(name) {
                comicIdsWithGeneric.insert(try r.get(cComicIdCol))
            }
        }
        var arr: [Comic] = []
        for cid in comicIdsWithGeneric {
            if let comic = try get(id: cid) { arr.append(comic) }
        }
        return arr
    }
    
    func isChapterNameGeneric(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return true }
        if trimmed.range(of: #"^第?[0-9零一二三四五六七八九十百千万]+[话回章节集卷頁页]$"#, options: .regularExpression) != nil {
            return true
        }
        return false
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
            merged.chapterNamesEnriched = (try? row.get(chapterNamesEnrichedCol)) ?? 0
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
                localPathCol <- merged.localPath,
                descCol <- merged.descText,
                statusCol <- merged.status,
                tagsCol <- merged.tags,
                categoryCol <- merged.category,
                chapterNamesEnrichedCol <- merged.chapterNamesEnriched,
                favoritedCol <- merged.favorited,
                updatedAtCol <- now,
                updateTimeCol <- merged.updateTime,
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
                localPathCol <- merged.localPath,
                descCol <- merged.descText,
                statusCol <- merged.status,
                tagsCol <- merged.tags,
                categoryCol <- merged.category,
                chapterNamesEnrichedCol <- merged.chapterNamesEnriched,
                favoritedCol <- merged.favorited,
                createdAtCol <- merged.createdAt,
                updatedAtCol <- merged.updatedAt,
                updateTimeCol <- merged.updateTime,
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
    
    func upsertBatch(_ items: [Comic]) throws {
        for c in items { try? upsert(c, chaptersInput: c.chapters.isEmpty ? nil : c.chapters) }
    }
    
    func update(id: String, setters: [String: Any?]) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var s: [Setter] = [updatedAtCol <- now]
        for (k, v) in setters {
            switch k {
            case "title":
                if let val = v as? String { s.append(titleCol <- val) }
            case "author":
                s.append(authorCol <- (v as? String))
            case "cover":
                s.append(coverCol <- (v as? String))
            case "localCover":
                s.append(localCoverCol <- (v as? String))
            case "localPath":
                s.append(localPathCol <- (v as? String))
            case "descText":
                s.append(descCol <- (v as? String))
            case "status":
                s.append(statusCol <- (v as? String))
            case "tags":
                s.append(tagsCol <- (v as? String))
            case "category":
                s.append(categoryCol <- (v as? String))
            case "favorited":
                if let b = v as? Bool { s.append(favoritedCol <- (b ? 1 : 0)) }
                else if let i = v as? Int { s.append(favoritedCol <- i) }
            case "updateTime":
                if let t = v as? Int64 { s.append(updateTimeCol <- t) }
            case "lastRead":
                if let t = v as? Int64 { s.append(lastReadCol <- t) }
            case "chapterCount":
                if let i = v as? Int { s.append(chapterCountCol <- i) }
            case "chapterNamesEnriched":
                if let i = v as? Int { s.append(chapterNamesEnrichedCol <- i) }
            case "updateDelta":
                if let i = v as? Int { s.append(updateDeltaCol <- i) }
            case "sourceUrl":
                s.append(sourceUrlCol <- (v as? String))
            default: break
            }
        }
        try db.run(comics.filter(idCol == id).update(s))
    }
    
    func setFavorite(id: String, favorited: Bool) throws {
        try update(id: id, setters: ["favorited": favorited])
    }
    
    func setLastRead(id: String) throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try update(id: id, setters: ["lastRead": now])
    }
    
    func markSynced(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(comics.filter(idCol == id).update(lastSyncCol <- now, updateDeltaCol <- 0, updatedAtCol <- now))
    }
    
    func clearUpdateDelta(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(comics.filter(idCol == id).update(updateDeltaCol <- 0))
    }
    
    func resetUpdateDeltaAll() throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(comics.update(updateDeltaCol <- 0))
    }
    
    func delete(id: String) throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(comics.filter(idCol == id).delete())
    }
    
    func clearAll() throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(chapters.delete())
        try db.run(comics.delete())
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
    
    func chaptersWithoutImageCount(limit: Int = 100) throws -> [(comicId: String, comicTitle: String, chapter: Chapter)] {
        let db = try DatabaseManager.shared.connection()
        let query = chapters.join(comics, on: cComicIdCol == idCol).filter(cImgCountCol == 0).limit(limit)
        var arr: [(String, String, Chapter)] = []
        for row in try db.prepare(query) {
            let chapter = Chapter(
                id: try row.get(cIdCol),
                comicId: try row.get(cComicIdCol),
                url: try row.get(cUrlCol),
                name: try row.get(cNameCol),
                sortOrder: try row.get(cOrderCol),
                imageCount: try row.get(cImgCountCol),
                createdAt: try row.get(cCreatedAtCol),
                updatedAt: try row.get(cUpdatedAtCol)
            )
            arr.append((try row.get(idCol), try row.get(titleCol), chapter))
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
    
    func updateChapterName(chapterId: String, name: String) throws {
        let db = try DatabaseManager.shared.connection()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try db.run(chapters.filter(cIdCol == chapterId).update(cNameCol <- name, cUpdatedAtCol <- now))
    }
    
    func updateChapterNames(comicId: String, patches: [(sortOrder: Int, name: String, imageCount: Int?)]) throws {
        for patch in patches {
            try updateChapterImageCount(comicId: comicId, sortOrder: patch.sortOrder, imageCount: patch.imageCount ?? 0, name: patch.name)
        }
    }
    
    func markComicChaptersEnriched(comicId: String) throws {
        try update(id: comicId, setters: ["chapterNamesEnriched": 1])
    }
    
    func getChapterImageCountBySourceUrl(_ sourceUrl: String) throws -> [Int: Int] {
        guard let comic = try getBySourceUrl(sourceUrl) else { return [:] }
        let chs = try getChapters(comicId: comic.id)
        var map: [Int: Int] = [:]
        for ch in chs { map[ch.sortOrder] = ch.imageCount }
        return map
    }
    
    func updateChapterImageCountBySourceUrl(_ sourceUrl: String, sortOrder: Int, imageCount: Int, name: String? = nil) throws {
        guard let comic = try getBySourceUrl(sourceUrl) else { return }
        try updateChapterImageCount(comicId: comic.id, sortOrder: sortOrder, imageCount: imageCount, name: name)
    }
    
    func repairBrokenChapterNames(prefixes: [String] = ["第", "Chapter"]) throws {
        let db = try DatabaseManager.shared.connection()
        let prefixSet = Set(prefixes)
        for row in try db.prepare(chapters.select(cIdCol, cNameCol)) {
            let _ = try row.get(cIdCol)
            let name = (try? row.get(cNameCol)) ?? ""
            if name.isEmpty || prefixSet.contains(where: { name.starts(with: $0) }) {
                let trimmed = name.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                if trimmed.range(of: #"^第?[0-9零一二三四五六七八九十百千万]+[话回章节集卷頁页]+$"#, options: .regularExpression) != nil {
                    continue
                }
            }
        }
    }
    
    func cleanupPureLocalComics() throws {
        let db = try DatabaseManager.shared.connection()
        try db.run(comics.filter((sourceUrlCol == nil || sourceUrlCol == "") && (localPathCol != nil && localPathCol != "")).delete())
    }
    
    private func mapComic(_ row: Row, db: Connection, includeChapters: Bool) throws -> Comic {
        var c = Comic(
            id: try row.get(idCol),
            sourceId: try? row.get(sourceIdCol),
            sourceUrl: try? row.get(sourceUrlCol),
            title: try row.get(titleCol),
            author: try? row.get(authorCol),
            cover: try? row.get(coverCol),
            localCover: try? row.get(localCoverCol),
            localPath: try? row.get(localPathCol),
            descText: try? row.get(descCol),
            status: try? row.get(statusCol),
            tags: try? row.get(tagsCol),
            category: try? row.get(categoryCol),
            chapterNamesEnriched: (try? row.get(chapterNamesEnrichedCol)) ?? 0,
            favorited: try row.get(favoritedCol),
            createdAt: try row.get(createdAtCol),
            updatedAt: try row.get(updatedAtCol),
            updateTime: (try? row.get(updateTimeCol)) ?? 0,
            lastSync: (try? row.get(lastSyncCol)) ?? 0,
            lastRead: (try? row.get(lastReadCol)) ?? 0,
            updateDelta: (try? row.get(updateDeltaCol)) ?? 0,
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