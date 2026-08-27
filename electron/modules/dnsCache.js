'use strict'

const dns = require('dns')

// ============ DNS 预解析 + 缓存 ============
// 根因: 国内系统 DNS 对 18rouman.vip 等域名解析不稳定(部分子域名 ETIMEOUT 28-49 秒)。
// 方案 1(main.js 的 DoH)已让 Electron net 的 DNS 走 Google/Cloudflare DoH, 但 DoH 服务器
// 本身可能不可达(如被墙)。本模块作为补充: 用 Node.js dns.Resolver 直连 8.8.8.8/1.1.1.1,
// 在下载前预解析域名, 3 秒内不可解析则快速失败, 避免 downloadBuf 的 30 秒超时。

// Bug #35 修复: 之前用 8.8.8.8/1.1.1.1, 在国内被 GFW 污染/超时,
// prefetch 对 18rouman.vip 子域名返回污染 IP 或失败, 导致 downloadBuf 抛 "DNS 解析失败"
// 变体回退被跳过。改为国内可靠公共 DNS (阿里 DNS + 腾讯 DNS), 失败时降级为 trust=true
// (信任系统 DNS, 交给 main.js 配置的 Chromium DoH 处理, 不再 fail fast)。
const PUBLIC_DNS_SERVERS = ['223.5.5.5', '119.29.29.29']
const RESOLVER = new dns.Resolver()
RESOLVER.setServers(PUBLIC_DNS_SERVERS)

// DNS 查询超时(毫秒): 国内 DNS 正常 <50ms, 给 2 秒兜底
const QUERY_TIMEOUT_MS = 2000
// 缓存 TTL: 成功 5 分钟, 失败 1 分钟(避免频繁重试不可解析的域名)
const CACHE_TTL_OK = 300000
const CACHE_TTL_FAIL = 60000

// 缓存: hostname -> { ok: boolean, ips: string[], expireAt: number }
const _cache = new Map()

function _resolveWithTimeout(hostname) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, QUERY_TIMEOUT_MS)

    RESOLVER.resolve4(hostname, (err, addresses) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err || !addresses || addresses.length === 0) {
        resolve(null)
      } else {
        resolve(addresses)
      }
    })
  })
}

/**
 * 预解析 URL 的域名, 返回是否可解析
 * @param {string} urlStr - 图片 URL
 * @returns {Promise<boolean>} true=可解析/降级信任, false=明确不可解析
 */
async function prefetch(urlStr) {
  let hostname
  try {
    hostname = new URL(urlStr).hostname
  } catch {
    return false
  }
  if (!hostname) return false

  // IP 直连不需要 DNS
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname === 'localhost') return true

  // 查缓存
  const cached = _cache.get(hostname)
  if (cached && cached.expireAt > Date.now()) {
    return cached.ok
  }

  // 用公共 DNS 解析
  const ips = await _resolveWithTimeout(hostname)
  const ok = ips !== null && ips.length > 0
  // Bug #35 修复: 公共 DNS(阿里/腾讯) 失败时, 不再直接判 false 阻断,
  // 而是降级为 trust=true 信任系统 DNS(让 main.js 配置的 Chromium DoH 处理),
  // 避免公共 DNS 偶发不可达时把正常的变体 URL 错误地过滤掉。
  _cache.set(hostname, {
    ok,
    ips: ips || [],
    expireAt: Date.now() + (ok ? CACHE_TTL_OK : CACHE_TTL_FAIL),
  })
  // 失败时降级信任（不等同于成功，也不 fail fast），让下载层自行尝试
  return ok ? true : true
}

/**
 * 批量预解析多个 URL 的域名, 返回可解析的 URL 列表
 * @param {string[]} urls
 * @returns {Promise<string[]>}
 */
async function filterResolvable(urls) {
  if (!urls || urls.length === 0) return []
  // 收集所有唯一 hostname
  const hostnames = new Set()
  for (const u of urls) {
    try { hostnames.add(new URL(u).hostname) } catch {}
  }
  // 并行预解析所有 hostname
  await Promise.all([...hostnames].map(h => prefetch(`https://${h}/`)))
  // 过滤可解析的 URL
  return urls.filter(u => {
    try {
      const h = new URL(u).hostname
      const c = _cache.get(h)
      return c ? c.ok : false
    } catch {
      return false
    }
  })
}

/** 清除缓存(测试/调试用) */
function clearCache() {
  _cache.clear()
}

module.exports = { prefetch, filterResolvable, clearCache }
