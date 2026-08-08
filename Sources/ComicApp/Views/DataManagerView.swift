import SwiftUI
import ZIPFoundation

struct DataManagerView: View {
    @EnvironmentObject var app: AppStore
    @State private var totalSize: Int64 = 0
    @State private var cacheSize: Int64 = 0
    @State private var downloadsSize: Int64 = 0
    @State private var dbSize: Int64 = 0
    @State private var isLoading = true
    @State private var progressText = ""
    @State private var showSuccessAlert = false
    @State private var alertMsg = ""
    
    var body: some View {
        Form {
            Section("存储概览") {
                HStack {
                    Image(systemName: "chart.pie.fill").font(.largeTitle).foregroundStyle(.blue)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("共占用 \(ByteCountFormatter.string(fromByteCount: totalSize, countStyle: .file))")
                            .font(.title2.weight(.bold))
                        Text("数据库 · 缓存 · 下载文件 · 缩略图").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(action: reload) {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .disabled(isLoading)
                }
                .padding(.vertical, 6)
                
                storageRow(icon: "tray.fill", title: "下载文件 (CBZ)", desc: "已下载的漫画章节包",
                          size: downloadsSize, color: .green)
                storageRow(icon: "photo.on.rectangle.angled", title: "图片缓存",
                          desc: "HTTP 缓存 & 缩略图", size: cacheSize, color: .orange)
                storageRow(icon: "database.fill", title: "SQLite 数据库",
                          desc: "comics.sqlite (含WAL/SHM)", size: dbSize, color: .purple)
                let other = max(0, totalSize - cacheSize - downloadsSize - dbSize)
                storageRow(icon: "shippingbox", title: "其他 (杂项)", desc: "Log / 临时文件",
                          size: other, color: .gray)
            }
            
            Section("备份与恢复") {
                HStack {
                    Label { Text("一键备份") } icon: { Image(systemName: "arrow.up.doc.fill").foregroundStyle(.blue) }
                    Spacer()
                    Button("导出 ZIP 备份") { exportBackup() }
                        .buttonStyle(.borderedProminent)
                }
                HStack {
                    Label { Text("从备份恢复") } icon: { Image(systemName: "arrow.down.doc.fill").foregroundStyle(.green) }
                    Spacer()
                    Button("导入 ZIP 备份") { importBackup() }
                        .buttonStyle(.bordered)
                }
                HStack {
                    Label { Text("迁移旧数据") } icon: { Image(systemName: "tray.and.arrow.up.fill").foregroundStyle(.orange) }
                    Spacer()
                    Button("扫描 Electron 项目 DB") { migrateFromElectron() }
                        .buttonStyle(.bordered)
                }
            }
            
            Section("清理与优化") {
                HStack {
                    Label { Text("清除图片缓存") } icon: { Image(systemName: "photo.badge.arrow.down.fill").foregroundStyle(.orange) }
                    Spacer()
                    Text("\(ByteCountFormatter.string(fromByteCount: cacheSize, countStyle: .file))")
                        .foregroundStyle(.secondary)
                    Button("清理") { clearCache() }
                        .buttonStyle(.bordered).tint(.orange)
                }
                HStack {
                    Label { Text("清理未完成下载 (.tmp)") } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                    Spacer()
                    Button("清理") { clearTempDownloads() }
                        .buttonStyle(.bordered).tint(.red)
                }
                HStack {
                    Label { Text("重建全文索引 (FTS5)") } icon: { Image(systemName: "magnifyingglass.circle.fill").foregroundStyle(.purple) }
                    Spacer()
                    Button("重建") { rebuildFTS() }
                        .buttonStyle(.bordered)
                }
                HStack {
                    Label { Text("数据库 VACUUM") } icon: { Image(systemName: "arrow.up.arrow.down.circle.fill").foregroundStyle(.indigo) }
                    Spacer()
                    Text("\(ByteCountFormatter.string(fromByteCount: dbSize, countStyle: .file))")
                        .foregroundStyle(.secondary)
                    Button("压缩") { vacuumDB() }
                        .buttonStyle(.bordered)
                }
            }
            
            if !progressText.isEmpty {
                Section("上次扫描") {
                    Text(progressText).font(.caption).foregroundStyle(.secondary)
                }
            }
            
            if !app.isBusyText.isEmpty {
                Section("后台运行") {
                    Label(app.isBusyText, systemImage: "gearshape.arrow.triangle.2.circlepath")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("数据管理")
        .task { reload() }
        .alert(alertMsg, isPresented: $showSuccessAlert) {
            Button("好", role: .cancel) {}
        }
    }
    
    private func storageRow(icon: String, title: String, desc: String, size: Int64, color: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(color)
                .font(.title3).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body)
                Text(desc).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))
                    .font(.body.weight(.semibold))
                if totalSize > 0 {
                    Text(String(format: "%.1f %%", Double(size) / Double(totalSize) * 100))
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
    
    private func dirSize(_ url: URL) -> Int64 {
        let fm = FileManager.default
        guard let en = fm.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles]) else { return 0 }
        var total: Int64 = 0
        for f in en {
                            guard let f = f as? URL else { continue }
            if let s = try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize { total += Int64(s) }
        }
        return total
    }
    
    private func fileSize(_ path: String) -> Int64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return Int64(attrs?[.size] as? Int ?? 0)
    }
    
    private func reload() {
        isLoading = true
        Task {
            let fm = FileManager.default
            let supportDir = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            let base = supportDir?.appendingPathComponent("ComicApp", isDirectory: true) ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads/ComicApp")
            
            let dl = base
            let cache = supportDir?.appendingPathComponent("ComicApp/Cache", isDirectory: true) ?? URL(fileURLWithPath: NSTemporaryDirectory())
            
            var dSize: Int64 = 0
            if fm.fileExists(atPath: dl.path) {
                for suffix in ["", "-images"] { dSize += dirSize(URL(fileURLWithPath: dl.path + suffix)) }
            }
            let cSize = dirSize(cache)
            
            let dbMgr = DatabaseManager.shared
            let dbPath = dbMgr.dbPath
            var dB: Int64 = fileSize(dbPath)
            for s in ["-wal", "-shm"] { dB += fileSize(dbPath + s) }
            
            let total = dSize + cSize + dB + dirSize(supportDir ?? URL(fileURLWithPath: NSHomeDirectory()))
            
            await MainActor.run {
                self.downloadsSize = dSize
                self.cacheSize = cSize
                self.dbSize = dB
                self.totalSize = total
                self.isLoading = false
                self.progressText = Date().formatted(date: .omitted, time: .standard)
            }
        }
    }
    
    private func showMsg(_ s: String) {
        alertMsg = s
        showSuccessAlert = true
    }
    
    private nonisolated func zipDirectory(source: URL, destination: URL) throws {
        guard let archive = Archive(url: destination, accessMode: .create) else {
            throw NSError(domain: "DataManager", code: 500, userInfo: [NSLocalizedDescriptionKey: "无法创建 ZIP 归档"])
        }
        let fm = FileManager.default
        let basePath = source.path
        func addEntries(dir: URL) throws {
            let items = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles)
            for item in items {
                let relative = String(item.path.dropFirst(basePath.count + 1))
                if item.hasDirectoryPath {
                    try addEntries(dir: item)
                } else {
                    try archive.addEntry(with: relative, fileURL: item, compressionMethod: .deflate)
                }
            }
        }
        try addEntries(dir: source)
    }
    
    private nonisolated func unzipDirectory(source: URL, destination: URL) throws {
        guard let archive = Archive(url: source, accessMode: .read) else {
            throw NSError(domain: "DataManager", code: 500, userInfo: [NSLocalizedDescriptionKey: "无法读取 ZIP 归档"])
        }
        let fm = FileManager.default
        let entries = Array(archive)
        for entry in entries {
            let dest = destination.appendingPathComponent(entry.path)
            if entry.type == .directory {
                try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
            } else {
                try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                _ = try? archive.extract(entry, to: dest)
            }
        }
    }
    
    private func exportBackup() {
        let panel = NSSavePanel()
        panel.title = "导出数据备份"
        panel.nameFieldStringValue = "comic_backup_\(Int(Date().timeIntervalSince1970)).zip"
        panel.allowedContentTypes = [.zip]
        if panel.runModal() == .OK, let url = panel.url {
            app.setBusy("正在打包备份...")
            Task.detached(priority: .userInitiated) {
                do {
                    let fm = FileManager.default
                    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                        .appendingPathComponent("backup_\(UUID().uuidString)", isDirectory: true)
                    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                    
                    let dbPath = DatabaseManager.shared.dbPath
                    for s in ["", "-wal", "-shm"] {
                        let p = dbPath + s
                        if fm.fileExists(atPath: p) {
                            try fm.copyItem(atPath: p, toPath: tmp.appendingPathComponent(URL(fileURLWithPath: p).lastPathComponent).path)
                        }
                    }
                    let dlBase = DownloadService.downloadsDir()
                    if fm.fileExists(atPath: dlBase.path) {
                        let dst = tmp.appendingPathComponent("downloads", isDirectory: true)
                        try? fm.copyItem(at: dlBase, to: dst)
                    }
                    if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
                    try zipDirectory(source: tmp, destination: url)
                    try? fm.removeItem(at: tmp)
                    await MainActor.run {
                        app.clearBusy()
                        showMsg("备份成功: \(url.lastPathComponent)")
                        reload()
                    }
                } catch {
                    await MainActor.run { app.clearBusy(); showMsg("备份失败: \(error.localizedDescription)") }
                }
            }
        }
    }
    
    private func importBackup() {
        let panel = NSOpenPanel()
        panel.title = "选择备份 ZIP"
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            app.setBusy("正在恢复备份...")
            Task.detached(priority: .userInitiated) {
                do {
                    let fm = FileManager.default
                    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
                        .appendingPathComponent("restore_\(UUID().uuidString)", isDirectory: true)
                    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
                    try unzipDirectory(source: url, destination: tmp)
                    let dbPath = DatabaseManager.shared.dbPath
                    for s in ["", "-wal", "-shm"] {
                        let src = tmp.appendingPathComponent(URL(fileURLWithPath: dbPath + s).lastPathComponent)
                        if fm.fileExists(atPath: src.path) {
                            try? fm.removeItem(atPath: dbPath + s)
                            try fm.copyItem(at: src, to: URL(fileURLWithPath: dbPath + s))
                        }
                    }
                    let dlSrc = tmp.appendingPathComponent("downloads")
                    if fm.fileExists(atPath: dlSrc.path) {
                        let dlDst = DownloadService.downloadsDir()
                        if let en = fm.enumerator(at: dlSrc, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
                            while let f = en.nextObject() as? URL {
                                let rel = f.path.replacingOccurrences(of: dlSrc.path + "/", with: "")
                                let dst = dlDst.appendingPathComponent(rel)
                                if !fm.fileExists(atPath: dst.deletingLastPathComponent().path) {
                                    try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
                                }
                                if !fm.fileExists(atPath: dst.path) { try fm.copyItem(at: f, to: dst) }
                            }
                        }
                    }
                    try? fm.removeItem(at: tmp)
                    await MainActor.run {
                        app.clearBusy()
                        showMsg("恢复完成，请重启应用")
                        reload()
                    }
                } catch {
                    await MainActor.run { app.clearBusy(); showMsg("恢复失败: \(error.localizedDescription)") }
                }
            }
        }
    }
    
    private func migrateFromElectron() {
        let panel = NSOpenPanel()
        panel.title = "选择参考项目数据库 (comics.sqlite)"
        panel.allowedContentTypes = [.init(filenameExtension: "sqlite")!]
        panel.allowsOtherFileTypes = true
        if panel.runModal() == .OK, let url = panel.url {
            app.setBusy("正在迁移旧数据...")
            Task {
                do {
                    try await ImportService.shared.importFromElectronDB(path: url.path) { pct, msg in
                        Task { @MainActor in app.setBusy(msg) }
                    }
                    await MainActor.run {
                        app.clearBusy()
                        app.refresh()
                        showMsg("迁移完成")
                        reload()
                    }
                } catch {
                    await MainActor.run { app.clearBusy(); showMsg("迁移失败: \(error.localizedDescription)") }
                }
            }
        }
    }
    
    private func clearCache() {
        let fm = FileManager.default
        if let sup = fm.urls(for: .cachesDirectory, in: .userDomainMask).first {
            let p = sup.appendingPathComponent("ComicApp")
            try? fm.removeItem(at: p)
        }
        URLCache.shared.removeAllCachedResponses()
        showMsg("缓存已清理")
        reload()
    }
    
    private func clearTempDownloads() {
        let base = DownloadService.downloadsDir()
        let fm = FileManager.default
        var removed = 0
        if let en = fm.enumerator(at: base, includingPropertiesForKeys: nil, options: []) {
            for f in en {
                            guard let f = f as? URL else { continue }
                if f.pathExtension == "tmp" || f.lastPathComponent.hasSuffix("-images") {
                    try? fm.removeItem(at: f)
                    removed += 1
                }
            }
        }
        showMsg("已清理 \(removed) 项临时文件")
        reload()
    }
    
    private func rebuildFTS() {
        app.setBusy("重建 FTS 索引...")
        Task {
            do {
                try DatabaseManager.shared.rebuildFTS()
                await MainActor.run { app.clearBusy(); showMsg("全文索引已重建"); reload() }
            } catch {
                await MainActor.run { app.clearBusy(); showMsg("失败: \(error.localizedDescription)") }
            }
        }
    }
    
    private func vacuumDB() {
        app.setBusy("正在 VACUUM...")
        Task {
            do {
                try DatabaseManager.shared.vacuum()
                await MainActor.run { app.clearBusy(); showMsg("数据库已压缩"); reload() }
            } catch {
                await MainActor.run { app.clearBusy(); showMsg("失败: \(error.localizedDescription)") }
            }
        }
    }
}