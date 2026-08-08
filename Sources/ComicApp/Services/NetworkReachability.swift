import Foundation
import SystemConfiguration

@MainActor
final class NetworkReachability: ObservableObject {
    static let shared = NetworkReachability()
    
    @Published private(set) var vpnConnected: Bool = false
    @Published private(set) var proxyConfigured: Bool = false
    @Published private(set) var proxyHTTPHost: String? = nil
    @Published private(set) var proxyHTTPSHost: String? = nil
    @Published private(set) var proxySOCKSHost: String? = nil
    @Published private(set) var pacURL: String? = nil
    @Published private(set) var egressMode: String = "direct"
    @Published private(set) var lastEgressCheck: Int64 = 0
    
    private init() {}
    
    enum Mode {
        case direct
        case systemProxy
        case vpnDirect
        case customProxy(String, Int)
    }
    
    func refresh() -> Mode {
        let (vpn, vpns) = checkVPN()
        let (proxy, h, s, k, pac) = checkSystemProxy()
        vpnConnected = vpn
        proxyConfigured = proxy
        proxyHTTPHost = h
        proxyHTTPSHost = s
        proxySOCKSHost = k
        pacURL = pac
        var mode: Mode = .direct
        if vpn {
            egressMode = "vpn"
            mode = .vpnDirect
        } else if proxy {
            egressMode = "system_proxy"
            if let h = h, let port = extractPort(h) { mode = .customProxy(extractHost(h), port) }
            else if let s = s, let port = extractPort(s) { mode = .customProxy(extractHost(s), port) }
            else { mode = .systemProxy }
        } else {
            egressMode = "direct"
        }
        NSLog("[Net] VPN=\(vpns.joined(separator:",")) Proxy=\(proxy) Egress=\(egressMode)")
        return mode
    }
    
    func checkEgressAccess(timeoutMs: Int = 4000, testURL: String = "https://smtt6.com/favicon.ico") async -> (reachable: Bool, ms: Int) {
        let start = Date()
        let mode = refresh()
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Double(timeoutMs) / 1000.0
        config.timeoutIntervalForResource = Double(timeoutMs) / 1000.0
        switch mode {
        case .direct, .vpnDirect:
            config.connectionProxyDictionary = [:]
        case .systemProxy:
            break
        case .customProxy(let host, let port):
            config.connectionProxyDictionary = [
                kCFNetworkProxiesHTTPEnable: true,
                kCFNetworkProxiesHTTPProxy: host,
                kCFNetworkProxiesHTTPPort: port,
                kCFNetworkProxiesHTTPSEnable: true,
                kCFNetworkProxiesHTTPSProxy: host,
                kCFNetworkProxiesHTTPSPort: port
            ] as [AnyHashable: Any]
        }
        let session = URLSession(configuration: config)
        var req = URLRequest(url: URL(string: testURL)!, cachePolicy: .reloadIgnoringLocalCacheData)
        req.httpMethod = "HEAD"
        req.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        do {
            let (_, resp) = try await session.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let delta = Int((Date().timeIntervalSince(start) * 1000).rounded())
            lastEgressCheck = Int64(Date().timeIntervalSince1970 * 1000)
            let ok = (200...399).contains(code) || code == 403
            NSLog("[Net] Egress check \(testURL) code=\(code) delta=\(delta)ms")
            return (ok, delta)
        } catch {
            let delta = Int((Date().timeIntervalSince(start) * 1000).rounded())
            lastEgressCheck = Int64(Date().timeIntervalSince1970 * 1000)
            NSLog("[Net] Egress FAIL \(error.localizedDescription) delta=\(delta)ms")
            return (false, delta)
        }
    }
    
    private func checkVPN() -> (connected: Bool, interfaces: [String]) {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0 else { return (false, []) }
        defer { freeifaddrs(ifaddr) }
        var result: [String] = []
        var ptr = ifaddr
        while ptr != nil {
            defer { ptr = ptr?.pointee.ifa_next }
            guard let interface = ptr?.pointee else { continue }
            let name = String(cString: interface.ifa_name)
            let flags = Int32(interface.ifa_flags)
            if (flags & IFF_UP) == IFF_UP && (flags & IFF_RUNNING) == IFF_RUNNING {
                let lower = name.lowercased()
                if lower.hasPrefix("utun") || lower.hasPrefix("tap") || lower.hasPrefix("tun") ||
                   lower.hasPrefix("ppp") || lower.hasPrefix("ipsec") || lower.hasPrefix("wire") ||
                   lower == "ppp0" || lower.contains("vpn") {
                    if !lower.hasPrefix("utun0") && !lower.contains("llw") && !lower.contains("awdl") {
                        if !result.contains(name) { result.append(name) }
                    }
                }
            }
        }
        let routes = getDefaultRoutes()
        let vpnDefault = routes.contains { r in r.starts(with: "utun") && !r.hasSuffix("utun0") }
        return ((!result.isEmpty && vpnDefault) || result.count > 0, result)
    }
    
    private func getDefaultRoutes() -> [String] {
        var res: [String] = []
        let task = Process()
        task.launchPath = "/sbin/route"
        task.arguments = ["-n", "get", "default"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = nil
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let str = String(data: data, encoding: .utf8) ?? ""
            for line in str.components(separatedBy: "\n") {
                if line.contains("interface:") {
                    let parts = line.components(separatedBy: ":").map { $0.trimmingCharacters(in: .whitespaces) }
                    if parts.count >= 2 { res.append(parts[1]) }
                }
            }
        } catch {}
        return res
    }
    
    private func checkSystemProxy() -> (enabled: Bool, http: String?, https: String?, socks: String?, pac: String?) {
        let settings = SCDynamicStoreCopyProxies(nil) as? [AnyHashable: Any] ?? [:]
        var httpHost: String? = nil
        var httpsHost: String? = nil
        var socksHost: String? = nil
        var pac: String? = nil
        let httpEnabled = (settings[kCFNetworkProxiesHTTPEnable] as? Int) ?? 0 == 1
        let httpsEnabled = (settings[kCFNetworkProxiesHTTPSEnable] as? Int) ?? 0 == 1
        let socksEnabled = (settings[kCFNetworkProxiesSOCKSEnable] as? Int) ?? 0 == 1
        let pacKey = kCFNetworkProxiesProxyAutoConfigEnable as String
        let pacURLKey = kCFNetworkProxiesProxyAutoConfigURLString as String
        let pacEnabled = (settings[pacKey] as? Int) ?? 0 == 1
        if httpEnabled, let h = settings[kCFNetworkProxiesHTTPProxy] as? String,
           let p = settings[kCFNetworkProxiesHTTPPort] as? Int {
            httpHost = "\(h):\(p)"
        }
        if httpsEnabled, let h = settings[kCFNetworkProxiesHTTPSProxy] as? String,
           let p = settings[kCFNetworkProxiesHTTPSPort] as? Int {
            httpsHost = "\(h):\(p)"
        }
        if socksEnabled, let h = settings[kCFNetworkProxiesSOCKSProxy] as? String,
           let p = settings[kCFNetworkProxiesSOCKSPort] as? Int {
            socksHost = "\(h):\(p)"
        }
        if pacEnabled, let u = settings[pacURLKey] as? String {
            pac = u
        }
        let enabled = httpEnabled || httpsEnabled || socksEnabled || pacEnabled
        return (enabled, httpHost, httpsHost, socksHost, pac)
    }
    
    private func extractHost(_ hostPort: String) -> String {
        let parts = hostPort.split(separator: ":")
        return String(parts.first ?? "")
    }
    
    private func extractPort(_ hostPort: String) -> Int? {
        let parts = hostPort.split(separator: ":")
        guard parts.count >= 2, let port = Int(parts[1]) else { return nil }
        return port
    }
}