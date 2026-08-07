import SwiftUI
import AppKit

struct SettingsView: View {
    @State private var cacheSize: Int64 = 0
    @State private var downloads: [DownloadRecord] = []
    @State private var history: [ReadingProgress] = []
    @State private var showCacheAlert = false
    @State private var showDbAlert = false
    
    var body: some View {
        TabView {
            generalTab.tabItem { Label("通用", systemImage: "gearshape") }
            dataTab.tabItem { Label("数据管理", systemImage: "externaldrive.badge.timemachine") }
            historyTab.tabItem { Label("阅读历史", systemImage: "clock.arrow.circlepath") }
            shortcutsTab.tabItem { Label("快捷键", systemImage: "command") }
            aboutTab.tabItem { Label("关于", systemImage: "info.circle") }
        }
        .frame(minWidth: 700, minHeight: 500)
        .padding()
        .onAppear(perform: refresh)
    }
    
    private var generalTab: some View {
        Form {
            Section("应用") {
                LabeledContent("版本") { Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0 (Swift)") }
                LabeledContent("数据库") {
                    Text(DatabaseManager.shared.getDBPath())
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Button("打开位置") {
                        NSWorkspace.shared.activateFileViewerSelecting([
                            URL(fileURLWithPath: DatabaseManager.shared.getDBPath())
                        ])
                    }
                }
                LabeledContent("下载目录") {
                    Text(CacheManager.shared.getDownloadsDir().path)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                    Button("打开") {
                        NSWorkspace.shared.open(CacheManager.shared.getDownloadsDir())
                    }
                }
            }
            Section("缓存") {
                LabeledContent("当前缓存大小") {
                    Text(byteFormatter.string(fromByteCount: cacheSize))
                        .monospacedDigit()
                    Button("清理 30 天前") {
                        try? CacheManager.shared.clearCache(olderThan: 30)
                        refresh()
                    }
                    Button("全部清理", role: .destructive) { showCacheAlert = true }
                        .alert("确认清理所有缓存？", isPresented: $showCacheAlert) {
                            Button("取消", role: .cancel) {}
                            Button("确认清理", role: .destructive) {
                                try? CacheManager.shared.clearCache(olderThan: 0)
                                refresh()
                            }
                        } message: {
                            Text("这将删除所有已缓存的封面、图片和章节列表数据，但不会删除下载到本地的漫画文件。")
                        }
                }
            }
            Section("数据") {
                LabeledContent("已下载章节") { Text("\(downloads.count) 章") }
                LabeledContent("已安装源站") {
                    HStack(spacing: 6) {
                        ForEach(SourceRegistry.shared.listInfos(), id: \.id) { s in
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                                Text(s.name)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Capsule().fill(Color.green.opacity(0.1)))
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
    
    private var dataTab: some View {
        VStack(spacing: 12) {
            HStack {
                Text("导出 / 数据管理").font(.title2).bold()
                Spacer()
                Button("刷新") { refresh() }
            }
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(groupedDownloads.keys.sorted(), id: \.self) { title in
                        exportGroup(title: title, records: groupedDownloads[title] ?? [])
                    }
                    if groupedDownloads.isEmpty {
                        VStack(spacing: 10) {
                            Image(systemName: "archivebox").font(.system(size: 48)).foregroundStyle(.secondary.opacity(0.4))
                            Text("暂无已下载的漫画")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 60)
                    }
                }
            }
            Divider()
            HStack {
                Button("导出数据库", role: .destructive) {
                    let panel = NSSavePanel()
                    panel.allowedContentTypes = [.data]
                    panel.nameFieldStringValue = "comics_\(ISO8601DateFormatter().string(from: Date()).prefix(10)).sqlite"
                    if panel.runModal() == .OK, let url = panel.url {
                        try? FileManager.default.copyItem(
                            atPath: DatabaseManager.shared.getDBPath(),
                            toPath: url.path
                        )
                    }
                }
                Button("重建数据库索引") {
                    Task { try? DatabaseManager.shared.initialize() }
                }
                Spacer()
                Button("危险：清空所有数据", role: .destructive) { showDbAlert = true }
                    .alert("危险操作", isPresented: $showDbAlert) {
                        Button("取消", role: .cancel) {}
                        Button("确认清空所有数据（漫画/章节/进度/下载记录）", role: .destructive) {
                            NotificationCenter.default.post(name: Notification.Name("NukeDatabase"), object: nil)
                        }
                    }
            }
        }
        .padding()
    }
    
    private var groupedDownloads: [String: [DownloadRecord]] {
        Dictionary(grouping: downloads, by: { $0.comicTitle }).mapValues { $0.sorted(by: { $0.chapterIndex < $1.chapterIndex }) }
    }
    
    private func exportGroup(title: String, records: [DownloadRecord]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text("\(records.count) 章已下载").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("打开文件夹") {
                    let folder = CacheManager.shared.getComicDownloadDir(title: title)
                    NSWorkspace.shared.open(folder)
                }
                Menu {
                    Button("导出 CBZ（单文件整本）") {
                        Task {
                            do {
                                let url = try await ExportService.shared.toCBZ(comicTitle: title)
                                NSWorkspace.shared.activateFileViewerSelecting([url])
                            } catch {
                                presentError(error)
                            }
                        }
                    }
                    Button("导出 EPUB（移动端阅读）") {
                        Task {
                            do {
                                let url = try await ExportService.shared.toEPUB(comicTitle: title)
                                NSWorkspace.shared.activateFileViewerSelecting([url])
                            } catch {
                                presentError(error)
                            }
                        }
                    }
                    Divider()
                    ForEach(records) { rec in
                        Button("CBZ：\(rec.chapterName)（\(rec.imagesCount)P）") {
                            do {
                                let url = try ExportService.shared.toCBZ(fromDownload: rec)
                                NSWorkspace.shared.activateFileViewerSelecting([url])
                            } catch {
                                presentError(error)
                            }
                        }
                    }
                } label: {
                    Label("导出", systemImage: "square.and.arrow.up")
                }
                .fixedSize()
            }
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(records.prefix(12)) { rec in
                        ChapterThumb(rec: rec)
                    }
                    if records.count > 12 {
                        Text("+ \(records.count - 12)")
                            .frame(width: 80, height: 100)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.1)))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.gray.opacity(0.05)))
    }
    
    private var historyTab: some View {
        VStack(spacing: 12) {
            HStack {
                Text("阅读历史").font(.title2).bold()
                Spacer()
                Text("最近 \(history.count) 条")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if history.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "book.closed")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary.opacity(0.4))
                    Text("暂无阅读记录")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(history) { p in
                            HStack {
                                Image(systemName: "book.fill")
                                    .foregroundStyle(Color.accentColor)
                                    .frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(comicTitle(for: p.comicId))
                                        .font(.body).bold().lineLimit(1)
                                    Text("第 \(p.chapterIndex + 1) 话 · 第 \(p.pageIndex + 1)/\(max(1, p.totalPages)) 页 · \(String(format: "%.0f%%", p.progress * 100))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(dateFormatter.string(from: Date(timeIntervalSince1970: Double(p.updatedAt) / 1000.0)))
                                    .font(.caption2).foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 6).padding(.horizontal, 10)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.04)))
                        }
                    }
                }
            }
        }
        .padding()
    }
    
    private func comicTitle(for id: String) -> String {
        (try? ComicRepository.shared.get(id: id))?.title ?? "(未知漫画) #\(id.prefix(6))"
    }
    
    private var shortcutsTab: some View {
        List {
            Section("阅读器") {
                shortcutRow(keys: ["←", "→"], label: "翻前 / 翻后一页")
                shortcutRow(keys: ["↑", "↓"], label: "翻前 / 翻后一页")
                shortcutRow(keys: ["Space"], label: "下一页")
                shortcutRow(keys: ["双击"], label: "翻页模式下翻页")
                shortcutRow(keys: ["左右滑动"], label: "翻页模式下前后翻页（可配置方向）")
                shortcutRow(keys: ["长按"], label: "显示/隐藏阅读控制栏")
            }
            Section("全局") {
                shortcutRow(keys: ["⌘", "L"], label: "添加漫画")
                shortcutRow(keys: ["⌘", "F"], label: "聚焦搜索框")
                shortcutRow(keys: ["⌘", "R"], label: "刷新列表")
            }
        }
        .listStyle(.sidebar)
    }
    
    private func shortcutRow(keys: [String], label: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            HStack(spacing: 4) {
                ForEach(keys, id: \.self) { k in
                    Text(k).font(.caption.monospaced())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 5).fill(Color.gray.opacity(0.15)))
                }
            }
        }
    }
    
    private var aboutTab: some View {
        VStack(spacing: 18) {
            Image(systemName: "book.circle.fill")
                .font(.system(size: 86))
                .foregroundStyle(.purple)
            VStack(spacing: 4) {
                Text("ComicApp (Swift)").font(.title2).bold()
                Text("版本 1.0.0 · macOS")
                Text("使用 Swift + SwiftUI + SQLite.swift 重构")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Text("原生 macOS 漫画阅读器 · 支持多源爬取 · 章节下载 · CBZ/EPUB 导出 · 本地书架")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private let byteFormatter: ByteCountFormatter = {
        let f = ByteCountFormatter()
        f.countStyle = .binary
        return f
    }()
    
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "M/d HH:mm"
        return f
    }()
    
    private func refresh() {
        cacheSize = CacheManager.shared.cacheSize()
        downloads = (try? ReadingRepository.shared.listDownloadRecords()) ?? []
        history = (try? ReadingRepository.shared.recentHistory(limit: 200)) ?? []
    }
    
    private func presentError(_ err: Error) {
        DispatchQueue.main.async {
            let a = NSAlert()
            a.messageText = "导出失败"
            a.informativeText = err.localizedDescription
            a.alertStyle = .warning
            a.addButton(withTitle: "OK")
            a.runModal()
        }
    }
}

struct ChapterThumb: View {
    let rec: DownloadRecord
    @State private var image: NSImage?
    
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let img = image {
                Image(nsImage: img)
                    .resizable().scaledToFill()
                    .frame(width: 80, height: 100).clipped().cornerRadius(8)
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(
                        LinearGradient(colors: [.purple.opacity(0.3), .blue.opacity(0.3)],
                                      startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .frame(width: 80, height: 100)
            }
            VStack(alignment: .leading) {
                Text("\(rec.imagesCount)P")
                    .font(.caption2).bold().foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(.black.opacity(0.6)))
            }
            .padding(5)
        }
        .onAppear(perform: load)
        .help(rec.chapterName)
    }
    
    private func load() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: rec.path).sorted(),
              let first = files.first(where: { ["jpg","jpeg","png","webp","gif","bmp"].contains(($0 as NSString).pathExtension.lowercased()) }) else { return }
        let url = URL(fileURLWithPath: rec.path).appendingPathComponent(first)
        image = NSImage(contentsOf: url)
    }
}