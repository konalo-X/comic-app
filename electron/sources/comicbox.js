'use strict'
/**
 * ComicBox 源 (https://www.comicbox.xyz) — 骨架版
 *
 * ⚠️ 当前状态: 网络层 + 章节图片提取为通用实现(复用 smtt6 模板)，
 *    目录/详情/搜索的选择器为占位 TODO，待用户提供页面 HTML 后填充。
 *    未注册进 registry.js（解析未定稿前不要启用，避免 app 加载半残源）。
 *
 * 需要用 VPN/代理环境下能访问 comicbox 的浏览器，把以下页面 HTML 发来:
 *   1) 书单页   https://www.comicbox.xyz/booklist?page=1
 *   2) 详情页   书单点进任意一本的漫画详情页
 *   3) 章节页   https://www.comicbox.xyz/free-chapter/43975?t=20260415
 */
const { URL } = require('url')
const https = require('https')
const http = require('http')
const zlib = require('zlib')
const cheerio = require('cheerio')
const ComicSource = require('./base')
const { net } = require('electron')
const { sleep, randomChoice, randomUA } = require('../utils')
const { getCookies, updateCookies } = require('../utils/cookieJar')

// ========== 智能爬虫配置（同 smtt6）==========
const RETRY_TIMES = 5
const TIMEOUT = 20000
const MAX_REDIRECTS = 5

const CRAWL_CONFIG = {
  baseDelay: 2000,
  randomDelayMax: 3000,
  adaptiveDelay: true,
  successDelayDecrease: 200,
  errorDelayIncrease: 1000,
  minDelay: 1500,
  maxDelay: 15000,
  maxConcurrency: 1,
  rotateHeaders: true,
  rotateUA: true,
  persistCookies: true,
  retryBackoff: true,
}
let currentAdaptiveDelay = CRAWL_CONFIG.baseDelay

const PLATFORMS = ['"macOS"', '"Windows"', '"Linux"']
function randomPlatform() { return randomChoice(PLATFORMS) }
function generateRequestFingerprint() {
  const chromeVersion = 120 + Math.floor(Math.random() * 15)
  return {
    ua: randomUA(),
    platform: randomPlatform(),
    secChUa: `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not_A Brand";v="24"`,
    acceptLanguage: Math.random() > 0.3 ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  }
}
function recordSuccess() {
  if (!CRAWL_CONFIG.adaptiveDelay) return
  currentAdaptiveDelay = Math.max(CRAWL_CONFIG.minDelay, currentAdaptiveDelay - CRAWL_CONFIG.successDelayDecrease)
}
function recordError() {
  if (!CRAWL_CONFIG.adaptiveDelay) return
  currentAdaptiveDelay = Math.min(CRAWL_CONFIG.maxDelay, currentAdaptiveDelay + CRAWL_CONFIG.errorDelayIncrease)
}
function calculateWaitTime() {
  const base = CRAWL_CONFIG.adaptiveDelay ? currentAdaptiveDelay : CRAWL_CONFIG.baseDelay
  return base + Math.random() * CRAWL_CONFIG.randomDelayMax
}
function absoluteUrl(href, base) {
  if (!href) return ''
  try { return new URL(href, base).href } catch { return href }
}

// ========== 请求队列 ==========
class RequestQueue {
  constructor(maxConcurrency = 1) { this.maxConcurrency = maxConcurrency; this.running = 0; this.queue = [] }
  async execute(fn) {
    return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this._process() })
  }
  async _process() {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) return
    this.running++
    const { fn, resolve, reject } = this.queue.shift()
    try { resolve(await fn()) }
    catch (e) { reject(e) }
    finally {
      this.running--
      const waitTime = calculateWaitTime()
      await sleep(waitTime)
      this._process()
    }
  }
}
const requestQueue = new RequestQueue(CRAWL_CONFIG.maxConcurrency)

// ========== Electron net 请求（同 smtt6，Chromium 栈）==========
function _fetchWithElectronNet(urlStr, referer, fingerprint, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const fp = fingerprint || generateRequestFingerprint()
    const parsed = new URL(urlStr)
    const headers = {
      'User-Agent': fp.ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': fp.acceptLanguage,
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': fp.secChUa,
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': fp.platform,
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    }
    // Bug #45 修复: Referer 通过 referrer 选项传给 Chromium
    const cookies = getCookies(parsed.hostname)
    if (cookies) headers['Cookie'] = cookies

    const request = net.request({ method: 'GET', url: urlStr, redirect: 'manual', referrer: referer || '' })
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value)

    let timeoutTimer = setTimeout(() => { request.abort(); reject(new Error('timeout')) }, TIMEOUT)
    request.on('response', (response) => {
      clearTimeout(timeoutTimer)
      const bodyTimer = setTimeout(() => {
        try { response.destroy() } catch (_) {}
        try { request.abort() } catch (_) {}
        reject(new Error('body timeout'))
      }, TIMEOUT)
      updateCookies(parsed.hostname, response.headers['set-cookie'])
      const statusCode = response.statusCode
      if ([301, 302, 307, 308].includes(statusCode)) {
        const location = response.headers['location']
        if (!location) { clearTimeout(bodyTimer); response.destroy(); return reject(new Error('Redirect without Location')) }
        clearTimeout(bodyTimer); response.destroy()
        if (redirectCount + 1 > MAX_REDIRECTS) return reject(new Error('Too many redirects'))
        return resolve(_fetchWithElectronNet(absoluteUrl(location, urlStr), urlStr, fp, redirectCount + 1))
      }
      if (statusCode >= 400) { clearTimeout(bodyTimer); response.destroy(); return reject(new Error('HTTP ' + statusCode)) }
      const chunks = []
      // Bug #8 同源修复: bodyTimer 在 data 时需要 reset,不能只 clear
      let bodyTimerReset = bodyTimer
      response.on('data', (chunk) => {
        clearTimeout(bodyTimerReset)
        bodyTimerReset = setTimeout(() => {
          try { response.destroy() } catch (_) {}
          try { request.abort() } catch (_) {}
          reject(new Error('body timeout'))
        }, TIMEOUT)
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(bodyTimerReset)
        const raw = Buffer.concat(chunks)
        const ct = (response.headers['content-type'] || '').toLowerCase()
        let html
        if (ct.includes('charset=gbk')) {
          try { html = new TextDecoder('gbk').decode(raw) } catch { html = raw.toString('utf8') }
        } else { html = raw.toString('utf8') }
        resolve(html)
      })
      response.on('error', (err) => { clearTimeout(bodyTimer); reject(err) })
    })
    request.on('error', (err) => { clearTimeout(timeoutTimer); reject(err) })
    request.end()
  })
}

// ========== 源类 ==========
class ComicboxSource extends ComicSource {
  get id() { return 'comicbox' }
  get name() { return 'ComicBox' }
  get lang() { return 'zh' }
  get baseUrl() { return 'https://www.comicbox.xyz' }

  async _fetch(url, referer = '', cancelledFn = null) {
    return requestQueue.execute(async () => {
      let fingerprint = generateRequestFingerprint()
      for (let i = 0; i < RETRY_TIMES; i++) {
        if (cancelledFn && cancelledFn()) throw new Error('cancelled')
        try {
          if (i > 0 || requestQueue.running > 0) {
            await sleep(calculateWaitTime())
          }
          const result = await _fetchWithElectronNet(url, referer, fingerprint)
          recordSuccess()
          return result
        } catch (e) {
          if (cancelledFn && (e.message === 'cancelled' || cancelledFn())) throw e
          const msg = e.message || ''
          console.warn(`[comicbox] 尝试 ${i + 1}/${RETRY_TIMES} 失败: ${msg} (${url})`)
          recordError()
          if (i === RETRY_TIMES - 1) throw e
          let backoffMs
          if (msg.includes('ECONNRESET') || msg.includes('ERR_CONNECTION_RESET')) backoffMs = Math.min(30000, 2000 * Math.pow(2, i) + Math.random() * 3000)
          else if (msg.includes('timeout') || msg.includes('body timeout')) backoffMs = Math.min(60000, 3000 * Math.pow(2, i) + Math.random() * 5000)
          else if (msg.includes('429')) backoffMs = Math.min(60000, 5000 * Math.pow(2, i) + Math.random() * 5000)
          else if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) backoffMs = Math.min(60000, 5000 * Math.pow(2, i) + Math.random() * 3000)
          else backoffMs = (i + 1) * 2000 + Math.random() * 2000
          await sleep(backoffMs)
          fingerprint = generateRequestFingerprint()
        }
      }
    })
  }

  // ---- 搜索：URL 待定，需 HTML 确认 ----
  async search(query, page = 1, cancelledFn = null) {
    // TODO: 根据 comicbox 搜索页 HTML 确定 URL（如 /search?q= 或 /booklist?key=）
    const url = `${this.baseUrl}/booklist?key=${encodeURIComponent(query)}&page=${page}`
    console.warn('[comicbox] search 选择器未定稿，返回空，待页面 HTML')
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  async getPopular(page = 1, cancelledFn = null) {
    const url = `${this.baseUrl}/booklist?page=${page}`
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  async getLatest(page = 1, cancelledFn = null) {
    const url = `${this.baseUrl}/booklist?page=${page}`
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  // ---- 目录/列表解析：占位 TODO ----
  _parseList(html, sourceUrl) {
    const $ = cheerio.load(html)
    const items = []
    // TODO: 根据 booklist HTML 写真实选择器（封面/标题/链接/更新时间/分类）
    console.warn('[comicbox] _parseList 选择器未定稿，请发送 booklist 页面 HTML')
    return { items, totalCount: 0, totalPages: 0, currentPage: 0 }
  }

  // ---- 详情：占位 TODO ----
  async getDetail(url, cancelledFn = null) {
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    const $ = cheerio.load(html)
    console.warn('[comicbox] getDetail 选择器未定稿，请发送详情页 HTML')
    return { title: '', cover: '', author: '', status: '', desc: '', tags: [], category: '', chapters: [], updateTime: 0 }
  }

  // ---- 章节图片：通用提取（多数站可用，待章节页 HTML 校准）----
  async getPageList(chapterUrl, referer, cancelledFn = null) {
    const html = await this._fetch(chapterUrl, referer || this.baseUrl + '/', cancelledFn)
    const $ = cheerio.load(html)
    const images = []
    const seen = new Set()
    function addUrl(u) {
      if (!u) return
      const abs = absoluteUrl(u, chapterUrl)
      if (!abs || seen.has(abs)) return
      seen.add(abs)
      images.push(abs)
    }
    $('img').each((i, el) => {
      const $el = $(el)
      for (const c of [$el.attr('data-original'), $el.attr('data-src'), $el.attr('data-lazy-src'), $el.attr('src')]) addUrl(c)
    })
    if (images.length < 3) {
      $('script').each((i, el) => {
        const script = $(el).html() || ''
        const arrayMatches = script.match(/\[[^\]]*https?:\/\/[^\[\]"' ]+\.(jpg|jpeg|png|webp|gif)[^\[\]]*\]/gi)
        if (arrayMatches) for (const m of arrayMatches) {
          const urls = m.match(/https?:\/\/[^\s"'\\]+\.(jpg|jpeg|png|webp|gif)/gi) || []
          for (const u of urls) addUrl(u)
        }
      })
    }
    const chapterName = $('h1,h2,.chapter-title').first().text().trim()
    console.log(`[comicbox] 章节解析: ${chapterUrl} -> ${images.length} 张`)
    return { images, chapterName }
  }

  // ---- 图片下载：真实（同 smtt6）----
  async fetchImage(imageUrl, referer) {
    for (let i = 0; i < 3; i++) {
      try { return await _downloadImage(imageUrl, referer || imageUrl) }
      catch (e) { if (i === 2) throw e; await sleep(1000 * (i + 1)) }
    }
  }
}

// 图片下载（Electron net，与浏览器 DNS 解析一致）
function _downloadImage(imageUrl, referer, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const fp = generateRequestFingerprint()

    // 使用 Electron net 模块 (Chromium 网络栈), 避免 Node.js getaddrinfo ENOTFOUND
    // Bug #45 修复: 用 referrer 选项替代 setHeader('Referer', ...), 避免跨域 referrer 被拦截
    const request = net.request({
      method: 'GET',
      url: imageUrl,
      redirect: 'manual',
      referrer: referer || '',
    })
    request.setHeader('User-Agent', fp.ua)
    request.setHeader('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8')
    request.setHeader('Accept-Language', fp.acceptLanguage)
    request.setHeader('Accept-Encoding', 'gzip, deflate, br')
    request.setHeader('Cache-Control', 'no-cache')

    let timeoutTimer = setTimeout(() => {
      try { request.abort() } catch (_) {}
      reject(new Error('Request timeout'))
    }, 30000)

    request.on('response', (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(timeoutTimer)
        try { request.abort() } catch (_) {}
        res.resume()
        if (redirectCount + 1 > MAX_REDIRECTS) return reject(new Error('Too many redirects'))
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, imageUrl).href
        return _downloadImage(nextUrl, referer, redirectCount + 1).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeoutTimer)
        res.resume()
        try { request.abort() } catch (_) {}
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const chunks = []
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip())
        : res.headers['content-encoding'] === 'deflate' ? res.pipe(zlib.createInflate())
        : res.headers['content-encoding'] === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => {
        clearTimeout(timeoutTimer)
        const buf = Buffer.concat(chunks)
        if (buf.length === 0) return reject(new Error('Empty response'))
        resolve(buf)
      })
      stream.on('error', (e) => { clearTimeout(timeoutTimer); reject(e) })
    })

    request.on('error', (e) => { clearTimeout(timeoutTimer); reject(e) })
    request.end()
  })
}

module.exports = ComicboxSource
