import Foundation
import Testing
@testable import ComicApp

struct ModelsTests {
    @Test func comicSearchResultCodable() throws {
        let result = ComicSearchResult(
            id: "test_1",
            title: "Test Comic",
            cover: "https://example.com/cover.jpg",
            author: "Test Author",
            sourceUrl: "https://example.com/comic/1",
            category: "Action",
            status: "Ongoing",
            tags: "action, adventure",
            lastChapter: "Chapter 100",
            sourceId: "test"
        )
        let data = try JSONEncoder().encode(result)
        let decoded = try JSONDecoder().decode(ComicSearchResult.self, from: data)
        #expect(decoded.id == result.id)
        #expect(decoded.title == result.title)
        #expect(decoded.sourceUrl == result.sourceUrl)
    }
    
    @Test func chapterDetailCodable() throws {
        let chapter = ChapterDetail(name: "Chapter 1", url: "https://example.com/ch1")
        let data = try JSONEncoder().encode(chapter)
        let decoded = try JSONDecoder().decode(ChapterDetail.self, from: data)
        #expect(decoded.name == chapter.name)
        #expect(decoded.url == chapter.url)
    }
    
    @Test func comicDetailCreation() {
        let detail = ComicDetail(
            title: "Test Title",
            author: "Author",
            cover: "https://example.com/cover.jpg",
            descText: "Description",
            status: "Ongoing",
            tags: ["Action", "Adventure"],
            category: "Manga",
            sourceUrl: "https://example.com/comic/1",
            chapters: [
                ChapterDetail(name: "Ch 1", url: "https://example.com/ch1"),
                ChapterDetail(name: "Ch 2", url: "https://example.com/ch2")
            ]
        )
        #expect(detail.title == "Test Title")
        #expect(detail.chapters.count == 2)
        #expect(detail.tags.contains("Action"))
    }
    
    @Test func jobTypeRawValue() {
        #expect(JobType.sync.rawValue == "sync")
        #expect(JobType.download.rawValue == "download")
        #expect(JobType.crawl.rawValue == "crawl")
        #expect(JobType.enrich.rawValue == "enrich")
        #expect(JobType.repair.rawValue == "repair")
        #expect(JobType.export.rawValue == "export")
    }
    
    @Test func jobStatusRawValue() {
        #expect(JobStatus.pending.rawValue == "pending")
        #expect(JobStatus.running.rawValue == "running")
        #expect(JobStatus.completed.rawValue == "completed")
        #expect(JobStatus.failed.rawValue == "failed")
        #expect(JobStatus.cancelled.rawValue == "cancelled")
    }
    
    @Test func sourceInfoCreation() {
        let info = SourceInfo(
            id: "test",
            name: "Test Source",
            lang: "zh-CN",
            host: "example.com",
            default: true,
            description: "A test source"
        )
        #expect(info.id == "test")
        #expect(info.name == "Test Source")
        #expect(info.default == true)
    }
}

struct SourceRegistryTests {
    @Test func sourceRegistrySingleton() {
        let r1 = SourceRegistry.shared
        let r2 = SourceRegistry.shared
        #expect(r1 === r2)
    }
    
    @Test func sourceRegistryRegisterAndGet() {
        let registry = SourceRegistry.shared
        let source = MockSource()
        registry.register(source: source)
        let retrieved = registry.get(id: "mock")
        #expect(retrieved !== nil)
        #expect(retrieved?.id == "mock")
    }
    
    @Test func sourceRegistryListInfos() {
        let registry = SourceRegistry.shared
        let source = MockSource()
        registry.register(source: source)
        let infos = registry.listInfos()
        #expect(infos.contains(where: { $0.id == "mock" }))
    }
}

struct NetworkManagerTests {
    @Test func networkManagerSingleton() {
        let n1 = NetworkManager.shared
        let n2 = NetworkManager.shared
        #expect(n1 === n2)
    }
}

struct StringExtensionTests {
    @Test func sha1OrHashConsistency() {
        let s1 = "https://www.manhuagui.com/comic/123"
        let s2 = "https://www.manhuagui.com/comic/123"
        let s3 = "different"
        #expect(s1.sha1OrHash == s2.sha1OrHash)
        #expect(s1.sha1OrHash != s3.sha1OrHash)
    }
    
    @Test func xmlEscaping() {
        let raw = "<script>alert('test')</script>"
        let escaped = raw.xmlEscaped
        #expect(!escaped.contains("<"))
        #expect(!escaped.contains(">"))
        #expect(!escaped.contains("'"))
    }
}

private final class MockSource: ComicSource {
    let id = "mock"
    let name = "Mock Source"
    let lang = "zh-CN"
    var baseURL: String { "https://mock.example.com" }
    
    func search(query: String, page: Int) async throws -> [ComicSearchResult] {
        return []
    }
    
    func getPopular(page: Int) async throws -> [ComicSearchResult] {
        return []
    }
    
    func getLatest(page: Int) async throws -> [ComicSearchResult] {
        return []
    }
    
    func getDetail(url: String) async throws -> ComicDetail {
        return ComicDetail(title: "Mock", sourceUrl: url)
    }
    
    func getPageList(chapterUrl: String, referer: String?) async throws -> ChapterPages {
        return ChapterPages(images: [], chapterName: nil)
    }
    
    func fetchImage(imageUrl: String, referer: String?) async throws -> Data {
        return Data()
    }
}