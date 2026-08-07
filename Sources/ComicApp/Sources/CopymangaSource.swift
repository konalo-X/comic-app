import Foundation
#if canImport(SwiftSoup)
import SwiftSoup
#endif

final class CopymangaSource: ComicSource {
    let id = "copymanga"
    let name = "拷贝漫画"
    let lang = "zh-CN"
    var baseURL: String { "https://www.copymanga.site" }
    private var apiBase: String { "https://api.copymanga.site" }
    
    func search(query: String, page: Int) async throws -> [ComicSearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let url = "\(apiBase)/api/v3/search/comic?q=\(q)&offset=\((page-1)*21)&limit=21&platform=1&q_type="
        let data = try await NetworkManager.shared.getData(url, referer: baseURL, retries: 3, accept: "application/json, text/plain, */*")
        var results: [ComicSearchResult] = []
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let d = json["results"] as? [String: Any],
           let list = d["list"] as? [[String: Any]] {
            for o in list {
                let name = o["name"] as? String ?? ""
                let p = o["path_word"] as? String ?? ""
                guard !name.isEmpty, !p.isEmpty else { continue }
                var cover = ""
                if let c = o["cover"] as? String { cover = c }
                else if let c = o["cover"] as? [String: Any] {
                    cover = c["url"] as? String ?? ""
                }
                let authors = (o["author"] as? [[String: Any]])?.compactMap { $0["name"] as? String }.joined(separator: "、")
                let last = ((o["last_chapter"] as? [String: Any])?["name"] as? String)
                       ?? (o["last_chapter_name"] as? String)
                let detailUrl = "\(baseURL)/comic/\(p)"
                let cat = (o["theme"] as? [[String: Any]])?.first?["name"] as? String
                results.append(ComicSearchResult(
                    id: "cpy_" + p,
                    title: name,
                    cover: cover,
                    author: authors,
                    sourceUrl: detailUrl,
                    category: cat,
                    lastChapter: last,
                    sourceId: id
                ))
            }
        }
        return results
    }
    
    func getDetail(url: String) async throws -> ComicDetail {
        let pwd = extractPathWord(from: url)
        guard !pwd.isEmpty else {
            throw NSError(domain: id, code: 404, userInfo: [NSLocalizedDescriptionKey: "无法解析路径"])
        }
        let apiUrl = "\(apiBase)/api/v3/comic2/\(pwd)?platform=1"
        let data = try await NetworkManager.shared.getData(apiUrl, referer: url, retries: 3, accept: "application/json, text/plain, */*")
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let r = json["results"] as? [String: Any],
              let comic = r["comic"] as? [String: Any] else {
            throw NSError(domain: id, code: -4, userInfo: [NSLocalizedDescriptionKey: "解析详情失败"])
        }
        let title = comic["name"] as? String ?? ""
        let author = (comic["author"] as? [[String: Any]])?.compactMap { $0["name"] as? String }.joined(separator: "、")
        var cover = ""
        if let c = comic["cover"] as? String { cover = c }
        else if let c = comic["cover"] as? [String: Any] { cover = c["url"] as? String ?? "" }
        let desc = comic["brief"] as? String
        let status: String? = {
            if let s = comic["status"] as? Int { return s == 0 ? "连载中" : "完结" }
            return nil
        }()
        var tags: [String] = []
        if let themes = comic["theme"] as? [[String: Any]] {
            tags = themes.compactMap { $0["name"] as? String }
        }
        let cat = tags.first
        
        let groupsApi = "\(apiBase)/api/v3/comic/\(pwd)/group/default?platform=1&limit=500&offset=0"
        let gd = try? await NetworkManager.shared.getData(groupsApi, referer: url, retries: 2, accept: "application/json, text/plain, */*")
        var chapters: [ChapterDetail] = []
        if let gd = gd,
           let j = try? JSONSerialization.jsonObject(with: gd) as? [String: Any],
           let rr = j["results"] as? [String: Any],
           let list = rr["list"] as? [[String: Any]] {
            for o in list {
                let name = o["name"] as? String ?? ""
                let u = o["uuid"] as? String ?? ""
                guard !name.isEmpty, !u.isEmpty else { continue }
                let cUrl = "\(baseURL)/comic/\(pwd)/chapter/\(u)"
                chapters.append(ChapterDetail(name: name, url: cUrl))
            }
        }
        return ComicDetail(title: title, author: author, cover: cover, descText: desc, status: status, tags: tags, category: cat, sourceUrl: url, chapters: chapters)
    }
    
    func getPageList(chapterUrl: String, referer: String?) async throws -> ChapterPages {
        let pwd = extractPathWord(from: chapterUrl)
        let pattern = #"chapter/([A-Za-z0-9_\-]+)"#
        var uuid = ""
        if let r = try? NSRegularExpression(pattern: pattern),
           let m = r.firstMatch(in: chapterUrl, range: NSRange(chapterUrl.startIndex..., in: chapterUrl)),
           let r2 = Range(m.range(at: 1), in: chapterUrl) {
            uuid = String(chapterUrl[r2])
        }
        guard !uuid.isEmpty, !pwd.isEmpty else {
            throw NSError(domain: id, code: 400, userInfo: [NSLocalizedDescriptionKey: "无效章节URL"])
        }
        let contentUrl = "\(apiBase)/api/v3/comic/\(pwd)/chapter2/\(uuid)?platform=1"
        let data = try await NetworkManager.shared.getData(contentUrl, referer: chapterUrl, retries: 3, accept: "application/json, text/plain, */*")
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let r = j["results"] as? [String: Any],
              let ch = r["chapter"] as? [String: Any],
              let words = ch["words"] as? [[String: Any]] else {
            throw NSError(domain: id, code: -5, userInfo: [NSLocalizedDescriptionKey: "解析章节失败"])
        }
        let sorted = words.sorted {
            let a = ($0["ordered"] as? Int) ?? 0
            let b = ($1["ordered"] as? Int) ?? 0
            return a < b
        }
        var urls: [String] = []
        for w in sorted {
            if let u = w["url"] as? String { urls.append(u) }
            else if let u = (w["url"] as? [String: Any])?["url"] as? String { urls.append(u) }
        }
        let name = ch["name"] as? String
        return ChapterPages(images: urls, chapterName: name)
    }
    
    func fetchImage(imageUrl: String, referer: String?) async throws -> Data {
        var ref = referer ?? baseURL
        if !ref.contains("http") { ref = baseURL }
        return try await NetworkManager.shared.getData(imageUrl, referer: ref, retries: 4)
    }
    
    private func extractPathWord(from url: String) -> String {
        let pattern = #"comic/([A-Za-z0-9_\-\u4e00-\u9fa5]+)"#
        if let r = try? NSRegularExpression(pattern: pattern),
           let m = r.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)),
           let r2 = Range(m.range(at: 1), in: url) {
            var s = String(url[r2])
            if let idx = s.firstIndex(of: "/") { s = String(s[..<idx]) }
            if let idx = s.firstIndex(of: "?") { s = String(s[..<idx]) }
            return s
        }
        return ""
    }
}