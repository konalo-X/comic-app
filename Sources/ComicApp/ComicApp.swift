import SwiftUI

@main
struct ComicApp: App {
    @StateObject private var appStore = AppStore.shared
    @StateObject private var jobQueue = JobQueue.shared
    @StateObject private var reader = ReaderStore.shared
    
    @State private var selection: Tab = .bookshelf
    @State private var columnVisibility: NavigationSplitViewVisibility = .doubleColumn
    @State private var showSettings = false
    
    enum Tab: Hashable {
        case bookshelf, categories, search, discover, reading, chapterMgr, dataMgr, epub, reader, downloads, history, shortcuts, settings
    }
    
    var body: some Scene {
        WindowGroup("漫快 ComicApp") {
            NavigationSplitView(columnVisibility: $columnVisibility) {
                sidebar
                    .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 300)
            } detail: {
                Group {
                    switch selection {
                    case .bookshelf:
                        BookshelfView().environmentObject(appStore)
                    case .categories:
                        CategoryMgrView().environmentObject(appStore)
                    case .search, .discover:
                        SearchView().environmentObject(appStore)
                    case .chapterMgr:
                        ChapterMgrView().environmentObject(appStore)
                    case .dataMgr:
                        DataManagerView().environmentObject(appStore)
                    case .epub:
                        EpubGenView().environmentObject(appStore)
                    case .reading, .reader:
                        ReaderView()
                            .environmentObject(appStore)
                            .environmentObject(reader)
                    case .downloads:
                        DownloadPageView()
                            .environmentObject(appStore)
                            .environmentObject(jobQueue)
                    case .history:
                        ReadingHistoryView().environmentObject(appStore)
                    case .shortcuts:
                        ShortcutsView()
                    case .settings:
                        SettingsView()
                    }
                }
                .navigationSplitViewColumnWidth(min: 600, ideal: 1100)
            }
            .navigationTitle("漫快")
            .onReceive(NotificationCenter.default.publisher(for: .switchTab)) { n in
                if let t = n.object as? String {
                    switch t {
                    case "bookshelf": selection = .bookshelf
                    case "reader", "reading": selection = .reader
                    case "downloads": selection = .downloads
                    case "history": selection = .history
                    case "chapterMgr": selection = .chapterMgr
                    case "dataMgr": selection = .dataMgr
                    case "epub": selection = .epub
                    case "shortcuts": selection = .shortcuts
                    case "settings": selection = .settings
                    default: break
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .startReading)) { n in
                if let comic = n.object as? Comic {
                    reader.open(comic: comic, chapterIndex: max(0, comic.chapters.count - 1))
                    selection = .reader
                }
            }
            .task {
                do {
                    try DatabaseManager.shared.initialize()
                    SourceRegistry.shared.register(source: Smtt6Source())
                    SourceRegistry.shared.register(source: ManhuaguiSource())
                    SourceRegistry.shared.register(source: CopymangaSource())
                    let info = SourceRegistry.shared.listInfos()
                    print("[Source] 已注册 \(info.count) 个漫画源")
                    appStore.refresh()
                    jobQueue.start()
                    try? await jobQueue.startupEnrichIfNeeded()
                } catch {
                    print("初始化失败: \(error)")
                }
            }
            .keyboardShortcut(.defaultAction)
        }
        .windowStyle(.titleBar)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appSettings) {
                Button("刷新书架") { appStore.refresh() }
                    .keyboardShortcut("r")
                Button("同步全部") { appStore.syncAll() }
                    .keyboardShortcut("y", modifiers: .command)
                Button("停止所有任务") { JobQueue.shared.cancelAll() }
                Button("导出设置...") { showSettings = true; selection = .settings }
            }
            CommandGroup(after: .newItem) {
                Button("添加漫画URL...") {
                    NotificationCenter.default.post(name: NSNotification.Name("TriggerAddComic"), object: nil)
                }
                .keyboardShortcut("l")
            }
        }
    }
    
    private var sidebar: some View {
        List(selection: $selection) {
            Section("主界面") {
                Label("我的书架", systemImage: "books.vertical.fill")
                    .tag(Tab.bookshelf)
                    .badge(appStore.totalComics > 0 ? "\(appStore.totalComics)" : nil)
                Label("分类与标签", systemImage: "tag.fill")
                    .tag(Tab.categories)
                Label("在线搜索", systemImage: "magnifyingglass")
                    .tag(Tab.search)
                Label("阅读历史", systemImage: "clock.arrow.circlepath")
                    .tag(Tab.history)
                Label("阅读器", systemImage: "book")
                    .tag(Tab.reader)
            }
            Section("内容管理") {
                Label("章节管理", systemImage: "list.number")
                    .tag(Tab.chapterMgr)
                Label("下载与任务", systemImage: "square.and.arrow.down.on.square.fill")
                    .tag(Tab.downloads)
                    .badge(jobQueue.stats.running + jobQueue.stats.pending > 0
                           ? "\(jobQueue.stats.running + jobQueue.stats.pending)"
                           : nil)
                Label("数据管理", systemImage: "externaldrive.fill.badge.timemachine")
                    .tag(Tab.dataMgr)
                Label("EPUB 生成", systemImage: "book.closed.fill")
                    .tag(Tab.epub)
            }
            Section("漫画源") {
                ForEach(SourceRegistry.shared.listInfos(), id: \.id) { info in
                    HStack(spacing: 8) {
                        Image(systemName: "globe")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(info.name).font(.system(size: 13))
                            Text(info.host).font(.caption2).foregroundStyle(.tertiary)
                        }
                        Spacer()
                        if info.default {
                            Image(systemName: "star.fill")
                                .foregroundStyle(.yellow)
                                .font(.caption2)
                        }
                    }
                    .help(info.description ?? "")
                }
            }
            Section("系统") {
                Label("快捷键", systemImage: "keyboard.fill")
                    .tag(Tab.shortcuts)
                Label("设置", systemImage: "gearshape.fill")
                    .tag(Tab.settings)
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                Divider()
                statusFooter
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .background(.ultraThinMaterial)
        }
    }
    
    private var statusFooter: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(jobQueue.stats.running > 0 ? Color.blue : Color.green)
                .frame(width: 7, height: 7)
                .shadow(color: (jobQueue.stats.running > 0 ? Color.blue : Color.green).opacity(0.5), radius: 2)
            VStack(alignment: .leading, spacing: 1) {
                Text(jobQueue.stats.running > 0 ? "运行中" : "空闲")
                    .font(.system(size: 11, weight: .semibold))
                Text("队列 \(jobQueue.stats.running + jobQueue.stats.pending) · 失败 \(jobQueue.stats.failed)")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text("DB: \(appStore.totalComics) 本")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                Text("书架 \(appStore.currentPage)/\(appStore.totalPages)")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}