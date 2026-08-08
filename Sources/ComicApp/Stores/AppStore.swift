import SwiftUI
import Combine

@MainActor
final class AppStore: ObservableObject {
    static let shared = AppStore()
    
    @Published var comics: [Comic] = []
    @Published var totalComics: Int = 0
    @Published var currentPage: Int = 1
    @Published var pageSize: Int = 50
    @Published var searchText: String = ""
    @Published var filterFavorited: Bool? = nil
    @Published var filterCategory: String? = nil
    @Published var sortBy: String = "updatedAt"
    @Published var sortDesc: Bool = true
    @Published var categories: [String] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String? = nil
    @Published var selectedComic: Comic? = nil
    @Published var isBusyText: String = ""
    private var busyStack: [String] = []
    
    private let repo = ComicRepository.shared
    private var cancellables = Set<AnyCancellable>()
    
    private init() {
        refresh()
        refreshCategories()
    }
    
    func refresh() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let result = try repo.list(
                    page: currentPage,
                    pageSize: pageSize,
                    favorited: filterFavorited,
                    category: filterCategory,
                    search: searchText.isEmpty ? nil : searchText,
                    sortBy: sortBy,
                    sortDesc: sortDesc
                )
                await MainActor.run {
                    self.comics = result.items
                    self.totalComics = result.total
                    self.isLoading = false
                }
            } catch {
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }
    
    func refreshCategories() {
        Task {
            let cats = (try? repo.allCategories()) ?? []
            await MainActor.run { self.categories = cats.map { $0.name } }
        }
    }
    
    func setPage(_ page: Int) {
        guard page > 0 else { return }
        currentPage = page
        refresh()
    }
    
    func applySearch(_ text: String) {
        searchText = text
        currentPage = 1
        refresh()
    }
    
    func applyFavoriteFilter(_ value: Bool?) {
        filterFavorited = value
        currentPage = 1
        refresh()
    }
    
    func applyCategoryFilter(_ value: String?) {
        filterCategory = value
        currentPage = 1
        refresh()
    }
    
    func applySort(by: String, desc: Bool) {
        sortBy = by
        sortDesc = desc
        refresh()
    }
    
    func toggleFavorite(comic: Comic) {
        let newFav = comic.favorited == 0
        Task {
            try? repo.setFavorite(id: comic.id, favorited: newFav)
            refresh()
        }
    }
    
    func delete(comic: Comic) {
        Task {
            try? repo.delete(id: comic.id)
            refresh()
        }
    }
    
    func addSync(sourceUrl: String, priority: Int = 5) {
        JobQueue.shared.add(type: .sync, payload: ["sourceUrl": sourceUrl], priority: priority)
    }
    
    func syncComic(comic: Comic) {
        guard let url = comic.sourceUrl else { return }
        addSync(sourceUrl: url, priority: 8)
    }
    
    func syncAll() {
        Task {
            let all = try? repo.list(page: 1, pageSize: 1000, favorited: nil, category: nil, search: nil, sortBy: "updatedAt", sortDesc: true)
            guard let all else { return }
            var i = 0
            for c in all.items {
                guard let url = c.sourceUrl else { continue }
                addSync(sourceUrl: url, priority: 5 - i / 50)
                i += 1
            }
        }
    }
    
    func downloadAll(comic: Comic) {
        _ = DownloadService.shared.downloadAllChapters(comic: comic, queue: JobQueue.shared)
    }
    
    func downloadRange(comic: Comic, from: Int, to: Int) {
        _ = DownloadService.shared.downloadAllChapters(comic: comic, startIndex: from, endIndex: to, queue: JobQueue.shared)
    }
    
    func loadComic(id: String) {
        Task {
            let c = try? repo.get(id: id)
            await MainActor.run { self.selectedComic = c }
        }
    }
    
    var totalPages: Int {
        max(1, Int(ceil(Double(totalComics) / Double(pageSize))))
    }
    
    func setBusy(_ text: String) {
        busyStack.append(text)
        isBusyText = busyStack.last ?? ""
    }
    
    func clearBusy() {
        _ = busyStack.popLast()
        isBusyText = busyStack.last ?? ""
    }
}