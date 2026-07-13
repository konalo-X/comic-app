'use strict'

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const core = require('./core')
const downloads = require('./downloads')
const { ensureDb, findExistingComicMatch, insertChapterRow, insertDownloadRecord, runInTransaction } = require('./helpers')

async function checkExistingByTitle(titles) {
  const db = ensureDb()
  if (!titles || titles.length === 0) return {}

  const allComics = db.prepare('SELECT id, title, sourceUrl FROM comics').all()
  if (allComics.length === 0) {
    const result = {}
    for (const t of titles) result[t] = false
    return result
  }

  const dbComics = allComics.map(({ id, title, sourceUrl }) => ({
    id, title, sourceUrl,
    normTitle: core.normalizeName(title)
  }))

  const result = {}
  for (const title of titles) {
    const norm = core.normalizeName(title)
    let matched = false
    for (const c of dbComics) {
      if (c.title === title) { matched = true; break }
      if (c.normTitle && norm && c.normTitle === norm) { matched = true; break }
      if (c.normTitle && norm && (c.normTitle.includes(norm) || norm.includes(c.normTitle))) {
        if (c.normTitle.length > 2 && norm.length > 2) { matched = true; break }
      }
    }
    result[title] = matched
  }
  return result
}

async function scanLocalComics(dirPath) {
  if (!fs.existsSync(dirPath)) return []

  const IMG_EXT = /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i
  const chapterDirPattern = /(^\d+-)|(^第\d+)|(^(ch(apter)?[_\-]?)?\d+)/i
  const MAX_COMICS = 50000
  const MAX_CHAPTERS_PER_COMIC = 2000

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const comics = []

  const sortByNumber = (arr) => {
    const getIdx = (name) => {
      const m = name.match(/\d+/)
      return m ? parseInt(m[0], 10) : 99999
    }
    return arr.sort((a, b) => {
      const ia = getIdx(typeof a === 'string' ? a : a.name)
      const ib = getIdx(typeof b === 'string' ? b : b.name)
      if (ia !== ib) return ia - ib
      return (typeof a === 'string' ? a : a.name).localeCompare(typeof b === 'string' ? b : b.name)
    })
  }

  const yieldEvery = 20
  let processedCount = 0

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('_')) continue
    if (comics.length >= MAX_COMICS) break

    const comicDir = path.join(dirPath, e.name)
    let subs
    try {
      subs = await fs.promises.readdir(comicDir, { withFileTypes: true })
    } catch { continue }

    let chapterDirs = subs.filter(d => d.isDirectory() && chapterDirPattern.test(d.name))
    if (chapterDirs.length === 0) {
      const candidates = []
      for (const d of subs) {
        if (!d.isDirectory()) continue
        const chDir = path.join(comicDir, d.name)
        try {
          const files = await fs.promises.readdir(chDir)
          if (files.some(f => IMG_EXT.test(f))) candidates.push(d)
        } catch {}
      }
      chapterDirs = candidates
    }
    if (chapterDirs.length === 0) continue
    if (chapterDirs.length > MAX_CHAPTERS_PER_COMIC) {
      chapterDirs = sortByNumber(chapterDirs).slice(0, MAX_CHAPTERS_PER_COMIC)
    }
    sortByNumber(chapterDirs)

    const chapters = []
    for (let idx = 0; idx < chapterDirs.length; idx++) {
      const d = chapterDirs[idx]
      const chDir = path.join(comicDir, d.name)
      let imageFiles
      try {
        imageFiles = (await fs.promises.readdir(chDir)).filter(f => IMG_EXT.test(f))
      } catch { continue }
      sortByNumber(imageFiles)
      const cleanName = d.name
        .replace(/^\d+-/, '')
        .replace(/^第(\d+)[話话章回集卷]/, '第$1话')
        .replace(/^ch(apter)?[_\-]?/, '')
      chapters.push({
        name: cleanName || `第${idx + 1}章`,
        imageCount: imageFiles.length,
        path: chDir
      })
    }
    if (chapters.length === 0) continue

    let cover = null
    const coverPath = path.join(comicDir, 'cover.webp')
    if (fs.existsSync(coverPath)) {
      cover = coverPath
    }

    comics.push({
      title: e.name,
      coverPath: cover,
      chapters,
      totalImages: chapters.reduce((s, c) => s + c.imageCount, 0)
    })

    processedCount++
    if (processedCount % yieldEvery === 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  return comics
}

async function importLocalComic(comic, targetRoot, sourceUrl, destDir) {
  const db = ensureDb()
  const titleDir = destDir || path.join(targetRoot, core.sanitizeFilename(comic.title))
  if (!fs.existsSync(titleDir)) fs.mkdirSync(titleDir, { recursive: true })

  if (comic.coverPath) {
    const srcPath = comic.coverPath.replace('file://', '')
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(titleDir, 'cover.webp'))
    }
  }

  let dbChapters = []
  for (let i = 0; i < comic.chapters.length; i++) {
    const ch = comic.chapters[i]
    const folderName = `${i + 1}-${core.sanitizeFilename(ch.name)}`
    const destDir = path.join(titleDir, folderName)
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

    const srcFiles = fs.readdirSync(ch.path).filter(f => /\.(webp|jpg|png)$/i.test(f)).sort()
    for (const f of srcFiles) {
      fs.copyFileSync(path.join(ch.path, f), path.join(destDir, f))
    }

    dbChapters.push({ name: ch.name, url: '', index: i, imageCount: ch.imageCount, path: path.join(titleDir, folderName) })
  }

  const now = Date.now()
  const id = sourceUrl || crypto.randomUUID()
  if (sourceUrl) {
    const existing = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (existing) {
      db.prepare('UPDATE comics SET chapter_count=?, updatedAt=?, favorited=1 WHERE id=?').run(comic.chapters.length, now, existing.id)
      db.prepare('DELETE FROM chapters WHERE comic_id=?').run(existing.id)
      runInTransaction(db, () => {
        for (let i = 0; i < dbChapters.length; i++) {
          insertChapterRow(db, existing.id, dbChapters[i], i)
        }
      })
    } else {
      const coverOnDisk = path.join(titleDir, 'cover.webp')
      const localCoverPath = fs.existsSync(coverOnDisk) ? coverOnDisk : (comic.coverPath || '')
      db.prepare('INSERT OR IGNORE INTO comics (id, sourceUrl, title, cover, local_cover, status, chapter_count, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        id, sourceUrl || null, comic.title, '', localCoverPath, '连载中', comic.chapters.length, 1, targetRoot, now, now
      )
      runInTransaction(db, () => {
        for (let i = 0; i < dbChapters.length; i++) {
          insertChapterRow(db, id, dbChapters[i], i)
        }
      })
    }
  } else {
    const coverOnDisk2 = path.join(titleDir, 'cover.webp')
    const localCoverPath2 = fs.existsSync(coverOnDisk2) ? coverOnDisk2 : (comic.coverPath || '')
    db.prepare('INSERT OR IGNORE INTO comics (id, sourceUrl, title, cover, local_cover, status, chapter_count, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      id, null, comic.title, '', localCoverPath2, '连载中', comic.chapters.length, 1, targetRoot, now, now
    )
    runInTransaction(db, () => {
      for (let i = 0; i < dbChapters.length; i++) {
        insertChapterRow(db, id, dbChapters[i], i)
      }
    })
  }

  for (const ch of dbChapters) {
    insertDownloadRecord(db, sourceUrl || id, comic.title, ch, ch.index, now)
  }

  return { success: true, title: comic.title, chapterCount: comic.chapters.length }
}

async function registerExistingDownload(comic, sourceUrl) {
  const db = ensureDb()
  const now = Date.now()

  const existing = await downloads.getDownloadRecords({ comicTitle: comic.title })
  const existingKeys = new Set(existing.map(r => `${r.comicTitle}-${r.chapterIndex}`))

  let finalComicId = null
  let matchedBy = null
  let wasFavoritedBefore = false

  if (sourceUrl) {
    const r1 = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (r1) {
      finalComicId = r1.id
      wasFavoritedBefore = !!r1.favorited
      matchedBy = 'sourceUrl'
    }
  }

  if (!finalComicId) {
    const allComics = db.prepare('SELECT id, title, favorited FROM comics').all()
    const match = findExistingComicMatch(allComics, comic.title)
    if (match) {
      finalComicId = match.row.id
      wasFavoritedBefore = !!match.row.favorited
      matchedBy = match.matchType
    }
  }

  if (!finalComicId) {
    finalComicId = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    matchedBy = 'new'
  }

  const chapters = Array.isArray(comic.chapters) ? comic.chapters : []
  const coverValue = comic.coverPath || null
  const localCover = coverValue

  let comicInserted = false
  if (matchedBy === 'new') {
    try {
      db.prepare('INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        finalComicId, sourceUrl || null, comic.title, null, localCover, '', '连载中', '', '', '', null, chapters.length, 0, 1, comic.localPath || null, now, now)
      comicInserted = true
      wasFavoritedBefore = false
    } catch (err) {
      console.error(`[DB] registerExistingDownload INSERT《${comic.title}》失败:`, err.message)
      matchedBy = 'title-exact-fallback'
      db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(cover, ?), local_cover = COALESCE(local_cover, ?), favorited = 1, local_path = COALESCE(local_path, ?), updatedAt = ? WHERE title = ?').run(
        chapters.length, null, localCover, comic.localPath || null, now, comic.title)
    }
  } else {
    const effectiveSourceUrl = sourceUrl || (() => {
      const r = db.prepare('SELECT sourceUrl FROM comics WHERE id = ?').get(finalComicId)
      return r ? r.sourceUrl : null
    })()
    db.prepare('UPDATE comics SET chapter_count = ?, local_cover = COALESCE(NULLIF(local_cover, \'\'), ?), sourceUrl = COALESCE(NULLIF(sourceUrl, \'\'), ?), favorited = 1, local_path = COALESCE(local_path, ?), updatedAt = ? WHERE id = ?').run(
      chapters.length, localCover, effectiveSourceUrl || null, comic.localPath || null, now, finalComicId)
  }

  const existingChapters = db.prepare('SELECT sort_order FROM chapters WHERE comic_id = ?').all(finalComicId)
  const existingChapterOrders = new Set(existingChapters.map(v => v.sort_order))

  let registeredCount = 0
  let skippedCount = 0
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    if (!existingChapterOrders.has(i)) {
      insertChapterRow(db, finalComicId, { name: ch.name || '', url: '', imageCount: ch.imageCount || 0, index: i }, i, { includeImageCount: true })
    }

    const key = `${comic.title}-${i}`
    if (existingKeys.has(key)) {
      skippedCount++
    } else {
      insertDownloadRecord(db, finalComicId, comic.title, { name: ch.name || '', index: i, imageCount: ch.imageCount || 0, path: ch.path || '' }, i, now)
      registeredCount++
    }
  }

  const verifyRow = db.prepare('SELECT favorited, updatedAt FROM comics WHERE id = ?').get(finalComicId)
  let verifiedFavorited = false
  if (verifyRow) {
    verifiedFavorited = !!verifyRow.favorited
  }

  const isNewlyFavorited = verifiedFavorited && !wasFavoritedBefore
  console.log(`[DB] 注册《${comic.title}》: matchedBy=${matchedBy}, registered=${registeredCount}章, skipped=${skippedCount}章, favorited=${verifiedFavorited} (was=${wasFavoritedBefore}, newly=${isNewlyFavorited}), id=${finalComicId.substring(0,30)}`)

  return {
    success: true, title: comic.title, chapterCount: chapters.length,
    registeredCount, skippedCount, matchedBy, comicId: finalComicId,
    wasFavoritedBefore, isNewlyFavorited, newlyInserted: comicInserted
  }
}

async function matchComicOnline(comic, sources) {
  if (!comic || !comic.title || !sources) return null
  const normTitle = core.normalizeTitle(comic.title)
  if (!normTitle || normTitle.length < 2) return null

  const searchKeyword = core.normalizeTitle(comic.title).substring(0, 30)
  let searchResults = []
  try {
    searchResults = await sources.multiSearch(searchKeyword, 1)
  } catch (e) {
    console.warn(`[matchOnline] 搜索《${comic.title}》失败:`, e.message)
    return null
  }

  if (!searchResults || searchResults.length === 0) {
    try {
      searchResults = await sources.multiSearch(comic.title, 1)
    } catch (e2) {
      return null
    }
    if (!searchResults || searchResults.length === 0) return null
  }

  const first = searchResults[0]
  if (core.normalizeTitle(first.title) === normTitle) {
    console.log(`[matchOnline] 《${comic.title}》精确匹配到: ${first.title}`)
    return { sourceUrl: first.sourceUrl, matchScore: 100, matchedTitle: first.title }
  }

  let bestMatch = null
  let bestScore = 0
  for (const item of searchResults.slice(0, 10)) {
    const normItem = core.normalizeTitle(item.title)
    if (!normItem) continue
    if (normItem === normTitle) {
      return { sourceUrl: item.sourceUrl, matchScore: 100, matchedTitle: item.title }
    }
    if (normItem.includes(normTitle) || normTitle.includes(normItem)) {
      const lenDiff = Math.abs(normItem.length - normTitle.length)
      if (lenDiff <= 10) {
        const score = Math.max(80 - lenDiff * 3, 50)
        if (score > bestScore) {
          bestScore = score
          bestMatch = { sourceUrl: item.sourceUrl, matchScore: score, matchedTitle: item.title }
        }
      }
    }
  }

  if (bestMatch) {
    console.log(`[matchOnline] 《${comic.title}》模糊匹配到: ${bestMatch.matchedTitle} (score=${bestMatch.matchScore})`)
    return bestMatch
  }

  return null
}

async function autoScanLocalComics(paths, sources, onProgress) {
  if (!paths || paths.length === 0) return { total: 0, matched: 0, imported: 0, skipped: 0 }
  const db = ensureDb()

  let totalScanned = 0
  let totalMatched = 0
  let totalImported = 0
  let totalSkipped = 0

  const dbComics = db.prepare('SELECT title, sourceUrl FROM comics').all()
  const dbComicByTitle = new Map()
  for (const c of dbComics) {
    const normTitle = core.normalizeName(c.title)
    if (c.sourceUrl) {
      dbComicByTitle.set(c.title, c.sourceUrl)
      if (normTitle) dbComicByTitle.set(normTitle, c.sourceUrl)
    }
  }
  console.log(`[autoScan] 数据库中有 ${dbComics.length} 本漫画，${dbComics.filter(c => c.sourceUrl).length} 个有 sourceUrl`)

  for (const scanPath of paths) {
    if (!fs.existsSync(scanPath)) {
      console.warn(`[autoScan] 路径不存在: ${scanPath}`)
      continue
    }
    if (onProgress) onProgress({ text: `扫描: ${scanPath}`, pct: 0 })

    const comics = await scanLocalComics(scanPath)
    totalScanned += comics.length

    if (onProgress) onProgress({ text: `找到 ${comics.length} 本漫画`, pct: 10, total: comics.length })

    for (let i = 0; i < comics.length; i++) {
      const comic = comics[i]
      let sourceUrl = null
      let matchMethod = 'none'

      if (dbComicByTitle.has(comic.title)) {
        sourceUrl = dbComicByTitle.get(comic.title)
        matchMethod = 'db-sourceUrl'
      } else {
        const normTitle = core.normalizeName(comic.title)
        if (normTitle && dbComicByTitle.has(normTitle)) {
          sourceUrl = dbComicByTitle.get(normTitle)
          matchMethod = 'db-sourceUrl-fuzzy'
        }
      }

      if (!sourceUrl) {
        const match = await matchComicOnline(comic, sources)
        if (match) {
          sourceUrl = match.sourceUrl
          matchMethod = 'online-search'
        }
      }

      if (sourceUrl) {
        totalMatched++
        comic.localPath = path.join(scanPath, comic.title)
        const result = await registerExistingDownload(comic, sourceUrl)
        if (result.newlyInserted || result.registeredCount > 0) {
          totalImported++
        } else {
          totalSkipped++
        }
      } else {
        comic.localPath = path.join(scanPath, comic.title)
        const result = await registerExistingDownload(comic, null)
        if (result && (result.newlyInserted || result.registeredCount > 0)) {
          totalImported++
        } else {
          totalSkipped++
        }
      }

      if (onProgress) {
        onProgress({
          text: `处理: ${comic.title} (${matchMethod})`,
          pct: 10 + Math.round((i + 1) / comics.length * 90),
          current: i + 1, total: comics.length,
          matched: totalMatched, imported: totalImported, skipped: totalSkipped
        })
      }
    }
  }

  return { total: totalScanned, matched: totalMatched, imported: totalImported, skipped: totalSkipped }
}

async function importLocalComics(dirPath, onProgress) {
  if (!fs.existsSync(dirPath)) {
    throw new Error('目录不存在: ' + dirPath)
  }

  if (onProgress) {
    onProgress({ text: '正在扫描目录...', pct: 0, imported: 0, total: 0 })
  }

  const comics = await scanLocalComics(dirPath)

  if (onProgress) {
    onProgress({ text: `扫描完成，找到 ${comics.length} 本漫画`, pct: 10, imported: 0, total: comics.length })
  }

  if (comics.length === 0) {
    return { imported: 0, skipped: 0, failed: 0 }
  }

  let imported = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < comics.length; i++) {
    const comic = comics[i]

    try {
      const matched = await matchComicByTitle(comic.title)
      if (matched) {
        const localPath = path.join(dirPath, comic.title)
        core.getDB().prepare('UPDATE comics SET local_path = ? WHERE id = ?').run(localPath, matched.id)
        skipped++
      } else {
        comic.localPath = path.join(dirPath, comic.title)
        await registerExistingDownload(comic, null)
        imported++
      }
    } catch (e) {
      failed++
      console.error(`[Import] 导入失败: ${comic.title}`, e)
    }

    if (onProgress) {
      const pct = Math.round(10 + (i + 1) / comics.length * 90)
      onProgress({ text: `正在导入: ${comic.title}`, pct, imported, skipped, failed, total: comics.length })
    }
  }

  if (onProgress) {
    onProgress({ text: `导入完成！成功 ${imported} 本，跳过 ${skipped} 本，失败 ${failed} 本`, pct: 100, imported, skipped, failed, total: comics.length })
  }

  return { imported, skipped, failed }
}

async function matchComicByTitle(title) {
  const db = ensureDb()

  const row = db.prepare('SELECT id, title, sourceUrl FROM comics WHERE title = ?').get(title)
  if (row) return { id: row.id, title: row.title, sourceUrl: row.sourceUrl }

  const all = db.prepare('SELECT id, title, sourceUrl FROM comics').all()
  const match = findExistingComicMatch(all, title)
  return match ? { id: match.row.id, title: match.row.title, sourceUrl: match.row.sourceUrl } : null
}

module.exports = {
  checkExistingByTitle, scanLocalComics, importLocalComic,
  registerExistingDownload, matchComicOnline,
  autoScanLocalComics, importLocalComics
}