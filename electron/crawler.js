'use strict'
const { URL } = require('url')
const https = require('https')
const http = require('http')
const zlib = require('zlib')
const cheerio = require('cheerio')
const { sleep, randomUA } = require('./utils')
const { getCookies, updateCookies } = require('./utils/cookieJar')
const AdaptiveRequestPool = require('./adaptiveRequestPool')
const SlidingCircuitBreaker = require('./utils/circuitBreaker')

const RETRY_TIMES = 3
const PARSE_TIMEOUT = 90000
const MAX_REDIRECTS = 5

// ============ HTTP 请求引擎 ============
function fetchHtml(urlStr, opts = {}) {
  const { referer = '', cookies = '', timeout = PARSE_TIMEOUT, redirectCount = 0 } = opts

  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'))

    const parsed = new URL(urlStr)
    const lib = parsed.protocol === 'https:' ? https : http
    const ua = randomUA()

    const headers = {
      'User-Agent': ua,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'DNT': '1'
    }
    if (referer) headers['Referer'] = referer
    if (cookies) headers['Cookie'] = cookies

    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      timeout,
      rejectUnauthorized: false
    }, (res) => {
      updateCookies(parsed.hostname, res.headers['set-cookie'])

      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume()
        const location = res.headers['location']
        if (!location) return reject(new Error('Redirect without Location'))
        const redirectUrl = absoluteUrl(location, urlStr)
        return resolve(fetchHtml(redirectUrl, { referer: urlStr, cookies: getCookies(parsed.hostname), timeout, redirectCount: redirectCount + 1 }))
      }

      if ([429, 503].includes(res.statusCode)) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      if (res.statusCode >= 400) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }

      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        const ce = (res.headers['content-encoding'] || '').toLowerCase()
        let buf = raw
        try {
          if (ce.includes('br')) buf = zlib.brotliDecompressSync(raw)
          else if (ce.includes('gzip')) buf = zlib.gunzipSync(raw)
          else if (ce.includes('deflate')) buf = zlib.inflateSync(raw)
        } catch (e) { buf = raw }
        const ct = res.headers['content-type'] || ''
        let html
        if (/charset=gbk/i.test(ct) || /charset="?gbk/i.test(buf.toString('utf8', 0, 1024))) {
          try { html = new TextDecoder('gbk').decode(buf) } catch (e) { html = buf.toString('utf8') }
        } else {
          html = buf.toString('utf8')
        }
        resolve(html)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

async function asyncFetch(session, urlStr, referer = '') {
  const parsed = new URL(urlStr)
  const hostname = parsed.hostname
  for (let retry = 0; retry < RETRY_TIMES; retry++) {
    try {
      const html = await fetchHtml(urlStr, { referer, cookies: getCookies(hostname), timeout: PARSE_TIMEOUT })
      return html
    } catch (err) {
      const msg = err.message || ''
      const isServerBusy = msg.includes('522') || msg.includes('503') || msg.includes('429') || msg.includes('ECONNRESET')
      if (retry === RETRY_TIMES - 1) throw err
      
      // 优化后的延迟策略：更短的基础延迟 + 指数退避（上限更低）
      if (isServerBusy) {
        // 服务器忙：指数退避，但上限更低（8秒）
        const delayMs = Math.min(1000 * Math.pow(1.5, retry), 8000) + Math.random() * 1000
        console.log(`[重试] ${urlStr} 第${retry + 1}次重试，延迟 ${Math.round(delayMs/1000)}秒`)
        await sleep(delayMs)
      } else {
        // 其他错误：短延迟（0.5-1秒）
        const delayMs = 500 + Math.random() * 500
        console.log(`[重试] ${urlStr} 第${retry + 1}次重试，延迟 ${Math.round(delayMs)}ms`)
        await sleep(delayMs)
      }
    }
  }
  return ''
}

// ============ 解析工具 ============
function absoluteUrl(href, base) {
  if (!href) return ''
  try { return new URL(href, base).href } catch { return href }
}

function getMeta(html, name) {
  const $ = cheerio.load(html)
  const sel = `meta[name="${name}"], meta[property="${name}"]`
  return $(sel).attr('content') || ''
}

// ============ 解析器（全部改用 cheerio）============

// 解析 smtt6.com 列表页
function parseCatalogList(html, sourceUrl) {
  const $ = cheerio.load(html)
  const items = []

  // 页面分类
  let pageCategory = $('h1.hl-title, h2.hl-title').first().text().trim()

  $('li.hl-list-item').each((i, el) => {
    const $li = $(el)
    const $a = $li.find('a').first()
    const href = absoluteUrl($a.attr('href') || '', sourceUrl)
    const title = $li.find('h2').first().text().trim() ||
                  $li.find('[class*="title"]').first().text().trim() ||
                  $a.attr('title') || ''
    const cover = $li.find('img[data-original]').attr('data-original') ||
                  $li.find('img[src]').attr('src') || ''

    // 时间
    let updateTime = ''
    const timeText = $.text().match(/\d{4}-\d{2}-\d{2}/)
    if (timeText) updateTime = timeText[0]

    // 分类标签
    let itemCategory = $li.find('span.hl-tag, span[class*="type"]').first().text().trim() ||
                       $li.find('a.hl-text-conch').first().text().trim()

    if (href && title) {
      items.push({
        title: absoluteUrl(cover, sourceUrl) ? title : title, // 修正
        cover: cover.startsWith('http') ? cover : absoluteUrl(cover, sourceUrl),
        sourceUrl: href,
        updateTime: updateTime.toString(),
        category: itemCategory || pageCategory || ''
      })
    }
  })

  return items
}

// 解析分页「下一页」链接
function parseNextPageUrl(html, sourceUrl) {
  if (!html) return null
  const $ = cheerio.load(html)
  const $pagination = $('ul.hl-page-wrap')
  if ($pagination.length === 0) return null
  const $next = $pagination.find('a').filter((i, el) => $(el).text().includes('下一页'))
  if ($next.length > 0) return absoluteUrl($next.attr('href') || '', sourceUrl)
  return null
}

// 解析漫画详情页
function parseDetail(html, sourceUrl) {
  const $ = cheerio.load(html)
  const result = {
    title: '',
    cover: '',
    author: '',
    status: '',
    desc: '',
    tags: [],
    category: '',
    chapters: []
  }

  result.title = getMeta(html, 'og:title') ||
    $('h1.hl-dc-title').first().text().trim() ||
    $('h1.hl-data-menu').first().text().trim() ||
    $('h1').first().text().trim()

  result.cover = getMeta(html, 'og:image') ||
    $('img.hl-item-thumb[data-original]').attr('data-original') ||
    $('img.hl-item-thumb[src]').attr('src') || ''

  const contentText = $('div.hl-dc-content').first().text() || ''
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

  const labelPositions = []
  for (const label of ALL_LABELS) {
    const fullLabel1 = label + '：'
    const fullLabel2 = label + ':'
    const idx1 = contentText.indexOf(fullLabel1)
    const idx2 = contentText.indexOf(fullLabel2)
    const idx = idx1 >= 0 && idx2 >= 0 ? Math.min(idx1, idx2) : Math.max(idx1, idx2)
    if (idx >= 0) {
      const matchedLabel = (idx === idx1 && idx1 >= 0) ? fullLabel1 : fullLabel2
      labelPositions.push({ pos: idx, label, matchedLabel, field: LABEL_MAP[label] })
    }
  }
  labelPositions.sort((a, b) => a.pos - b.pos)

  const parsed = {}
  for (let i = 0; i < labelPositions.length; i++) {
    const cur = labelPositions[i]
    const startPos = cur.pos + cur.matchedLabel.length
    const endPos = i + 1 < labelPositions.length ? labelPositions[i + 1].pos : contentText.length
    let val = contentText.substring(startPos, endPos).trim()
    val = val.replace(/^[\s,，|\/\\]+|[\s,，|\/\\]+$/g, '').trim()
    parsed[cur.field] = val
  }

  result.author = parsed.author || ''
  result.status = parsed.status || parsed.status_extra || ''

  result.desc = getMeta(html, 'og:description') ||
    getMeta(html, 'description') ||
    $('div.hl-dc-desc').first().text().trim() ||
    parsed.desc_raw || ''

  const $tagEm = $('em.hl-text-muted').filter((i, el) => $(el).text().trim() === 'TAG：' || $(el).text().trim().includes('TAG'))
  if ($tagEm.length > 0) {
    const $tagContainer = $tagEm.closest('li')
    const tagLinks = $tagContainer.find('a[href*="/man-hua-lei-bie/"]')
    tagLinks.each((i, el) => {
      result.tags.push($(el).text().trim())
    })
  }

  const validCategories = ['日漫', '韩漫', '真人', '3D漫画', '3D', '同性']
  for (const tag of result.tags) {
    const match = validCategories.find(cat => tag.includes(cat) || cat.includes(tag))
    if (match) {
      result.category = match.includes('3D') ? '3D漫画' : match
      break
    }
  }

  if (!result.category) {
    $('div.hl-dc-tag a').each((i, el) => {
      const tag = $(el).text().trim()
      const match = validCategories.find(cat => tag.includes(cat) || cat.includes(tag))
      if (match) {
        result.category = match.includes('3D') ? '3D漫画' : match
        return false
      }
    })
  }

  const $playsList = $('ul#hl-plays-list')
  if ($playsList.length > 0) {
    $playsList.find('a.module-play-list-link').each((i, el) => {
      const $a = $(el)
      result.chapters.push({
        name: $a.text().trim(),
        url: absoluteUrl($a.attr('href') || '', sourceUrl)
      })
    })
  }

  if (result.chapters.length === 0) {
    $playsList.find('a').each((i, el) => {
      const $a = $(el)
      const text = $a.text().trim()
      if (text) {
        result.chapters.push({
          name: text,
          url: absoluteUrl($a.attr('href') || '', sourceUrl)
        })
      }
    })
  }

  return result
}

// 兼容旧接口
function parseGeneric(html, sourceUrl) {
  const detail = parseDetail(html, sourceUrl)
  return {
    title: detail.title,
    cover: detail.cover,
    author: detail.author,
    status: detail.status,
    desc: detail.desc,
    chapters: detail.chapters
  }
}

// 解析章节阅读页面的图片
function parseChapterPage(html, sourceUrl) {
  const $ = cheerio.load(html)
  const images = []
  $('img[data-original]').each((i, el) => {
    const url = absoluteUrl($(el).attr('data-original') || '', sourceUrl)
    if (url) images.push(url)
  })
  // 备选：直接 src
  if (images.length === 0) {
    $('img[src]').each((i, el) => {
      const src = $(el).attr('src') || ''
      if (src.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        images.push(absoluteUrl(src, sourceUrl))
      }
    })
  }
  return images
}

// 从章节页面提取章节名
function parseChapterName(html) {
  const $ = cheerio.load(html)
  const title = $('h2').first().text().trim()
  if (title && title !== '未知章节' && title !== '漫画信息') return title
  const altTitle = $('[class*="hl-reader-title"]').first().text().trim()
  if (altTitle) return altTitle
  return ''
}

// ============ 批量并发请求工具 ============
// 并发拉取多个 URL 的结果
async function batchFetch(urls, concurrency = 5, delayMs = 1500, options = {}) {
  // 去重处理
  const deduplicator = options.deduplicator || null
  const uniqueUrls = []
  const urlIndexMap = {}  // 原始索引 -> 去重后的索引
  
  if (deduplicator) {
    console.log(`[batchFetch] 去重前：${urls.length} 个URL`)
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      if (!deduplicator.mightContain(url)) {
        // URL一定不存在，添加到去重列表
        urlIndexMap[i] = uniqueUrls.length
        uniqueUrls.push(url)
        deduplicator.add(url)
      } else {
        console.log(`[batchFetch] 跳过重复URL：${url}`)
      }
    }
    console.log(`[batchFetch] 去重后：${uniqueUrls.length} 个URL（节省 ${urls.length - uniqueUrls.length} 个请求）`)
  } else {
    uniqueUrls.push(...urls)
    urls.forEach((_, i) => urlIndexMap[i] = i)
  }
  
  const pool = new AdaptiveRequestPool({ initialConcurrency: concurrency, maxConcurrency: concurrency })
  const results = []

  for (let i = 0; i < uniqueUrls.length; i++) {
    const idx = i
    const url = uniqueUrls[i]
    const p = pool.add(async () => {
      // 交错节流：每个请求之间至少 delayMs
      await sleep(delayMs + Math.random() * 1000)
      return { idx, html: await asyncFetch(null, url) }
    }, `batch-${i}`)
    results.push(p)
  }

  const settled = await Promise.allSettled(results)
  // 按原始顺序返回（去重的URL填充到正确位置）
  const ordered = new Array(urls.length)
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) {
      const originalIdx = Object.keys(urlIndexMap).find(key => urlIndexMap[key] === r.value.idx)
      if (originalIdx !== undefined) {
        ordered[originalIdx] = r.value.html
      }
    }
  }
  return ordered
}

module.exports = {
  fetchUrl: asyncFetch,
  parseGeneric,
  parseDetail,
  parseCatalogList,
  parseNextPageUrl,
  parseChapterPage,
  parseChapterName,
  getMeta,
  absoluteUrl,
  batchFetch,
  SlidingCircuitBreaker,
  get URLDeduplicator() {
    try {
      return require('./urlDeduplicator')
    } catch (e) {
      console.warn('[crawler] URLDeduplicator 不可用:', e.message)
      return null
    }
  }
}