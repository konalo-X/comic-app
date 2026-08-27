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
const TIMEOUT = 20000
// 重定向最大次数，防止重定向环导致无限递归栈溢出
const MAX_REDIRECTS = 5

async function _sleepWithCancel(ms, cancelledFn, cancelMsg) {
  if (!cancelledFn) return sleep(ms)
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (cancelledFn()) {
      console.log(`[SmartCrawl] ${cancelMsg || 'sleep cancelled'}`)
      throw new Error('cancelled')
    }
    await sleep(Math.min(500, ms - (Date.now() - start)))
  }
}

// ========== 智能爬虫配置 ==========
const CRAWL_CONFIG = {
  // 优化(Bug #47): 原 maxConcurrency=1 导致所有 smtt6 搜索/详情页/章节列表请求全串行,
  // 每次再间隔 2~5s, autoEnrich 抓 3000 本漫画 ≈ 1.7~4.2 小时, 体感"追更/下载像卡住".
  // 实测 hide.me 隧道出口干净、源站暂无 429/封禁, 提到 3 并发(详情页抓取). 图片下载走 net.request 直连,
  // 不经过此队列, 不受影响. 若日后出现 429 可降回 2 或 1.
  baseDelay: 800,
  randomDelayMax: 1200,
  adaptiveDelay: true,
  successDelayDecrease: 200,
  errorDelayIncrease: 1000,
  minDelay: 600,
  maxDelay: 15000,
  maxConcurrency: 3,
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
// Bug #48: 确定性错误(空/非法 URL, 404 等)不应累加退避延迟, 否则个别脏数据会把全局
// 并发拖到 maxDelay(15s), 抵消并发优化. 仅网络类错误(timeout/重置/DNS/5xx)才退避.
function recordErrorIfNetwork(msg) {
  const networkish = /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket hang|连接被重置|DNS|ENOTFOUND|EAI_AGAIN|5\d\d|网络请求失败/i.test(msg || '')
  if (networkish) recordError()
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
function _fetchWithElectronNet(urlStr, referer, fingerprint, redirectCount = 0) {
  // 【硬超时兜底】net.request 在连接阶段(DNS/TLS)可能彻底挂死(连 error/response 回调都不触发),
  // 此时内置 timeoutTimer 的 request.abort() 也可能失效, 导致 Promise 永久 pending -> 主线程看似空闲但
  // 上层 await 永远不返回 -> JobQueue 任务卡死。这里用独立定时器做外层硬超时兜底, 超时直接 reject。
  // 注意: hardTimer 必须在 Promise 内部定义, 才能捕获到正确的 resolve/reject,
  // 放在 Promise 外部会因 reject 尚未定义而失效(曾踩坑: 硬超时从不触发)。
  return new Promise((resolve, reject) => {
    const HARD_TIMEOUT = Math.max(TIMEOUT * 2, 45000)
    const hardTimer = setTimeout(() => {
      try { clearTimeout(timeoutTimer) } catch (_) {}
      try { request && request.abort() } catch (_) {}
      reject(new Error('hard timeout (net.request 连接阶段挂死)'))
    }, HARD_TIMEOUT)
    if (hardTimer.unref) hardTimer.unref()

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

    // Bug #45 修复: Referer 通过 referrer 选项传给 Chromium, 不再用 setHeader
    //   (跨域 referrer 用 setHeader 会被 Chromium 判定无效并 ERR_BLOCKED_BY_CLIENT)
    const cookies = getCookies(parsed.hostname)
    if (cookies) headers['Cookie'] = cookies

    const request = net.request({
      method: 'GET',
      url: urlStr,
      redirect: 'manual',
      referrer: referer || '',
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
      clearTimeout(hardTimer)

      // body 接收超时保护：response 头已到、但 data/end 永远不来（半截卡死）时兜底
      let bodyTimer = setTimeout(() => {
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
        if (redirectCount + 1 > MAX_REDIRECTS) {
          return reject(new Error('Too many redirects'))
        }
        return resolve(_fetchWithElectronNet(absoluteUrl(location, urlStr), urlStr, fp, redirectCount + 1))
      }

      if (statusCode >= 400) {
        clearTimeout(bodyTimer)
        response.destroy()
        return reject(new Error('HTTP ' + statusCode))
      }

      const chunks = []
      response.on('data', (chunk) => {
        // Bug #8 修复: 收到 data 时不仅要 clear 还要 reset(重启)bodyTimer
        // 之前只 clearTimeout 会导致 timer 停掉后后续 chunk 永久不来时挂死
        clearTimeout(bodyTimer)
        bodyTimer = setTimeout(() => {
          try { response.destroy() } catch (_) {}
          try { request.abort() } catch (_) {}
          reject(new Error('body timeout'))
        }, TIMEOUT)
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(bodyTimer)
        clearTimeout(hardTimer)
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
      clearTimeout(hardTimer)
      reject(err)
    })

    // 任意成功/重定向/拒绝路径都清理硬定时器
    const _origResolve = resolve
    const _origReject = reject
    // 包装 resolve/reject 以清硬定时器(重定向递归的 resolve 在外层, 这里直接清)
    const cleanup = () => clearTimeout(hardTimer)
    const wrappedResolve = (v) => { cleanup(); _origResolve(v) }
    const wrappedReject = (e) => { cleanup(); _origReject(e) }
    // 重定向分支内部调用 _fetchWithElectronNet 递归, 其自带硬定时器, 这里只清当前层
    const prevResolve = resolve
    resolve = wrappedResolve
    reject = wrappedReject

    request.end()
  })
  // 注意: hardTimer 是 Promise 构造函数内部的 const, 此处的 .catch 回调不在其词法作用域内,
  // 访问 hardTimer 会 ReferenceError。所有 resolve/reject 路径(含 wrappedReject/timeoutTimer/
  // bodyTimer/request error)内部都已 clearTimeout(hardTimer), 这里无需再清, 仅透传错误。
  .catch((e) => { throw e })
}

// ========== 漫画源类 ==========

// 注: 旧的 buildSmtt6ImageUrlVariants / CDN_HOST_CANDIDATES_SMTT6 已删除。
// smtt6 图片已迁移到 18rouman.vip 域名(Cloudflare CDN), 旧的 p5.smtt6.com 等子域名 DNS 全部失效。
// 变体生成由 downloadPaths.js 的 generateImageUrlVariants 通用函数处理(不限于 smtt6 域名)。

class Smtt6Source extends ComicSource {
  get id() { return 'smtt6' }
  get name() { return 'SM动漫' }
  get lang() { return 'zh' }
  get baseUrl() { return 'https://smtt6.com' }

  async _fetch(url, referer = '', cancelledFn = null) {
    return requestQueue.execute(async () => {
      let fingerprint = generateRequestFingerprint()

      for (let i = 0; i < RETRY_TIMES; i++) {
        if (cancelledFn && cancelledFn()) {
          console.log(`[SmartCrawl] 请求被取消: ${url}`)
          throw new Error('cancelled')
        }
        try {
          // 注意: 仅在重试(i>0)时退避. 原代码 `i>0 || requestQueue.running>0` 会在并发>1 时
          // 对每个并发请求都额外 sleep 一次(requestQueue._process 内部 finally 已 sleep 过),
          // 形成双重限速, 抵消并发提升. 去掉 running>0 条件即可让并发真正生效.
          if (i > 0) {
            const waitTime = calculateWaitTime()
            console.log(`[SmartCrawl] 等待 ${(waitTime / 1000).toFixed(1)}s 后请求...`)
            await _sleepWithCancel(waitTime, cancelledFn, `等待期间被取消: ${url}`)
          }

          const result = await _fetchWithElectronNet(url, referer, fingerprint)
          recordSuccess()
          console.log(`[SmartCrawl] 成功: ${url}`)
          return result
        } catch (e) {
          if (cancelledFn && (e.message === 'cancelled' || cancelledFn())) throw e
          const msg = e.message || ''
          console.warn(`[SmartCrawl] 尝试 ${i + 1}/${RETRY_TIMES} 失败: ${msg} (${url})`)
          recordErrorIfNetwork(msg)

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

          await _sleepWithCancel(backoffMs, cancelledFn, `退避期间被取消: ${url}`)
          fingerprint = generateRequestFingerprint()
        }
      }
    })
  }

  async search(query, page = 1, cancelledFn = null) {
    const url = `${this.baseUrl}/cata.php?key=${encodeURIComponent(query)}`
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  async getPopular(page = 1, cancelledFn = null) {
    const url = `${this.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/${page}`
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  async getLatest(page = 1, cancelledFn = null) {
    const url = `${this.baseUrl}/man-hua-lei-bie/all/ob/time/st/all/page/${page}`
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
    return this._parseList(html, url)
  }

  _parseList(html, sourceUrl) {
    const $ = cheerio.load(html)
    const items = []
    let pageCategory = $('h1.hl-title, h2.hl-title').first().text().trim()

    // 解析分页信息：共 X 个筛选结果 Y / Z 页
    let totalCount = 0
    let totalPages = 0
    let currentPage = 0

    // 尝试多种方式获取分页文本
    // 方式 1: ul.hl-page-wrap 的父元素
    let pageText = $('ul.hl-page-wrap').parent().text() || ''
    // 方式 2: 整个 body 中搜索包含 "/" 和 "页" 的文本块
    if (!pageText || pageText.length < 10) {
      pageText = $('body').text() || ''
    }

    // 尝试多种分页格式
    const countMatch = pageText.match(/共\s*(\d+(?:,\d+)*)\s*个/)
    if (countMatch) totalCount = parseInt(countMatch[1].replace(/,/g, ''), 10) || 0

    // 格式 1: "1 / 126 页" 或 "1/126页" / "第1/126页"
    let pageMatch = pageText.match(/(\d+)\s*\/\s*(\d+)\s*页/)
    // 格式 2: "1 / 126" (无"页"字，但前面有"共 X 个")
    if (!pageMatch) pageMatch = pageText.match(/共\s*\d+(?:,\d+)*\s*个[^0-9]*(\d+)\s*\/\s*(\d+)/)
    // 格式 3: 从分页链接中提取最大页码（最可靠的兜底方案）
    if (totalPages === 0) {
      const pageLinks = $('ul.hl-page-wrap a[href]')
      let maxPageFromLinks = 0
      pageLinks.each((i, el) => {
        const href = $(el).attr('href') || ''
        const m = href.match(/page\/(\d+)/)
        if (m) {
          const p = parseInt(m[1], 10)
          if (p > maxPageFromLinks) maxPageFromLinks = p
        }
      })
      if (maxPageFromLinks > 0) {
        totalPages = maxPageFromLinks
      }
    }

    // 格式 4: 通用 "数字/数字"（兜底方案）
    if (!pageMatch) pageMatch = pageText.match(/(\d+)\s*\/\s*(\d+)/)
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10) || 0
      totalPages = parseInt(pageMatch[2], 10) || 0
    }

    // 格式 5: 如果还不行，尝试从 body 中搜索 "共 X 页"
    if (totalPages === 0) {
      const totalPagesMatch = pageText.match(/共\s*(\d+)\s*页/)
      if (totalPagesMatch) {
        totalPages = parseInt(totalPagesMatch[1], 10) || 0
      }
    }

    if (totalPages === 0) {
      console.log(`[smtt6] _parseList 分页解析失败，尝试了所有格式。pageText前200字符="${pageText.substring(0, 200)}"`)
    }

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
    return { items, totalCount, totalPages, currentPage }
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

  async getDetail(url, cancelledFn = null) {
    // Bug #48 修复: 脏数据 comic.sourceUrl 可能为 null/空, 直接传进来会到 new URL(null)
    // 抛 'Invalid URL (null)', 且会触发 recordError 把全局自适应延迟顶满, 拖垮并发.
    // 这里早退, 抛明确错误交由上层(syncService)跳过该漫画.
    if (!url || typeof url !== 'string' || !/^https?:/.test(url)) {
      throw new Error('空或不合法 URL (skip)')
    }
    const html = await this._fetch(url, this.baseUrl + '/', cancelledFn)
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

  async getPageList(chapterUrl, referer, cancelledFn = null) {
    const html = await this._fetch(chapterUrl, referer || this.baseUrl + '/', cancelledFn)
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

// ========== 图片下载（Electron net，与浏览器 DNS 解析一致） ==========
function _downloadImage(imageUrl, referer, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const fp = generateRequestFingerprint()

    // 使用 Electron net 模块 (Chromium 网络栈), 避免 Node.js getaddrinfo ENOTFOUND
    // Bug #45 修复: 用 referrer 选项替代 setHeader('Referer', ...), 避免跨域 referrer 被 Chromium 拦截
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
        if (redirectCount + 1 > MAX_REDIRECTS) {
          return reject(new Error('Too many redirects'))
        }
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
        : res.headers['content-encoding'] === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res

      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => {
        clearTimeout(timeoutTimer)
        const buf = Buffer.concat(chunks)
        if (buf.length === 0) return reject(new Error('Empty response'))
        resolve(buf)
      })
      stream.on('error', (e) => {
        clearTimeout(timeoutTimer)
        reject(e)
      })
    })

    request.on('error', (e) => {
      clearTimeout(timeoutTimer)
      reject(e)
    })

    request.end()
  })
}

module.exports = Smtt6Source