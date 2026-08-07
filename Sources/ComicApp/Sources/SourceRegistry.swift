import Foundation

final class SourceRegistry: @unchecked Sendable {
    static let shared = SourceRegistry()
    
    private let lock = NSLock()
    private var sources: [String: ComicSource] = [:]
    
    private init() {}
    
    func register(source: ComicSource) {
        lock.lock()
        sources[source.id] = source
        lock.unlock()
    }
    
    func get(id: String) -> ComicSource? {
        lock.lock()
        defer { lock.unlock() }
        return sources[id]
    }
    
    func all() -> [ComicSource] {
        lock.lock()
        defer { lock.unlock() }
        return Array(sources.values)
    }
    
    func listInfos() -> [SourceInfo] {
        lock.lock()
        let srcs = sources.values
        lock.unlock()
        return srcs.map { s in
            SourceInfo(
                id: s.id,
                name: s.name,
                lang: s.lang,
                host: URL(string: s.baseURL)?.host ?? s.baseURL,
                default: s.id == "smtt6",
                description: ""
            )
        }
    }
    
    func search(query: String, page: Int = 1, sourceId: String? = nil) async throws -> [ComicSearchResult] {
        if let sourceId, let source = sources[sourceId] {
            return try await source.search(query: query, page: page)
        }
        var all: [ComicSearchResult] = []
        for source in sources.values {
            do {
                let results = try await source.search(query: query, page: page)
                all.append(contentsOf: results)
            } catch {
                continue
            }
        }
        return all
    }
    
    func getDetail(url: String) async throws -> (ComicDetail, String) {
        var lastError: Error?
        for source in sources.values {
            if url.contains(source.baseURL.replacingOccurrences(of: "https://", with: "")) ||
               url.contains(source.id) {
                do {
                    return (try await source.getDetail(url: url), source.id)
                } catch {
                    lastError = error
                }
            }
        }
        for source in sources.values {
            do {
                return (try await source.getDetail(url: url), source.id)
            } catch {
                lastError = error
            }
        }
        throw lastError ?? NSError(domain: "SourceRegistry", code: 404, userInfo: [NSLocalizedDescriptionKey: "No source could handle URL: \(url)"])
    }
    
    func getPageList(chapterUrl: String, referer: String? = nil) async throws -> (ChapterPages, String) {
        var lastError: Error?
        for source in sources.values {
            if chapterUrl.contains(source.baseURL.replacingOccurrences(of: "https://", with: "")) {
                do {
                    return (try await source.getPageList(chapterUrl: chapterUrl, referer: referer), source.id)
                } catch {
                    lastError = error
                }
            }
        }
        for source in sources.values {
            do {
                return (try await source.getPageList(chapterUrl: chapterUrl, referer: referer), source.id)
            } catch {
                lastError = error
            }
        }
        throw lastError ?? NSError(domain: "SourceRegistry", code: 404, userInfo: [NSLocalizedDescriptionKey: "No source could handle chapter URL"])
    }
    
    func fetchImage(imageUrl: String, referer: String? = nil) async throws -> Data {
        for source in sources.values {
            if let r = referer, r.contains(source.baseURL.replacingOccurrences(of: "https://", with: "")) {
                return try await source.fetchImage(imageUrl: imageUrl, referer: referer)
            }
        }
        if let source = sources.values.first {
            return try await source.fetchImage(imageUrl: imageUrl, referer: referer)
        }
        throw NSError(domain: "SourceRegistry", code: 500, userInfo: [NSLocalizedDescriptionKey: "No source registered"])
    }
}