'use strict'
/**
 * 图片磁盘缓存 — LRU 淘汰，2GB 上限
 * 存储路径: ~/.comic-app/cache/{sha256(url)}.jpg
 */
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')

const CACHE_ROOT = path.join(app.getPath('userData'), 'cache')
const MAX_SIZE = 2 * 1024 * 1024 * 1024 // 2GB
let meta = null // { entries: { [hash]: { size, lastAccess, url } }, totalSize, totalFiles }
let metaDirty = false
let metaTimer = null
let cleanupTimer = null

// ===== 内部方法 =====

function metaFile() { return path.join(CACHE_ROOT, '_meta.json') }

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)
}

function ensureDir() {
  if (!fs.existsSync(CACHE_ROOT)) fs.mkdirSync(CACHE_ROOT, { recursive: true })
}

function loadMeta() {
  if (meta) return
  ensureDir()
  const file = metaFile()
  try {
    if (fs.existsSync(file)) {
      meta = JSON.parse(fs.readFileSync(file, 'utf8'))
    }
  } catch { /* 损坏就重置 */ }
  if (!meta || !meta.entries) {
    meta = { entries: {}, totalSize: 0, totalFiles: 0 }
  }
}

function saveMetaSync() {
  if (!metaDirty) return
  try {
    fs.writeFileSync(metaFile(), JSON.stringify(meta))
    metaDirty = false
  } catch {}
}

function saveMetaDebounced() {
  metaDirty = true
  if (metaTimer) clearTimeout(metaTimer)
  metaTimer = setTimeout(saveMetaSync, 2000)
}

function getCachePath(url) {
  return path.join(CACHE_ROOT, hashUrl(url) + '.img')
}

// ===== 对外 API =====

/** 获取缓存图片路径，不命中返回 null */
function getCachedPath(url) {
  if (!url) return null
  loadMeta()
  const h = hashUrl(url)
  const entry = meta.entries[h]
  if (!entry) return null

  const p = getCachePath(url)
  // 文件被外部删了
  if (!fs.existsSync(p)) {
    delete meta.entries[h]
    meta.totalSize -= entry.size || 0
    meta.totalFiles--
    metaDirty = true
    saveMetaDebounced()
    return null
  }

  // 更新最后访问时间（LRU）
  entry.lastAccess = Date.now()
  metaDirty = true
  saveMetaDebounced()
  return p
}

/** 保存图片到缓存 */
async function setCache(url, buffer) {
  if (!url || !buffer || buffer.length === 0) return
  loadMeta()
  ensureDir()

  const h = hashUrl(url)
  const p = getCachePath(url)
  const size = buffer.length

  // 检查是否有旧条目
  if (meta.entries[h]) {
    meta.totalSize -= meta.entries[h].size || 0
  } else {
    meta.totalFiles++
  }

  meta.entries[h] = { size, lastAccess: Date.now(), url }
  meta.totalSize += size
  metaDirty = true

  try {
    fs.writeFileSync(p, buffer)
  } catch (e) {
    console.error('[Cache] 写入失败:', url, e.message)
    // 回滚
    meta.totalSize -= size
    meta.totalFiles--
    delete meta.entries[h]
    return
  }

  // 超出上限则异步淘汰
  if (meta.totalSize > MAX_SIZE) {
    scheduleCleanup()
  }

  saveMetaDebounced()
}

/** 是否缓存了该 URL */
function hasCache(url) {
  if (!url) return false
  loadMeta()
  return !!meta.entries[hashUrl(url)]
}

/** 获取缓存统计 */
function getStats() {
  loadMeta()
  return {
    totalSize: meta.totalSize,
    totalFiles: meta.totalFiles,
    maxSize: MAX_SIZE,
    cacheDir: CACHE_ROOT
  }
}

/** 清空全部缓存 */
function clearCache() {
  loadMeta()
  ensureDir()
  for (const h of Object.keys(meta.entries)) {
    const p = path.join(CACHE_ROOT, h + '.img')
    try { fs.unlinkSync(p) } catch {}
  }
  meta = { entries: {}, totalSize: 0, totalFiles: 0 }
  metaDirty = true
  saveMetaSync()
  console.log('[Cache] 已清空')
}

// ===== LRU 淘汰 =====

function scheduleCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer)
  cleanupTimer = setTimeout(doCleanup, 100)
}

function doCleanup() {
  loadMeta()
  const sorted = Object.entries(meta.entries)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess) // 最久未访问的在前面

  let freed = 0
  for (const [h, entry] of sorted) {
    if (meta.totalSize <= MAX_SIZE * 0.85) break // 降到 1.7GB 以下停止
    const p = path.join(CACHE_ROOT, h + '.img')
    try {
      fs.unlinkSync(p)
      meta.totalSize -= entry.size || 0
      delete meta.entries[h]
      meta.totalFiles--
      freed++
    } catch {}
  }

  if (freed > 0) {
    console.log(`[Cache] LRU 淘汰 ${freed} 个文件，当前 ${(meta.totalSize / 1024 / 1024).toFixed(0)}MB`)
    metaDirty = true
    saveMetaSync()
  }
  cleanupTimer = null
}

/** 预热（应用启动时加载 meta，清理死文件） */
async function warmup() {
  loadMeta()
  // 清理已不存在的文件引用
  let cleaned = 0
  for (const [h, entry] of Object.entries(meta.entries)) {
    const p = path.join(CACHE_ROOT, h + '.img')
    if (!fs.existsSync(p)) {
      delete meta.entries[h]
      meta.totalSize -= entry.size || 0
      meta.totalFiles--
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log(`[Cache] 预热: 清理 ${cleaned} 个失效引用，当前 ${meta.totalFiles} 文件`)
    metaDirty = true
    saveMetaSync()
  }
}

process.on('exit', () => { if (metaDirty) { try { fs.writeFileSync(metaFile(), JSON.stringify(meta)) } catch (_) {} } })
process.on('SIGTERM', () => { saveMetaSync(); process.exit(0) })
process.on('SIGINT', () => { saveMetaSync(); process.exit(0) })

module.exports = {
  CACHE_ROOT,
  getCachedPath,
  setCache,
  hasCache,
  getStats,
  clearCache,
  warmup
}