'use strict'
const { URL } = require('url')
const https = require('https')
const http = require('http')
const zlib = require('zlib')
const cheerio = require('cheerio')
const ComicSource = require('./base')
const { net } = require('electron')
const { sleep, randomChoice, randomUA } = require('../utils')
const { getCookies, updateCookies } = require('../utils/cookieJar')

// 将 "2024-01-15" / "2024年01月15日" / "01月15日" / "2024/01/15" 等格式转换为时间戳
function parseDateToTimestamp(dateStr) {
  if (!dateStr) return 0
  const s = String(dateStr).trim()
  if (!s) return 0

  // 格式1: 2024-01-15 或 2024/01/15
  let m = s.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/)
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
    return isNaN(t) ? 0 : t
  }
  // 格式2: 01月15日（缺少年份，用当前年）
  m = s.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const nowYear = new Date().getFullYear()
    const t = new Date(nowYear, Number(m[1]) - 1, Number(m[2])).getTime()
    return isNaN(t) ? 0 : t
  }
  // 格式3: 01-15 或 01/15
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})$/)
  if (m) {
    const nowYear = new Date().getFullYear()
    const t = new Date(nowYear, Number(m[1]) - 1, Number(m[2])).getTime()
    return isNaN(t) ? 0 : t
  }
  // 格式4: 纯数字时间戳（秒或毫秒）
  if (/^\d{10,13}$/.test(s)) {
    const num = Number(s)
    return num < 1e12 ? num * 1000 : num
  }
  // 最后尝试直接 new Date
  const t = new Date(s).getTime()
  return isNaN(t) ? 0 : t
}

const RETRY_TIMES = 5
const TIMEOUT = 90000

// ========== 智能爬虫配置 ==========
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

// ========== 请求指纹 ==========
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

// ========== 自适应延迟 ==========
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

// ========== 请求队列 ==========
class RequestQueue {
  constructor(maxConcurrency = 1) {
    this.maxConcurrency = maxConcurrency
    this.running = 0
    this.queue = []
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject })
      this._process()
    })
  }

  async _process() {
    if (this.running >= this.maxConcurrency || this.queue.length === 0) return
    this.running++
    const { fn, resolve, reject } = this.queue.shift()
    try {
      resolve(await fn())
    } catch (e) {
      reject(e)
    } finally {
      this.running--
      const waitTime = calculateWaitTime()
      await sleep(waitTime)
      this._process()
    }
  }
}

const requestQueue = new RequestQueue(CRAWL_CONFIG.maxConcurrency)

// ========== URL 工具 ==========
function absoluteUrl(href, base) {
  if (!href) return ''
  try { return new URL(href, base).href } catch { return href }
}

// ========== 核心请求（Electron net 模块 - Chromium 网络栈） ==========
function _fetchWithElectronNet(urlStr, referer, fingerprint) {
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

    if (referer) headers['Referer'] = referer

    const cookies = getCookies(parsed.hostname)
    if (cookies) headers['Cookie'] = cookies

    const request = net.request({
      method: 'GET',
      url: urlStr,
      redirect: 'manual',
    })

    // 设置请求头
    for (const [key, value] of Object.entries(headers)) {
      request.setHeader(key, value)
    }

    let timeoutTimer = setTimeout(() => {
      request.abort()
      reject(new Error('timeout'))
    }, TIMEOUT)

    request.on('response', (response) => {
      clearTimeout(timeoutTimer)

      // body 接收超时保护：response 头已到、但 data/end 永远不来（半截卡死）时兜底
      const bodyTimer = setTimeout(() => {
        try { response.destroy() } catch (_) {}
        try { request.abort() } catch (_) {}
        reject(new Error('body timeout'))
      }, TIMEOUT)

      updateCookies(parsed.hostname, response.headers['set-cookie'])

      const statusCode = response.statusCode
      if ([301, 302, 307, 308].includes(statusCode)) {
        const location = response.headers['location']
        if (!location) {
          clearTimeout(bodyTimer)
          response.destroy()
          return reject(new Error('Redirect without Location'))
        }
        clearTimeout(bodyTimer)
        response.destroy()
        return resolve(_fetchWithElectronNet(absoluteUrl(location, urlStr), urlStr, fp))
      }

      if (statusCode >= 400) {
        clearTimeout(bodyTimer)
        response.destroy()
        return reject(new Error('HTTP ' + statusCode))
      }

      const chunks = []
      response.on('data', (chunk) => {
        clearTimeout(bodyTimer)
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(bodyTimer)
        const raw = Buffer.concat(chunks)
        // Electron net 自动解压，直接转字符串
        const ct = (response.headers['content-type'] || '').toLowerCase()
        let html
        if (ct.includes('charset=gbk')) {
          try { html = new TextDecoder('gbk').decode(raw) } catch { html = raw.toString('utf8') }
        } else {
          html = raw.toString('utf8')
        }
        resolve(html)
      })
      response.on('error', (err) => {
        clearTimeout(bodyTimer)
        reject(err)
      })
    })

    request.on('error', (err) => {
      clearTimeout(timeoutTimer)
      reject(err)
    })

    request.end()
  })
}

// ========== 漫画源类 ==========
class Smtt6Source extends ComicSource {
  get id() { return 'smtt6' }
  get name() { return 'SM动漫' }
  get lang() { return 'zh' }
  get baseUrl() { return 'https://smtt6.com' }

  async _fetch(url, referer = '') {
    return requestQueue.execute(async () => {
      let fingerprint = generateRequestFingerprint()

      for (let i = 0; i < RETRY_TIMES; i++) {
        try {
          if (i > 0 || requestQueue.running > 0) {
            const waitTime = calculateWaitTime()
            console.log(`[SmartCrawl] 等待 ${(waitTime / 1000).toFixed(1)}s 后请求...`)
            await sleep(waitTime)
          }

          const result = await _fetchWithElectronNet(url, referer, fingerprint)
          recordSuccess()
          console.log(`[SmartCrawl] 成功: ${url}`)
          return result
        } catch (e) {
          const msg = e.message || ''
          console.warn(`[SmartCrawl] 尝试 ${i + 1}/${RETRY_TIMES} 失败: ${msg} (${url})`)
          recordError()

          if (i === RETRY_TIMES - 1) throw e

          let backoffMs
          if (msg.includes('ECONNRESET') || msg.includes('ERR_CONNECTION_RESET')) {
            backoffMs = Math.min(30000, 2000 * Math.pow(2, i) + Math.random() * 3000)
            console.log(`[SmartCrawl] 连接重置，退避 ${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          } else if (msg.includes('timeout') || msg.includes('body timeout')) {
            // 超时错误增加更长的退避时间，并增加重试次数
            backoffMs = Math.min(60000, 3000 * Math.pow(2, i) + Math.random() * 5000)
            console.log(`[SmartCrawl] 请求超时，退避 ${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          } else if (msg.includes('429')) {
            backoffMs = Math.min(60000, 5000 * Math.pow(2, i) + Math.random() * 5000)
            console.log(`[SmartCrawl] 请求过于频繁(429)，退避 ${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          } else if (msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN')) {
            // DNS 解析失败，等待更长时间
            backoffMs = Math.min(60000, 5000 * Math.pow(2, i) + Math.random() * 3000)
            console.log(`[SmartCrawl] DNS 解析失败，退避 ${(backoffMs / 1000).toFixed(1)}s 后重试...`)
          } else {
            backoffMs = (i + 1) * 2000 + Math.random() * 2000
          }

          await sleep(backoffMs)
          fingerprint = generateRequestFingerprint()
        }
      }
    })
  }

  async search(query, page = 1) {
    const url = `${this.baseUrl}/cata.php?key=${encodeURIComponent(query)}`
    const html = await this._fetch(url, this.baseUrl + '/')
    return this._parseList(html, url)
  }

  async getPopular(page = 1) {
    const url = `${this.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/${page}`
    const html = await this._fetch(url, this.baseUrl + '/')
    return this._parseList(html, url)
  }

  async getLatest(page = 1) {
    const url = `${this.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/${page}`
    const html = await this._fetch(url, this.baseUrl + '/')
    return this._parseList(html, url)
  }

  _parseList(html, sourceUrl) {
    const $ = cheerio.load(html)
    const items = []
    let pageCategory = $('h1.hl-title, h2.hl-title').first().text().trim()

    $('li.hl-list-item').each((i, el) => {
      const $li = $(el)
      const $a = $li.find('a').first()
      const href = absoluteUrl($a.attr('href') || '', sourceUrl)
      const title = $li.find('h2').first().text().trim() ||
                    $li.find('[class*="title"]').first().text().trim() ||
                    $a.attr('title') || ''
      let cover = $li.find('.hl-item-thumb[data-original]').attr('data-original') ||
                  $li.find('img[data-original]').attr('data-original') ||
                  $li.find('img[src]').attr('src') || ''
      if (cover && !cover.startsWith('http')) cover = absoluteUrl(cover, sourceUrl)

      let updateTimeStr = ''
      const $bt = $li.find('b.hl-list-tips, span[class*="time"]')
      if ($bt.length) updateTimeStr = $bt.first().text().trim()
      const timeMatch = $.text().match(/\d{4}-\d{2}-\d{2}/)

      let itemCategory = $li.find('span.hl-tag, span[class*="type"]').first().text().trim()

      if (href && title) {
        const rawUpdateTime = updateTimeStr || (timeMatch ? timeMatch[0] : '')
        items.push({
          title, cover, sourceUrl: href,
          updateTime: parseDateToTimestamp(rawUpdateTime),
          category: itemCategory || pageCategory || ''
        })
      }
    })
    return items
  }

  getNextPageUrl(currentPageUrl, currentPageHtml) {
    if (!currentPageHtml) return null
    const $ = cheerio.load(currentPageHtml)
    const $pagination = $('ul.hl-page-wrap')
    if ($pagination.length === 0) return null
    const $next = $pagination.find('a').filter((i, el) => $(el).text().includes('下一页'))
    if ($next.length > 0) return absoluteUrl($next.attr('href') || '', currentPageUrl)
    return null
  }

  async getDetail(url) {
    const html = await this._fetch(url, this.baseUrl + '/')
    const $ = cheerio.load(html)
    const result = {
      title: '', cover: '', author: '', status: '',
      desc: '', tags: [], category: '', chapters: [],
      updateTime: 0
    }

    result.title = $('meta[property="og:title"]').attr('content') ||
      $('h1.hl-dc-title').first().text().trim()

    result.cover = $('meta[property="og:image"]').attr('content') ||
      $('.hl-item-thumb[data-original]').first().attr('data-original') ||
      $('img.hl-item-thumb[data-original]').attr('data-original') || ''

    // 严格的详情页字段解析：按字段标签位置切分，避免空字段时把下一个标签当作值
    const contentText = $('div.hl-dc-content').first().text() || ''
    // 定义所有可能出现的字段标签（按优先级/常见度排列）
    const LABEL_MAP = {
      '作者': 'author',
      '状态': 'status',
      '简介': 'desc_raw',
      '类别': 'category_raw',
      '分类': 'category_raw',
      '标签': 'tags_raw',
      'TAG': 'tags_raw',
      '更新': 'update_raw',
      '连载': 'status_extra',
      '最新章节': 'chapter_raw',
      '章节': 'chapter_raw',
      '地区': 'region_raw',
    }
    const ALL_LABELS = Object.keys(LABEL_MAP)

    // 第一步：扫描 contentText，找出所有标签出现的位置
    const labelPositions = []
    for (const label of ALL_LABELS) {
      const fullLabel1 = label + '：'
      const fullLabel2 = label + ':'
      const idx1 = contentText.indexOf(fullLabel1)
      const idx2 = contentText.indexOf(fullLabel2)
      const idx = idx1 >= 0 && idx2 >= 0 ? Math.min(idx1, idx2) : Math.max(idx1, idx2)
      if (idx >= 0) {
        // 选择实际匹配到的那个标签字符串（全角或半角冒号）
        const matchedLabel = (idx === idx1 && idx1 >= 0) ? fullLabel1 : fullLabel2
        labelPositions.push({ pos: idx, label, matchedLabel, field: LABEL_MAP[label] })
      }
    }
    // 按位置排序
    labelPositions.sort((a, b) => a.pos - b.pos)

    // 第二步：根据位置切分，每个字段的值 = 当前标签结束位置 到 下一个标签开始位置
    const parsed = {}
    for (let i = 0; i < labelPositions.length; i++) {
      const cur = labelPositions[i]
      const startPos = cur.pos + cur.matchedLabel.length
      const endPos = i + 1 < labelPositions.length ? labelPositions[i + 1].pos : contentText.length
      let val = contentText.substring(startPos, endPos).trim()
      // 清理常见的分隔符、多余空格
      val = val.replace(/^[\s,，|\/\\]+|[\s,，|\/\\]+$/g, '').trim()
      // 如果值为空或只包含空白/分隔符，视为空字段
      parsed[cur.field] = val
    }

    result.author = parsed.author || ''
    // 状态可能在状态字段或连载字段中
    result.status = parsed.status || parsed.status_extra || ''

    // 简介优先从 meta 标签取，其次才从 contentText 解析
    const metaDesc = $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content')
    result.desc = metaDesc || parsed.desc_raw || $('div.hl-dc-desc').first().text().trim()

    // 类别/标签从页面链接中提取（比文本解析更可靠）
    const $tagEm = $('em.hl-text-muted').filter((i, el) => $(el).text().trim().includes('TAG'))
    if ($tagEm.length > 0) {
      $tagEm.closest('li').find('a[href*="/man-hua-lei-bie/"]').each((i, el) => {
        result.tags.push($(el).text().trim())
      })
      result.tags = [...new Set(result.tags)]
    }
    const validCategories = ['日漫', '韩漫', '真人', '3D漫画', '同性']
    let matchedTagIdx = -1
    for (let i = 0; i < result.tags.length; i++) {
      const tag = result.tags[i]
      const match = validCategories.find(cat => tag.includes(cat) || cat.includes(tag))
      if (match) { result.category = match.includes('3D') ? '3D漫画' : match; matchedTagIdx = i; break }
    }
    if (matchedTagIdx >= 0) {
      result.tags.splice(matchedTagIdx, 1)
    }
    // 如果从标签链接中没提取到分类，回退到文本解析的"类别/分类"字段
    if (!result.category && parsed.category_raw) {
      const rawCat = parsed.category_raw.trim()
      for (const cat of validCategories) {
        if (rawCat.includes(cat) || cat.includes(rawCat)) {
          result.category = cat.includes('3D') ? '3D漫画' : cat
          break
        }
      }
      // 如果仍然没匹配到，直接使用原始值（只要不是纯数字/乱码）
      if (!result.category && rawCat.length >= 2 && rawCat.length <= 10 && !/^\d+$/.test(rawCat)) {
        result.category = rawCat
      }
    }

    const $playsList = $('ul#hl-plays-list')
    if ($playsList.length > 0) {
      $playsList.find('a.module-play-list-link').each((i, el) => {
        const $a = $(el)
        result.chapters.push({
          name: $a.text().trim(),
          url: absoluteUrl($a.attr('href') || '', url)
        })
      })
    }
    if (result.chapters.length === 0) {
      $playsList.find('a').each((i, el) => {
        const text = $(el).text().trim()
        if (text) result.chapters.push({ name: text, url: absoluteUrl($(el).attr('href') || '', url) })
      })
    }

    // 从详情页提取更新时间：先查内容区的日期文本，再查章节名中的日期
    const fullText = $('body').text() || ''
    let detailUpdateTime = 0
    const dateMatch = fullText.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/)
    if (dateMatch) {
      detailUpdateTime = parseDateToTimestamp(dateMatch[0])
    }
    // 还可以从最新章节名里提取（比如章节名含 "第12话 2024年01月15日"）
    if (!detailUpdateTime && result.chapters.length > 0) {
      const lastChapterName = result.chapters[result.chapters.length - 1].name || ''
      const lastDateMatch = lastChapterName.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/)
      if (lastDateMatch) {
        detailUpdateTime = parseDateToTimestamp(lastDateMatch[0])
      }
    }
    result.updateTime = detailUpdateTime

    return result
  }

  async getPageList(chapterUrl, referer) {
    const html = await this._fetch(chapterUrl, referer || this.baseUrl + '/')
    const $ = cheerio.load(html)
    const images = []
    const seen = new Set()

    function addUrl(u) {
      if (!u) return
      const abs = absoluteUrl(u, chapterUrl)
      if (!abs || seen.has(abs)) return
      if (!/\.(jpg|jpeg|png|webp|gif|bmp|svg)(\?|#|$)/i.test(abs) && !abs.includes('image') && !abs.includes('img') && !abs.includes('/pic/') && !abs.includes('/photo/')) {
        if (!/^https?:\/\//.test(abs)) return
      }
      seen.add(abs)
      images.push(abs)
    }

    $('img').each((i, el) => {
      const $el = $(el)
      const candidates = [
        $el.attr('data-original'),
        $el.attr('data-src'),
        $el.attr('data-lazy-src'),
        $el.attr('data-url'),
        $el.attr('data-img'),
        $el.attr('src')
      ]
      for (const c of candidates) addUrl(c)
    })

    if (images.length < 3) {
      $('script').each((i, el) => {
        const script = $(el).html() || ''
        if (!script) return

        const arrayMatches = script.match(/\[[^\]]*https?:\/\/[^\[\]"' ]+\.(jpg|jpeg|png|webp|gif)[^\[\]]*\]/gi)
        if (arrayMatches) {
          for (const m of arrayMatches) {
            const urls = m.match(/https?:\/\/[^\s"'\\]+\.(jpg|jpeg|png|webp|gif)/gi) || []
            for (const u of urls) addUrl(u)
          }
        }

        const varMatches = script.match(/(?:chapterImages|chapterPic|chapter_?images|chapter_?pic|images|photos|picList|imgList|pictureList)\s*[=:]\s*\[([^\]]*)\]/i)
        if (varMatches && varMatches[1]) {
          const urls = varMatches[1].match(/https?:\/\/[^\s"'\\)]+|\b[^"\s',]+\.(jpg|jpeg|png|webp|gif)/gi) || []
          for (const u of urls) addUrl(u)
        }

        const urlMatches = script.match(/https?:\/\/[^\s"'<>)]+\.(jpg|jpeg|png|webp|gif)(\?[^\s"'<>)]*)?/gi)
        if (urlMatches && images.length < 5) {
          for (const u of urlMatches) addUrl(u)
        }
      })
    }

    if (images.length < 3) {
      $('*').each((i, el) => {
        const $el = $(el)
        const attrs = $el.attr()
        for (const [k, v] of Object.entries(attrs || {})) {
          if (k.startsWith('data-') && typeof v === 'string') {
            if (/https?:\/\/[^\s]+\.(jpg|jpeg|png|webp|gif)/i.test(v)) {
              const u = v.match(/https?:\/\/[^\s"'<>)]*\.(jpg|jpeg|png|webp|gif)(\?[^\s"'<>)]*)?/i)
              if (u) addUrl(u[0])
            }
          }
        }
      })
    }

    let chapterName = ''
    const h2Text = $('h2').first().text().trim()
    if (h2Text) chapterName = h2Text

    console.log(`[smtt6] 解析章节: ${chapterUrl} -> 找到 ${images.length} 张图片`)

    return { images, chapterName }
  }

  async fetchImage(imageUrl, referer) {
    for (let i = 0; i < 3; i++) {
      try {
        return await _downloadImage(imageUrl, referer || imageUrl)
      } catch (e) {
        if (i === 2) throw e
        await sleep(1000 * (i + 1))
      }
    }
  }
}

// ========== 图片下载（Node.js https，绕过 Electron referrer 检查） ==========
function _downloadImage(imageUrl, referer) {
  return new Promise((resolve, reject) => {
    const fp = generateRequestFingerprint()
    const parsed = new URL(imageUrl)
    const lib = parsed.protocol === 'https:' ? https : http

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': fp.ua,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': fp.acceptLanguage,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Referer': referer || '',
      },
      rejectUnauthorized: false,
    }

    const req = lib.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, imageUrl).href
        return _downloadImage(nextUrl, referer).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }

      const chunks = []
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip())
        : res.headers['content-encoding'] === 'deflate' ? res.pipe(zlib.createInflate())
        : res.headers['content-encoding'] === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res

      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (buf.length === 0) return reject(new Error('Empty response'))
        resolve(buf)
      })
      stream.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')) })
    req.end()
  })
}

module.exports = Smtt6Source