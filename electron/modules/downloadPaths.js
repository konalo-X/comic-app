'use strict'
const path = require('path')
const fs = require('fs')
const https = require('https')
const http = require('http')
const url = require('url')
const sharpPool = require('./sharpPool')
const { app } = require('electron')
const { sanitizeFilename: sanitize, normalizeName, sleep, getDiskInfo } = require('../utils')
const db = require('../db')

const INTERNAL_ROOT = path.join(app.getPath('documents'), 'comic-downloads')
let EXTERNAL_ROOT = INTERNAL_ROOT
let globalDownloadConcurrency = 3

function setExternalRoot(root) {
  EXTERNAL_ROOT = root
}

function getExternalRoot() {
  return EXTERNAL_ROOT
}

function getGlobalDownloadConcurrency() {
  return globalDownloadConcurrency
}

function setGlobalDownloadConcurrency(val) {
  globalDownloadConcurrency = val
}

function getDownloadRoots() {
  const candidates = []
  candidates.push(INTERNAL_ROOT)
  if (EXTERNAL_ROOT !== INTERNAL_ROOT && fs.existsSync(EXTERNAL_ROOT)) {
    candidates.push(EXTERNAL_ROOT)
  }
  candidates.push(app.getPath('downloads'))
  return candidates
}

function getPrimaryDownloadRoot() {
  if (EXTERNAL_ROOT !== INTERNAL_ROOT && fs.existsSync(EXTERNAL_ROOT)) {
    return EXTERNAL_ROOT
  }
  return INTERNAL_ROOT
}

function normalizeUrl(u) {
  if (!u) return ''
  try {
    let s = String(u).trim().toLowerCase()
    s = s.replace(/^https?:\/\//, '')
    s = s.replace(/^www\./, '')
    s = s.replace(/[#?].*$/, '')
    s = s.replace(/\/+$/, '')
    return s
  } catch (_) {
    return String(u || '').toLowerCase()
  }
}

const comicDirCache = new Map()
let comicDirCacheTimestamp = 0
const COMIC_DIR_CACHE_TTL = 5 * 60 * 1000

const chapterDirCache = new Map()
let chapterDirCacheTimestamp = 0

function resolveUniqueComicDir(preferredPath, sourceUrl) {
  // 防御：preferredPath 绝不能是下载根目录本身
  const rootSet = new Set(getDownloadRoots().map(r => path.resolve(r)))
  if (rootSet.has(path.resolve(preferredPath))) {
    throw new Error(`[目录错误] resolveUniqueComicDir: preferredPath 不能是下载根目录: ${preferredPath}`)
  }

  if (!fs.existsSync(preferredPath)) return preferredPath

  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        if (row?.local_path === preferredPath) return preferredPath
      }
    } catch (_) {}
  }

  let counter = 1
  let candidate
  do {
    candidate = `${preferredPath}_${counter}`
    counter++
  } while (fs.existsSync(candidate))
  return candidate
}

function findComicDir(title, sourceUrl) {
  // 获取所有下载根目录的 resolved 路径，用于防御性检查
  const rootSet = new Set(getDownloadRoots().map(r => path.resolve(r)))

  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        // 防御：local_path 不能是下载根目录本身（历史脏数据）
        if (row?.local_path && fs.existsSync(row.local_path) && !rootSet.has(path.resolve(row.local_path))) {
          return row.local_path
        }
      }
    } catch (_) {}
  }

  const now = Date.now()
  const cacheKey = normalizeName(title)
  
  if (now - comicDirCacheTimestamp < COMIC_DIR_CACHE_TTL && comicDirCache.has(cacheKey)) {
    return comicDirCache.get(cacheKey)
  }

  const candidates = [sanitize(title), title]
  const normTitle = normalizeName(title)

  for (const root of getDownloadRoots()) {
    for (const c of candidates) {
      const p = path.join(root, c)
      if (fs.existsSync(p)) {
        comicDirCache.set(cacheKey, p)
        comicDirCacheTimestamp = now
        return p
      }
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const normDir = normalizeName(e.name)
        if (normDir && normTitle && normDir === normTitle) {
          const p = path.join(root, e.name)
          comicDirCache.set(cacheKey, p)
          comicDirCache.set(normalizeName(e.name), p)
          comicDirCacheTimestamp = now
          return p
        }
      }
    } catch (_) {}
  }
  
  comicDirCache.set(cacheKey, null)
  return null
}

function clearComicDirCache() {
  comicDirCache.clear()
  comicDirCacheTimestamp = 0
  chapterDirCache.clear()
  chapterDirCacheTimestamp = 0
}

function findChapterDir(comicDir, chapterIndex, chapterName, usedDirs) {
  if (!comicDir || !fs.existsSync(comicDir)) return null
  const now = Date.now()
  const cacheKey = `${comicDir}:${chapterIndex}:${chapterName}`
  
  if (now - chapterDirCacheTimestamp < COMIC_DIR_CACHE_TTL && chapterDirCache.has(cacheKey)) {
    const cached = chapterDirCache.get(cacheKey)
    if (cached && fs.existsSync(cached)) return cached
    if (cached === null) return null
  }

  const used = usedDirs || new Set()
  const entries = fs.readdirSync(comicDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !used.has(path.join(comicDir, e.name)))

  const exactByName = entries.find(e => {
    const m = e.name.match(/^(\d+)-(.*)$/)
    if (!m) return false
    const idx = parseInt(m[1], 10) - 1
    if (idx !== chapterIndex) return false
    const dirChapterName = m[2]
    const normDir = normalizeName(dirChapterName)
    const normName = normalizeName(chapterName)
    if (chapterName === dirChapterName) return true
    if (sanitize(chapterName) === dirChapterName) return true
    if (normDir && normName && normDir === normName) return true
    return false
  })
  if (exactByName) {
      const chPath = path.join(comicDir, exactByName.name)
      const files = listChapterImages(chPath)
      if (files.length > 3 || (files.length > 0 && !chapterName)) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }

  if (chapterName) {
    const normName = normalizeName(chapterName)
    const nameOnlyMatch = entries.find(e => {
      const m = e.name.match(/^(\d+)-(.*)$/)
      if (!m) return false
      const dirChapterName = m[2]
      const lowName = e.name.toLowerCase()
      if (/休刊|公告|通知|预告|请假|停更|说明/.test(lowName)) return false
      const normDir = normalizeName(dirChapterName)
      if (sanitize(chapterName) === dirChapterName) return true
      if (normDir && normName && normDir === normName) return true
      return false
    })
    if (nameOnlyMatch) {
      const chPath = path.join(comicDir, nameOnlyMatch.name)
      const files = listChapterImages(chPath)
      if (files.length > 3) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }
  }

  const exactByIndex = entries.find(e => {
    const m = e.name.match(/^(\d+)/)
    if (!m) return false
    const idx = parseInt(m[1], 10) - 1
    if (idx !== chapterIndex) return false

    const m2 = e.name.match(/^(\d+)-(.*)$/)
    const dirChapterName = m2 ? m2[2] : ''
    if (chapterName && dirChapterName) {
      const dirHasNum = /\d+/.test(dirChapterName) ? parseInt(dirChapterName.match(/\d+/)[0], 10) : null
      const chapterHasNum = /\d+/.test(chapterName) ? parseInt(chapterName.match(/\d+/)[0], 10) : null
      if (dirHasNum !== null && chapterHasNum !== null && Math.abs(dirHasNum - chapterHasNum) > 20) {
        return false
      }
    }
    return true
  })
  if (exactByIndex) {
    const chPath = path.join(comicDir, exactByIndex.name)
    const files = listChapterImages(chPath)
    if (files.length > 3) {
      chapterDirCache.set(cacheKey, chPath)
      chapterDirCacheTimestamp = now
      return chPath
    }
  }

  const numbered = entries
    .filter(e => /^\d+/.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/^(\d+)/)[1], 10)
      const nb = parseInt(b.name.match(/^(\d+)/)[1], 10)
      return na - nb
    })
  if (chapterIndex < numbered.length) {
    const candidate = numbered[chapterIndex]
    const num = parseInt(candidate.name.match(/^(\d+)/)[1], 10)
    if (Math.abs(num - (chapterIndex + 1)) <= 2) {
      const chPath = path.join(comicDir, candidate.name)
      const files = listChapterImages(chPath)
      if (files.length > 3) {
        chapterDirCache.set(cacheKey, chPath)
        chapterDirCacheTimestamp = now
        return chPath
      }
    }
  }
  chapterDirCache.set(cacheKey, null)
  return null
}

function listChapterImages(chapterDir) {
  if (!chapterDir || !fs.existsSync(chapterDir)) return []
  const files = fs.readdirSync(chapterDir).filter(f =>
    /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i.test(f)
  )
  files.sort((a, b) => {
    const ma = a.match(/\d+/)
    const mb = b.match(/\d+/)
    const na = ma ? parseInt(ma[0], 10) : 99999
    const nb = mb ? parseInt(mb[0], 10) : 99999
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  })
  return files.map(f => path.join(chapterDir, f))
}

function detectBufferFormat(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif'
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp'
  return 'unknown'
}

async function detectFileFormat(filePath) {
  const fd = fs.openSync(filePath, 'r')
  const header = Buffer.alloc(12)
  fs.readSync(fd, header, 0, 12, 0)
  fs.closeSync(fd)
  return detectBufferFormat(header)
}

async function validateImageFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    const stat = fs.statSync(filePath)
    if (stat.size === 0) return false
    await sharpPool.metadata(filePath)
    return true
  } catch (e) {
    return false
  }
}

async function getValidChapterImages(chapterDir) {
  const allFiles = listChapterImages(chapterDir)
  const validFiles = []
  for (const f of allFiles) {
    if (await validateImageFile(f)) {
      validFiles.push(f)
    } else {
      console.warn(`[下载] 检测到损坏/空图片文件: ${f}`)
    }
  }
  return validFiles
}

async function checkDiskSpace(dirPath, requiredBytes) {
  try {
    const info = await getDiskInfo(dirPath)
    return info.free > requiredBytes + 100 * 1024 * 1024
  } catch (e) {
    console.warn(`[下载] 磁盘空间检查失败: ${e.message}`)
    return true
  }
}

function getChapterStatePath(chDir) {
  return path.join(chDir, '.chapter_state.json')
}

function loadChapterState(chDir) {
  const p = getChapterStatePath(chDir)
  try {
    if (fs.existsSync(p)) {
      const state = JSON.parse(fs.readFileSync(p, 'utf8'))
      return state
    }
  } catch (e) {
    console.warn(`[下载] 读取章节状态失败: ${e.message}`)
  }
  return null
}

function saveChapterState(chDir, state) {
  try {
    fs.writeFileSync(getChapterStatePath(chDir), JSON.stringify(state, null, 2))
  } catch (e) {
    console.warn(`[下载] 保存章节状态失败: ${e.message}`)
  }
}

async function downloadChapterImages(job, images, chDir, startIndex, comicTitle, chapterName, chapter, sourceUrl, onProgress) {
  if (!images || images.length === 0) {
    throw new Error('无图片可下载')
  }

  const state = loadChapterState(chDir) || {
    totalImages: images.length,
    completedIndices: [],
    failedImages: [],
    startTime: Date.now()
  }

  if (state.totalImages !== images.length) {
    state.totalImages = images.length
  }

  const indicesToDownload = []
  for (let i = startIndex || 0; i < images.length; i++) {
    const existingFile = path.join(chDir, `${String(i + 1).padStart(3, '0')}.webp`)
    if (fs.existsSync(existingFile)) {
      const isValid = await validateImageFile(existingFile)
      if (isValid) {
        if (!state.completedIndices.includes(i)) {
          state.completedIndices.push(i)
        }
        continue
      } else {
        console.warn(`[下载] 图片 ${i + 1} 已存在但损坏，重新下载`)
      }
    }
    if (state.completedIndices.includes(i)) {
      state.completedIndices = state.completedIndices.filter(idx => idx !== i)
    }
    indicesToDownload.push(i)
  }

  if (indicesToDownload.length === 0) {
    try { console.log(`[下载] 所有图片已存在且有效: ${comicTitle} › ${chapterName}`) } catch {}
    return {
      success: true,
      downloaded: 0,
      total: images.length,
      chapter: chapterName,
      skipped: true
    }
  }

  try { console.log(`[下载] 开始下载 ${comicTitle} › ${chapterName} (${indicesToDownload.length}/${images.length} 张)`) } catch {}

  const estimatedBytes = indicesToDownload.length * 500 * 1024
  const hasSpace = await checkDiskSpace(chDir, estimatedBytes)
  if (!hasSpace) {
    throw new Error(`磁盘空间不足，需要约 ${(estimatedBytes / 1024 / 1024).toFixed(1)}MB`)
  }

  const imageConcurrency = 5
  const imageBuffers = new Map()
  let downloadQueueIdx = 0
  let completedCount = 0
  let bytesDownloaded = 0
  let speedStartTime = Date.now()
  const currentFailedImages = []

  async function imgWorker() {
    while (downloadQueueIdx < indicesToDownload.length && !job.cancelled()) {
      const queuePos = downloadQueueIdx++
      const imageIndex = indicesToDownload[queuePos]
      const imageUrl = images[imageIndex]

      let retries = 0
      let success = false
      let lastError = null

      while (retries < 3 && !success) {
        try {
          const { buffer: buf } = await downloadBuf(imageUrl, chapter.url)
          if (!buf || buf.length === 0) {
            throw new Error('下载的图片为空')
          }
          imageBuffers.set(imageIndex, buf)
          bytesDownloaded += buf.length
          success = true
        } catch (e) {
          retries++
          lastError = e
          if (retries >= 3) {
            currentFailedImages.push({
              index: imageIndex + 1,
              url: imageUrl,
              error: e.message
            })
            try { console.warn(`[下载] 图片下载失败 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页 (${retries}/3): ${e.message}`) } catch {}
          } else {
            const delay = 1000 * Math.pow(2, retries - 1) + Math.random() * 1000
            try { console.log(`[下载] 第${imageIndex + 1}页 第${retries}次重试，等待 ${Math.round(delay)}ms...`) } catch {}
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }

      completedCount++
      const elapsed = (Date.now() - speedStartTime) / 1000
      const speed = elapsed > 0 ? formatBytes(Math.round(bytesDownloaded / elapsed)) + '/s' : '0 KB/s'
      if (completedCount % 3 === 0 || completedCount === indicesToDownload.length) {
        onProgress({
          chapterIdx: chapter.index,
          current: state.completedIndices.length + completedCount,
          total: images.length,
          downloaded: completedCount,
          speed
        })
      }
    }
  }

  const workers = Array.from({ length: imageConcurrency }, () => imgWorker())
  await Promise.all(workers)

  if (job.cancelled()) {
    for (const [idx, buf] of imageBuffers) {
      if (buf) {
        if (!state.completedIndices.includes(idx)) {
          state.completedIndices.push(idx)
        }
      }
    }
    saveChapterState(chDir, state)
    return {
      cancelled: true,
      downloaded: imageBuffers.size,
      total: images.length,
      failedImages: currentFailedImages
    }
  }

  let downloaded = 0
  const writeErrors = []
  for (const [imageIndex, buf] of imageBuffers) {
    if (!buf) continue
    const outPath = path.join(chDir, `${String(imageIndex + 1).padStart(3, '0')}.webp`)
    try {
      await sharpPool.webpConvert(buf, outPath, { quality: 85 })
      const actualFormat = await detectFileFormat(outPath)
      if (actualFormat !== 'webp') {
        console.warn(`[下载] 图片格式不正确(${actualFormat})，重新转换: ${outPath}`)
        const webpBuf = await sharpPool.webpConvertToBuffer(buf, { quality: 85 })
        fs.writeFileSync(outPath, webpBuf)
      }
      downloaded++
      if (!state.completedIndices.includes(imageIndex)) {
        state.completedIndices.push(imageIndex)
      }
      state.failedImages = (state.failedImages || []).filter(f => f.index !== imageIndex + 1)
    } catch (e) {
      writeErrors.push({ index: imageIndex + 1, error: e.message })
      try { console.warn(`[下载] 图片转换失败 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页: ${e.message}`) } catch {}
    }
  }

  if (currentFailedImages.length > 0) {
    state.failedImages = [...(state.failedImages || []), ...currentFailedImages]
  }

  saveChapterState(chDir, state)

  if (state.completedIndices.length >= images.length) {
    try {
      const statePath = getChapterStatePath(chDir)
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath)
        try { console.log(`[下载] 章节完成，清理状态文件: ${chapterName}`) } catch {}
      }
    } catch (e) {}
  }

  onProgress({
    chapterIdx: chapter.index,
    current: images.length,
    total: images.length,
    downloaded,
    done: true
  })

  const result = {
    success: true,
    downloaded,
    total: images.length,
    chapter: chapterName
  }

  if (state.failedImages && state.failedImages.length > 0) {
    result.failedImages = state.failedImages
    result.failedCount = state.failedImages.length
  }

  return result
}

async function downloadAndConvert(url, filePath, referer) {
  for (let i = 0; i < 3; i++) {
    try {
      const { buffer, byteLength } = await downloadBuf(url, referer)
      await sharpPool.webpConvert(buffer, filePath, { quality: 85 })
      const actualFormat = await detectFileFormat(filePath)
      if (actualFormat !== 'webp') {
        console.warn(`[下载] 图片格式不正确(${actualFormat})，重新转换: ${filePath}`)
        const webpBuf = await sharpPool.webpConvertToBuffer(buffer, { quality: 85 })
        fs.writeFileSync(filePath, webpBuf)
      }
      return byteLength
    } catch (e) { if (i === 2) throw e; await sleep(1000 * (i + 1)) }
  }
  return 0
}
function downloadBuf(imageUrl, referer, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const lib = imageUrl.startsWith('https') ? https : http
    const req = lib.get(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': referer || imageUrl, 'Accept': 'image/*'
      }
    }, (res) => {
      if (settled) { res.resume(); return }
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy()
        settled = true
        const redirectUrl = new url.URL(res.headers.location, imageUrl).href
        return resolve(downloadBuf(redirectUrl, referer, timeoutMs))
      }
      if (res.statusCode !== 200) {
        req.destroy()
        settled = true
        let errorMsg = `HTTP ${res.statusCode}`
        if (res.statusCode === 404) errorMsg = `HTTP 404 (图片不存在)`
        else if (res.statusCode === 403) errorMsg = `HTTP 403 (访问被拒绝)`
        else if (res.statusCode === 429) errorMsg = `HTTP 429 (请求过于频繁)`
        else if (res.statusCode >= 500) errorMsg = `HTTP ${res.statusCode} (服务器错误)`
        return reject(new Error(errorMsg))
      }
      const c = []
      let resTimeout = setTimeout(() => {
        settled = true
        req.destroy()
        reject(new Error('Response timeout'))
      }, timeoutMs)
      res.on('data', d => {
        clearTimeout(resTimeout)
        resTimeout = setTimeout(() => {
          settled = true
          req.destroy()
          reject(new Error('Response timeout'))
        }, timeoutMs)
        c.push(d)
      })
      res.on('end', () => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        const buf = Buffer.concat(c)
        resolve({ buffer: buf, byteLength: buf.length })
      })
      res.on('error', (e) => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        req.destroy()
        reject(e)
      })
    })
    let reqTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error('Request timeout'))
    }, timeoutMs)
    req.on('timeout', () => {
      if (settled) return
      clearTimeout(reqTimeout)
      settled = true
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.on('error', (e) => {
      if (settled) return
      clearTimeout(reqTimeout)
      settled = true
      reject(e)
    })
  })
}
async function checkChapterHealth(chapterDir, options = {}) {
  const { onlineCount, deepCheck } = options
  const issues = []
  const allFiles = listChapterImages(chapterDir)

  if (allFiles.length === 0) {
    issues.push({ type: 'empty', message: '章节目录为空' })
    return { healthy: false, issues, totalFiles: 0, corruptCount: 0, emptyCount: 0, gapCount: 0, missingCount: 0, onlineCount: onlineCount || 0 }
  }

  let corruptCount = 0
  let emptyCount = 0
  for (const f of allFiles) {
    try {
      const stat = fs.statSync(f)
      if (stat.size === 0) {
        emptyCount++
        issues.push({ type: 'empty_file', file: f, message: `空文件: ${path.basename(f)}` })
        continue
      }
      await sharpPool.metadata(f)
    } catch (e) {
      corruptCount++
      issues.push({ type: 'corrupt', file: f, message: `损坏文件: ${path.basename(f)} - ${e.message}` })
    }
  }

  const validCount = allFiles.length - corruptCount - emptyCount

  const indices = allFiles.map(f => {
    const m = path.basename(f).match(/(\d+)/)
    return m ? parseInt(m[1], 10) : 0
  }).sort((a, b) => a - b)

  const gaps = []
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] - indices[i - 1] > 1) {
      for (let j = indices[i - 1] + 1; j < indices[i]; j++) {
        gaps.push(j)
      }
    }
  }
  if (gaps.length > 0) {
    issues.push({ type: 'gap', missingIndices: gaps, message: `缺失 ${gaps.length} 张图片 (序号: ${gaps.join(', ')})` })
  }

  let missingCount = 0
  if (onlineCount && onlineCount > validCount) {
    missingCount = onlineCount - validCount
    issues.push({ type: 'incomplete', onlineCount, localCount: validCount, missingCount, message: `图片不完整: 在线 ${onlineCount} 张, 本地有效 ${validCount} 张, 缺少 ${missingCount} 张` })
  }

  const healthy = issues.length === 0
  return { healthy, issues, totalFiles: allFiles.length, corruptCount, emptyCount, gapCount: gaps.length, missingCount, onlineCount: onlineCount || 0, validCount }
}

async function checkComicHealth(comicDir, options = {}) {
  const { chapterOnlineCounts } = options
  if (!comicDir || !fs.existsSync(comicDir)) {
    return { healthy: false, chapters: [], message: '漫画目录不存在' }
  }

  const entries = fs.readdirSync(comicDir, { withFileTypes: true })
  const chapterDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))

  let missingCover = false
  const coverPath = path.join(comicDir, 'cover.webp')
  if (!fs.existsSync(coverPath)) {
    missingCover = true
  }

  const chapters = []
  let totalIssues = missingCover ? 1 : 0

  for (let i = 0; i < chapterDirs.length; i++) {
    const entry = chapterDirs[i]
    const chDir = path.join(comicDir, entry.name)
    const chapterOpts = {}
    if (chapterOnlineCounts && chapterOnlineCounts[i] != null) {
      chapterOpts.onlineCount = chapterOnlineCounts[i]
    }
    const health = await checkChapterHealth(chDir, chapterOpts)
    if (!health.healthy) {
      totalIssues += health.issues.length
    }
    chapters.push({
      dirName: entry.name,
      chapterIndex: i,
      ...health
    })
  }

  return {
    healthy: totalIssues === 0,
    comicDir,
    totalChapters: chapterDirs.length,
    totalIssues,
    missingCover,
    chapters
  }
}

module.exports = {
  getDownloadRoots,
  getPrimaryDownloadRoot,
  setExternalRoot,
  getExternalRoot,
  normalizeUrl,
  resolveUniqueComicDir,
  resolveComicDir,
  findComicDir,
  clearComicDirCache,
  findChapterDir,
  listChapterImages,
  validateImageFile,
  getValidChapterImages,
  checkDiskSpace,
  getChapterStatePath,
  loadChapterState,
  saveChapterState,
  downloadChapterImages,
  downloadAndConvert,
  downloadBuf,
  sleep,
  checkChapterHealth,
  checkComicHealth,
  getGlobalDownloadConcurrency,
  setGlobalDownloadConcurrency
}

function resolveComicDir(comicTitle, sourceUrl, payloadComicDir) {
  if (payloadComicDir && typeof payloadComicDir === 'string' && payloadComicDir.trim() !== '') {
    return payloadComicDir
  }
  if (!comicTitle || typeof comicTitle !== 'string' || comicTitle.trim() === '') {
    throw new Error('漫画标题不能为空，无法确定下载路径')
  }
  const title = comicTitle.trim()
  let dir = findComicDir(title, sourceUrl)
  if (!dir) {
    const preferred = path.join(getPrimaryDownloadRoot(), sanitize(title))
    dir = resolveUniqueComicDir(preferred, sourceUrl)
  }
  const downloadRoot = getPrimaryDownloadRoot()
  if (downloadRoot.startsWith('/Volumes/') && !fs.existsSync(downloadRoot)) {
    throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
  }
  const resolvedComicDir = path.resolve(dir)
  const resolvedRoot = path.resolve(downloadRoot)
  if (resolvedComicDir === resolvedRoot) {
    throw new Error(`漫画目录路径无效，与下载根目录相同: ${dir}`)
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}