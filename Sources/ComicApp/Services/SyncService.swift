import Foundation
import SQLite

final class SyncService: @unchecked Sendable {
    static let shared = SyncService()
    private init() {}
    
    nonisolated func syncComic(job: Job, queue: JobQueue) async throws {
        guard let sourceUrl = job.payload["sourceUrl"], !sourceUrl.isEmpty else {
            throw NSError(domain: "SyncService", code: 400, userInfo: [NSLocalizedDescriptionKey: "Missing sourceUrl"])
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.1, message: "获取详情...")
        }
        let (detail, sourceId) = try await SourceRegistry.shared.getDetail(url: sourceUrl)
        
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.55, message: "保存到数据库...")
        }
        
        var comic = Comic(
            sourceId: sourceId,
            sourceUrl: sourceUrl,
            title: detail.title,
            author: detail.author,
            cover: detail.cover,
            descText: detail.descText,
            status: detail.status,
            tags: detail.tags.joined(separator: ", "),
            category: detail.category
        )
        
        let chapters = detail.chapters.enumerated().map { i, ch in
            Chapter(
                comicId: "",
                url: ch.url,
                name: ch.name,
                sortOrder: i
            )
        }
        comic.chapterCount = chapters.count
        
        let saved = try ComicRepository.shared.upsert(comic, chaptersInput: chapters)
        
        if let cover = detail.cover {
            await MainActor.run {
                queue.reportProgress(jobId: job.id, progress: 0.8, message: "下载封面...")
            }
            do {
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: cover, referer: sourceUrl)
                let localPath = try CacheManager.shared.saveCover(data: data, sourceUrl: sourceUrl)
                if !localPath.isEmpty {
                    var updated = saved
                    updated.localCover = localPath
                    _ = try ComicRepository.shared.upsert(updated)
                }
            } catch {}
        }
        
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.95, message: "处理章节数...")
        }
        
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "完成")
            NotificationCenter.default.post(name: Notification.Name("RefreshBookshelf"), object: nil)
        }
    }
}