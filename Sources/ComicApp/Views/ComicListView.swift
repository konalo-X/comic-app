import SwiftUI

struct ComicListView: View {
    @EnvironmentObject var store: AppStore
    @State private var results: [ComicSearchResult] = []
    @State private var isLoading = false
    @State private var errorMsg: String? = nil
    @State private var page = 1
    @State private var activeSort: SortMode = .latest
    @State private var selectedSource: String? = nil
    @State private var showAddURL = false
    @State private var newSourceUrl = ""
    
    enum SortMode: String, CaseIterable {
        case latest = "最新"
        case popular = "热门"
    }
    
    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            
            if isLoading && results.isEmpty {
                Spacer()
                ProgressView("正在加载漫画列表...")
                    .controlSize(.large)
                Spacer()
            } else if let e = errorMsg {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 48))
                        .foregroundStyle(.orange)
                    Text("加载失败").font(.title2).bold()
                    Text(e).foregroundStyle(.secondary)
                    Button("重试") { loadData() }
                        .buttonStyle(.borderedProminent)
                }
                Spacer()
            } else if results.isEmpty {
                Spacer()
                VStack(spacing: 16) {
                    Image(systemName: "globe")
                        .font(.system(size: 64))
                        .foregroundStyle(.secondary.opacity(0.4))
                    Text("暂无漫画数据")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("点击下方按钮从漫画源获取最新漫画列表")
                        .foregroundStyle(.tertiary)
                    
                    HStack(spacing: 12) {
                        Button(action: loadData) {
                            Label("加载热门", systemImage: "flame.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        
                        Button(action: { showAddURL = true }) {
                            Label("添加漫画URL", systemImage: "plus")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 170), spacing: 18)],
                        spacing: 18
                    ) {
                        ForEach(results) { r in
                            SearchResultCard(result: r) { add in
                                if add {
                                    store.addSync(sourceUrl: r.sourceUrl, priority: 7)
                                }
                            }
                            .contextMenu {
                                Button("添加到书架") {
                                    store.addSync(sourceUrl: r.sourceUrl, priority: 7)
                                }
                                Button("下载全部章节") {
                                    // TODO: implement download
                                }
                                Button("在浏览器打开") {
                                    if let u = URL(string: r.sourceUrl) {
                                        NSWorkspace.shared.open(u)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 18)
                    
                    paginationBar
                        .padding(.bottom, 20)
                }
            }
        }
        .sheet(isPresented: $showAddURL) {
            addUrlSheet
        }
        .onAppear {
            if results.isEmpty {
                loadData()
            }
        }
    }
    
    private var headerBar: some View {
        HStack(spacing: 12) {
            Picker("", selection: $activeSort) {
                ForEach(SortMode.allCases, id: \.self) { mode in
                    Text(mode.rawValue).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 160)
            .onChange(of: activeSort) { _, _ in
                page = 1
                loadData()
            }
            
            Picker("来源", selection: $selectedSource) {
                Text("全部来源").tag(Optional<String>.none)
                ForEach(SourceRegistry.shared.listInfos(), id: \.id) { info in
                    Text(info.name).tag(Optional(info.id))
                }
            }
            .frame(width: 180)
            .onChange(of: selectedSource) { _, _ in
                page = 1
                loadData()
            }
            
            Spacer()
            
            Text("\(results.count) 个结果")
                .font(.callout)
                .foregroundStyle(.secondary)
            
            Button(action: { showAddURL = true }) {
                Label("添加", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.borderedProminent)
            
            Button(action: loadData) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
    
    private var paginationBar: some View {
        HStack(spacing: 8) {
            Button(action: { page = max(1, page - 1); loadData() }) {
                Image(systemName: "chevron.left")
            }
            .disabled(page <= 1)
            .buttonStyle(.bordered)
            
            Text("第 \(page) 页")
                .font(.callout)
                .monospacedDigit()
            
            Button(action: { page += 1; loadData() }) {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.bordered)
            
            Spacer()
        }
        .padding(.horizontal, 20)
    }
    
    private var addUrlSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("添加漫画").font(.title2).bold()
            Text("粘贴漫画详情页 URL，系统会自动抓取详情与章节列表")
                .foregroundStyle(.secondary)
            
            TextField("例如 https://www.smtt6.com/comic/xxx", text: $newSourceUrl)
                .textFieldStyle(.roundedBorder)
                .onSubmit(confirmAdd)
            
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
    
    private func loadData() {
        isLoading = true
        errorMsg = nil
        Task {
            do {
                let list: [ComicSearchResult]
                if let sid = selectedSource, let source = SourceRegistry.shared.get(id: sid) {
                    switch activeSort {
                    case .popular:
                        list = try await source.getPopular(page: page)
                    case .latest:
                        list = try await source.getLatest(page: page)
                    }
                } else {
                    var all: [ComicSearchResult] = []
                    for info in SourceRegistry.shared.listInfos() {
                        guard let source = SourceRegistry.shared.get(id: info.id) else { continue }
                        do {
                            let results = try await (activeSort == .popular
                                ? source.getPopular(page: page)
                                : source.getLatest(page: page))
                            all.append(contentsOf: results)
                        } catch { continue }
                    }
                    list = all
                }
                await MainActor.run {
                    self.results = list
                    self.isLoading = false
                }
            } catch {
                await MainActor.run {
                    self.errorMsg = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
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

struct SearchResultCard: View {
    let result: ComicSearchResult
    let onAction: (Bool) -> Void
    @State private var coverImage: NSImage? = nil
    @State private var loadFailed = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let img = coverImage {
                        Image(nsImage: img)
                            .resizable()
                            .scaledToFill()
                    } else if loadFailed {
                        Rectangle()
                            .fill(LinearGradient(
                                colors: [Color.blue.opacity(0.3), Color.purple.opacity(0.3)],
                                startPoint: .topLeading, endPoint: .bottomTrailing
                            ))
                            .overlay {
                                VStack(spacing: 4) {
                                    Image(systemName: "book")
                                        .font(.system(size: 36))
                                        .foregroundStyle(.white.opacity(0.8))
                                    Text(result.title.prefix(6))
                                        .font(.caption2)
                                        .foregroundStyle(.white)
                                        .lineLimit(1)
                                }
                            }
                    } else {
                        Rectangle()
                            .fill(Color.gray.opacity(0.15))
                            .overlay { ProgressView().scaleEffect(0.7) }
                    }
                }
                .frame(width: 160, height: 220)
                .clipped()
                .cornerRadius(10)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.gray.opacity(0.15), lineWidth: 1)
                )
                
                Button(action: { onAction(true) }) {
                    Image(systemName: "plus.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                }
                .buttonStyle(.plain)
                .padding(8)
            }
            
            Text(result.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(2)
                .frame(height: 34, alignment: .topLeading)
            
            if let author = result.author, !author.isEmpty {
                Text(author)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            
            if let last = result.lastChapter, !last.isEmpty {
                Text(last)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .frame(width: 160)
        .onAppear(perform: loadCover)
    }
    
    private func loadCover() {
        guard let urlStr = result.cover, let _ = URL(string: urlStr) else {
            loadFailed = true
            return
        }
        Task.detached {
            do {
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: urlStr, referer: result.sourceUrl)
                if let img = NSImage(data: data) {
                    await MainActor.run { self.coverImage = img }
                } else {
                    await MainActor.run { self.loadFailed = true }
                }
            } catch {
                await MainActor.run { self.loadFailed = true }
            }
        }
    }
}