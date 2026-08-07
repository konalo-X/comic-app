import Foundation

struct Comic: Identifiable, Codable, Hashable {
    var id: String
    var sourceId: String?
    var sourceUrl: String?
    var title: String
    var author: String?
    var cover: String?
    var localCover: String?
    var descText: String?
    var status: String?
    var tags: String?
    var category: String?
    var favorited: Int = 0
    var createdAt: Int64
    var updatedAt: Int64
    var lastSync: Int64 = 0
    var lastRead: Int64 = 0
    var updateDelta: Int = 0
    var chapters: [Chapter] = []
    var chapterCount: Int = 0
    
    init(id: String = UUID().uuidString,
         sourceId: String? = nil,
         sourceUrl: String? = nil,
         title: String,
         author: String? = nil,
         cover: String? = nil,
         localCover: String? = nil,
         descText: String? = nil,
         status: String? = nil,
         tags: String? = nil,
         category: String? = nil,
         favorited: Int = 0,
         createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
         updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
         lastSync: Int64 = 0,
         lastRead: Int64 = 0,
         updateDelta: Int = 0,
         chapters: [Chapter] = [],
         chapterCount: Int = 0) {
        self.id = id
        self.sourceId = sourceId
        self.sourceUrl = sourceUrl
        self.title = title
        self.author = author
        self.cover = cover
        self.localCover = localCover
        self.descText = descText
        self.status = status
        self.tags = tags
        self.category = category
        self.favorited = favorited
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastSync = lastSync
        self.lastRead = lastRead
        self.updateDelta = updateDelta
        self.chapters = chapters
        self.chapterCount = chapterCount
    }
    
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func == (lhs: Comic, rhs: Comic) -> Bool { lhs.id == rhs.id }
}

struct Chapter: Identifiable, Codable, Hashable {
    var id: String
    var comicId: String
    var url: String
    var name: String
    var sortOrder: Int
    var imageCount: Int = 0
    var createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    var updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    
    init(id: String = UUID().uuidString,
         comicId: String,
         url: String,
         name: String,
         sortOrder: Int,
         imageCount: Int = 0,
         createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
         updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        self.id = id
        self.comicId = comicId
        self.url = url
        self.name = name
        self.sortOrder = sortOrder
        self.imageCount = imageCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
    
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func == (lhs: Chapter, rhs: Chapter) -> Bool { lhs.id == rhs.id }
}

struct ReadingProgress: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var comicId: String
    var chapterIndex: Int
    var chapterUrl: String?
    var pageIndex: Int
    var totalPages: Int
    var progress: Double
    var createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    var updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    
    init(id: String = UUID().uuidString,
         comicId: String,
         chapterIndex: Int,
         chapterUrl: String? = nil,
         pageIndex: Int,
         totalPages: Int,
         progress: Double,
         createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
         updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
        self.id = id
        self.comicId = comicId
        self.chapterIndex = chapterIndex
        self.chapterUrl = chapterUrl
        self.pageIndex = pageIndex
        self.totalPages = totalPages
        self.progress = progress
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

enum DownloadStatus: String, Codable, CaseIterable, Hashable {
    case completed
    case missing
    case corrupted
    case downloading
}

struct DownloadRecord: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var comicId: String
    var comicTitle: String
    var chapterId: String
    var chapterName: String
    var chapterIndex: Int
    var chapterUrl: String
    var path: String
    var imagesCount: Int
    var totalSize: Int64
    var status: DownloadStatus = .completed
    var createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    var updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
}

enum JobStatus: String, Codable, CaseIterable, Hashable {
    case pending
    case running
    case completed
    case failed
    case cancelled
    
    var label: String {
        switch self {
        case .pending: return "等待"
        case .running: return "运行"
        case .completed: return "完成"
        case .failed: return "失败"
        case .cancelled: return "取消"
        }
    }
}

enum JobType: String, Codable, CaseIterable, Hashable {
    case sync
    case download
    case enrich
    case repair
    case crawl
}

struct Job: Identifiable, Codable, Hashable {
    var id: String = UUID().uuidString
    var type: JobType
    var status: JobStatus = .pending
    var payload: [String: String] = [:]
    var progress: Double = 0
    var message: String? = nil
    var error: String? = nil
    var priority: Int = 5
    var retryCount: Int = 0
    var maxRetries: Int = 3
    var createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    var updatedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
}

struct ComicSearchResult: Identifiable, Codable, Hashable {
    var id: String
    var title: String
    var cover: String?
    var author: String?
    var sourceUrl: String
    var category: String?
    var status: String?
    var tags: String?
    var lastChapter: String?
    var sourceId: String? = nil
}

struct ComicDetail {
    var title: String
    var author: String?
    var cover: String?
    var descText: String?
    var status: String?
    var tags: [String] = []
    var category: String?
    var sourceUrl: String
    var chapters: [ChapterDetail] = []
}

struct ChapterDetail {
    var name: String
    var url: String
}

struct ChapterPages: Codable {
    var images: [String]
    var chapterName: String?
    var nextChapterUrl: String?
    var prevChapterUrl: String?
}

struct SourceInfo: Identifiable, Hashable, Codable, Sendable {
    let id: String
    let name: String
    let lang: String
    let host: String
    let `default`: Bool
    let description: String?
    
    init(id: String, name: String, lang: String, host: String = "", `default`: Bool = false, description: String? = nil) {
        self.id = id
        self.name = name
        self.lang = lang
        self.host = host
        self.default = `default`
        self.description = description
    }
}

protocol ComicSource: AnyObject {
    var id: String { get }
    var name: String { get }
    var lang: String { get }
    var baseURL: String { get }
    
    func search(query: String, page: Int) async throws -> [ComicSearchResult]
    func getDetail(url: String) async throws -> ComicDetail
    func getPageList(chapterUrl: String, referer: String?) async throws -> ChapterPages
    func fetchImage(imageUrl: String, referer: String?) async throws -> Data
}