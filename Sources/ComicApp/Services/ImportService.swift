import Foundation
import SQLite

final class ImportService: @unchecked Sendable {
    static let shared = ImportService()
    private init() {}
    
    func importFromElectronDB(path: String, progress: @escaping @Sendable (Double, String) -> Void) async throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: path) else {
            throw NSError(domain: "Import", code: 404, userInfo: [NSLocalizedDescriptionKey: "DB 文件不存在"])
        }
        let repo = ComicRepository.shared
        let readingRepo = try ReadingRepository.shared
        let src = try Connection(path)
        let comicCount: Int64 = try src.scalar("SELECT COUNT(*) FROM comics") as? Int64 ?? 0
        var done: Int64 = 0
        let rows = try src.prepare("SELECT id, sourceUrl, source, title, author, cover, category, tags, description, updatedAt, favorited, createdAt FROM comics")
        for r in rows {
            let id = r[0] as? String ?? UUID().uuidString
            let sourceUrl = r[1] as? String ?? ""
            let source = r[2] as? String ?? ""
            let title = r[3] as? String ?? ""
            let author = r[4] as? String
            let cover = r[5] as? String ?? ""
            let category = r[6] as? String
            let tags = r[7] as? String
            let desc = r[8] as? String
            let updatedAt = r[9] as? Int64 ?? Int64(Date().timeIntervalSince1970 * 1000)
            let favorited = (r[10] as? Int64 ?? 0) > 0
            let createdAt = r[11] as? Int64 ?? updatedAt
            var comic = Comic(
                id: id, sourceId: source, sourceUrl: sourceUrl, title: title,
                author: author, cover: cover, localCover: nil, localPath: nil,
                descText: desc, status: nil, tags: tags, category: category,
                chapterNamesEnriched: 0, favorited: favorited ? 1 : 0,
                createdAt: createdAt, updatedAt: updatedAt, updateTime: 0,
                lastSync: 0, lastRead: 0, updateDelta: 0, chapters: [], chapterCount: 0
            )
            do {
                let chRows = try src.prepare("SELECT id, name, sourceUrl, downloaded, createdAt FROM chapters WHERE comicId = ? ORDER BY CAST(SUBSTR(id, INSTR(id, '_') + 1) AS INTEGER) ASC, id ASC", id)
                for cr in chRows {
                    let cid = cr[0] as? String ?? UUID().uuidString
                    let cname = cr[1] as? String ?? ""
                    let curl = cr[2] as? String ?? ""
                    let cat = cr[4] as? Int64 ?? createdAt
                    comic.chapters.append(Chapter(id: cid, comicId: id, url: curl, name: cname, sortOrder: 0, createdAt: cat, updatedAt: cat))
                }
                try repo.upsert(comic, chaptersInput: comic.chapters.isEmpty ? nil : comic.chapters)
            }
            done += 1
            progress(Double(done) / Double(max(1, comicCount)), "导入 \(done)/\(comicCount): \(title)")
            try Task.checkCancellation()
        }
        progress(1.0, "导入漫画完成，迁移阅读进度...")
        let progRows = try src.prepare("SELECT comicId, chapterIndex, pageIndex, scrollY, updatedAt, totalPages FROM reading_progress")
        var progs = 0
        for pr in progRows {
            let cid = pr[0] as? String ?? ""
            let chi = pr[1] as? Int ?? 0
            let pi = pr[2] as? Int ?? 0
            let ua = pr[4] as? Int64 ?? 0
            let tp = pr[5] as? Int ?? 0
            if cid.isEmpty { continue }
            try? readingRepo.saveProgress(ReadingProgress(comicId: cid, chapterIndex: chi, pageIndex: pi, totalPages: tp, progress: 0))
            progs += 1
        }
        progress(1.0, "完成！\(done) 本漫画，\(progs) 条阅读进度")
    }
    
    @MainActor
    func handleImportJob(job: Job, queue: JobQueue) async throws {
        queue.reportProgress(jobId: job.id, progress: 0.01, message: "准备扫描本地漫画目录...")
        let rootDir = job.payload["rootDir"]
        let comicId = job.payload["comicId"]
        if let dir = rootDir {
            let scanned = await scanLocalComics(in: dir)
            queue.reportProgress(jobId: job.id, current: scanned.count, total: max(1, scanned.count), message: "扫描完成\(scanned.count)本，导入功能开发中")
        } else if let cid = comicId {
            queue.reportProgress(jobId: job.id, progress: 0.5, message: "导入ID=\(cid)功能开发中")
        }
        try await Task.sleep(nanoseconds: 500_000_000)
    }
    
    func scanLocalComics(in rootDir: String) async -> [ScannedLocalComic] {
        let fm = FileManager.default
        var results: [ScannedLocalComic] = []
        guard let enumerator = fm.enumerator(atPath: rootDir) else { return results }
        let imageExts: Set<String> = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"]
        var cur: ScannedLocalComic? = nil
        var seenTitles = Set<String>()
        while let entry = enumerator.nextObject() as? String {
            let full = (rootDir as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            fm.fileExists(atPath: full, isDirectory: &isDir)
            if isDir.boolValue {
                let dirName = (entry as NSString).lastPathComponent
                if dirName.hasPrefix(".") { enumerator.skipDescendants(); continue }
                let normalized = dirName
                    .replacingOccurrences(of: #"\s*\(\d+\)$"#, with: "", options: .regularExpression)
                    .replacingOccurrences(of: #"_\d+$"#, with: "", options: .regularExpression)
                    .replacingOccurrences(of: #"-\d+$"#, with: "", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                let cleanTitle = normalized.isEmpty ? dirName : normalized
                if !seenTitles.contains(cleanTitle) {
                    seenTitles.insert(cleanTitle)
                    var new = ScannedLocalComic(title: cleanTitle, path: full)
                    cur?.chapterDirectories.sort()
                    if let c = cur { results.append(c) }
                    cur = new
                } else if let ci = cur, ci.title == cleanTitle {
                    cur?.chapterDirectories.append(full)
                } else {
                    for (idx, _) in results.enumerated() where results[idx].title == cleanTitle {
                        results[idx].chapterDirectories.append(full)
                    }
                }
            } else {
                let ext = (full as NSString).pathExtension.lowercased()
                if imageExts.contains(ext) {
                    let chapterDir = (full as NSString).deletingLastPathComponent
                    if let ci = cur, !ci.chapterDirectories.contains(chapterDir) {
                        cur?.chapterDirectories.append(chapterDir)
                    }
                }
            }
        }
        cur?.chapterDirectories.sort()
        if let c = cur { results.append(c) }
        return results
    }
}