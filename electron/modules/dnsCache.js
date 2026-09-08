'use strict'

const dns = require('dns')

// ============ DNS 预解析 + 缓存 ============
// 根因: 国内系统 DNS 对 18rouman.vip 等域名解析不稳定(部分子域名 ETIMEOUT 28-49 秒)。
// 方案 1(main.js 的 DoH)已让 Electron net 的 DNS 走 Google/Cloudflare DoH, 但 DoH 服务器
// 本身可能不可达(如被墙)。本模块作为补充: 用 Node.js dns.Resolver 直连公共 DNS,
// 在下载前预解析域名, 超时则快速失败, 避免 downloadBuf 的 30 秒超时。

// Bug #35 修复: 之前用 8.8.8.8/1.1.1.1, 在国内被 GFW 污染/超时,
// 改为国内可靠公共 DNS (阿里 DNS + 腾讯 DNS), 失败时降级为 trust=true。
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

// [防 libuv uv_cancel abort 2026-09-08]
// dns.Resolver.resolve4 走 dns 模块内部线程池(底层也是 libuv)。当请求在途、但 JS 端已不持有
// Promise 引用(并发 fan-out 后丢弃 / 任务取消)时, V8 GC 会对在途请求调用 uv_cancel,
// libuv 在请求已提交线程池后 uv_cancel 返回非 0 -> 直接 abort 整个进程
// (崩溃栈: uv_free_interface_addresses + uv_fs_stat + OnFatalError -> SIGABRT, 与 09-02/09-05 同)。
// 修复: 把所有在途 DNS Promise 注册进模块级 Set, settle 后才移除, GC 永远碰不到在途请求。
const _dnsPending = new Set()
function _guardDns(promise) {
  _dnsPending.add(promise)
  promise.then(
    () => _dnsPending.delete(promise),
    () => _dnsPending.delete(promise)
  )
  return promise
}

// [DNS 限并发 2026-09-08] 避免下载峰值时 DNS 线程池 + fs 线程池 + sharpPool 同时满载叠加触发死锁。
const DNS_MAX_CONCURRENCY = 4
let _dnsRunning = 0
const _dnsQueue = []

function _resolveWithTimeout(hostname) {
  return _guardDns(new Promise((resolve) => {
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
  }))
}

// 对外: 带限流包装(内部 _resolveWithTimeout 已被 _guardDns 保活)
function resolveLimited(hostname) {
  if (_dnsRunning >= DNS_MAX_CONCURRENCY) {
    return new Promise((resolve) => {
      _dnsQueue.push(() => resolve(_resolveWithTimeout(hostname)))
    })
  }
  _dnsRunning++
  const p = _resolveWithTimeout(hostname)
  p.finally(() => {
    _dnsRunning--
    const next = _dnsQueue.shift()
    if (next) next()
  })
  return p
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

  // 用公共 DNS 解析(限并发 + 保活)
  const ips = await resolveLimited(hostname)
  const ok = ips !== null && ips.length > 0
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
  const hostnames = new Set()
  for (const u of urls) {
    try { hostnames.add(new URL(u).hostname) } catch {}
  }
  await Promise.all([...hostnames].map(h => prefetch(`https://${h}/`)))
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
