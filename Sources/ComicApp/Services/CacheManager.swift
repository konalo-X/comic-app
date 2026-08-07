import Foundation
import CryptoKit

final class CacheManager: @unchecked Sendable {
    static let shared = CacheManager()
    
    private let fm = FileManager.default
    private(set) var cacheDir: URL
    private(set) var imageCacheDir: URL
    private(set) var coverCacheDir: URL
    private(set) var chapterCacheDir: URL
    
    private init() {
        let cachesDir = fm.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
        cacheDir = cachesDir.appendingPathComponent("ComicApp", isDirectory: true)
        imageCacheDir = cacheDir.appendingPathComponent("images", isDirectory: true)
        coverCacheDir = cacheDir.appendingPathComponent("covers", isDirectory: true)
        chapterCacheDir = cacheDir.appendingPathComponent("chapters", isDirectory: true)
        try? fm.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: imageCacheDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: coverCacheDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: chapterCacheDir, withIntermediateDirectories: true)
    }
    
    func getDownloadsDir() -> URL {
        let downloads = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Downloads")
        let dir = downloads.appendingPathComponent("ComicApp", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    
    func getComicDownloadDir(title: String) -> URL {
        let safe = sanitizeFilename(title)
        let dir = getDownloadsDir().appendingPathComponent(safe, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    
    func getChapterDownloadDir(comicTitle: String, chapterIndex: Int, chapterName: String) -> URL {
        let comicDir = getComicDownloadDir(title: comicTitle)
        let safeName = sanitizeFilename("\(chapterIndex + 1)-\(chapterName)")
        let dir = comicDir.appendingPathComponent(safeName, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    
    func sha256(_ str: String) -> String {
        let data = Data(str.utf8)
        let hash = SHA256.hash(data: data)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }
    
    func cachedImagePath(url: String) -> URL {
        let ext = (url as NSString).pathExtension.isEmpty ? "jpg" : (url as NSString).pathExtension
        let name = sha256(url) + "." + ext
        return imageCacheDir.appendingPathComponent(name)
    }
    
    func cachedCoverPath(sourceUrl: String?) -> URL {
        let key = sourceUrl ?? UUID().uuidString
        let name = sha256(key) + ".jpg"
        return coverCacheDir.appendingPathComponent(name)
    }
    
    func cachedChapterPageListPath(chapterUrl: String) -> URL {
        let name = sha256(chapterUrl) + ".json"
        return chapterCacheDir.appendingPathComponent(name)
    }
    
    func hasCachedImage(url: String) -> Bool {
        let path = cachedImagePath(url: url).path
        return fm.fileExists(atPath: path)
    }
    
    func getCachedImage(url: String) -> Data? {
        let path = cachedImagePath(url: url)
        return try? Data(contentsOf: path)
    }
    
    func saveImage(_ data: Data, url: String) throws {
        let path = cachedImagePath(url: url)
        try data.write(to: path, options: .atomic)
    }
    
    func getCachedPageList(chapterUrl: String) -> ChapterPages? {
        let path = cachedChapterPageListPath(chapterUrl: chapterUrl)
        guard let data = try? Data(contentsOf: path) else { return nil }
        return try? JSONDecoder().decode(ChapterPages.self, from: data)
    }
    
    func saveCachedPageList(_ pages: ChapterPages, chapterUrl: String) throws {
        let path = cachedChapterPageListPath(chapterUrl: chapterUrl)
        let data = try JSONEncoder().encode(pages)
        try data.write(to: path, options: [.atomic])
    }
    
    func saveCover(data: Data, sourceUrl: String?) throws -> String {
        let path = cachedCoverPath(sourceUrl: sourceUrl)
        try data.write(to: path, options: [.atomic])
        return path.path
    }
    
    func getCoverLocalPath(sourceUrl: String?) -> String? {
        let path = cachedCoverPath(sourceUrl: sourceUrl).path
        return fm.fileExists(atPath: path) ? path : nil
    }
    
    func clearCache(olderThan days: Int = 30) throws {
        let cutoff = Date().addingTimeInterval(-Double(days) * 86400)
        let attrs: [URLResourceKey] = [.contentModificationDateKey, .isDirectoryKey]
        for dir in [imageCacheDir, coverCacheDir, chapterCacheDir] {
            guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: attrs, options: [.skipsHiddenFiles]) else { continue }
            for file in files {
                guard let values = try? file.resourceValues(forKeys: Set(attrs)),
                      let modified = values.contentModificationDate,
                      values.isDirectory != true,
                      modified < cutoff else { continue }
                try? fm.removeItem(at: file)
            }
        }
    }
    
    func cacheSize() -> Int64 {
        var total: Int64 = 0
        for dir in [imageCacheDir, coverCacheDir, chapterCacheDir] {
            guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey]) else { continue }
            for case let file as URL in enumerator {
                if let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize {
                    total += Int64(size)
                }
            }
        }
        return total
    }
    
    func sanitizeFilename(_ name: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\?%*|\"<>:")
        var result = name.components(separatedBy: invalid).joined(separator: "_")
        result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.isEmpty { result = "untitled" }
        if result.count > 200 { result = String(result.prefix(200)) }
        return result
    }
}