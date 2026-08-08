import SwiftUI
import ZIPFoundation

struct EpubGenView: View {
    @EnvironmentObject var app: AppStore
    @State private var selected = Set<String>()
    @State private var searchText = ""
    @State private var isGenerating = false
    @State private var progressText = ""
    @State private var outputDir: URL? = DownloadService.downloadsDir().appendingPathComponent("_EPUB", isDirectory: true)
    @State private var showSuccess = false
    @State private var alertMsg = ""
    
    var comics: [Comic] {
        if searchText.isEmpty { return app.comics }
        return app.comics.filter { $0.title.localizedCaseInsensitiveContains(searchText) }
    }
    
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack(spacing: 0) {
                VStack {
                    List(selection: $selected) {
                        ForEach(comics, id: \.id) { c in
                            HStack(spacing: 10) {
                                AsyncImage(url: URL(string: c.cover ?? "")) { phase in
                                    if let img = phase.image { img.resizable().aspectRatio(contentMode: .fill) }
                                    else { Color.gray.opacity(0.2) }
                                }
                                .frame(width: 44, height: 60).clipped().cornerRadius(5)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                    Text("\(c.chapters.count) 话 · \(c.author ?? c.sourceId ?? "未知")")
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                            .tag(c.id).padding(.vertical, 3)
                        }
                    }
                    .listStyle(.inset)
                    .searchable(text: $searchText)
                }
                .frame(width: 360)
                Divider()
                previewPanel
            }
        }
        .navigationTitle("EPUB 生成")
        .alert(alertMsg, isPresented: $showSuccess) {
            Button("好", role: .cancel) {}
            if let d = outputDir { Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([d]) } }
        }
    }
    
    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "book.closed.fill").font(.title2).foregroundStyle(.indigo)
            VStack(alignment: .leading) {
                Text("EPUB 生成").font(.title3.weight(.semibold))
                Text("选择要导出为 EPUB 的漫画").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("全选") { selected = Set(comics.map { $0.id }) }.controlSize(.small)
            Button("取消") { selected.removeAll() }.controlSize(.small)
            Button {
                if let url = outputDir { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            } label: {
                Label("输出目录", systemImage: "folder")
            }
            .controlSize(.small)
            Button("选择目录...") { chooseOutputDir() }
                .controlSize(.small)
            Button("生成 EPUB (\(selected.count))") { generate() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(selected.isEmpty || isGenerating)
        }
        .padding(16)
    }
    
    private var previewPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("预览 / 设置").font(.headline)
                Spacer()
                if isGenerating {
                    ProgressView().progressViewStyle(.circular).controlSize(.small)
                }
            }
            if selected.isEmpty {
                ContentUnavailableView("选择漫画", systemImage: "square.and.pencil",
                    description: Text("从左侧列表选择要打包为 EPUB 的漫画"))
            } else {
                Form {
                    Section("选中 (\(selected.count) 本)") {
                        ScrollView {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], spacing: 10) {
                                ForEach(app.comics.filter { selected.contains($0.id) }) { c in
                                    VStack(spacing: 4) {
                                        AsyncImage(url: URL(string: c.cover ?? "")) { phase in
                                            if let img = phase.image { img.resizable().aspectRatio(contentMode: .fill) }
                                            else { Color.gray.opacity(0.2) }
                                        }
                                        .frame(width: 80, height: 110).clipped().cornerRadius(4)
                                        Text(c.title).font(.caption2).lineLimit(2).multilineTextAlignment(.center)
                                            .frame(width: 90, height: 28)
                                    }
                                }
                            }
                            .padding(.vertical, 6)
                        }
                        .frame(height: 240)
                    }
                    Section("EPUB 选项") {
                        LabeledContent("输出目录", value: outputDir?.path ?? "未设置")
                        Toggle("自动合并多话为单卷", isOn: .constant(true))
                        Toggle("生成目录页 (NCX)", isOn: .constant(true))
                        Toggle("内联封面元数据", isOn: .constant(true))
                    }
                    if !progressText.isEmpty {
                        Section("日志") {
                            Text(progressText).font(.caption).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .formStyle(.grouped)
            }
            Spacer()
        }
        .padding(16)
    }
    
    private func chooseOutputDir() {
        let p = NSOpenPanel()
        p.canChooseDirectories = true
        p.canChooseFiles = false
        p.canCreateDirectories = true
        if p.runModal() == .OK, let u = p.url { outputDir = u }
    }
    
    private func generate() {
        guard let outDir = outputDir else { return }
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        isGenerating = true
        progressText = "准备...\n"
        let comics = app.comics.filter { selected.contains($0.id) }
        Task.detached(priority: .userInitiated) {
            var finished = 0
            for comic in comics {
                let safeTitle = DownloadService.sanitizeName(comic.title)
                let epubPath = outDir.appendingPathComponent("\(safeTitle).epub").path
                let msg = "[\(finished + 1)/\(comics.count)] 处理 \(comic.title)...\n"
                await MainActor.run {
                    self.progressText += msg
                }
                do {
                    try await self.generateOne(comic: comic, output: epubPath)
                    finished += 1
                } catch {
                    let errMsg = "  ❌ 失败: \(error.localizedDescription)\n"
                    await MainActor.run {
                        self.progressText += errMsg
                    }
                }
            }
            await MainActor.run {
                self.isGenerating = false
                self.alertMsg = "完成！\(finished)/\(comics.count) 个 EPUB 已生成到:\n\(outDir.path)"
                self.showSuccess = true
            }
        }
    }
    
    private func generateOne(comic: Comic, output: String) async throws {
        let fm = FileManager.default
        let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("epub_\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: tmpDir) }
        try fm.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        
        let metsDir = tmpDir.appendingPathComponent("META-INF")
        let opsDir = tmpDir.appendingPathComponent("OEBPS", isDirectory: true)
        let imgDir = opsDir.appendingPathComponent("images", isDirectory: true)
        try fm.createDirectory(at: metsDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: imgDir, withIntermediateDirectories: true)
        
        // 1. mimetype
        let mimeURL = tmpDir.appendingPathComponent("mimetype")
        try "application/epub+zip".write(to: mimeURL, atomically: false, encoding: .utf8)
        
        // 2. META-INF/container.xml
        let container = """
<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
        try container.write(to: metsDir.appendingPathComponent("container.xml"), atomically: true, encoding: .utf8)
        
        // 3. 下载封面
        var coverEntry: String? = nil
        if let coverUrlStr = comic.cover, let url = URL(string: coverUrlStr) {
            do {
                let (data, _) = try await NetworkManager.shared.request(url.absoluteString, method: "GET", referer: nil, retries: 2, accept: "image/*")
                let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
                let coverName = "cover.\(ext)"
                try data.write(to: imgDir.appendingPathComponent(coverName))
                coverEntry = coverName
            } catch {}
        }
        
        var manifestItems: [String] = []
        var spineItems: [String] = []
        func addManifest(_ id: String, _ href: String, _ type: String) {
            manifestItems.append("    <item id=\"\(id)\" href=\"\(href)\" media-type=\"\(type)\"/>")
        }
        func addSpine(_ id: String) { spineItems.append("    <itemref idref=\"\(id)\"/>") }
        
        // title page
        let titleXhtml = xhtml(title: comic.title, body: """
  <div style="text-align:center; padding-top:25%;">
    <h1>\(escapeXml(comic.title))</h1>
    <p style="color:#666;margin-top:2em;">作者: \(escapeXml(comic.author ?? ""))</p>
    <p style="color:#999;">共 \(comic.chapters.count) 话 · 由漫快自动生成</p>
  </div>
""")
        try titleXhtml.write(to: opsDir.appendingPathComponent("title.xhtml"), atomically: true, encoding: .utf8)
        addManifest("titlepage", "title.xhtml", "application/xhtml+xml")
        addSpine("titlepage")
        
        // toc page
        var tocBody = "<h1>目录</h1>\n  <ol style=\"line-height:2;\">\n"
        for (idx, ch) in comic.chapters.enumerated() {
            tocBody += "    <li><a href=\"chapter_\(idx).xhtml\">\(escapeXml(ch.name))</a></li>\n"
        }
        tocBody += "  </ol>"
        let tocXhtml = xhtml(title: "目录", body: tocBody)
        try tocXhtml.write(to: opsDir.appendingPathComponent("toc.xhtml"), atomically: true, encoding: .utf8)
        addManifest("toc", "toc.xhtml", "application/xhtml+xml")
        addSpine("toc")
        
        // chapter pages
        for (idx, ch) in comic.chapters.enumerated() {
            let localCBZ = DownloadService.localPath(for: comic, chapterIndex: idx)
            var chCover: String? = nil
            if fm.fileExists(atPath: localCBZ) {
                let dir = tmpDir.appendingPathComponent("cbz_extract_\(idx)", isDirectory: true)
                do {
                    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                    // unzip CBZ using ZIPFoundation
                    if let archive = Archive(url: URL(fileURLWithPath: localCBZ), accessMode: .read) {
                        let entries = Array(archive)
                        for entry in entries {
                            let ext = (entry.path as NSString).pathExtension.lowercased()
                            if ["jpg","jpeg","png","webp","gif","bmp"].contains(ext) {
                                let dest = dir.appendingPathComponent(entry.path)
                                try? fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                                _ = try? archive.extract(entry, to: dest)
                            }
                        }
                    }
                    var imgFiles: [URL] = []
                    if let en = fm.enumerator(at: dir, includingPropertiesForKeys: nil, options: .skipsHiddenFiles) {
                        while let f = en.nextObject() as? URL {
                            if ["jpg","jpeg","png","webp","gif","bmp"].contains(f.pathExtension.lowercased()) {
                                imgFiles.append(f)
                            }
                        }
                    }
                    imgFiles.sort { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
                    if let first = imgFiles.first {
                        let ext = first.pathExtension.isEmpty ? "jpg" : first.pathExtension
                        let destName = "ch\(idx)_0.\(ext)"
                        try fm.copyItem(at: first, to: imgDir.appendingPathComponent(destName))
                        chCover = destName
                    }
                    try? fm.removeItem(at: dir)
                } catch {}
            }
            var chapterBody = "<h2>\(escapeXml(ch.name))</h2>\n"
            if let img = chCover {
                addManifest("img_ch\(idx)_0", "images/\(img)", mime(for: img))
                chapterBody += "  <div><img src=\"images/\(img)\" alt=\"\"/></div>\n"
            } else {
                chapterBody += "  <p style=\"color:#999;text-align:center;\">[第 \(idx + 1) 话，未包含在本次 EPUB 包中]</p>\n"
            }
            let chXhtml = xhtml(title: ch.name, body: chapterBody)
            let fname = "chapter_\(idx).xhtml"
            try chXhtml.write(to: opsDir.appendingPathComponent(fname), atomically: true, encoding: .utf8)
            addManifest("ch\(idx)", fname, "application/xhtml+xml")
            addSpine("ch\(idx)")
        }
        
        if let c = coverEntry {
            addManifest("cover-image", "images/\(c)", mime(for: c))
        }
        
        let coverManifest = coverEntry == nil ? "" : "    <meta name=\"cover\" content=\"cover-image\"/>\n"
        let manifestStr = manifestItems.joined(separator: "\n")
        let spineStr = spineItems.joined(separator: "\n")
        let opf = """
<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="BookId">urn:uuid:\(comic.id)</dc:identifier>
    <dc:title>\(escapeXml(comic.title))</dc:title>
    <dc:creator opf:role="aut">\(escapeXml(comic.author ?? "佚名"))</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>漫快 ComicApp</dc:publisher>
    <dc:description>\(escapeXml(comic.descText ?? ""))</dc:description>
    <dc:subject>\(escapeXml(comic.category ?? ""))</dc:subject>
    <meta property="dcterms:modified">\(isoNow())</meta>
\(coverManifest)  </metadata>
  <manifest>
\(manifestStr)
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
\(spineStr)
  </spine>
</package>
"""
        try opf.write(to: opsDir.appendingPathComponent("content.opf"), atomically: true, encoding: .utf8)
        
        var navPoints: [String] = []
        var playOrder = 1
        navPoints.append("""
        <navPoint id="navpoint-title" playOrder="\(playOrder)"><navLabel><text>封面</text></navLabel><content src="title.xhtml"/></navPoint>
""")
        playOrder += 1
        navPoints.append("""
        <navPoint id="navpoint-toc" playOrder="\(playOrder)"><navLabel><text>目录</text></navLabel><content src="toc.xhtml"/></navPoint>
""")
        playOrder += 1
        for (idx, ch) in comic.chapters.enumerated() {
            navPoints.append("""
        <navPoint id="navpoint-\(idx)" playOrder="\(playOrder)"><navLabel><text>\(escapeXml(ch.name))</text></navLabel><content src="chapter_\(idx).xhtml"/></navPoint>
""")
            playOrder += 1
        }
        let ncx = """
<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:\(comic.id)"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
  <docTitle><text>\(escapeXml(comic.title))</text></docTitle>
  <navMap>
\(navPoints.joined())  </navMap>
</ncx>
"""
        try ncx.write(to: opsDir.appendingPathComponent("toc.ncx"), atomically: true, encoding: .utf8)
        
        if fm.fileExists(atPath: output) { try fm.removeItem(atPath: output) }
        try zipDirectory(source: tmpDir, destination: URL(fileURLWithPath: output))
    }
    
    private func zipDirectory(source: URL, destination: URL) throws {
        guard let archive = Archive(url: destination, accessMode: .create) else {
            throw NSError(domain: "EpubGen", code: 500, userInfo: [NSLocalizedDescriptionKey: "无法创建 ZIP 归档"])
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
    
    private func xhtml(title: String, body: String) -> String {
        """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh" xml:lang="zh">
<head>
  <title>\(escapeXml(title))</title>
  <style type="text/css">
    body { font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif; margin: 3%; }
    h1, h2 { font-weight: 600; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
\(body)
</body>
</html>
"""
    }
    
    private func escapeXml(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }
    
    private func mime(for filename: String) -> String {
        switch filename.lowercased().split(separator: ".").last {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        default: return "application/octet-stream"
        }
    }
    
    private func isoNow() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: Date())
    }
}