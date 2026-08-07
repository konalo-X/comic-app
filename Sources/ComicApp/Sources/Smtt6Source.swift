import Foundation
#if canImport(SwiftSoup)
import SwiftSoup
#endif

final class Smtt6Source: ComicSource {
    let id = "smtt6"
    let name = "神漫画 (smtt6.com)"
    let lang = "zh-CN"
    var baseURL: String { "https://www.smtt6.com" }
    
    func search(query: String, page: Int) async throws -> [ComicSearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let url = "\(baseURL)/search?q=\(q)&page=\(page)"
        let html = try await NetworkManager.shared.get(url, referer: baseURL)
        var results: [ComicSearchResult] = []
        #if canImport(SwiftSoup)
        let doc = try SwiftSoup.parse(html)
        let cards = try doc.select(".comic-item, .book-item, .search-item, div.card")
        for c in cards {
            let title = try c.select("a.title, h3, .comic-title").first?.text().trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !title.isEmpty else { continue }
            let href = try c.select("a").first?.attr("href") ?? ""
            let detailUrl = href.hasPrefix("http") ? href : baseURL + href
            let cover = try c.select("img").first?.attr("data-src") ?? c.select("img").first?.attr("src") ?? ""
            let author = try c.select(".author, .comic-author").first?.text()
            let last = try c.select(".last-chapter, .latest").first?.text()
            let cat = try c.select(".category, .tag").first?.text()
            results.append(ComicSearchResult(
                id: "smtt6_" + (detailUrl as NSString).lastPathComponent,
                title: title,
                cover: cover.hasPrefix("http") ? cover : nil,
                author: author,
                sourceUrl: detailUrl,
                category: cat,
                lastChapter: last,
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
        title = try doc.select("h1.title, .comic-title, h1").first?.text() ?? ""
        if title.isEmpty { title = (try? doc.title()) ?? "" }
        cover = try doc.select(".cover img, .comic-cover img, img.cover").first?.attr("data-src")
               ?? doc.select(".cover img, .comic-cover img, img.cover").first?.attr("src")
        author = try doc.select(".author, .info .item:contains(作者)").first?.text().replacingOccurrences(of: "作者：", with: "")
        status = try doc.select(".status, .info .item:contains(状态)").first?.text().replacingOccurrences(of: "状态：", with: "")
        category = try doc.select(".category, .info .item:contains(类别)").first?.text().replacingOccurrences(of: "类别：", with: "")
        let tagsHtml = try doc.select(".tags a, .tag-list a")
        for a in tagsHtml { tags.append(try a.text()) }
        desc = try doc.select(".desc, .summary, .comic-desc").first?.text()
        
        let links = try doc.select(".chapter-list a, .list-chapters a, #chapter-list a, .chapter-item a")
        for a in links {
            let href = try a.attr("href")
            let hrefFull = href.hasPrefix("http") ? href : baseURL + href
            let n = try a.text().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !n.isEmpty else { continue }
            chapters.append(ChapterDetail(name: n, url: hrefFull))
        }
        #endif
        return ComicDetail(title: title, author: author, cover: cover, descText: desc, status: status, tags: tags, category: category, sourceUrl: url, chapters: chapters.reversed())
    }
    
    func getPageList(chapterUrl: String, referer: String?) async throws -> ChapterPages {
        let html = try await NetworkManager.shared.get(chapterUrl, referer: referer ?? baseURL)
        var images: [String] = []
        var chName: String? = nil
        #if canImport(SwiftSoup)
        let doc = try SwiftSoup.parse(html)
        chName = try doc.select("h1.chapter-title, .title, .chapter h1, h2").first?.text()
        let imgs = try doc.select(".chapter-content img, .comic-content img, .read-content img, #images img")
        for img in imgs {
            var src = try img.attr("data-src")
            if src.isEmpty { src = try img.attr("src") }
            if src.isEmpty { continue }
            if !src.hasPrefix("http") {
                if src.hasPrefix("//") { src = "https:" + src }
                else if let base = URL(string: chapterUrl) { src = URL(string: src, relativeTo: base)?.absoluteString ?? src }
            }
            images.append(src)
        }
        if images.isEmpty {
            #if canImport(SwiftSoup)
            if let scriptContent = try? doc.select("script").first(where: { (try? $0.html().contains("chapterImages")) ?? false })?.html() {
                let pattern = #"chapterImages\s*=\s*(\[[^\]]*\])"#
                if let regex = try? NSRegularExpression(pattern: pattern),
                   let match = regex.firstMatch(in: scriptContent, range: NSRange(scriptContent.startIndex..., in: scriptContent)),
                   let range = Range(match.range(at: 1), in: scriptContent) {
                    let jsonStr = String(scriptContent[range])
                    if let data = jsonStr.data(using: .utf8),
                       let arr = try? JSONSerialization.jsonObject(with: data) as? [String] {
                        for i in arr {
                            var full = i
                            if !full.hasPrefix("http") {
                                if full.hasPrefix("//") { full = "https:" + full }
                                else if let base = URL(string: chapterUrl) {
                                    full = URL(string: full, relativeTo: base)?.absoluteString ?? full
                                }
                            }
                            images.append(full)
                        }
                    }
                }
            }
            #endif
        }
        #endif
        return ChapterPages(images: images, chapterName: chName)
    }
    
    func fetchImage(imageUrl: String, referer: String?) async throws -> Data {
        var ref = referer
        if ref == nil { ref = baseURL }
        return try await NetworkManager.shared.getData(imageUrl, referer: ref, retries: 4)
    }
}