import SwiftUI

struct BookshelfView: View {
    @EnvironmentObject var store: AppStore
    @State private var showDetail = false
    @State private var showAddURL = false
    @State private var newSourceUrl = ""
    
    private let columns = [GridItem(.adaptive(minimum: 170), spacing: 18)]
    
    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            ScrollView {
                if store.comics.isEmpty && !store.isLoading {
                    emptyState.padding(.top, 80)
                } else {
                    LazyVGrid(columns: columns, spacing: 20) {
                        ForEach(store.comics) { comic in
                            ComicCardView(
                                comic: comic,
                                onTap: {
                                    store.selectedComic = comic
                                    store.loadComic(id: comic.id)
                                    showDetail = true
                                },
                                onFavorite: { store.toggleFavorite(comic: comic) }
                            )
                            .contextMenu {
                                Button("开始阅读") {
                                    store.selectedComic = comic
                                    store.loadComic(id: comic.id)
                                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                        NotificationCenter.default.post(name: .startReading, object: comic)
                                    }
                                }
                                Button("同步信息") { store.syncComic(comic: comic) }
                                Button("下载全部") { store.downloadAll(comic: comic) }
                                Divider()
                                Button(comic.favorited == 1 ? "取消收藏" : "加入收藏") {
                                    store.toggleFavorite(comic: comic)
                                }
                                Divider()
                                Button("删除", role: .destructive) { store.delete(comic: comic) }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 18)
                    
                    if store.totalPages > 1 {
                        paginationBar.padding(.bottom, 20)
                    }
                }
            }
        }
        .sheet(isPresented: $showDetail) {
            if let comic = store.selectedComic {
                ComicDetailView(comic: comic)
                    .frame(minWidth: 820, minHeight: 620)
            }
        }
        .sheet(isPresented: $showAddURL) {
            addUrlSheet
        }
    }
    
    private var topBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索标题/作者/标签...", text: $store.searchText, onCommit: {
                    store.applySearch(store.searchText)
                })
                .textFieldStyle(.plain)
                if !store.searchText.isEmpty {
                    Button(action: {
                        store.searchText = ""
                        store.applySearch("")
                    }) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }.buttonStyle(.plain)
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
            .frame(maxWidth: 380)
            
            Picker("", selection: $store.filterFavorited) {
                Text("全部").tag(Optional<Bool>.none)
                Text("收藏").tag(Optional<Bool>(true))
                Text("未收藏").tag(Optional<Bool>(false))
            }
            .pickerStyle(.segmented)
            .frame(width: 170)
            .onChange(of: store.filterFavorited) { _, v in store.applyFavoriteFilter(v) }
            
            Picker("", selection: Binding(
                get: { store.filterCategory ?? "" },
                set: { v in store.applyCategoryFilter(v.isEmpty ? nil : v) }
            )) {
                Text("全部分类").tag("")
                ForEach(store.categories, id: \.self) { Text($0).tag($0) }
            }
            .frame(width: 160)
            
            Spacer()
            
            Menu {
                Button("更新时间 ↓", action: { store.applySort(by: "updatedAt", desc: true) })
                Button("更新时间 ↑", action: { store.applySort(by: "updatedAt", desc: false) })
                Button("创建时间 ↓", action: { store.applySort(by: "createdAt", desc: true) })
                Button("章节数 ↓", action: { store.applySort(by: "chapter_count", desc: true) })
                Button("标题 A-Z", action: { store.applySort(by: "title", desc: false) })
            } label: {
                Label("排序", systemImage: "arrow.up.arrow.down")
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            
            Button(action: { showAddURL = true }) {
                Label("添加漫画", systemImage: "plus.circle.fill")
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            
            Button(action: store.refresh) {
                Image(systemName: "arrow.clockwise")
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
    
    private var paginationBar: some View {
        HStack(spacing: 8) {
            Button(action: { store.setPage(1) }) {
                Image(systemName: "chevron.left.2")
            }
            .disabled(store.currentPage == 1)
            .buttonStyle(.bordered)
            
            Button(action: { store.setPage(store.currentPage - 1) }) {
                Image(systemName: "chevron.left")
            }
            .disabled(store.currentPage == 1)
            .buttonStyle(.bordered)
            
            Group {
                let range = paginationRange
                ForEach(range, id: \.self) { p in
                    Button("\(p)") { store.setPage(p) }
                        .buttonStyle(.borderedProminent)
                        .tint(p == store.currentPage ? .accentColor : .gray)
                }
            }
            
            Button(action: { store.setPage(store.currentPage + 1) }) {
                Image(systemName: "chevron.right")
            }
            .disabled(store.currentPage == store.totalPages)
            .buttonStyle(.bordered)
            
            Button(action: { store.setPage(store.totalPages) }) {
                Image(systemName: "chevron.right.2")
            }
            .disabled(store.currentPage == store.totalPages)
            .buttonStyle(.bordered)
            
            Text("共 \(store.totalComics) 本 · 第 \(store.currentPage)/\(store.totalPages) 页")
                .font(.callout).foregroundStyle(.secondary)
                .padding(.leading, 10)
        }
    }
    
    private var paginationRange: [Int] {
        let t = store.totalPages
        let c = store.currentPage
        var r = Set<Int>()
        r.insert(1); r.insert(t)
        for i in c-2...c+2 where i > 0 && i <= t { r.insert(i) }
        return r.sorted()
    }
    
    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "books.vertical")
                .font(.system(size: 72))
                .foregroundStyle(.secondary.opacity(0.6))
            VStack(spacing: 8) {
                Text("书架还空着")
                    .font(.title2).bold()
                Text("点击右上角「添加漫画」输入详情页 URL，或使用搜索发现新漫画")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }
            Button(action: { showAddURL = true }) {
                Label("添加第一本漫画", systemImage: "plus.circle.fill")
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 18).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
        }
    }
    
    private var addUrlSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("添加漫画").font(.title2).bold()
            Text("粘贴漫画详情页 URL，系统会自动抓取详情与章节列表")
                .foregroundStyle(.secondary)
            
            TextField("例如 https://www.smtt6.com/comic/xxx", text: $newSourceUrl)
                .textFieldStyle(.roundedBorder)
                .onSubmit(confirmAdd)
            
            HStack(spacing: 10) {
                Text("支持的站点：")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                ForEach(SourceRegistry.shared.listInfos(), id: \.id) { info in
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        Text(info.name)
                    }
                    .font(.callout)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Capsule().fill(Color.green.opacity(0.1)))
                }
            }
            
            HStack {
                Spacer()
                Button("取消") { showAddURL = false }
                .keyboardShortcut(.cancelAction)
                Button(action: confirmAdd) {
                    Label("开始抓取", systemImage: "arrow.down.circle.fill")
                }
                .keyboardShortcut(.defaultAction)
                .disabled(newSourceUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(22)
        .frame(width: 560)
    }
    
    private func confirmAdd() {
        let url = newSourceUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return }
        store.addSync(sourceUrl: url, priority: 9)
        newSourceUrl = ""
        showAddURL = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            store.refresh()
        }
    }
}

extension Notification.Name {
    static let startReading = Notification.Name("startReading")
}