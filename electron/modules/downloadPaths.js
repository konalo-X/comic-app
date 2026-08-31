'use strict'
const path = require('path')
const fs = require('fs')
const safeFs = require('./safeFs')
const https = require('https')
const http = require('http')
const url = require('url')
const { net } = require('electron')
const sharpPool = require('./sharpPool')
const { app } = require('electron')
const { sanitizeFilename: sanitize, normalizeName, sleep, getDiskInfo, normalizeUrl } = require('../utils')
const db = require('../db')
const dnsCache = require('./dnsCache')

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

// 生成图片 URL 的候选变体:很多图床在初始 HTML 里暴露的是占位 URL(错误后缀/错误 CDN 节点),
// 真实图片需要做 .jpg/.png → .webp 后缀替换,或 p2/p3/p4/p5 ↔ p2p/p3p/p4p/p5p 的 CDN 主机切换。
// 当下载主 URL 返回 404/403 时,尝试这些变体可以大幅提高成功率(尤其是新上传的图)。
const CDN_HOST_SWAPS = [
  // 先做 "普通 ↔ 带P线路" 的两两互换——这是最常见的 CDN 混淆手段
  [/^p(\d)\./i, 'p$1p.'],
  [/^p(\d)p\./i, 'p$1.'],
  // 兜底:相邻编号主机轮询 (p5→p4→p3→p2→p6, p5p→p4p→p3p 等)
]
const CDN_ADJACENT_NUMBERS = [
  // 数字部分 2,3,4,5,6 的环形相邻(注意 p5/p4 之间流量大,优先试)
  { '2': ['3', '4', '5', '6'], '3': ['4', '2', '5', '6'], '4': ['5', '3', '6', '2'],
    '5': ['4', '6', '3', '2'], '6': ['5', '4', '3', '2'] }
][0]

// =================== 子域 RST 熔断 (增强 2026-08-20) ===================
// 墙按请求随机 reset:某个 CDN 子域(p3.18rouman.vip 等)可能连续 5 次 RST。
// 与其在每个子域上反复撞墙(每次 30s 超时 × 重试),不如一旦某主机连续失败达到阈值,
// 就把它熔断 N 秒(默认 30s),期间不再作为首选变体,直接跳到其它可达主机。
const _hostBreaker = new Map() // host -> { failures, trippedUntil }
const BREAKER_FAIL_THRESHOLD = 5 // 连续失败多少次触发熔断
const BREAKER_COOLDOWN_MS = 30 * 1000 // 熔断时长
const BREAKER_RESET_AFTER = 3 // 连续成功多少次解除该主机失败计数
function _hostBreakerIsTripped(host) {
  const b = _hostBreaker.get(host)
  if (!b) return false
  if (b.trippedUntil && Date.now() < b.trippedUntil) return true
  if (b.trippedUntil && Date.now() >= b.trippedUntil) {
    // 冷却结束,恢复并可重新尝试(清空计数)
    _hostBreaker.delete(host)
  }
  return false
}
function _hostBreakerRecordFailure(host) {
  if (!host) return
  const b = _hostBreaker.get(host) || { failures: 0, successes: 0, trippedUntil: 0 }
  b.failures++
  b.successes = 0
  if (b.failures >= BREAKER_FAIL_THRESHOLD) {
    b.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS
    try { console.warn(`[熔断] CDN 主机 ${host} 连续 ${b.failures} 次失败,熔断 ${BREAKER_COOLDOWN_MS / 1000}s`) } catch {}
  }
  _hostBreaker.set(host, b)
}
function _hostBreakerRecordSuccess(host) {
  if (!host) return
  const b = _hostBreaker.get(host)
  if (!b) return
  b.successes++
  b.failures = 0
  if (b.successes >= BREAKER_RESET_AFTER) {
    // 稳定恢复,彻底清除该主机熔断状态
    _hostBreaker.delete(host)
  } else {
    _hostBreaker.set(host, b)
  }
}
function _isNetworkFailure(msg) {
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|socket hang|连接被重置|DNS 解析失败|Request timeout|网络请求失败|5\d\d|收到空响应/i.test(msg || '')
}

function generateImageUrlVariants(origUrl) {
  try {
    const u = new url.URL(origUrl)
    const origHost = u.hostname
    const origPath = u.pathname
    const search = u.search
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(origPath)) return [origUrl]

    const origExt = (origPath.match(/\.(jpg|jpeg|png|webp|gif)$/i) || ['.jpg'])[0].toLowerCase()
    // 后缀优先级:原后缀 → webp(新图首选) → jpg(旧图兜底)
    const exts = []
    const push = e => { if (!exts.includes(e)) exts.push(e) }
    push(origExt); push('.webp')
    if (origExt !== '.jpg') push('.jpg')

    // 主机候选:原主机 → 基础 swap (普通↔带P) → 相邻编号主机
    const hosts = [origHost]
    const pushHost = h => { if (!hosts.includes(h)) hosts.push(h) }

    for (const [rx, repl] of CDN_HOST_SWAPS) {
      if (rx.test(origHost)) pushHost(origHost.replace(rx, repl))
    }
    const numMatch = origHost.match(/^p(\d+)(p?)\./i)
    if (numMatch) {
      const origNum = numMatch[1]
      const hasP = !!numMatch[2]
      const adjNums = CDN_ADJACENT_NUMBERS[origNum] || []
      for (const n of adjNums) {
        const stem = origHost.replace(/^p\d+p?\./i, '')
        pushHost(`p${n}${hasP ? 'p' : ''}.${stem}`)
        pushHost(`p${n}${hasP ? '' : 'p'}.${stem}`)
      }
    }

    // [优化 2026-08-08] 18rouman.vip 的 pN. 主域在部分网络被 TCP 重置(直连 000),
    // 但其 pNp. 子域可达。把可达子域提到 hosts 最前, 让第一梯队优先试可达主机。
    const reachHost = (() => {
      const m = /^p(\d+)\.(18rouman\.vip)$/i.exec(origHost)
      if (m) {
        const cand = `p${m[1]}p.${m[2]}`
        if (!hosts.includes(cand)) pushHost(cand)
        return cand
      }
      return null
    })()
    if (reachHost && hosts.includes(reachHost)) {
      hosts.splice(hosts.indexOf(reachHost), 1)
      hosts.unshift(reachHost)
    }
    // [增强 2026-08-20] 熔断:把当前处于熔断期的主机排到队尾,优先试其它可达主机。
    const reachable = hosts.filter(h => !_hostBreakerIsTripped(h))
    const tripped = hosts.filter(h => _hostBreakerIsTripped(h))
    const orderedHosts = reachable.concat(tripped)
    const primaryHost = orderedHosts[0]

    const out = []
    const seen = new Set()
    const pushV = v => { if (!seen.has(v)) { seen.add(v); out.push(v) } }

    // 第一梯队:可达主机(优先) + 所有后缀变体; 原主机作为第二梯队回退
    pushV(`${u.protocol}//${primaryHost}${origPath}${search}`)
    for (let ei = 1; ei < exts.length; ei++) {
      const newPath = origPath.replace(/\.(jpg|jpeg|png|webp|gif)$/i, exts[ei])
      pushV(`${u.protocol}//${primaryHost}${newPath}${search}`)
    }
    // 第二梯队:主机变体(先 swap 基础,再相邻编号) × [原后缀, webp]
    // 用 orderedHosts 保证熔断主机排到最后(优先试可达主机)
    for (let hi = 1; hi < orderedHosts.length; hi++) {
      const host = orderedHosts[hi]
      const useExts = exts.slice(0, 2) // 切主机只试 2 个后缀
      for (const ext of useExts) {
        const newPath = origPath.replace(/\.(jpg|jpeg|png|webp|gif)$/i, ext)
        pushV(`${u.protocol}//${host}${newPath}${search}`)
      }
    }
    return out.length ? out : [origUrl]
  } catch (e) {
    return [origUrl]
  }
}

// 对 downloadBuf 的包装:当主 URL 返回 404/403 时,自动尝试 generateImageUrlVariants() 生成的变体。
// 只对 404/403 这种"明确不存在/无权限"的错误使用变体;对 429/5xx/网络错误沿用原重试机制(退避再试同一个)。
async function downloadBufWithVariantFallback(imageUrl, referer, timeoutMs = 30000) {
  const variants = generateImageUrlVariants(imageUrl)
  const lastErrors = []
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i]
    try {
      const result = await downloadBuf(v, referer, timeoutMs)
      if (i > 0) {
        try { console.log(`[下载] 变体成功: 原URL返回失败, 变体 ${i}/${variants.length-1} ${v.substring(Math.max(0,v.length-70))} OK`) } catch {}
      }
      return result
    } catch (e) {
      const msg = (e && e.message) || String(e)
      // 原来只把 404/403 视为"确定找不到"才切变体; 现在把连接层错误也纳入:
      // 18rouman.vip 主域被墙表现为 TCP reset / 超时 / 网络失败(非 404),
      // 这类错误切到 pNp 可达子域即可成功, 不应在同一种子上反复重试。
      const isVariantable = /HTTP 404|HTTP 403|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|Request timeout|网络请求失败|socket hang|连接被重置|DNS 解析失败/i.test(msg)
      lastErrors.push(`${v.substring(Math.max(0,v.length-70))} → ${msg}`)
      // 只有 404/403 这种"确定找不到"才切下一个变体;其他错误让上层重试机制处理
      if (!isVariantable) throw e
      // 变体也不要无限试,试到上限就抛出聚合错误
      if (i === variants.length - 1) {
        const allMsgs = lastErrors.slice(0, 6).join(' ; ')
        throw new Error(`${msg} (已尝试 ${variants.length} 个 URL 变体均失败: ${allMsgs})`)
      }
    }
  }
  throw new Error(`下载失败: 无可用 URL 变体 (${variants.length} 个)`)
}

// 主线程异步判存在助手: 避免热路径(可移动磁盘)同步 fs.existsSync 卡死主线程导致 abort。
async function existsAsync(p) {
  try { await safeFs.stat(p); return true } catch (_) { return false }
}

function getDownloadRoots() {
  const candidates = []
  candidates.push(INTERNAL_ROOT)
  // 关键修复: 之前每次都同步 fs.existsSync(EXTERNAL_ROOT) 走网络盘(AFP/SMB),
  // 而 findComicDir/findChapterDir 在 sync 热路径每章都会调 getDownloadRoots,
  // 几百本×每本几十章 = 几万次同步网络 syscall -> 主线程卡死 (sync 永久 active).
  // 改为缓存盘挂载状态(30s TTL), 最多每 30s 才发一次同步 existsSync, 完全可接受.
  if (EXTERNAL_ROOT !== INTERNAL_ROOT && externalRootAvailable()) {
    candidates.push(EXTERNAL_ROOT)
  }
  candidates.push(app.getPath('downloads'))
  return candidates
}

// 外部盘挂载状态缓存(避免热路径每次同步 existsSync 网络盘)
// 关键修复: 热路径(getDownloadRoots)每 30s 会撞上 TTL 过期, 旧代码同步 fs.existsSync(EXTERNAL_ROOT)
// 扫网络盘 -> 底层 uv_fs_stat 在主线程卡死 -> SIGABRT (2026-08-31 19:01 崩溃同栈).
// 改为: 热路径只读缓存不阻塞; TTL 过期时 fire-and-forget 异步重检(永不阻塞主线程).
let _externalRootOk = false
let _externalRootTs = 0
function externalRootAvailable() {
  const now = Date.now()
  if (now - _externalRootTs > 30000) {
    // 不阻塞: 仅触发异步重检, 本次仍返回旧值
    _externalRootTs = now
    refreshExternalRoot()
  }
  return _externalRootOk
}
async function refreshExternalRoot() {
  try {
    await safeFs.access(EXTERNAL_ROOT)
    _externalRootOk = true
  } catch (_) { _externalRootOk = false }
  _externalRootTs = Date.now()
}

function getPrimaryDownloadRoot() {
  if (EXTERNAL_ROOT !== INTERNAL_ROOT && externalRootAvailable()) {
    return EXTERNAL_ROOT
  }
  return INTERNAL_ROOT
}

const comicDirCache = new Map()
let comicDirCacheTimestamp = 0
const COMIC_DIR_CACHE_TTL = 5 * 60 * 1000

const chapterDirCache = new Map()
let chapterDirCacheTimestamp = 0

async function resolveUniqueComicDir(preferredPath, sourceUrl) {
  // 防御：preferredPath 绝不能是下载根目录本身
  const rootSet = new Set(getDownloadRoots().map(r => path.resolve(r)))
  if (rootSet.has(path.resolve(preferredPath))) {
    throw new Error(`[目录错误] resolveUniqueComicDir: preferredPath 不能是下载根目录: ${preferredPath}`)
  }

  // 预订机制 (2026-07-27): 选定目录后立即 mkdir + 回写 local_path。
  // 否则两本同名漫画并发解析时(目录都还不存在)会拿到同一路径串本。
  const reserve = async (p) => {
    try { await safeFs.mkdir(p, { recursive: true }) } catch (_) {}
    if (sourceUrl) {
      try {
        const raw = db.getRawDB()
        if (raw) raw.prepare('UPDATE comics SET local_path = ? WHERE sourceUrl = ?').run(p, sourceUrl)
      } catch (_) {}
    }
    return p
  }

  if (!(await existsAsync(preferredPath))) return await reserve(preferredPath)

  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        if (row?.local_path === preferredPath) return preferredPath
        // Bug #46 修复: preferredPath 存在但 DB 中自己未映射 → 不等于"被占"!
        // 先确认该路径是否被 *其他* sourceUrl 占用:
        //   - 没人占用: 这就是之前下载的漏写了 local_path 的老目录,直接用 + 回写 DB
        //   - 被别人占用: 才进入 _N 分配逻辑
        const occupant = raw.prepare('SELECT sourceUrl FROM comics WHERE local_path = ? LIMIT 1').get(preferredPath)
        if (!occupant || !occupant.sourceUrl) {
          try { console.log(`[resolveUniqueComicDir] 目录已存在但未入 DB 映射,直接认领: ${preferredPath}`) } catch {}
          return reserve(preferredPath)
        }
        if (occupant.sourceUrl === sourceUrl) {
          return preferredPath
        }
        // 被其他漫画占用才继续
        try { console.warn(`[resolveUniqueComicDir] 目录已被其他漫画占用: ${preferredPath} 被=${occupant.sourceUrl.slice(0,60)} 自己=${String(sourceUrl||'').slice(0,60)} → 分配 _N`) } catch {}
      }
    } catch (_) {}
  } else {
    // 没有 sourceUrl 的场景(极少见): 目录存在也直接用, 反正没人声明归属
    return reserve(preferredPath)
  }

  let counter = 1
  let candidate
  do {
    candidate = `${preferredPath}_${counter}`
    counter++
  } while (await existsAsync(candidate))
  return await reserve(candidate)
}

async function findComicDir(title, sourceUrl) {
  // 获取所有下载根目录的 resolved 路径，用于防御性检查
  // 注: getDownloadRoots() 内部已用 externalRootAvailable() 缓存, 不再每次同步扫网络盘
  const rootSet = new Set(getDownloadRoots().map(r => path.resolve(r)))

  if (sourceUrl) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const row = raw.prepare('SELECT local_path FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        // 防御：local_path 不能是下载根目录本身（历史脏数据）
        // 不再做 fs.existsSync(row.local_path): 同步网络盘 syscall 在热路径会卡主线程;
        // 信任 DB 中已存的 local_path, 真正缺失会在后续 findChapterDir 找不到章节时自愈.
        if (row?.local_path && !rootSet.has(path.resolve(row.local_path))) {
          return row.local_path
        }
      }
    } catch (_) {}
  }

  // 同名多本防串 (2026-07-27 / Bug #43 修正):
  //  源站标题和库中 DB title 可能存在全角/半角标点差异(如 ":" vs "："), 按原字符串
  //   WHERE title = ? 会返回 1, 绕过同名检测, 结果会错误地进入另一本已存在的目录。
  //  改用 normalizeName 统一去符号/去去重后缀后比同组, 确保:
  //   ① 全角/半冒号、[ ]/【 】、「找回自我」vs「找回自我_1」都视为同组；
  //   ② 同组超过 1 本时，禁止按标题兜底找目录(会住进另一本的目录)，
  //     只信上面的 sourceUrl→local_path 精确路径；返回 null 让上层 resolveUniqueComicDir
  //     自动分配独立目录(加 _N 后缀)。
  //  注意: 必须放在缓存检查之前 — 缓存按标题键存, 同名两本命中同一条缓存。
  try {
    const raw = db.getRawDB()
    if (raw) {
      const allRows = raw.prepare('SELECT title FROM comics').all()
      const normT = normalizeName(title) || normalizeTitle(title)
      let dupN = 0
      const candidates = new Set()
      candidates.add(normT)
      if (sourceUrl) {
        const own = raw.prepare('SELECT title FROM comics WHERE sourceUrl = ?').get(sourceUrl)
        if (own?.title) {
          candidates.add(normalizeName(own.title) || normalizeTitle(own.title))
        }
      }
      for (const r of allRows) {
        const rn = normalizeName(r.title) || normalizeTitle(r.title)
        if (rn && candidates.has(rn)) dupN++
      }
      if (dupN > 1) return null
    }
  } catch (_) {}

  const now = Date.now()
  const cacheKey = normalizeName(title)
  
  if (now - comicDirCacheTimestamp < COMIC_DIR_CACHE_TTL && comicDirCache.has(cacheKey)) {
    return comicDirCache.get(cacheKey)
  }

  const candidates = [sanitize(title), title]
  const normTitle = normalizeName(title)

  // Bug #44 / [3D]沉沦 串写 修复: 扫盘匹配后,若该目录在 DB 中已被其他漫画占用,
  // 则不做命中,避免把新漫画下载到别人已存在的目录里。
  // (例如 normDir==='3d沉沦' 但实际磁盘目录是「母娘...沉沦...七海」,
  // 被其他漫画占用,就不能因为 normalize 后都含「沉沦」而误匹配。)
  let rawForCheck = null
  try {
    const dbRaw = db.getRawDB()
    if (dbRaw) rawForCheck = dbRaw.prepare('SELECT sourceUrl FROM comics WHERE local_path = ? LIMIT 1')
  } catch (_) {}

  for (const root of getDownloadRoots()) {
    try {
      const entries = await safeFs.readdir(root, { withFileTypes: true })
      const matchedDirs = []
      for (const e of entries) {
        if (!e.isDirectory()) continue
        // 1. 精确名称匹配（最高优先级）：目录名和清理后的标题完全一致
        if (e.name === sanitize(title) || e.name === title) {
          matchedDirs.push({ name: e.name, exact: true, hasSuffix: false })
          continue
        }
        const normDir = normalizeName(e.name)
        if (normDir && normTitle && normDir === normTitle) {
          // 2. 标准化匹配：区分"是否带 _N 去重后缀"，优先无后缀版本
          const hasSuffix = /[\s_\-（(]\s*\d+\s*[)）]?\s*$/.test(e.name) || /[\s_\-]\s*\d+\s*$/.test(e.name)
          matchedDirs.push({ name: e.name, exact: false, hasSuffix })
        }
      }
      // 排序优先级: exact=true > exact=false且无后缀 > exact=false且带后缀；
      // 同优先级再按目录名长度升序（更短的通常更"原始"），确保 [3D]沉沦 优先于 [3D]沉沦_1。
      matchedDirs.sort((a, b) => {
        const rank = x => (x.exact ? 0 : (x.hasSuffix ? 2 : 1))
        const ra = rank(a), rb = rank(b)
        if (ra !== rb) return ra - rb
        return a.name.length - b.name.length
      })
      for (const m of matchedDirs) {
        const p = path.join(root, m.name)
        if (rawForCheck) {
          try {
            const occupant = rawForCheck.get(p)
            // 只有 2 种情况允许命中:
            //  ① DB 中没人占用此目录 (occupant 为空);
            //  ② 占用者就是自己 (sourceUrl 匹配)。
            // 如果被其他 sourceUrl 的漫画占用, 跳过, 继续试下一个候选（比如优先无后缀目录被占用了，再试 _1）。
            if (occupant && occupant.sourceUrl && sourceUrl && occupant.sourceUrl !== sourceUrl) {
              continue
            }
          } catch (_) {}
        }
        comicDirCache.set(cacheKey, p)
        comicDirCache.set(normalizeName(m.name), p)
        comicDirCacheTimestamp = now
        return p
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

async function findChapterDir(comicDir, chapterIndex, chapterName, usedDirs) {
  // 去掉同步 fs.existsSync(comicDir): 调用方(_triggerAutoDownload)传入的 comicDir 已由 findComicDir 确认存在,
  // 而网络盘上每次 existsSync 走 AFP/SMB 协议延迟高, 每章一次 = 几千次同步 syscall 卡死主线程.
  if (!comicDir) return null
  const now = Date.now()
  const cacheKey = `${comicDir}:${chapterIndex}:${chapterName}`
  
  if (now - chapterDirCacheTimestamp < COMIC_DIR_CACHE_TTL && chapterDirCache.has(cacheKey)) {
    const cached = chapterDirCache.get(cacheKey)
    if (cached && await existsAsync(cached)) return cached
    if (cached === null) return null
  }

  const used = usedDirs || new Set()
  const entries = (await safeFs.readdir(comicDir, { withFileTypes: true }))
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
      const files = await listChapterImages(chPath)
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
      const files = await listChapterImages(chPath)
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
    const files = await listChapterImages(chPath)
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
      const files = await listChapterImages(chPath)
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

async function listChapterImages(chapterDir) {
  if (!chapterDir || !(await existsAsync(chapterDir))) return []
  const files = (await safeFs.readdir(chapterDir)).filter(f =>
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
  // Bug #11 修复: fs.openSync 后如果 readSync 抛错, fd 会泄漏; 用 try/finally 确保 close
  const fd = await safeFs.open(filePath, 'r')
  try {
    const header = Buffer.alloc(12)
    await fd.read(header, 0, 12, 0)
    return detectBufferFormat(header)
  } finally {
    await fd.close()
  }
}

async function validateImageFile(filePath) {
  try {
    // 不再用同步 fs.statSync/existsSync (网络盘上每个 stat 走 AFP/SMB 协议,
    // 几百本×每本几十章×每章上百图 = 几万次同步 syscall 会彻底堵死主线程).
    // 直接让 sharp 读图头: 文件不存在/为空/损坏都会 reject, 自然返回 false.
    const meta = await sharpPool.metadata(filePath)
    if (!meta || (meta.width === 0 && meta.height === 0)) return false
    return true
  } catch (e) {
    return false
  }
}

async function getValidChapterImages(chapterDir) {
  const allFiles = await listChapterImages(chapterDir)
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

// ---- Per-image 校验缓存 ----
// 主人要求: success 必须建立在「章节图片不缺 且 每张图片都真 sharp 解析过图头且正常」之上;
// 且 sharp 过 OK 的图以后不再重复 sharp。
// 实现: 每章一个 .sharp_cache.json, 记录每个图片文件 {size, mtimeMs} 指纹。
// 指纹未变的图视为「曾经 sharp 过 OK」, 命中缓存直接跳过 sharp; 仅新增/修改/损坏(指纹变)的图才 true sharp。
// 返回 { validFiles, allVerified }:
//   - validFiles: 通过校验(或命中缓存)的文件绝对路径数组
//   - allVerified: 是否「每张图都真做过 sharp 校验且 OK」(即无未校验图、无损坏图)
//     只有 allVerified && 数量不缺 才能写 success。
function getSharpCachePath(chDir) {
  return path.join(chDir, '.sharp_cache.json')
}

async function loadSharpCache(chDir) {
  const p = getSharpCachePath(chDir)
  try {
    // 直接尝试读, 文件不存在/解析失败都返回空缓存; 不再用同步 fs.existsSync+readFileSync
    return JSON.parse(await safeFs.readFile(p, 'utf8')) || {}
  } catch (_) {}
  return {}
}

async function saveSharpCache(chDir, cache) {
  try {
    // Bug #20 修复: 原子写 — 先写 .tmp 再 rename
    const finalPath = getSharpCachePath(chDir)
    const tmpPath = finalPath + '.tmp'
    await safeFs.writeFile(tmpPath, JSON.stringify(cache))
    await safeFs.rename(tmpPath, finalPath)
  } catch (e) {
    console.warn(`[下载] 保存 sharp 缓存失败: ${e.message}`)
  }
}

async function fileFingerprint(filePath) {
  try {
    const st = await safeFs.stat(filePath)
    return { size: st.size, mtime: Math.round(st.mtimeMs) }
  } catch (_) {
    return null
  }
}

async function getValidChapterImagesCached(chapterDir) {
  const allFiles = await listChapterImages(chapterDir)
  if (allFiles.length === 0) return { validFiles: [], allVerified: false }

  const cache = await loadSharpCache(chapterDir)
  const cacheEntries = cache.entries || {}
  const validFiles = []
  let allVerified = true
  let dirty = false
  const nextEntries = {}

  for (const f of allFiles) {
    const fp = await fileFingerprint(f)
    const base = path.basename(f)
    const prev = cacheEntries[base]
    const hit = fp && prev && prev.size === fp.size && prev.mtime === fp.mtime
    if (hit && prev.ok === true) {
      // 命中缓存: 曾经 sharp 过 OK, 且文件未变 -> 不再 sharp, 直接信任
      validFiles.push(f)
      nextEntries[base] = prev
      continue
    }
    // 需要真 sharp 校验(新增/修改/或曾损坏)
    const ok = await validateImageFile(f)
    if (ok) {
      validFiles.push(f)
      nextEntries[base] = { size: fp ? fp.size : 0, mtime: fp ? fp.mtime : 0, ok: true }
    } else {
      allVerified = false
      // 损坏/空文件: 记录 ok=false, 下次若文件变了会重新 sharp
      nextEntries[base] = { size: fp ? fp.size : 0, mtime: fp ? fp.mtime : 0, ok: false }
      console.warn(`[下载] 检测到损坏/空图片文件: ${f}`)
    }
    dirty = true
  }

  // 清理已删除文件的缓存条目
  for (const k of Object.keys(nextEntries)) {
    if (!allFiles.some(f => path.basename(f) === k)) delete nextEntries[k]
  }

  if (dirty || Object.keys(nextEntries).length !== Object.keys(cacheEntries).length) {
    await saveSharpCache(chapterDir, { entries: nextEntries })
  }
  return { validFiles, allVerified }
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

async function loadChapterState(chDir) {
  const p = getChapterStatePath(chDir)
  try {
    const state = JSON.parse(await safeFs.readFile(p, 'utf8'))
    return state
  } catch (e) {
    console.warn(`[下载] 读取章节状态失败: ${e.message}`)
  }
  return null
}

async function saveChapterState(chDir, state) {
  try {
    // Bug #20 修复: 原子写 — 先写 .tmp 再 rename, 防止崩溃时产生截断 JSON
    const finalPath = getChapterStatePath(chDir)
    const tmpPath = finalPath + '.tmp'
    await safeFs.writeFile(tmpPath, JSON.stringify(state, null, 2))
    await safeFs.rename(tmpPath, finalPath)
  } catch (e) {
    console.warn(`[下载] 保存章节状态失败: ${e.message}`)
  }
}

async function downloadChapterImages(job, images, chDir, startIndex, comicTitle, chapterName, chapter, sourceUrl, onProgress) {
  if (!images || images.length === 0) {
    throw new Error('无图片可下载')
  }

  const state = await loadChapterState(chDir) || {
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
    if (await existsAsync(existingFile)) {
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
      // [增强 2026-08-20] 空图(瞬态)多给 2 次重试机会(共 5 次),因为源站偶发返回空 buffer。
      const maxRetries = 5

      while (retries < maxRetries && !success) {
        try {
          // 先用带变体回退的 downloadBuf:404/403 自动切 .webp + 换 CDN 主机重试
          const { buffer: buf } = await downloadBufWithVariantFallback(imageUrl, chapter.url)
          if (!buf || buf.length === 0) {
            // [增强 2026-08-20] 空图(源站偶发返回 0 字节/损坏 buffer)按瞬态错误处理:
            // 计入熔断失败让后续更可能切到其它主机,并触发重试而不是永久失败。
            try { _hostBreakerRecordFailure(new url.URL(imageUrl).hostname) } catch {}
            throw new Error('下载的图片为空(空buffer)')
          }
          imageBuffers.set(imageIndex, buf)
          bytesDownloaded += buf.length
          success = true
        } catch (e) {
          retries++
          lastError = e
          // Bug #21 修复: 永久错误(所有变体均 404/403)不重试, 直接计入失败
          const msg = String(e?.message || e)
          // [增强 2026-08-20] 空图是瞬态错误,不计入永久失败,继续重试(直到 maxRetries 用尽)
          if (msg.includes('下载的图片为空')) {
            if (retries < maxRetries) {
              const delay = 800 + Math.random() * 1200
              try { console.log(`[下载] 第${imageIndex + 1}页 空图重试,等待 ${Math.round(delay)}ms...`) } catch {}
              await new Promise(r => setTimeout(r, delay))
              continue
            }
            // 重试耗尽仍空:记为失败项
            currentFailedImages.push({
              index: imageIndex + 1,
              url: imageUrl,
              error: '空图(重试耗尽)',
              emptyImage: true
            })
            try { console.warn(`[下载] 图片空图重试耗尽 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页`) } catch {}
            break
          }
          if (msg.includes('HTTP 404') || msg.includes('均失败') || msg.includes('HTTP 403')) {
            currentFailedImages.push({
              index: imageIndex + 1,
              url: imageUrl,
              error: e.message
            })
            try { console.warn(`[下载] 图片永久失败 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页: ${e.message}`) } catch {}
            break
          }
          if (retries >= maxRetries) {
            currentFailedImages.push({
              index: imageIndex + 1,
              url: imageUrl,
              error: e.message
            })
            try { console.warn(`[下载] 图片下载失败 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页 (${retries}/${maxRetries}): ${e.message}`) } catch {}
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
    // 取消时只统计已真正落盘的图片数（fs.existsSync 校验过的）
    // 未落盘的 buffer 主动丢弃，不计入完成数，避免 DB 记录大于实际磁盘文件数
    let downloadedOnDisk = 0
    let pendingInBuffer = 0
    for (const [idx, buf] of imageBuffers) {
      if (!buf) continue
      const outPath = path.join(chDir, `${String(idx + 1).padStart(3, '0')}.webp`)
      if (await existsAsync(outPath)) {
        // 已真正落盘：保留计入完成
        downloadedOnDisk++
        if (!state.completedIndices.includes(idx)) {
          state.completedIndices.push(idx)
        }
      } else {
        // 未落盘的 buffer 主动丢弃，仅计入 pending
        pendingInBuffer++
      }
    }
    await saveChapterState(chDir, state)
    return {
      cancelled: true,
      downloaded: downloadedOnDisk,
      pending: pendingInBuffer,
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
        await safeFs.writeFile(outPath, webpBuf)
      }
      downloaded++
      if (!state.completedIndices.includes(imageIndex)) {
        state.completedIndices.push(imageIndex)
      }
      state.failedImages = (state.failedImages || []).filter(f => f.index !== imageIndex + 1)
    } catch (e) {
      writeErrors.push({ index: imageIndex + 1, error: e.message })
      try { console.warn(`[下载] 图片转换失败 ${comicTitle} › ${chapterName} 第${imageIndex + 1}页: ${e.message}`) } catch {}
      // Bug #5 修复: writeErrors 合入 state.failedImages, 同时从 completedIndices 中去掉(防止失败当成功)
      state.completedIndices = state.completedIndices.filter(i => i !== imageIndex)
      // 避免 failedImages 里同一 index 重复
      state.failedImages = (state.failedImages || []).filter(f => f.index !== imageIndex + 1)
      state.failedImages.push({
        index: imageIndex + 1,
        url: (images[imageIndex] && (typeof images[imageIndex] === 'string' ? images[imageIndex] : images[imageIndex].url)) || '',
        error: `write:${e.message}`
      })
    }
  }

  if (currentFailedImages.length > 0) {
    const existing = new Set((state.failedImages || []).map(f => f.index))
    for (const f of currentFailedImages) {
      if (!existing.has(f.index)) state.failedImages.push(f)
    }
  }

  await saveChapterState(chDir, state)

  // Bug #4 修复: 所有页面都已下载 AND 没有任何失败项 => success=true
  const failedCount = (state.failedImages || []).length
  const allCompleted = state.completedIndices.length >= images.length
  if (allCompleted && failedCount === 0) {
    try {
      const statePath = getChapterStatePath(chDir)
      if (await existsAsync(statePath)) {
        await safeFs.unlink(statePath)
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
    // Bug #4 修复: success 不再永远为 true
    success: allCompleted && failedCount === 0,
    downloaded,
    total: images.length,
    chapter: chapterName
  }

  if (failedCount > 0) {
    result.failedImages = state.failedImages
    result.failedCount = failedCount
  }
  if (writeErrors.length > 0) {
    result.writeErrors = writeErrors
  }

  return result
}

async function downloadAndConvert(url, filePath, referer) {
  for (let i = 0; i < 3; i++) {
    try {
      const { buffer, byteLength } = await downloadBufWithVariantFallback(url, referer)
      await sharpPool.webpConvert(buffer, filePath, { quality: 85 })
      const actualFormat = await detectFileFormat(filePath)
      if (actualFormat !== 'webp') {
        console.warn(`[下载] 图片格式不正确(${actualFormat})，重新转换: ${filePath}`)
        const webpBuf = await sharpPool.webpConvertToBuffer(buffer, { quality: 85 })
        await safeFs.writeFile(filePath, webpBuf)
      }
      return byteLength
    } catch (e) { if (i === 2) throw e; await sleep(1000 * (i + 1)) }
  }
  return 0
}
const MAX_REDIRECTS = 5
async function downloadBuf(imageUrl, referer, timeoutMs = 30000, redirectsLeft = MAX_REDIRECTS) {
  // DNS 预解析: 用公共 DNS(8.8.8.8/1.1.1.1)快速检查域名是否可解析(3 秒超时)
  // 避免系统 DNS 对 18rouman.vip 等域名超时 28-49 秒, 触发 downloadBuf 30 秒超时
  const dnsOk = await dnsCache.prefetch(imageUrl)
  if (!dnsOk) {
    let hostname = ''
    try { hostname = new url.URL(imageUrl).hostname } catch {}
    throw new Error(`DNS 解析失败: ${hostname}`)
  }

  return new Promise((resolve, reject) => {
    let settled = false

    // 使用 Electron net 模块 (Chromium 网络栈), 与浏览器 DNS 解析一致, 避免 Node.js getaddrinfo ENOTFOUND
    // Bug #45 修复: 用 net.request 的 referrer 选项替代 setHeader('Referer', ...),
    //   否则 Chromium 的 Referrer 安全策略会判定跨域 referrer 无效并阻止请求
    //   (smtt6.com → 18rouman.vip 跨域, setHeader 设置的 Referer 被 ERR_BLOCKED_BY_CLIENT 拦截)
    const request = net.request({
      method: 'GET',
      url: imageUrl,
      redirect: 'manual',
      referrer: referer || '',
    })
    request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    request.setHeader('Accept', 'image/*')

    let reqTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { request.abort() } catch (_) {}
      // [增强 2026-08-20] 熔断:请求超时计入主机失败
      try { _hostBreakerRecordFailure(new url.URL(imageUrl).hostname) } catch {}
      reject(new Error('Request timeout'))
    }, timeoutMs)

    request.on('response', (res) => {
      if (settled) { res.resume(); return }

      if ([301, 302, 307, 308].includes(res.statusCode)) {
        try { request.abort() } catch (_) {}
        clearTimeout(reqTimeout)
        settled = true
        if (redirectsLeft <= 0) {
          return reject(new Error(`重定向次数超过上限 (${MAX_REDIRECTS})`))
        }
        const location = res.headers.location
        if (!location) return reject(new Error('重定向缺少 Location 头'))
        const redirectUrl = location.startsWith('http') ? location : new url.URL(location, imageUrl).href
        return resolve(downloadBuf(redirectUrl, referer, timeoutMs, redirectsLeft - 1))
      }

      if (res.statusCode !== 200) {
        try { request.abort() } catch (_) {}
        clearTimeout(reqTimeout)
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
        if (settled) return
        settled = true
        try { request.abort() } catch (_) {}
        // [增强 2026-08-20] 熔断:响应超时计入主机失败
        try { _hostBreakerRecordFailure(new url.URL(imageUrl).hostname) } catch {}
        reject(new Error('Response timeout'))
      }, timeoutMs)

      res.on('data', (d) => {
        clearTimeout(resTimeout)
        resTimeout = setTimeout(() => {
          if (settled) return
          settled = true
          try { request.abort() } catch (_) {}
          // [增强 2026-08-20] 熔断:响应体传输超时计入主机失败
          try { _hostBreakerRecordFailure(new url.URL(imageUrl).hostname) } catch {}
          reject(new Error('Response timeout'))
        }, timeoutMs)
        c.push(d)
      })
      res.on('end', () => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        const buf = Buffer.concat(c)
        // [增强 2026-08-20] 熔断:成功拿到响应(即便空)也算主机可用,清除失败计数
        try { _hostBreakerRecordSuccess(new url.URL(imageUrl).hostname) } catch {}
        resolve({ buffer: buf, byteLength: buf.length })
      })
      res.on('error', (e) => {
        if (settled) return
        clearTimeout(resTimeout)
        settled = true
        try { request.abort() } catch (_) {}
        reject(new Error(`Response error: ${(e && (e.message || e.code)) || String(e)}`))
      })
    })

    request.on('error', (e) => {
      if (settled) return
      clearTimeout(reqTimeout)
      settled = true
      const code = (e && e.code) || ''
      const rawMsg = (e && e.message) || ''
      const friendly = code ? `网络请求失败: ${code} ${rawMsg}`.trim() : (rawMsg || '网络请求失败: 未知错误')
      // [增强 2026-08-20] 熔断:网络层失败(含 ECONNRESET/超时)计入该主机失败
      if (_isNetworkFailure(friendly)) {
        try { _hostBreakerRecordFailure(new url.URL(imageUrl).hostname) } catch {}
      }
      reject(new Error(friendly))
    })

    request.end()
  })
}
async function checkChapterHealth(chapterDir, options = {}) {
  const { onlineCount, deepCheck } = options
  const issues = []
  const allFiles = await listChapterImages(chapterDir)

  if (allFiles.length === 0) {
    issues.push({ type: 'empty', message: '章节目录为空' })
    return { healthy: false, issues, totalFiles: 0, corruptCount: 0, emptyCount: 0, gapCount: 0, missingCount: 0, onlineCount: onlineCount || 0 }
  }

  let corruptCount = 0
  let emptyCount = 0
  for (const f of allFiles) {
    try {
      const stat = await safeFs.stat(f)
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
  if (!comicDir || !(await existsAsync(comicDir))) {
    return { healthy: false, chapters: [], message: '漫画目录不存在' }
  }

  const entries = await safeFs.readdir(comicDir, { withFileTypes: true })
  const chapterDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))

  let missingCover = false
  const coverPath = path.join(comicDir, 'cover.webp')
  if (!(await existsAsync(coverPath))) {
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
  existsAsync,
  getDownloadRoots,
  getPrimaryDownloadRoot,
  setExternalRoot,
  getExternalRoot,
  refreshExternalRoot,
  normalizeUrl,
  resolveUniqueComicDir,
  resolveComicDir,
  findComicDir,
  clearComicDirCache,
  findChapterDir,
  listChapterImages,
  validateImageFile,
  getValidChapterImages,
  getValidChapterImagesCached,
  getSharpCachePath,
  checkDiskSpace,
  getChapterStatePath,
  loadChapterState,
  saveChapterState,
  downloadChapterImages,
  downloadAndConvert,
  downloadBuf,
  downloadBufWithVariantFallback,
  generateImageUrlVariants,
  sleep,
  checkChapterHealth,
  checkComicHealth,
  getGlobalDownloadConcurrency,
  setGlobalDownloadConcurrency
}

async function resolveComicDir(comicTitle, sourceUrl, payloadComicDir) {
  if (payloadComicDir && typeof payloadComicDir === 'string' && payloadComicDir.trim() !== '') {
    return payloadComicDir
  }
  if (!comicTitle || typeof comicTitle !== 'string' || comicTitle.trim() === '') {
    throw new Error('漫画标题不能为空，无法确定下载路径')
  }
  const title = comicTitle.trim()
  let dir = await findComicDir(title, sourceUrl)

  // Bug #44 第二道防线: findComicDir 命中后,再核对 DB 中该路径是否被其他漫画占用。
  // findComicDir 里虽已做占用检查,但缓存 / try-catch 吞错等场景可能漏过;
  // resolveComicDir 是真正进入下载前的最后关口,在这里兜底最稳。
  if (dir) {
    try {
      const raw = db.getRawDB()
      if (raw) {
        const occupant = raw.prepare('SELECT sourceUrl FROM comics WHERE local_path = ? LIMIT 1').get(dir)
        if (occupant && occupant.sourceUrl && sourceUrl && occupant.sourceUrl !== sourceUrl) {
          console.warn(`[resolveComicDir] findComicDir 命中的目录已被其他漫画占用,放弃匹配并分配新目录: 「${title}」path=${dir}  被 sourceUrl=${occupant.sourceUrl.slice(0,60)} 占用`)
          dir = null
        }
      }
    } catch (_) {}
  }

  if (!dir) {
    const preferred = path.join(getPrimaryDownloadRoot(), sanitize(title))
    dir = await resolveUniqueComicDir(preferred, sourceUrl)
  }
  const downloadRoot = getPrimaryDownloadRoot()
  if (downloadRoot.startsWith('/Volumes/') && !(await existsAsync(downloadRoot))) {
    throw new Error(`下载磁盘未挂载: ${downloadRoot}\n请先连接外部磁盘后再下载`)
  }
  const resolvedComicDir = path.resolve(dir)
  const resolvedRoot = path.resolve(downloadRoot)
  if (resolvedComicDir === resolvedRoot) {
    throw new Error(`漫画目录路径无效，与下载根目录相同: ${dir}`)
  }
  if (!(await existsAsync(dir))) {
    await safeFs.mkdir(dir, { recursive: true })
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