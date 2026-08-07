import SwiftUI
import Combine

@MainActor
final class ReaderStore: ObservableObject {
    static let shared = ReaderStore()
    
    @Published var comic: Comic? = nil
    @Published var chapters: [Chapter] = []
    @Published var currentChapterIndex: Int = 0
    @Published var currentPageIndex: Int = 0
    @Published var totalPages: Int = 0
    @Published var pageUrls: [String] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil
    @Published var readingMode: ReadingMode = .scroll
    @Published var pageDirection: PageDirection = .ltr
    @Published var cachedData: [String: Data] = [:]
    @Published var chapterName: String? = nil
    
    private var prefetchTask: Task<Void, Never>?
    
    enum ReadingMode: String, CaseIterable, Identifiable {
        case scroll, flip
        var id: String { rawValue }
        var label: String {
            switch self {
            case .scroll: return "滚动"
            case .flip: return "翻页"
            }
        }
    }
    
    enum PageDirection: String, CaseIterable, Identifiable {
        case ltr, rtl, ttb
        var id: String { rawValue }
        var label: String {
            switch self {
            case .ltr: return "从左到右"
            case .rtl: return "从右到左（日式）"
            case .ttb: return "从上到下"
            }
        }
    }
    
    private init() {}
    
    func open(comic: Comic, chapterIndex: Int? = nil) {
        self.comic = comic
        self.chapters = comic.chapters
        let startIdx = chapterIndex ?? currentChapterIndex
        goToChapter(index: startIdx)
    }
    
    func goToChapter(index: Int) {
        guard !chapters.isEmpty else { return }
        var idx = index
        if idx < 0 { idx = 0 }
        if idx >= chapters.count { idx = chapters.count - 1 }
        currentChapterIndex = idx
        currentPageIndex = 0
        cachedData.removeAll()
        loadChapter()
        saveProgress()
    }
    
    func nextChapter() {
        if currentChapterIndex < chapters.count - 1 {
            goToChapter(index: currentChapterIndex + 1)
        }
    }
    
    func prevChapter() {
        if currentChapterIndex > 0 {
            goToChapter(index: currentChapterIndex - 1)
        }
    }
    
    func setPage(_ page: Int) {
        var p = page
        if p < 0 { p = 0 }
        if p >= pageUrls.count { p = max(0, pageUrls.count - 1) }
        currentPageIndex = p
        saveProgress()
        schedulePrefetch()
    }
    
    func nextPage() {
        if currentPageIndex < pageUrls.count - 1 {
            setPage(currentPageIndex + 1)
        } else {
            nextChapter()
        }
    }
    
    func prevPage() {
        if currentPageIndex > 0 {
            setPage(currentPageIndex - 1)
        } else {
            prevChapter()
        }
    }
    
    private func loadChapter() {
        guard !chapters.isEmpty else { return }
        let ch = chapters[currentChapterIndex]
        chapterName = ch.name
        isLoading = true
        errorMessage = nil
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let pages: ChapterPages
                if let cached = CacheManager.shared.getCachedPageList(chapterUrl: ch.url) {
                    pages = cached
                } else {
                    let (p, _) = try await SourceRegistry.shared.getPageList(chapterUrl: ch.url, referer: self?.comic?.sourceUrl)
                    pages = p
                    try? CacheManager.shared.saveCachedPageList(p, chapterUrl: ch.url)
                }
                await MainActor.run {
                    guard let self else { return }
                    self.pageUrls = pages.images
                    self.totalPages = pages.images.count
                    self.currentPageIndex = 0
                    if let n = pages.chapterName, !n.isEmpty { self.chapterName = n }
                    self.isLoading = false
                    if let comic = self.comic {
                        let savedChapters = (try? ComicRepository.shared.getChapters(comicId: comic.id)) ?? []
                        if let idx = savedChapters.firstIndex(where: { $0.sortOrder == self.currentChapterIndex }) {
                            _ = idx
                        }
                    }
                    self.schedulePrefetch()
                    self.saveProgress()
                }
            } catch {
                await MainActor.run {
                    guard let self else { return }
                    self.errorMessage = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }
    
    private func schedulePrefetch() {
        prefetchTask?.cancel()
        prefetchTask = Task.detached(priority: .low) { [weak self] in
            guard let self else { return }
            let urls: [String] = await MainActor.run { Array(self.pageUrls) }
            let current: Int = await MainActor.run { self.currentPageIndex }
            let range = max(0, current - 1)..<min(urls.count, current + 6)
            for i in range {
                guard !Task.isCancelled else { break }
                let url = urls[i]
                let hasCached: Bool = await MainActor.run { self.cachedData[url] != nil }
                if hasCached { continue }
                if CacheManager.shared.hasCachedImage(url: url), let d = CacheManager.shared.getCachedImage(url: url) {
                    await MainActor.run { self.cachedData[url] = d }
                    continue
                }
                do {
                    let ref = await MainActor.run { self.comic?.sourceUrl }
                    let data = try await SourceRegistry.shared.fetchImage(imageUrl: url, referer: ref)
                    try? CacheManager.shared.saveImage(data, url: url)
                    await MainActor.run { self.cachedData[url] = data }
                } catch {
                    continue
                }
            }
        }
    }
    
    func pageData(_ url: String) -> Data? {
        if let d = cachedData[url] { return d }
        if CacheManager.shared.hasCachedImage(url: url) {
            let d = CacheManager.shared.getCachedImage(url: url)
            if let d { cachedData[url] = d }
            return d
        }
        return nil
    }
    
    func loadPageImageIfNeeded(_ url: String) {
        guard cachedData[url] == nil else { return }
        Task.detached(priority: .high) { [weak self] in
            do {
                let ref = await MainActor.run { self?.comic?.sourceUrl }
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: url, referer: ref)
                try? CacheManager.shared.saveImage(data, url: url)
                await MainActor.run { self?.cachedData[url] = data }
            } catch {}
        }
    }
    
    private func saveProgress() {
        guard let comic else { return }
        var p = ReadingProgress(
            comicId: comic.id,
            chapterIndex: currentChapterIndex,
            chapterUrl: chapters.indices.contains(currentChapterIndex) ? chapters[currentChapterIndex].url : nil,
            pageIndex: currentPageIndex,
            totalPages: totalPages,
            progress: totalPages > 0 ? Double(currentPageIndex) / Double(totalPages) : 0
        )
        Task.detached {
            try? ReadingRepository.shared.saveProgress(p)
        }
    }
    
    func restoreProgress(comic: Comic) -> Bool {
        guard let p = try? ReadingRepository.shared.getProgress(comicId: comic.id) else { return false }
        open(comic: comic, chapterIndex: p.chapterIndex)
        return true
    }
}