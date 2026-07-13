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
      const buf = await src.fetchImage(imageUrl, refererUrl || imageUrl)
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
        const localPath = pB64 ? Buffer.from(pB64, 'base64').toString('utf-8') : ''
        if (!localPath || !fs.existsSync(localPath)) {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
          return
        }
        const ext = path.extname(localPath).toLowerCase()
        const ct = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' :
                   ext === '.gif' ? 'image/gif' : ext === '.svg' ? 'image/svg+xml' :
                   ext === '.avif' ? 'image/avif' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg'
        try {
          const stat = fs.statSync(localPath)
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=31536000',
            'X-Source': 'local'
          })
          fs.createReadStream(localPath).pipe(res)
        } catch (e) {
          console.warn(`[Proxy] 读取本地文件失败: ${localPath} -> ${e.message}`)
          res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
          res.end(placeholderSvg)
        }
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
          const stat = fs.statSync(cachedPath)
          res.writeHead(200, {
            'Content-Type': ct,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=31536000',
            'X-Cache': 'HIT'
          })
          fs.createReadStream(cachedPath).pipe(res)
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
  startImageProxyServer
}