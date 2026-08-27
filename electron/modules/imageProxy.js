'use strict'
const http = require('http')
const url = require('url')
const path = require('path')
const fs = require('fs')

const cache = require('../cache')
const sources = require('../sources/registry')
const {
  getProxyImageUrl,
  getLocalProxyUrl,
  getProxyPort,
  getProxyBaseUrl
} = require('../utils/proxyUrl')

const inflightRequests = new Map()
// Bug #2 修复: /local 端点只允许读取白名单目录下的图片文件
// 默认空数组: 白名单未配置前拒绝所有请求; 由 startup.js 在完成路径配置后通过 setAllowedLocalDirs 注入
let _allowedLocalDirs = []
const ALLOWED_IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.bmp','.svg','.avif'])
function setAllowedLocalDirs(dirList) {
  _allowedLocalDirs = Array.isArray(dirList) ? dirList.filter(Boolean).map(d => path.resolve(String(d))) : []
}
async function _validateLocalPath(localPath) {
  // 返回 { status: 'allow'|'deny'|'placeholder', reason?: string, resolved?: string }
  if (!localPath || typeof localPath !== 'string') return { status: 'deny', reason: 'bad-path' }
  if (localPath.indexOf('\0') >= 0) return { status: 'deny', reason: 'nul-byte' }
  if (!path.isAbsolute(localPath)) return { status: 'deny', reason: 'not-absolute' }
  let resolved
  try {
    resolved = path.resolve(localPath)
    // 白名单尚未配置 -> 全部拒绝(安全默认)
    if (_allowedLocalDirs.length === 0) return { status: 'deny', reason: 'whitelist-empty' }
    // 必须是真实存在的文件(异步,避免主线程扫外部盘)
    let stat
    try { stat = await fs.promises.stat(resolved) } catch (_) { return { status: 'placeholder' } }
    if (!stat.isFile()) return { status: 'deny', reason: 'not-a-file' }
    // 只允许图片后缀
    const ext = path.extname(resolved).toLowerCase()
    if (!ALLOWED_IMAGE_EXTS.has(ext)) return { status: 'deny', reason: 'bad-ext:' + ext }
    // 必须在白名单目录树中
    for (const allowed of _allowedLocalDirs) {
      const prefix = allowed.endsWith(path.sep) ? allowed : (allowed + path.sep)
      if (resolved.startsWith(prefix)) return { status: 'allow', resolved }
      // 等于目录本身不算(不能读目录)
    }
    return { status: 'deny', reason: 'out-of-whitelist' }
  } catch (e) {
    return { status: 'deny', reason: 'error:' + (e.code || e.message) }
  }
}

async function fetchAndCacheImage(imageUrl, refererUrl) {
  const cached = cache.getCachedPath(imageUrl)
  if (cached) {
    return fs.promises.readFile(cached)
  }

  if (inflightRequests.has(imageUrl)) {
    return inflightRequests.get(imageUrl)
  }

  const src = imageUrl.includes('smtt6') ? sources.get('smtt6') : sources.default
  const p = (async () => {
    try {
      let buf = null
      try {
        buf = await src.fetchImage(imageUrl, refererUrl || imageUrl)
      } catch (e) {
        // 18rouman.vip CDN 的封面 URL 可能是占位主机/后缀, 首次请求返回 404/403 时
        // 尝试 URL 变体(切换 p4p↔p3p 等主机、.webp↔.jpg 后缀), 与章节图片下载逻辑一致。
        // 注意: 这里直接用 src.fetchImage (Electron net + DoH) 请求变体, 而非 downloadBuf,
        // 因为 downloadBuf 内部的 dnsCache.prefetch 用 8.8.8.8/1.1.1.1 (国内被墙/DNS污染),
        // 会导致变体域名预解析失败或返回污染 IP, 反而拖垮下载。
        const msg = (e && e.message) || ''
        if (/HTTP 40[34]/i.test(msg)) {
          try {
            const { generateImageUrlVariants } = require('./downloadPaths')
            const variants = generateImageUrlVariants(imageUrl)
            // 跳过第 0 个(原 URL, 已知 404), 最多试 10 个变体
            for (let vi = 1; vi < Math.min(variants.length, 11); vi++) {
              try {
                const vBuf = await src.fetchImage(variants[vi], refererUrl || imageUrl)
                if (vBuf && vBuf.length > 0) {
                  buf = vBuf
                  console.log(`[Proxy] 封面变体命中 (${vi}/${variants.length-1}): ${variants[vi].substring(0, 80)}...`)
                  break
                }
              } catch (_) {
                // 继续下一个变体
              }
            }
          } catch (e2) {
            console.warn(`[Proxy] 封面变体回退失败: ${imageUrl.substring(0, 80)}... -> ${e2.message}`)
          }
        } else {
          throw e
        }
      }
      if (buf && buf.length > 0) {
        await cache.setCache(imageUrl, buf)
      }
      return buf
    } finally {
      inflightRequests.delete(imageUrl)
    }
  })()
  inflightRequests.set(imageUrl, p)
  return p
}

function startImageProxyServer() {
  const placeholderSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
    '<rect fill="#222" width="800" height="600"/>' +
    '<text fill="#666" font-family="sans-serif" font-size="24" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">图片加载失败</text>' +
    '</svg>'
  )

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = new url.URL(req.url, getProxyBaseUrl())

      if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
        return
      }

      if (parsed.pathname === '/local') {
        const pB64 = decodeURIComponent(parsed.searchParams.get('p') || '')
        let localPath = ''
        try { localPath = pB64 ? Buffer.from(pB64, 'base64').toString('utf-8') : '' } catch {}
        const v = await _validateLocalPath(localPath)
        if (v.status === 'allow' && v.resolved) {
          const ext = path.extname(v.resolved).toLowerCase()
          const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' :
                     ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' :
                     ext === '.avif' ? 'image/avif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
          try {
            const stat = await fs.promises.stat(v.resolved)
            res.writeHead(200, {
              'Content-Type': ct,
              'Content-Length': stat.size,
              'Cache-Control': 'public, max-age=31536000',
              'X-Source': 'local'
            })
            // Bug #41 修复: 加 error/close 处理, 防止 fd 泄漏
            const rs = fs.createReadStream(v.resolved)
            rs.on('error', () => { try { res.destroy() } catch {} })
            res.on('close', () => { try { rs.destroy() } catch {} })
            rs.pipe(res)
          } catch (e) {
            // Bug #41 修复: 返回 404 而非 placeholder SVG, 让前端 @error 能触发回退到在线封面
            console.warn(`[Proxy] 本地文件不存在: ${v.resolved} -> ${e.message}`)
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('Local file not found')
          }
          return
        }
        // deny 或 placeholder:全部返回占位图,不暴露 deny 原因
        if (v.status === 'deny') {
          console.warn(`[Proxy] /local 请求被拒绝: ${v.reason} <- ${String(localPath).substring(0,120)}`)
        }
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(placeholderSvg)
        return
      }

      if (parsed.pathname !== '/img') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const uB64 = decodeURIComponent(parsed.searchParams.get('u') || '')
      const rB64 = decodeURIComponent(parsed.searchParams.get('r') || '')
      const imageUrl = uB64 ? Buffer.from(uB64, 'base64').toString('utf-8') : ''
      const refererUrl = rB64 ? Buffer.from(rB64, 'base64').toString('utf-8') : ''

      if (!imageUrl) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(placeholderSvg)
        return
      }

      const cachedPath = cache.getCachedPath(imageUrl)
      if (cachedPath) {
        const ext = path.extname(imageUrl).toLowerCase().replace(/\?.*/, '') || '.jpg'
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg'
        try {
          const stat = await fs.promises.stat(cachedPath)
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=31536000',
            'X-Cache': 'HIT'
          })
          // Bug #18 修复: 加 error/close 处理, 防止 fd 泄漏
          const rs = fs.createReadStream(cachedPath)
          rs.on('error', () => { try { res.destroy() } catch {} })
          res.on('close', () => { try { rs.destroy() } catch {} })
          rs.pipe(res)
          return
        } catch (e) {
          console.warn(`[Proxy] 读取缓存文件失败: ${imageUrl} -> ${e.message}`)
        }
      }

      try {
        const buf = await fetchAndCacheImage(imageUrl, refererUrl)
        if (!buf || buf.length === 0) {
          console.warn(`[Proxy] 图片为空: ${imageUrl}`)
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
          return
        }

        let ct = 'image/jpeg'
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) ct = 'image/png'
        else if (buf[0] === 0xff && buf[1] === 0xd8) ct = 'image/jpeg'
        else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ct = 'image/gif'
        else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf.toString('utf-8', 8, 12) === 'WEBP') ct = 'image/webp'

        console.log(`[Proxy] 图片缓存: ${imageUrl} (${(buf.length/1024).toFixed(1)}KB)`)
        res.writeHead(200, {
          'Content-Type': ct,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000',
          'X-Cache': 'MISS'
        })
        res.end(buf)
        return
      } catch (e) {
        console.warn(`[Proxy] 图片缓存失败: ${imageUrl} -> ${e.message}`)
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
        res.end(placeholderSvg)
        return
      }
    } catch (e) {
      console.warn('[Proxy] 请求异常:', req.url, e.message)
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      res.end(placeholderSvg)
    }
  })

  let attempts = 0
  const maxAttempts = 10
  function tryListen() {
    const basePort = getProxyPort()
    const port = basePort + attempts
    if (attempts >= maxAttempts) {
      console.error('[Proxy] 无法找到可用端口，图片代理启动失败')
      return
    }
    server.listen(port, '127.0.0.1', () => {
      if (port !== basePort) {
        const { setProxyPort } = require('../utils/proxyUrl')
        setProxyPort(port)
      }
      console.log(`[Proxy] 图片代理运行在 http://127.0.0.1:${port}`)
    })
  }
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      attempts++
      console.log(`[Proxy] 端口 ${getProxyPort() + attempts - 1} 被占用，尝试 ${getProxyPort() + attempts}...`)
      server.close()
      tryListen()
    } else {
      console.warn('[Proxy] 服务器错误:', e.message)
    }
  })
  tryListen()
}

module.exports = {
  getProxyImageUrl,
  getLocalProxyUrl,
  fetchAndCacheImage,
  startImageProxyServer,
  setAllowedLocalDirs
}