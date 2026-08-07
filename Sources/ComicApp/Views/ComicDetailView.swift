import SwiftUI

struct ComicDetailView: View {
    let comic: Comic
    @State private var loaded: Comic
    @EnvironmentObject var store: AppStore
    @State private var coverImage: NSImage? = nil
    @State private var coverFailed = false
    @State private var selection: Chapter? = nil
    @State private var showReader = false
    @State private var showDownloadSheet = false
    @State private var downloadFrom: Int = 0
    @State private var downloadTo: Int = 0
    @State private var downloadedRecords: [DownloadRecord] = []
    
    init(comic: Comic) {
        self.comic = comic
        self._loaded = State(initialValue: comic)
    }
    
    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            ScrollView {
                HStack(alignment: .top, spacing: 24) {
                    coverSection.padding(.leading, 24).padding(.top, 20)
                    infoSection
                }
                Divider().padding(.horizontal, 24).padding(.vertical, 18)
                chapterSection.padding(.horizontal, 24).padding(.bottom, 24)
            }
        }
        .sheet(isPresented: $showDownloadSheet) { downloadSheet }
        .onAppear(perform: {
            Task {
                if let fresh = try? ComicRepository.shared.get(id: comic.id) {
                    loaded = fresh
                    refreshDownloaded()
                }
                loadCover()
            }
        })
    }
    
    private var headerBar: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(loaded.title).font(.title2).bold().lineLimit(1)
                if let author = loaded.author, !author.isEmpty {
                    Text(author).font(.callout).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(action: { store.syncComic(comic: loaded) }) {
                Label("同步", systemImage: "arrow.triangle.2.circlepath")
            }
            Button(action: { store.toggleFavorite(comic: loaded)
                loaded.favorited = loaded.favorited == 1 ? 0 : 1
            }) {
                Label(loaded.favorited == 1 ? "已收藏" : "收藏", systemImage: loaded.favorited == 1 ? "heart.fill" : "heart")
                    .tint(loaded.favorited == 1 ? .pink : .accentColor)
            }
            Button(action: { showDownloadSheet = true }) {
                Label("下载", systemImage: "square.and.arrow.down")
            }
            Button(action: startReadLatest) {
                Label("开始阅读", systemImage: "book.fill")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }
    
    private var coverSection: some View {
        VStack(spacing: 12) {
            ZStack {
                if let img = coverImage {
                    Image(nsImage: img).resizable().scaledToFit()
                } else if coverFailed {
                    Rectangle().fill(
                        LinearGradient(colors: [.pink.opacity(0.4), .purple.opacity(0.4)],
                                      startPoint: .topLeading, endPoint: .bottomTrailing)
                    ).overlay {
                        VStack {
                            Image(systemName: "book").font(.system(size: 60)).foregroundStyle(.white.opacity(0.9))
                            Text(loaded.title.prefix(10)).font(.headline).foregroundStyle(.white)
                        }
                    }
                } else {
                    Rectangle().fill(Color.gray.opacity(0.12)).overlay { ProgressView() }
                }
            }
            .frame(width: 200, height: 280)
            .clipped().cornerRadius(12)
            .shadow(color: .black.opacity(0.12), radius: 8, y: 4)
            
            if loaded.chapterCount > 0 {
                VStack(spacing: 8) {
                    statRow(label: "章节", value: "\(loaded.chapterCount)")
                    statRow(label: "已下载", value: "\(downloadedRecords.count)")
                    if let s = loaded.status, !s.isEmpty { statRow(label: "状态", value: s) }
                    if let c = loaded.category, !c.isEmpty { statRow(label: "分类", value: c) }
                    if loaded.updateDelta > 0 {
                        statRow(label: "新章节", value: "+\(loaded.updateDelta)")
                            .foregroundStyle(.orange)
                    }
                }
                .padding(12)
                .frame(width: 200)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.gray.opacity(0.06)))
            }
        }
    }
    
    private var infoSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !tagsDisplay.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(tagsDisplay, id: \.self) { tag in
                        Text(tag)
                            .font(.system(size: 12))
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(Capsule().fill(Color.purple.opacity(0.12)))
                            .foregroundStyle(.purple)
                    }
                }
            }
            if let desc = loaded.descText, !desc.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("简介").font(.headline)
                    Text(desc)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .lineSpacing(5)
                        .lineLimit(8)
                }
            }
        }
        .padding(.trailing, 24).padding(.top, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    
    private var tagsDisplay: [String] {
        guard let t = loaded.tags, !t.isEmpty else { return [] }
        return t.split(whereSeparator: { " ，,、/;；".contains($0) }).map(String.init).filter { !$0.isEmpty }
    }
    
    private func statRow(label: String, value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption).bold()
        }
    }
    
    private var chapterSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("章节列表 (\(loaded.chapters.count))").font(.headline)
                Spacer()
                Picker("", selection: .constant(0)) {
                    Text("升序").tag(0)
                    Text("降序").tag(1)
                }
                .pickerStyle(.segmented)
                .frame(width: 110)
            }
            LazyVStack(spacing: 2) {
                ForEach(Array(loaded.chapters.enumerated()), id: \.element.id) { idx, ch in
                    let downloaded = downloadedRecords.contains(where: { $0.chapterIndex == idx })
                    Button(action: { readChapter(idx) }) {
                        HStack(spacing: 12) {
                            Text(String(format: "%04d", idx + 1))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 48, alignment: .leading)
                            Text(ch.name.isEmpty ? "第\(idx + 1)话" : ch.name)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if downloaded {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            } else if ch.imageCount > 0 {
                                Text("\(ch.imageCount)P")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Menu {
                                Button("阅读") { readChapter(idx) }
                                Button("下载本章") {
                                    store.downloadRange(comic: loaded, from: idx, to: idx)
                                }
                                Button("从本章下载到结尾") {
                                    store.downloadRange(comic: loaded, from: idx, to: loaded.chapters.count - 1)
                                }
                                Divider()
                                Button(role: .destructive, action: {
                                    if let folder = downloadedRecords.first(where: { $0.chapterIndex == idx })?.path {
                                        try? FileManager.default.removeItem(atPath: folder)
                                        refreshDownloaded()
                                    }
                                }) { Text("删除本地下载") }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .menuStyle(.borderlessButton)
                            .frame(width: 24)
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 12)
                        .contentShape(Rectangle())
                        .background(
                            RoundedRectangle(cornerRadius: 8)
                                .fill(downloaded ? Color.green.opacity(0.06) : Color.clear)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(downloaded ? Color.green.opacity(0.2) : Color.gray.opacity(0.08))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
    
    private var downloadSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("下载章节").font(.title2).bold()
            HStack {
                Stepper("从第 \(downloadFrom + 1) 话", value: $downloadFrom,
                        in: 0...max(0, loaded.chapters.count - 1))
                Stepper("到第 \(downloadTo + 1) 话", value: $downloadTo,
                        in: 0...max(0, loaded.chapters.count - 1))
            }
            HStack {
                Button("全部") {
                    downloadFrom = 0
                    downloadTo = max(0, loaded.chapters.count - 1)
                }
                Button("仅未下载") {
                    let uns = Set(downloadedRecords.map(\.chapterIndex))
                    let arr = loaded.chapters.indices.filter { !uns.contains($0) }.sorted()
                    if !arr.isEmpty { downloadFrom = arr[0]; downloadTo = arr.last! }
                }
                Button("最新10话") {
                    let total = loaded.chapters.count
                    downloadFrom = max(0, total - 10)
                    downloadTo = max(0, total - 1)
                }
                Spacer()
            }
            .buttonStyle(.bordered)
            
            HStack {
                Spacer()
                Button("取消") { showDownloadSheet = false }
                Button(action: confirmDownload) {
                    Label("加入下载队列", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.borderedProminent)
                .disabled(downloadFrom > downloadTo || loaded.chapters.isEmpty)
            }
        }
        .padding(22).frame(width: 520)
        .onAppear {
            downloadFrom = 0
            downloadTo = max(0, loaded.chapters.count - 1)
        }
    }
    
    private func confirmDownload() {
        store.downloadRange(comic: loaded, from: downloadFrom, to: downloadTo)
        showDownloadSheet = false
    }
    
    private func loadCover() {
        let localCover = loaded.localCover
        let sourceUrl = loaded.sourceUrl
        let coverUrl = loaded.cover
        let path = localCover ?? CacheManager.shared.getCoverLocalPath(sourceUrl: sourceUrl)
        if let path, let img = NSImage(contentsOfFile: path) { coverImage = img; return }
        guard let coverUrl else { coverFailed = true; return }
        Task.detached {
            do {
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: coverUrl, referer: sourceUrl)
                let img = NSImage(data: data)
                if let img {
                    try? CacheManager.shared.saveCover(data: data, sourceUrl: sourceUrl)
                    await MainActor.run { self.coverImage = img }
                } else { await MainActor.run { self.coverFailed = true } }
            } catch { await MainActor.run { self.coverFailed = true } }
        }
    }
    
    private func refreshDownloaded() {
        downloadedRecords = (try? ReadingRepository.shared.getDownloadRecords(comicId: loaded.id)) ?? []
    }
    
    private func readChapter(_ idx: Int) {
        let reader = ReaderStore.shared
        reader.open(comic: loaded, chapterIndex: idx)
        NotificationCenter.default.post(name: .switchTab, object: "reader")
    }
    
    private func startReadLatest() {
        let idx = max(0, loaded.chapters.count - 1)
        readChapter(idx)
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        let height = rows.reduce(0) { $0 + ($1.maxHeight ?? 0) + spacing } - spacing
        return CGSize(width: proposal.width ?? 300, height: max(0, height))
    }
    
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = computeRows(proposal: proposal, subviews: subviews)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for item in row.items {
                item.view.place(at: CGPoint(x: x, y: y),
                                proposal: ProposedViewSize(width: item.size.width, height: item.size.height))
                x += item.size.width + spacing
            }
            y += (row.maxHeight ?? 0) + spacing
        }
    }
    
    private struct Row {
        var items: [(view: LayoutSubview, size: CGSize)] = []
        var maxHeight: CGFloat?
    }
    
    private func computeRows(proposal: ProposedViewSize, subviews: Subviews) -> [Row] {
        let maxWidth = proposal.width ?? 300
        var rows: [Row] = [Row()]
        var currentX: CGFloat = 0
        for sv in subviews {
            let s = sv.sizeThatFits(.unspecified)
            if currentX + s.width > maxWidth && !rows[rows.count - 1].items.isEmpty {
                rows.append(Row())
                currentX = 0
            }
            rows[rows.count - 1].items.append((sv, s))
            let h = rows[rows.count - 1].maxHeight ?? 0
            rows[rows.count - 1].maxHeight = max(h, s.height)
            currentX += s.width + spacing
        }
        return rows
    }
}

extension Notification.Name {
    static let switchTab = Notification.Name("switchTab")
}