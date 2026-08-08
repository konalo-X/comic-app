import SwiftUI

struct ChapterMgrView: View {
    @EnvironmentObject var app: AppStore
    @State private var selectedComicId: String? = nil
    @State private var selection = Set<String>()
    @State private var searchText = ""
    
    var currentComic: Comic? {
        app.comics.first { $0.id == selectedComicId }
    }
    
    var filteredChapters: [Chapter] {
        guard let c = currentComic else { return [] }
        let list = c.chapters
        if searchText.isEmpty { return list }
        return list.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }
    
    var stats: (total: Int, downloaded: Int, missing: [Int]) {
        guard let c = currentComic else { return (0, 0, []) }
        var down = 0
        var missing: [Int] = []
        for (idx, _) in c.chapters.enumerated() {
            let path = DownloadService.localPath(for: c, chapterIndex: idx)
            let fm = FileManager.default
            let exists = fm.fileExists(atPath: path) && ((try? fm.attributesOfItem(atPath: path)[.size] as? Int ?? 0) ?? 0) > 10_000
            if exists { down += 1 }
            else { missing.append(idx) }
        }
        return (c.chapters.count, down, missing)
    }
    
    var body: some View {
        NavigationSplitView {
            comicList
                .navigationSplitViewColumnWidth(min: 240, ideal: 300)
        } detail: {
            if let c = currentComic {
                chapterDetail(c)
            } else {
                ContentUnavailableView("选择漫画", systemImage: "book.pages",
                    description: Text("从左侧选择一本漫画以管理其章节"))
            }
        }
        .navigationTitle("章节管理")
    }
    
    private var comicList: some View {
        List(app.comics, id: \.id, selection: $selectedComicId) { c in
            HStack(spacing: 10) {
                AsyncImage(url: URL(string: c.cover ?? "")) { phase in
                    if let image = phase.image {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else { Color.gray.opacity(0.2) }
                }
                .frame(width: 40, height: 54).clipped().cornerRadius(4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                    Text("\(c.chapters.count) 话").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .tag(c.id)
            .padding(.vertical, 4)
        }
        .listStyle(.sidebar)
        .searchable(text: $searchText, placement: .sidebar)
    }
    
    private func chapterDetail(_ c: Comic) -> some View {
        let s = stats
        return VStack(spacing: 0) {
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    AsyncImage(url: URL(string: c.cover ?? "")) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: .fill)
                        } else { Color.gray.opacity(0.2) }
                    }
                    .frame(width: 90, height: 124).clipped().cornerRadius(8)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(c.title).font(.title2.weight(.bold))
                        Text(c.author ?? c.sourceId ?? "未知来源").font(.subheadline).foregroundStyle(.secondary)
                        HStack(spacing: 16) {
                            Label("\(s.total) 话", systemImage: "list.bullet.rectangle")
                            Label("\(s.downloaded) 已下载", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                            if !s.missing.isEmpty {
                                Label("\(s.missing.count) 缺失", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                HStack {
                    Button("下载选中 (\(selection.count))") { downloadSelected(c) }
                        .disabled(selection.isEmpty)
                        .buttonStyle(.borderedProminent)
                    Button("下载全部未下载") { downloadMissing(c) }
                    if !s.missing.isEmpty {
                        Button("补齐缺失 (\(s.missing.count))", role: .destructive) { redownloadMissing(c, missing: s.missing) }
                    }
                    Spacer()
                    Menu {
                        Button("全选") { selection = Set(filteredChapters.map { $0.id }) }
                        Button("取消全选") { selection.removeAll() }
                        Button("仅选未下载") {
                            selection.removeAll()
                            for (idx, ch) in c.chapters.enumerated() {
                                let path = DownloadService.localPath(for: c, chapterIndex: idx)
                                let exists = FileManager.default.fileExists(atPath: path)
                                if !exists { selection.insert(ch.id) }
                            }
                        }
                        Divider()
                        Button("删除选中本地文件", role: .destructive) { deleteSelectedLocal(c) }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton)
                }
                .controlSize(.small)
            }
            .padding(16)
            Divider()
            List(selection: $selection) {
                ForEach(Array(filteredChapters.enumerated()), id: \.element.id) { (idx, ch) in
                    let realIdx = c.chapters.firstIndex { $0.id == ch.id } ?? idx
                    chapterRow(ch, index: realIdx, comic: c)
                        .tag(ch.id)
                }
            }
            .listStyle(.inset)
            .searchable(text: $searchText, prompt: "搜索章节")
        }
    }
    
    private func chapterRow(_ ch: Chapter, index: Int, comic: Comic) -> some View {
        let path = DownloadService.localPath(for: comic, chapterIndex: index)
        let fm = FileManager.default
        let size = (try? fm.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        let exists = fm.fileExists(atPath: path) && size > 10_000
        let imgCnt = ch.imageCount
        
        return HStack(spacing: 10) {
            Image(systemName: exists ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(exists ? .green : .secondary)
            Text(String(format: "%03d", index + 1)).font(.system(.caption, design: .monospaced)).foregroundStyle(.tertiary).frame(width: 42, alignment: .trailing)
            Text(ch.name).font(.system(size: 13)).lineLimit(1)
            Spacer()
            if imgCnt > 0 {
                Text("\(imgCnt) 图").font(.caption2).foregroundStyle(.secondary)
            }
            if exists {
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
    
    private func downloadSelected(_ c: Comic) {
        let idxs = selection.compactMap { sid in c.chapters.firstIndex { $0.id == sid } }
        DownloadService.queueDownloads(comic: c, chapterIndices: idxs)
    }
    
    private func downloadMissing(_ c: Comic) {
        var miss: [Int] = []
        for (idx, _) in c.chapters.enumerated() {
            let p = DownloadService.localPath(for: c, chapterIndex: idx)
            if !FileManager.default.fileExists(atPath: p) { miss.append(idx) }
        }
        if !miss.isEmpty { DownloadService.queueDownloads(comic: c, chapterIndices: miss, priority: 1) }
    }
    
    private func redownloadMissing(_ c: Comic, missing: [Int]) {
        DownloadService.queueDownloads(comic: c, chapterIndices: missing, priority: 3, forceRedownload: true)
    }
    
    private func deleteSelectedLocal(_ c: Comic) {
        for sid in selection {
            if let idx = c.chapters.firstIndex(where: { $0.id == sid }) {
                let p = DownloadService.localPath(for: c, chapterIndex: idx)
                try? FileManager.default.removeItem(atPath: p)
                for suffix in ["-images", ".tmp"] { try? FileManager.default.removeItem(atPath: p + suffix) }
            }
        }
    }
}