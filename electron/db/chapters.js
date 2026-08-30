'use strict'

const { ensureDb, loadChapterList } = require('./helpers')

async function updateChapterImageCounts(comicId, chaptersWithCounts) {
  const db = ensureDb()
  if (!chaptersWithCounts || chaptersWithCounts.length === 0) return
  const updateStmt = db.prepare('UPDATE chapters SET image_count = ? WHERE comic_id = ? AND url = ?')
  const updateAll = db.transaction(() => {
    for (const ch of chaptersWithCounts) {
      if (ch.url) {
        updateStmt.run(ch.image_count || 0, comicId, ch.url)
      }
    }
  })
  updateAll()
  return chaptersWithCounts.length
}

async function updateChapterImageCountBySourceUrl(sourceUrl, chapterIndex, imageCount) {
  const db = ensureDb()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  db.prepare('UPDATE chapters SET image_count = ? WHERE comic_id = ? AND sort_order = ?').run(
    imageCount || 0, row.id, chapterIndex
  )
  return 1
}

// 按 sourceUrl + 章节序号取源站应有图片数(image_count)。
// 用于下载 skip 判定: 磁盘已有图数必须 == 源站应有数才能跳过, 否则当缺图补下。
// 返回 0 表示未知(无 image_count), 由调用方决定如何处理。
async function getChapterImageCountBySourceUrl(sourceUrl, chapterIndex) {
  const db = ensureDb()
  if (!sourceUrl) return 0
  const row = db.prepare('SELECT id FROM comics WHERE sourceUrl = ? LIMIT 1').get(sourceUrl)
  if (!row) return 0
  const ch = db.prepare('SELECT image_count FROM chapters WHERE comic_id = ? AND sort_order = ? LIMIT 1').get(row.id, chapterIndex)
  return (ch && ch.image_count) ? ch.image_count : 0
}

async function getComicsNeedingImageCountUpdate(batchSize) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT DISTINCT c.id, c.sourceUrl, c.title, c.chapter_count
     FROM comics c
     INNER JOIN chapters ch ON ch.comic_id = c.id
     WHERE (ch.image_count IS NULL OR ch.image_count = 0) AND ch.url IS NOT NULL AND ch.url != ''
     ORDER BY c.chapter_count DESC, c.id
     LIMIT ?`
  ).all(batchSize)
  return rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count
  }))
}

async function getChaptersWithoutImageCount(comicId) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT sort_order, name, url FROM chapters WHERE comic_id = ? AND (image_count IS NULL OR image_count = 0) AND url IS NOT NULL AND url != '' ORDER BY sort_order`
  ).all(comicId)
  return rows.map(r => ({
    index: r.sort_order,
    name: r.name,
    url: r.url
  }))
}

function isChapterNameGeneric(name) {
  if (!name) return true
  const trimmed = String(name).trim()
  const genericPatterns = [
    /^第\s*\d+\s*[话話章回集]$/,
    /^ch(apter)?\s*\d+$/i,
    /^episode\s*\d+$/i,
    /^ep\s*\d+$/i
  ]
  return genericPatterns.some(p => p.test(trimmed))
}

async function getComicsWithGenericChapterNames(batchSize = 10) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT DISTINCT c.id, c.sourceUrl, c.title, c.chapter_count, c.chapter_names_enriched
     FROM comics c
     INNER JOIN chapters ch ON ch.comic_id = c.id
     WHERE c.chapter_count > 0
       AND c.sourceUrl IS NOT NULL AND c.sourceUrl != ''
       AND (
         ch.name IS NULL OR ch.name = ''
         OR ch.name GLOB '第*[0-9]*话'
         OR ch.name GLOB '第*[0-9]*話'
         OR ch.name GLOB '第*[0-9]*章'
         OR ch.name GLOB '第*[0-9]*回'
         OR ch.name GLOB '第*[0-9]*集'
       )
     ORDER BY c.chapter_count DESC
     LIMIT ?`
  ).all(batchSize)
  return rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count || 0,
    chapter_names_enriched: r.chapter_names_enriched || 0
  }))
}

async function getComicsNeedingChapterNameEnrichment(batchSize = 10) {
  const db = ensureDb()
  const rows = db.prepare(
    `SELECT id, sourceUrl, title, chapter_count, chapter_names_enriched
     FROM comics
     WHERE chapter_count > 0 AND (chapter_names_enriched = 0 OR chapter_names_enriched IS NULL)
     ORDER BY chapter_count DESC
     LIMIT ?`
  ).all(batchSize)
  const docs = rows.map(r => ({
    _id: r.id,
    sourceUrl: r.sourceUrl,
    title: r.title,
    chapter_count: r.chapter_count || 0,
    chapter_names_enriched: r.chapter_names_enriched || 0
  }))
  for (const doc of docs) {
    doc.chapters = loadChapterList(db, doc._id)
  }
  return docs
}

async function updateChapterName(comicId, sortOrder, newName) {
  const db = ensureDb()
  db.prepare('UPDATE chapters SET name = ? WHERE comic_id = ? AND sort_order = ?').run(newName || '', comicId, sortOrder)
}

async function updateChapterNames(comicId, updates) {
  const db = ensureDb()
  if (!updates || updates.length === 0) return 0
  const updateStmt = db.prepare('UPDATE chapters SET name = ? WHERE comic_id = ? AND sort_order = ?')
  const updateAll = db.transaction(() => {
    for (const u of updates) {
      updateStmt.run(u.name || '', comicId, u.index)
    }
  })
  updateAll()
  return updates.length
}

async function markComicChaptersEnriched(comicId) {
  const db = ensureDb()
  db.prepare('UPDATE comics SET chapter_names_enriched = 1, updatedAt = ? WHERE id = ?').run(Date.now(), comicId)
}

module.exports = {
  updateChapterImageCounts, updateChapterImageCountBySourceUrl,
  getChapterImageCountBySourceUrl,
  getComicsNeedingImageCountUpdate, getChaptersWithoutImageCount,
  isChapterNameGeneric, getComicsWithGenericChapterNames,
  getComicsNeedingChapterNameEnrichment,
  updateChapterName, updateChapterNames, markComicChaptersEnriched,
  reconcileImageCounts
}

// ============ Bug 修复 (2026-08-17): image_count 以磁盘为准回填 ============
// 背景: chapters.image_count 之前只写源站"应有图数 expected", 与磁盘实况脱节
// (抽查 SuperDick: DB 记"第1话 28图"但磁盘 0 张, "第121话 0图"但文件夹不存在),
// 导致: ① 无法用 image_count 判断"是否真下载"; ② getComicsNeedingImageCountUpdate
// 把"0图"章当"待补"无限循环扫描, 浪费 sync 配额。
// 本函数: 遍历漫画 local_path 下各章文件夹, 用真实图片文件数覆盖 image_count,
// 让 DB 与磁盘一致。返回实际回填的章节数。
const path = require('path')
const fs = require('fs')
const safeFs = require('../modules/safeFs')

async function reconcileImageCounts(comicId, localPath) {
  const db = ensureDb()
  // 关键修复: 之前用同步 fs.existsSync(localPath) 判存在——local_path 在可移动磁盘(AFP/SMB)
  // 上时, 每次 sync 扫全库都会在主线程发起上万次同步 stat syscall, 卡死主线程
  // (uv_fs_stat -> uv_mutex 死锁 -> abort 崩溃, 见 08-29 12:50 崩溃报告)。
  if (!localPath) return 0
  try { await safeFs.access(localPath) } catch (_) { return 0 }

  // 取该漫画所有章节 (id, name, sort_order) 用于磁盘目录匹配
  const rows = db.prepare(
    'SELECT id, name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order'
  ).all(comicId)
  if (rows.length === 0) return 0

  // 章节磁盘目录命名形如 "12-第12话" 或 "12"，用 sort_order+1 前缀匹配
  let dirEntries = []
  try {
    dirEntries = (await safeFs.readdir(localPath, { withFileTypes: true }))
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
  } catch (_) {
    return 0
  }
  const dirByName = new Set(dirEntries.map(e => e.name))

  const IMG_RE = /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i

  // 关键修复: 先异步收集每章真实图数(扫外部网络盘走 fs.promises, 不卡主线程),
  // 再一次性同步事务写库。不能在 db.transaction 回调里 await (事务闭包非 async)。
  const counts = [] // [{ id, count }]
  for (const r of rows) {
    // 候选目录: 优先 "sort_order+1-xxx"，其次 "sort_order+1"
    const idx = r.sort_order + 1
    let dirName = null
    const named = `${idx}-${r.name}`
    if (dirByName.has(named)) dirName = named
    else if (dirByName.has(String(idx))) dirName = String(idx)
    else {
      const fallback = dirEntries.find(e => e.name === String(idx) || e.name.startsWith(`${idx}-`))
      if (fallback) dirName = fallback.name
    }
    if (!dirName) continue
    const chDir = path.join(localPath, dirName)
    let count = 0
    try {
      count = (await safeFs.readdir(chDir)).filter(f => IMG_RE.test(f)).length
    } catch (_) { count = 0 }
    counts.push({ id: r.id, count })
  }

  const updateStmt = db.prepare('UPDATE chapters SET image_count = ? WHERE id = ?')
  const tx = db.transaction(() => { for (const c of counts) { updateStmt.run(c.count, c.id) } })
  tx()
  return counts.length
}