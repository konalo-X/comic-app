import Foundation
import ZIPFoundation

final class ExportService: @unchecked Sendable {
    static let shared = ExportService()
    private init() {}
    
    func toCBZ(comicTitle: String, chapterIndex: Int? = nil, progress: ((Double, String) -> Void)? = nil) async throws -> URL {
        let records: [DownloadRecord]
        if let idx = chapterIndex {
            records = (try ReadingRepository.shared.getDownloadRecords(comicId: "")).filter { $0.comicTitle == comicTitle && $0.chapterIndex == idx }
        } else {
            records = try ReadingRepository.shared.listDownloadRecords().filter { $0.comicTitle == comicTitle }
        }
        guard !records.isEmpty else {
            throw NSError(domain: "ExportService", code: 404, userInfo: [NSLocalizedDescriptionKey: "未找到下载记录"])
        }
        let safeTitle = CacheManager.shared.sanitizeFilename(comicTitle)
        let outDir = CacheManager.shared.getDownloadsDir()
        let cbzUrl = outDir.appendingPathComponent("\(safeTitle).cbz")
        if FileManager.default.fileExists(atPath: cbzUrl.path) {
            try? FileManager.default.removeItem(at: cbzUrl)
        }
        let archive = try Archive(url: cbzUrl, accessMode: .create)
        let total = records.count
        for (idx, rec) in records.enumerated() {
            progress?(Double(idx) / Double(total), "添加章节 \(rec.chapterName)...")
            try addChapter(to: archive, record: rec, prefix: String(format: "%04d-", idx))
        }
        progress?(1.0, "完成")
        return cbzUrl
    }
    
    func toCBZ(fromDownload record: DownloadRecord, progress: ((Double, String) -> Void)? = nil) throws -> URL {
        let safeTitle = CacheManager.shared.sanitizeFilename("\(record.comicTitle)-\(record.chapterName)")
        let outDir = CacheManager.shared.getDownloadsDir()
        let cbzUrl = outDir.appendingPathComponent("\(safeTitle).cbz")
        if FileManager.default.fileExists(atPath: cbzUrl.path) {
            try? FileManager.default.removeItem(at: cbzUrl)
        }
        let archive = try Archive(url: cbzUrl, accessMode: .create)
        try addChapter(to: archive, record: record, prefix: "")
        progress?(1.0, "完成")
        return cbzUrl
    }
    
    private func addChapter(to archive: Archive, record: DownloadRecord, prefix: String) throws {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(atPath: record.path).sorted() else { return }
        let images = files.filter { ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(($0 as NSString).pathExtension.lowercased()) }.sorted()
        for filename in images {
            let fileUrl = URL(fileURLWithPath: record.path).appendingPathComponent(filename)
            let entryName = "\(prefix)\(filename)"
            try archive.addEntry(with: entryName, fileURL: fileUrl, compressionMethod: .none)
        }
    }
    
    func toEPUB(comicTitle: String, progress: ((Double, String) -> Void)? = nil) async throws -> URL {
        let records = try ReadingRepository.shared.listDownloadRecords().filter { $0.comicTitle == comicTitle }
        guard !records.isEmpty else {
            throw NSError(domain: "ExportService", code: 404, userInfo: [NSLocalizedDescriptionKey: "未找到下载记录"])
        }
        let safeTitle = CacheManager.shared.sanitizeFilename(comicTitle)
        let outDir = CacheManager.shared.getDownloadsDir()
        let epubUrl = outDir.appendingPathComponent("\(safeTitle).epub")
        if FileManager.default.fileExists(atPath: epubUrl.path) {
            try? FileManager.default.removeItem(at: epubUrl)
        }
        let archive = try Archive(url: epubUrl, accessMode: .create)
        let mime = "application/epub+zip"
        let mimeData = mime.data(using: .utf8)!
        try archive.addEntry(
            with: "mimetype",
            type: .file,
            uncompressedSize: Int64(mimeData.count),
            modificationDate: Date(),
            permissions: UInt16(0o644),
            compressionMethod: .none,
            bufferSize: 16384,
            progress: nil
        ) { (position: Int64, size: Int) in
            return mimeData.subdata(in: Int(position)..<Int(position) + size)
        }
        
        let containerXML = """
        <?xml version="1.0" encoding="UTF-8"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>
        """
        let containerData = containerXML.data(using: .utf8)!
        try archive.addEntry(
            with: "META-INF/container.xml",
            type: .file,
            uncompressedSize: Int64(containerData.count),
            modificationDate: Date(),
            permissions: UInt16(0o644),
            compressionMethod: .deflate,
            bufferSize: 16384,
            progress: nil
        ) { (position: Int64, size: Int) in
            return containerData.subdata(in: Int(position)..<Int(position) + size)
        }
        
        var imageManifest: [String] = []
        var spineItems: [String] = []
        var chapterRefs: [String] = []
        var allImageFiles: [(name: String, data: Data, chapterIdx: Int)] = []
        
        progress?(0.1, "收集图片...")
        for (chIdx, rec) in records.enumerated() {
            let fm = FileManager.default
            guard let files = try? fm.contentsOfDirectory(atPath: rec.path).sorted() else { continue }
            let images = files.filter { ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(($0 as NSString).pathExtension.lowercased()) }.sorted()
            for (i, fname) in images.enumerated() {
                let fileUrl = URL(fileURLWithPath: rec.path).appendingPathComponent(fname)
                guard let data = try? Data(contentsOf: fileUrl) else { continue }
                let imgName = "img_\(chIdx)_\(i).\((fname as NSString).pathExtension.lowercased())"
                allImageFiles.append((imgName, data, chIdx))
                let mediaType: String
                switch (fname as NSString).pathExtension.lowercased() {
                case "png": mediaType = "image/png"
                case "gif": mediaType = "image/gif"
                case "webp": mediaType = "image/webp"
                case "bmp": mediaType = "image/bmp"
                default: mediaType = "image/jpeg"
                }
                imageManifest.append("    <item id=\"\(imgName)\" href=\"\(imgName)\" media-type=\"\(mediaType)\"/>")
            }
        }
        
        progress?(0.5, "生成内容...")
        let groupedImages = Dictionary(grouping: allImageFiles, by: { $0.chapterIdx }).sorted(by: { $0.key < $1.key })
        for (chIdx, images) in groupedImages {
            let chapterName = chIdx < records.count ? records[chIdx].chapterName : "第\(chIdx + 1)话"
            var body = ""
            for img in images {
                body += "<div><img src=\"\(img.name)\" alt=\"\"/></div>\n"
            }
            let xhtml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE html>
            <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
            <head>
              <title>\(chapterName.xmlEscaped)</title>
              <style>body{margin:0;padding:0;}img{display:block;width:100%;max-width:100%;height:auto;}div{page-break-after:always;}</style>
            </head>
            <body>\n\(body)</body></html>
            """
            let pageName = "chapter_\(chIdx).xhtml"
            let xhtmlData = xhtml.data(using: .utf8)!
            try archive.addEntry(
                with: "OEBPS/\(pageName)",
                type: .file,
                uncompressedSize: Int64(xhtmlData.count),
                modificationDate: Date(),
                permissions: UInt16(0o644),
                compressionMethod: .deflate,
                bufferSize: 16384,
                progress: nil
            ) { (position: Int64, size: Int) in
                return xhtmlData.subdata(in: Int(position)..<Int(position) + size)
            }
            imageManifest.append("    <item id=\"\(pageName)\" href=\"\(pageName)\" media-type=\"application/xhtml+xml\"/>")
            spineItems.append("    <itemref idref=\"\(pageName)\"/>")
            chapterRefs.append("    <navPoint id=\"nav\(chIdx)\"><navLabel><text>\(chapterName.xmlEscaped)</text></navLabel><content src=\"\(pageName)\"/></navPoint>")
        }
        
        progress?(0.8, "写入图片...")
        for img in allImageFiles {
            let imgData = img.data
            try archive.addEntry(
                with: "OEBPS/\(img.name)",
                type: .file,
                uncompressedSize: Int64(imgData.count),
                modificationDate: Date(),
                permissions: UInt16(0o644),
                compressionMethod: .deflate,
                bufferSize: 16384,
                progress: nil
            ) { (position: Int64, size: Int) in
                return imgData.subdata(in: Int(position)..<Int(position) + size)
            }
        }
        
        let opf = """
        <?xml version="1.0" encoding="UTF-8"?>
        <package version="3.0" unique-identifier="BookId" xmlns="http://www.idpf.org/2007/opf">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>\(comicTitle.xmlEscaped)</dc:title>
            <dc:language>zh-CN</dc:language>
            <dc:identifier id="BookId">comicapp-\(safeTitle)</dc:identifier>
            <meta property="dcterms:modified">\(ISO8601DateFormatter().string(from: Date()))</meta>
          </metadata>
          <manifest>\n\(imageManifest.joined(separator: "\n"))\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
          </manifest>
          <spine toc="ncx">\n\(spineItems.joined(separator: "\n"))\n  </spine>
        </package>
        """
        let opfData = opf.data(using: .utf8)!
        try archive.addEntry(
            with: "OEBPS/content.opf",
            type: .file,
            uncompressedSize: Int64(opfData.count),
            modificationDate: Date(),
            permissions: UInt16(0o644),
            compressionMethod: .deflate,
            bufferSize: 16384,
            progress: nil
        ) { (position: Int64, size: Int) in
            return opfData.subdata(in: Int(position)..<Int(position) + size)
        }
        
        let ncx = """
        <?xml version="1.0" encoding="UTF-8"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head><meta name="dtb:uid" content="comicapp-\(safeTitle)"/></head>
          <docTitle><text>\(comicTitle.xmlEscaped)</text></docTitle>
          <navMap>\n\(chapterRefs.joined(separator: "\n"))\n  </navMap>
        </ncx>
        """
        let ncxData = ncx.data(using: .utf8)!
        try archive.addEntry(
            with: "OEBPS/toc.ncx",
            type: .file,
            uncompressedSize: Int64(ncxData.count),
            modificationDate: Date(),
            permissions: UInt16(0o644),
            compressionMethod: .deflate,
            bufferSize: 16384,
            progress: nil
        ) { (position: Int64, size: Int) in
            return ncxData.subdata(in: Int(position)..<Int(position) + size)
        }
        
        let navItems = chapterRefs.enumerated().map { (i, _) -> String in
            let chIdx = i
            let chapterName = chIdx < records.count ? records[chIdx].chapterName : "第\(chIdx + 1)话"
            return "      <li><a href=\"chapter_\(chIdx).xhtml\">\(chapterName.xmlEscaped)</a></li>"
        }.joined(separator: "\n")
        let nav = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <head><title>目录</title></head>
        <body>
          <nav epub:type="toc"><h1>目录</h1><ol>\n\(navItems)\n</ol></nav>
        </body></html>
        """
        let navData = nav.data(using: .utf8)!
        try archive.addEntry(
            with: "OEBPS/nav.xhtml",
            type: .file,
            uncompressedSize: Int64(navData.count),
            modificationDate: Date(),
            permissions: UInt16(0o644),
            compressionMethod: .deflate,
            bufferSize: 16384,
            progress: nil
        ) { (position: Int64, size: Int) in
            return navData.subdata(in: Int(position)..<Int(position) + size)
        }
        progress?(1.0, "EPUB 导出完成")
        return epubUrl
    }
    
    func listDownloads() throws -> [String] {
        let records = try ReadingRepository.shared.listDownloadRecords()
        return Array(Set(records.map { $0.comicTitle })).sorted()
    }
    
    func getDownloadChapters(title: String) throws -> [DownloadRecord] {
        try ReadingRepository.shared.listDownloadRecords().filter { $0.comicTitle == title }
    }
    
    func checkEpubExists(title: String) -> Bool {
        let safe = CacheManager.shared.sanitizeFilename(title)
        let epub = CacheManager.shared.getDownloadsDir().appendingPathComponent("\(safe).epub").path
        return FileManager.default.fileExists(atPath: epub)
    }
    
    nonisolated func handleExportJob(job: Job, queue: JobQueue) async throws {
        let format = (job.payload["format"] ?? "cbz").lowercased()
        let comicTitle = job.payload["comicTitle"] ?? ""
        guard !comicTitle.isEmpty else {
            throw NSError(domain: "ExportService", code: 400, userInfo: [NSLocalizedDescriptionKey: "缺少漫画标题"])
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 0.05, message: "准备导出 \(comicTitle)...")
        }
        let _: URL
        if format == "epub" {
            _ = try await toEPUB(comicTitle: comicTitle) { prog, msg in
                Task { @MainActor in
                    queue.reportProgress(jobId: job.id, progress: 0.05 + 0.9 * prog, message: msg)
                }
            }
        } else {
            _ = try await toCBZ(comicTitle: comicTitle) { prog, msg in
                Task { @MainActor in
                    queue.reportProgress(jobId: job.id, progress: 0.05 + 0.9 * prog, message: msg)
                }
            }
        }
        await MainActor.run {
            queue.reportProgress(jobId: job.id, progress: 1.0, message: "导出完成")
        }
    }
}

extension String {
    var xmlEscaped: String {
        var result = self
        result = result.replacingOccurrences(of: "&", with: "&amp;")
        result = result.replacingOccurrences(of: "<", with: "&lt;")
        result = result.replacingOccurrences(of: ">", with: "&gt;")
        result = result.replacingOccurrences(of: "\"", with: "&quot;")
        result = result.replacingOccurrences(of: "'", with: "&apos;")
        return result
    }
}