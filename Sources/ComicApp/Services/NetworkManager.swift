import Foundation

final class NetworkManager: @unchecked Sendable {
    static let shared = NetworkManager()
    
    private init() {}
    
    private let lock = NSLock()
    private var cookieStorage: [String: [HTTPCookie]] = [:]
    
    func get(_ url: String, referer: String? = nil, retries: Int = 3, accept: String = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") async throws -> String {
        let (data, _) = try await request(url, method: "GET", referer: referer, retries: retries, accept: accept)
        if let s = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .init(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))) { return s }
        throw NSError(domain: "Network", code: -10, userInfo: [NSLocalizedDescriptionKey: "解码失败"])
    }
    
    func getData(_ url: String, referer: String? = nil, retries: Int = 3, accept: String = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8") async throws -> Data {
        let (data, _) = try await request(url, method: "GET", referer: referer, retries: retries, accept: accept)
        return data
    }
    
    func request(_ url: String, method: String, referer: String? = nil, retries: Int, accept: String, body: Data? = nil, contentType: String? = nil) async throws -> (Data, HTTPURLResponse) {
        var tries = 0
        var lastErr: Error?
        repeat {
            tries += 1
            do {
                return try await doRequest(url, method: method, referer: referer, accept: accept, body: body, contentType: contentType)
            } catch {
                lastErr = error
                if tries <= retries {
                    let delay = UInt64(pow(2.0, Double(tries)) * 400_000_000)
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
        } while tries <= retries
        throw lastErr ?? NSError(domain: "Network", code: -1, userInfo: [NSLocalizedDescriptionKey: "请求失败"])
    }
    
    private func doRequest(_ urlStr: String, method: String, referer: String?, accept: String, body: Data?, contentType: String?) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: urlStr) else {
            throw NSError(domain: "Network", code: -2, userInfo: [NSLocalizedDescriptionKey: "无效URL: \(urlStr)"])
        }
        let host = url.host ?? ""
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue(accept, forHTTPHeaderField: "Accept")
        req.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        req.setValue(userAgent(for: host), forHTTPHeaderField: "User-Agent")
        if let ref = referer { req.setValue(ref, forHTTPHeaderField: "Referer") }
        else if !host.isEmpty { req.setValue("https://\(host)/", forHTTPHeaderField: "Origin") }
        if let ct = contentType { req.setValue(ct, forHTTPHeaderField: "Content-Type") }
        if let b = body { req.httpBody = b }
        
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 90
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        let session = URLSession(configuration: cfg)
        defer { session.finishTasksAndInvalidate() }
        var (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw NSError(domain: "Network", code: -3, userInfo: [NSLocalizedDescriptionKey: "非HTTP响应"])
        }
        storeCookies(from: http, url: url)
        let status = http.statusCode
        if status >= 300 && status < 400, let loc = http.value(forHTTPHeaderField: "Location") {
            var resolved = loc
            if resolved.hasPrefix("/"), let base = URL(string: "/", relativeTo: url) {
                resolved = URL(string: loc, relativeTo: base)?.absoluteString ?? resolved
            }
            if let next = URL(string: resolved) {
                req.url = next
                req.httpMethod = "GET"
                req.httpBody = nil
                let (d2, r2) = try await session.data(for: req)
                data = d2
                resp = r2
            }
        }
        guard let finalHttp = resp as? HTTPURLResponse else { throw NSError(domain: "Network", code: -3, userInfo: [:]) }
        if finalHttp.statusCode >= 400 {
            throw NSError(domain: "Network", code: finalHttp.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "HTTP \(finalHttp.statusCode)"
            ])
        }
        storeCookies(from: finalHttp, url: req.url ?? url)
        return (data, finalHttp)
    }
    
    private func storeCookies(from http: HTTPURLResponse, url: URL) {
        guard let header = http.allHeaderFields as? [String: String], let host = url.host else { return }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: header, for: url)
        lock.lock()
        cookieStorage[host] = (cookieStorage[host] ?? []) + cookies
        lock.unlock()
    }
    
    private func userAgent(for host: String) -> String {
        if host.contains("copymanga") || host.contains("mangacopy") {
            return "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        }
        if host.contains("smtt6") || host.contains("shenmanman") || host.contains("toon") {
            return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
        return "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
    }
}