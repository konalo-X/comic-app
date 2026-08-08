import SwiftUI

@main
struct ComicApp: App {
    @StateObject private var appStore = AppStore.shared
    @StateObject private var jobQueue = JobQueue.shared
    @StateObject private var reader = ReaderStore.shared

    @State private var selection: Tab = .bookshelf
    @State private var showSettings = false

    enum Tab: String, Hashable, CaseIterable {
        case bookshelf = "bookshelf"
        case categories = "categories"
        case search = "search"
        case history = "history"
        case reader = "reader"
        case chapterMgr = "chapterMgr"
        case downloads = "downloads"
        case dataMgr = "dataMgr"
        case epub = "epub"
        case shortcuts = "shortcuts"
        case settings = "settings"

        var title: String {
            switch self {
            case .bookshelf: return "我的书架"
            case .categories: return "分类与标签"
            case .search: return "在线搜索"
            case .history: return "阅读历史"
            case .reader: return "阅读器"
            case .chapterMgr: return "章节管理"
            case .downloads: return "下载与任务"
            case .dataMgr: return "数据管理"
            case .epub: return "EPUB 生成"
            case .shortcuts: return "快捷键"
            case .settings: return "设置"
            }
        }

        var icon: String {
            switch self {
            case .bookshelf: return "books.vertical.fill"
            case .categories: return "tag.fill"
            case .search: return "magnifyingglass"
            case .history: return "clock.arrow.circlepath"
            case .reader: return "book"
            case .chapterMgr: return "list.number"
            case .downloads: return "square.and.arrow.down.on.square.fill"
            case .dataMgr: return "externaldrive.fill.badge.timemachine"
            case .epub: return "book.closed.fill"
            case .shortcuts: return "keyboard.fill"
            case .settings: return "gearshape.fill"
            }
        }
    }

    var body: some Scene {
        WindowGroup("漫快 ComicApp") {
            HSplitView {
                sidebar
                    .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)

                contentView
                    .frame(minWidth: 700, minHeight: 500)
            }
            .navigationTitle("漫快")
            .onReceive(NotificationCenter.default.publisher(for: .switchTab)) { n in
                if let t = n.object as? String, let tab = Tab(rawValue: t) {
                    selection = tab
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
                .keyboardShortcut("n", modifiers: .command)
            }
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            List(selection: $selection) {
                Section("主界面") {
                    sidebarItem(.bookshelf, badge: appStore.totalComics > 0 ? "\(appStore.totalComics)" : nil)
                    sidebarItem(.categories)
                    sidebarItem(.search)
                    sidebarItem(.history)
                    sidebarItem(.reader)
                }
                Section("内容管理") {
                    sidebarItem(.chapterMgr)
                    sidebarItem(.downloads, badge: jobQueue.stats.running + jobQueue.stats.pending > 0
                                ? "\(jobQueue.stats.running + jobQueue.stats.pending)"
                                : nil)
                    sidebarItem(.dataMgr)
                    sidebarItem(.epub)
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
                    sidebarItem(.shortcuts)
                    sidebarItem(.settings)
                }
            }
            .listStyle(.sidebar)

            Divider()
            statusFooter
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            .background(.ultraThinMaterial)
        }
    }

    private func sidebarItem(_ tab: Tab, badge: String? = nil) -> some View {
        Label(tab.title, systemImage: tab.icon)
            .tag(tab)
            .badge(badge)
    }

    @ViewBuilder
    private var contentView: some View {
        switch selection {
        case .bookshelf:
            BookshelfView().environmentObject(appStore)
        case .categories:
            CategoryMgrView().environmentObject(appStore)
        case .search:
            SearchView().environmentObject(appStore)
        case .history:
            ReadingHistoryView().environmentObject(appStore)
        case .reader:
            ReaderView()
                .environmentObject(appStore)
                .environmentObject(reader)
        case .chapterMgr:
            ChapterMgrView().environmentObject(appStore)
        case .downloads:
            DownloadPageView()
                .environmentObject(appStore)
                .environmentObject(jobQueue)
        case .dataMgr:
            DataManagerView().environmentObject(appStore)
        case .epub:
            EpubGenView().environmentObject(appStore)
        case .shortcuts:
            ShortcutsView()
        case .settings:
            SettingsView()
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

extension Notification.Name {
    static let switchTab = Notification.Name("switchTab")
}