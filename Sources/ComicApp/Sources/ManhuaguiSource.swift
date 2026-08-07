import Foundation
#if canImport(SwiftSoup)
import SwiftSoup
#endif

final class ManhuaguiSource: ComicSource {
    let id = "manhuagui"
    let name = "漫画柜"
    let lang = "zh-CN"
    var baseURL: String { "https://www.manhuagui.com" }
    
    func search(query: String, page: Int) async throws -> [ComicSearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let url = page == 1 ? "\(baseURL)/s_\(q).html" : "\(baseURL)/s_\(q)_p\(page).html"
        let html = try await NetworkManager.shared.get(url, referer: baseURL)
        var results: [ComicSearchResult] = []
        #if canImport(SwiftSoup)
        let doc = try SwiftSoup.parse(html)
        let items = try doc.select(".book-cover, .book-list li, .result-item")
        for it in items {
            let a = try it.select("a").first
            let title = try a?.attr("title") ?? it.select("h3, .title").text()
            guard !title.isEmpty else { continue }
            var href = try a?.attr("href") ?? ""
            href = href.hasPrefix("http") ? href : baseURL + href
            let cover = try it.select("img").first?.attr("data-src") ?? it.select("img").first?.attr("src")
            let c = try it.select(".last, .update").text()
            results.append(ComicSearchResult(
                id: "mhg_" + href.sha1OrHash,
                title: title,
                cover: cover?.hasPrefix("http") == true ? cover : nil,
                author: nil,
                sourceUrl: href,
                category: nil,
                lastChapter: c,
                sourceId: id
            ))
        }
        #endif
        return results
    }
    
    func getDetail(url: String) async throws -> ComicDetail {
        let html = try await NetworkManager.shared.get(url, referer: baseURL)
        var title = "", author: String? = nil, cover: String? = nil, desc: String? = nil, status: String? = nil, category: String? = nil
        var tags: [String] = []
        var chapters: [ChapterDetail] = []
        #if canImport(SwiftSoup)
        let doc = try SwiftSoup.parse(html)
        title = try doc.select(".book-title h1, h1.title").first?.text() ?? (try? doc.title()) ?? ""
        cover = try doc.select(".book-cover img, .cover img").first?.attr("src") ?? doc.select(".book-cover img, .cover img").first?.attr("data-src")
        author = try doc.select("div:contains(作者) a").first?.text()
        status = try doc.select(".status, a.status").first?.text()
        category = try doc.select("div:contains(类别) a, .category a").first?.text()
        tags = try doc.select(".tags a, .keywords a").map { try $0.text() }
        desc = try doc.select(".intro, .book-intro").first?.text()
        
        let links = try doc.select(".chapter-list a, .chapter-item a, .chapter-manhua a")
        var seen: Set<String> = []
        for a in links {
            let href = try a.attr("href")
            guard !href.isEmpty else { continue }
            let full = href.hasPrefix("http") ? href : (href.hasPrefix("//") ? "https:" + href : baseURL + href)
            let n = try a.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty, !seen.contains(full) else { continue }
            seen.insert(full)
            chapters.append(ChapterDetail(name: n, url: full))
        }
        #endif
        return ComicDetail(title: title, author: author, cover: cover, descText: desc, status: status, tags: tags, category: category, sourceUrl: url, chapters: chapters)
    }
    
    func getPageList(chapterUrl: String, referer: String?) async throws -> ChapterPages {
        let html = try await NetworkManager.shared.get(chapterUrl, referer: referer ?? baseURL)
        var images: [String] = []
        var chName: String? = nil
        #if canImport(SwiftSoup)
        let doc = try SwiftSoup.parse(html)
        chName = try doc.select(".chapter-title, h1.title").first?.text()
        let scripts = try doc.select("script").map { try $0.html() }
        for s in scripts {
            if s.contains("images") && (s.contains("chapterData") || s.contains("[")) {
                let p1 = #"(?:images|imgPath|src)\s*[:=]\s*(\[.*?\])"#
                if let r = try? NSRegularExpression(pattern: p1),
                   let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
                   let r2 = Range(m.range(at: 1), in: s) {
                    let json = String(s[r2])
                    if let data = json.data(using: .utf8), let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
                        for i in arr {
                            var u = i
                            if !u.hasPrefix("http") {
                                if u.hasPrefix("//") { u = "https:" + u }
                                else if let base = URL(string: chapterUrl) { u = URL(string: u, relativeTo: base)?.absoluteString ?? u }
                            }
                            images.append(u)
                        }
                    }
                }
            }
        }
        if images.isEmpty {
            let imgs = try doc.select("img")
            for img in imgs {
                var src = try img.attr("data-src"); if src.isEmpty { src = try img.attr("src") }
                guard !src.isEmpty else { continue }
                let lc = src.lowercased()
                if !(lc.contains("http") || lc.hasSuffix(".jpg") || lc.hasSuffix(".png") || lc.hasSuffix(".webp") || lc.hasSuffix(".jpeg")) {
                    continue
                }
                if !src.hasPrefix("http") {
                    if src.hasPrefix("//") { src = "https:" + src }
                    else if let base = URL(string: chapterUrl) { src = URL(string: src, relativeTo: base)?.absoluteString ?? src }
                }
                images.append(src)
            }
        }
        #endif
        return ChapterPages(images: images, chapterName: chName)
    }
    
    func fetchImage(imageUrl: String, referer: String?) async throws -> Data {
        try await NetworkManager.shared.getData(imageUrl, referer: referer ?? baseURL, retries: 4)
    }
}

extension String {
    var sha1OrHash: String {
        var h = 0
        for ch in utf16 { h = h &* 31 &+ Int(ch) }
        return String(abs(h), radix: 16)
    }
}