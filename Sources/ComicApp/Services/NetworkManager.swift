import Foundation

final class NetworkManager: @unchecked Sendable {
    static let shared = NetworkManager()
    
    private init() {}
    
    private struct CookieState {
        var cookieStorage: [String: [HTTPCookie]] = [:]
        var customProxy: (host: String, port: Int)? = nil
        var forceDirect: Bool = false
    }
    private let stateQueue = DispatchQueue(label: "NetworkManager.state")
    private var state = CookieState()
    private func readState<T>(_ fn: (CookieState) throws -> T) rethrows -> T {
        try stateQueue.sync { try fn(state) }
    }
    private func writeState(_ fn: (inout CookieState) throws -> Void) rethrows {
        try stateQueue.sync { try fn(&state) }
    }
    
    func applyEgressMode(mode: NetworkReachability.Mode) {
        writeState { s in
            switch mode {
            case .direct, .vpnDirect:
                s.forceDirect = true
                s.customProxy = nil
            case .systemProxy:
                s.forceDirect = false
                s.customProxy = nil
            case .customProxy(let h, let p):
                s.forceDirect = false
                s.customProxy = (h, p)
            }
        }
    }
    
    func get(_ url: String, referer: String? = nil, retries: Int = 3, accept: String = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8") async throws -> String {
        let (data, _) = try await request(url, method: "GET", referer: referer, retries: retries, accept: accept)
        if let s = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .init(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))) { return s }
        throw NSError(domain: "Network", code: -10, userInfo: [NSLocalizedDescriptionKey: "解码失败"])
    }
    
    func getData(_ url: String, referer: String? = nil, retries: Int = 2, accept: String = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8") async throws -> Data {
        let variants = buildURLVariants(original: url)
        var lastErr: Error?
        for (idx, v) in variants.enumerated() {
            let rem = max(1, retries - (idx > 0 ? 1 : 0))
            do {
                let (data, http) = try await request(v, method: "GET", referer: referer, retries: rem, accept: accept)
                if isValidImageResponse(data: data, http: http) {
                    if idx > 0 { NSLog("[IMG] 变体成功 \(url) → \(v)") }
                    return data
                }
                lastErr = NSError(domain: "IMG", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "无效图片数据 code=\(http.statusCode)"])
            } catch {
                lastErr = error
                let desc = error.localizedDescription.lowercased()
                let code = (error as NSError).code
                if code == 404 || code == 403 || desc.contains("not found") || desc.contains("forbidden") || desc.contains("无此") {
                    continue
                }
            }
        }
        throw lastErr ?? NSError(domain: "IMG", code: 404, userInfo: [NSLocalizedDescriptionKey: "所有URL变体均失败 variants=\(variants.count)"])
    }
    
    private func buildURLVariants(original: String) -> [String] {
        guard let u = URL(string: original) else { return [original] }
        var results: [String] = [original]
        let pathExt = u.pathExtension.lowercased()
        let path = u.path
        let host = u.host ?? ""
        let scheme = u.scheme ?? "https"
        
        if !pathExt.isEmpty {
            let altExts: [String]
            switch pathExt {
            case "jpg": altExts = ["jpeg", "webp", "png", "JPG", "gif"]
            case "jpeg": altExts = ["jpg", "webp", "png", "JPEG"]
            case "png": altExts = ["webp", "jpg", "jpeg", "PNG"]
            case "webp": altExts = ["jpg", "jpeg", "png", "WEBP"]
            case "gif": altExts = ["png", "jpg"]
            default: altExts = ["jpg", "png", "webp"]
            }
            for e in altExts {
                if var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
                    let p = (path as NSString).deletingPathExtension
                    comps.path = p + "." + e
                    if let s = comps.string { results.append(s) }
                }
            }
        }
        
        if host.contains("p2.pic") {
            let altNodes = ["p2.pic", "p3.pic", "p1.pic", "p0.pic"]
            for node in altNodes {
                if host == node { continue }
                if var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
                    comps.host = comps.host?.replacingOccurrences(of: host, with: node)
                    comps.scheme = scheme
                    if let s = comps.string { results.append(s) }
                }
            }
        } else if host.contains("p.pic") {
            let altNodes = ["p1.pic", "p2.pic", "p3.pic", "p4.pic", "p0.pic"]
            for node in altNodes {
                if host == node { continue }
                if var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
                    comps.host = comps.host?.replacingOccurrences(of: host, with: node)
                    comps.scheme = scheme
                    if let s = comps.string { results.append(s) }
                }
            }
        }
        
        if scheme == "https" {
            if var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
                comps.scheme = "http"
                if let s = comps.string { results.append(s) }
            }
        }
        if host.starts(with: "img") {
            let suffix = host.dropFirst(3)
            if var comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
                comps.host = "www\(suffix)"
                if let s = comps.string { results.append(s) }
            }
        }
        return Array(NSOrderedSet(array: results)) as! [String]
    }
    
    private func isValidImageResponse(data: Data, http: HTTPURLResponse) -> Bool {
        if data.count < 80 { return false }
        let c = http.statusCode
        if c < 200 || c >= 400 { return false }
        var buf = [UInt8](repeating: 0, count: 16)
        data.copyBytes(to: &buf, count: min(16, data.count))
        if buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF { return true }
        if buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4E && buf[3] == 0x47 { return true }
        if buf[0] == 0x47 && buf[1] == 0x49 && buf[2] == 0x46 { return true }
        if buf[0] == 0x52 && buf[1] == 0x49 && buf[2] == 0x46 && buf[3] == 0x46 &&
           buf[8] == 0x57 && buf[9] == 0x45 && buf[10] == 0x42 && buf[11] == 0x50 { return true }
        if buf[0] == 0x42 && buf[1] == 0x4D { return true }
        if data.count > 200 { return true }
        return false
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
        injectAntiHotlink(for: &req, url: url, referer: referer, host: host)
        if let ct = contentType { req.setValue(ct, forHTTPHeaderField: "Content-Type") }
        if let b = body { req.httpBody = b }
        
        let (forceDirect, customProxy, cookiesForHost) = readState { s in
            return (s.forceDirect, s.customProxy, s.cookieStorage[host] ?? [])
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 25
        cfg.timeoutIntervalForResource = 75
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        if forceDirect {
            cfg.connectionProxyDictionary = [:]
        } else if let p = customProxy {
            cfg.connectionProxyDictionary = [
                kCFNetworkProxiesHTTPEnable: true,
                kCFNetworkProxiesHTTPProxy: p.host,
                kCFNetworkProxiesHTTPPort: p.port,
                kCFNetworkProxiesHTTPSEnable: true,
                kCFNetworkProxiesHTTPSProxy: p.host,
                kCFNetworkProxiesHTTPSPort: p.port
            ] as [AnyHashable: Any]
        }
        if !cookiesForHost.isEmpty {
            let dict = HTTPCookie.requestHeaderFields(with: cookiesForHost)
            for (k, v) in dict { req.setValue(v, forHTTPHeaderField: k) }
        }
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
    
    private func injectAntiHotlink(for req: inout URLRequest, url: URL, referer: String?, host: String) {
        if let ref = referer {
            req.setValue(ref, forHTTPHeaderField: "Referer")
        } else if !host.isEmpty {
            if host.contains("smtt6") {
                req.setValue("https://www.smtt6.com/", forHTTPHeaderField: "Referer")
                req.setValue("https://www.smtt6.com/", forHTTPHeaderField: "Origin")
            } else if host.contains("copymanga") || host.contains("mangacopy") {
                req.setValue("https://www.copymanga.site/", forHTTPHeaderField: "Referer")
                req.setValue("https://www.copymanga.site/", forHTTPHeaderField: "Origin")
            } else if host.contains("manhuagui") || host.contains("mhgui") {
                req.setValue("https://www.manhuagui.com/", forHTTPHeaderField: "Referer")
                req.setValue("https://www.manhuagui.com/", forHTTPHeaderField: "Origin")
            } else {
                req.setValue("https://\(host)/", forHTTPHeaderField: "Referer")
                req.setValue("https://\(host)/", forHTTPHeaderField: "Origin")
            }
        }
        if host.contains("mhcdn") || host.contains("mhtp") || host.contains("manhuajia") {
            req.setValue("https://www.manhuagui.com/", forHTTPHeaderField: "Referer")
            req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        }
        req.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        req.setValue("?1", forHTTPHeaderField: "Sec-Fetch-Dest")
        req.setValue("empty", forHTTPHeaderField: "Sec-Fetch-Mode")
        req.setValue("gzip, deflate, br", forHTTPHeaderField: "Accept-Encoding")
    }
    
    private func storeCookies(from http: HTTPURLResponse, url: URL) {
        guard let header = http.allHeaderFields as? [String: String], let host = url.host else { return }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: header, for: url)
        guard !cookies.isEmpty else { return }
        writeState { s in
            var existing = s.cookieStorage[host] ?? []
            let byName = Dictionary(grouping: existing, by: { $0.name })
            for c in cookies {
                if byName[c.name] != nil { existing.removeAll { $0.name == c.name } }
                existing.append(c)
            }
            s.cookieStorage[host] = existing
        }
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