import Foundation
import ZIPFoundation

final class DownloadService: @unchecked Sendable {
    static let shared = DownloadService()
    private init() {}
    
    static func downloadsDir() -> URL {
        let paths = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        let base = paths.first?.appendingPathComponent("ComicApp", isDirectory: true) ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads/ComicApp")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }
    
    static func sanitizeName(_ s: String) -> String {
        var r = s
        for ch in ["/", ":", "?", "\"", "<", ">", "|", "\\", "*"] {
            r = r.replacingOccurrences(of: ch, with: "_")
        }
        return r.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    
    static func localPath(for comic: Comic, chapterIndex: Int) -> String {
        let base = downloadsDir()
        let safeTitle = sanitizeName(comic.title.count > 0 ? comic.title : comic.id)
        let comicDir = base.appendingPathComponent(safeTitle, isDirectory: true)
        try? FileManager.default.createDirectory(at: comicDir, withIntermediateDirectories: true)
        let chName = comic.chapters.indices.contains(chapterIndex) ? comic.chapters[chapterIndex].name : "第\(chapterIndex + 1)话"
        let safeCh = sanitizeName(String(format: "%03d_%@", chapterIndex + 1, chName))
        return comicDir.appendingPathComponent("\(safeCh).cbz").path
    }
    
    @MainActor
    static func queueDownloads(comic: Comic, chapterIndices: [Int], priority: Int = 2, forceRedownload: Bool = false) {
        let q = JobQueue.shared
        for idx in chapterIndices {
            guard idx >= 0 && idx < comic.chapters.count else { continue }
            let ch = comic.chapters[idx]
            let path = localPath(for: comic, chapterIndex: idx)
            if !forceRedownload && FileManager.default.fileExists(atPath: path) { continue }
            var payload: [String: String] = [
                "comicId": comic.id,
                "comicTitle": comic.title,
                "chapterIndex": "\(idx)",
                "chapterName": ch.name,
                "chapterUrl": ch.url,
                "chapterId": ch.id,
                "sourceUrl": comic.sourceUrl ?? "",
                "source": comic.sourceId ?? "",
                "force": forceRedownload ? "1" : "0"
            ]
            if let c = comic.cover, let cover = c.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
                payload["cover"] = cover
            }
            q.add(type: .download, payload: payload, priority: priority, mutexKey: "dl_\(comic.id)_\(idx)")
        }
    }
    
    nonisolated func downloadChapter(job: Job, queue: JobQueue) async throws {
        guard let comicId = job.payload["comicId"],
              let comicTitle = job.payload["comicTitle"],
              let chapterIndexStr = job.payload["chapterIndex"],
              let chapterIndex = Int(chapterIndexStr),
              let chapterUrl = job.payload["chapterUrl"] else {
            throw NSError(domain: "DownloadService", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid payload"])
        }
        let chapterName = job.payload["chapterName"] ?? "第\(chapterIndex + 1)话"
        let sourceUrl = job.payload["sourceUrl"]
        let chapterId = job.payload["chapterId"] ?? "\(comicId)_\(chapterIndex)"
        
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.05, message: "解析章节图片列表...")
        }
        let pages: ChapterPages
        if let cached = CacheManager.shared.getCachedPageList(chapterUrl: chapterUrl) {
            pages = cached
        } else {
            let (p, _) = try await SourceRegistry.shared.getPageList(chapterUrl: chapterUrl, referer: sourceUrl)
            pages = p
            try? CacheManager.shared.saveCachedPageList(p, chapterUrl: chapterUrl)
        }
        let imageUrls = pages.images
        guard !imageUrls.isEmpty else {
            throw NSError(domain: "DownloadService", code: 500, userInfo: [NSLocalizedDescriptionKey: "章节无图片"])
        }
        
        let actualChapterName = pages.chapterName ?? chapterName
        let chapterDir = CacheManager.shared.getChapterDownloadDir(
            comicTitle: comicTitle, chapterIndex: chapterIndex, chapterName: actualChapterName
        )
        
        let fm = FileManager.default
        try? fm.createDirectory(at: chapterDir, withIntermediateDirectories: true)
        
        var existingIdx: Set<Int> = []
        if let files = try? fm.contentsOfDirectory(atPath: chapterDir.path) {
            for file in files {
                let ext = (file as NSString).pathExtension.lowercased()
                if ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(ext) {
                    let name = (file as NSString).deletingPathExtension
                    if let i = Int(name) { existingIdx.insert(i - 1) }
                }
            }
        }
        
        let total = imageUrls.count
        var successes = existingIdx.count
        var totalBytes: Int64 = 0
        
        for (index, url) in imageUrls.enumerated() {
            try Task.checkCancellation()
            if await queue.checkCancelled(jobId: job.id) { throw CancellationError() }
            if existingIdx.contains(index) { continue }
            do {
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: url, referer: sourceUrl)
                var ext = (url as NSString).pathExtension.lowercased()
                if ext.isEmpty || !["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(ext) {
                    ext = detectImageFormat(data) ?? "jpg"
                }
                let filename = String(format: "%04d.\(ext)", index + 1)
                try data.write(to: chapterDir.appendingPathComponent(filename), options: [.atomic])
                try? CacheManager.shared.saveImage(data, url: url)
                totalBytes += Int64(data.count)
                successes += 1
                let progress = 0.1 + 0.85 * Double(successes) / Double(total)
                await MainActor.run {
                    queue.reportProgress(jobId: job.id, progress: progress, message: "下载 \(successes)/\(total)")
                }
            } catch {
                if successes == 0 && index == total - 1 { throw error }
            }
        }
        
        guard successes > 0 else {
            throw NSError(domain: "DownloadService", code: 500, userInfo: [NSLocalizedDescriptionKey: "所有图片下载失败"])
        }
        
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.97, message: "保存下载记录...")
        }
        let record = DownloadRecord(
            id: UUID().uuidString,
            comicId: comicId,
            comicTitle: comicTitle,
            chapterId: chapterId,
            chapterName: actualChapterName,
            chapterIndex: chapterIndex,
            chapterUrl: chapterUrl,
            path: chapterDir.path,
            imagesCount: successes,
            totalSize: totalBytes
        )
        try ReadingRepository.shared.addDownload(record)
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "完成：\(successes)/\(total) 张")
        }
    }
    
    @MainActor
    func downloadAllChapters(comic: Comic, startIndex: Int? = nil, endIndex: Int? = nil, queue: JobQueue) -> Int {
        let chapters = comic.chapters
        let start = startIndex ?? 0
        let end = endIndex ?? max(0, chapters.count - 1)
        guard start <= end, start >= 0, end < chapters.count else { return 0 }
        var added = 0
        for i in start...end {
            let ch = chapters[i]
            queue.add(
                type: .download,
                payload: [
                    "comicId": comic.id,
                    "comicTitle": comic.title,
                    "chapterIndex": String(i),
                    "chapterId": ch.id,
                    "chapterUrl": ch.url,
                    "chapterName": ch.name,
                    "sourceUrl": comic.sourceUrl ?? ""
                ],
                priority: max(0, 10 - i)
            )
            added += 1
        }
        return added
    }
    
    private func detectImageFormat(_ data: Data) -> String? {
        guard data.count >= 12 else { return nil }
        var bytes = [UInt8](repeating: 0, count: 12)
        data.copyBytes(to: &bytes, count: 12)
        if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF { return "jpg" }
        if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 { return "png" }
        if bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 { return "gif" }
        if bytes[0] == 0x42 && bytes[1] == 0x4D { return "bmp" }
        if bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46,
           bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50 { return "webp" }
        return nil
    }
}

final class EnrichService: @unchecked Sendable {
    static let shared = EnrichService()
    private init() {}
    
    nonisolated func enrich(job: Job, queue: JobQueue) async throws {
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0, message: "获取待补齐漫画列表...")
        }
        let all = try ComicRepository.shared.list(page: 1, pageSize: 2000, favorited: nil, category: nil, search: nil, sortBy: "updatedAt", sortDesc: true)
        let needList = all.items.filter { c in
            if c.chapters.isEmpty { return false }
            return c.chapters.contains { $0.imageCount == 0 }
        }
        guard !needList.isEmpty else {
            await MainActor.run {
                queue.reportProgress(jobId: job.id, progress: 1.0, message: "无需补齐")
            }
            return
        }
        let total = needList.count
        for (idx, comic) in needList.enumerated() {
            try Task.checkCancellation()
            if await queue.checkCancelled(jobId: job.id) { throw CancellationError() }
            let prog = Double(idx) / Double(total) * 0.9
            await MainActor.run {
                queue.reportProgress(jobId: job.id, progress: prog, message: "补齐 \(idx + 1)/\(total): \(comic.title)")
            }
            let sourceUrl = comic.sourceUrl
            var updatedChapters: [Chapter] = []
            var saveComic = comic
            for ch in comic.chapters {
                var newCh = ch
                if newCh.imageCount == 0 {
                    do {
                        let (pages, _) = try await SourceRegistry.shared.getPageList(chapterUrl: ch.url, referer: sourceUrl)
                        newCh.imageCount = pages.images.count
                        try? CacheManager.shared.saveCachedPageList(pages, chapterUrl: ch.url)
                    } catch {}
                }
                updatedChapters.append(newCh)
            }
            saveComic.chapters = updatedChapters
            _ = try ComicRepository.shared.upsert(saveComic)
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "补齐完成")
        }
    }
}

final class RepairService: @unchecked Sendable {
    static let shared = RepairService()
    private init() {}
    
    nonisolated func repair(job: Job, queue: JobQueue) async throws {
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0, message: "开始检查下载记录...")
        }
        let records = try ReadingRepository.shared.listDownloadRecords()
        let fm = FileManager.default
        var fixed: [DownloadRecord] = []
        let total = records.count
        for (idx, rec) in records.enumerated() {
            try Task.checkCancellation()
            var r = rec
            var changed = false
            var isDir: ObjCBool = false
            let exists = fm.fileExists(atPath: r.path, isDirectory: &isDir)
            if !exists || !isDir.boolValue {
                r.status = .missing
                changed = true
            } else {
                var count = 0
                var size: Int64 = 0
                if let files = try? fm.contentsOfDirectory(atPath: r.path) {
                    for file in files {
                        let ext = (file as NSString).pathExtension.lowercased()
                        if ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(ext) {
                            count += 1
                            let full = (r.path as NSString).appendingPathComponent(file)
                            if let attrs = try? fm.attributesOfItem(atPath: full),
                               let s = attrs[.size] as? NSNumber {
                                size += s.int64Value
                            }
                        }
                    }
                }
                if count == 0 {
                    r.status = .corrupted
                    changed = true
                } else {
                    if r.imagesCount != count || r.totalSize != size {
                        r.imagesCount = count
                        r.totalSize = size
                        changed = true
                    }
                    if r.status != .completed {
                        r.status = .completed
                        changed = true
                    }
                }
            }
            if changed { fixed.append(r) }
            let prog = Double(idx + 1) / Double(total) * 0.9
            await MainActor.run {
                queue.reportProgress(jobId: job.id, progress: prog, message: "检查 \(idx + 1)/\(total)")
            }
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.95, message: "保存修复结果 \(fixed.count)...")
        }
        for rec in fixed {
            try ReadingRepository.shared.updateDownload(rec)
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "修复完成，更新 \(fixed.count) 条")
        }
    }
}

final class CrawlService: @unchecked Sendable {
    static let shared = CrawlService()
    private init() {}
    
    nonisolated func crawl(job: Job, queue: JobQueue) async throws {
        let sourceId = job.payload["sourceId"] ?? "smtt6"
        let keyword = job.payload["keyword"] ?? ""
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0, message: "开始搜索 \(keyword)...")
        }
        guard let source = SourceRegistry.shared.get(id: sourceId) else {
            throw NSError(domain: "CrawlService", code: 400, userInfo: [NSLocalizedDescriptionKey: "Unknown source: \(sourceId)"])
        }
        let list = try await source.search(query: keyword, page: 1)
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.6, message: "找到 \(list.count) 条结果，入队同步...")
        }
        var crawled = 0
        for item in list {
            try Task.checkCancellation()
            _ = await MainActor.run {
                queue.add(
                    type: .sync,
                    payload: [
                        "sourceUrl": item.sourceUrl,
                        "comicTitle": item.title
                    ],
                    priority: 0
                )
            }
            crawled += 1
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "爬取完成：\(crawled) 条入队同步")
        }
    }
}