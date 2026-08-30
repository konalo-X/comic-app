'use strict'

const path = require('path')
const fs = require('fs')
const safeFs = require('../modules/safeFs')
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
  try { await safeFs.access(dirPath) } catch (_) { return [] }

  const IMG_EXT = /\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i
  const chapterDirPattern = /(^\d+-)|(^第\d+)|(^(ch(apter)?[_\-]?)?\d+)/i
  const MAX_COMICS = 50000
  const MAX_CHAPTERS_PER_COMIC = 2000

  const entries = await safeFs.readdir(dirPath, { withFileTypes: true })
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
      subs = await safeFs.readdir(comicDir, { withFileTypes: true })
    } catch { continue }

    let chapterDirs = subs.filter(d => d.isDirectory() && chapterDirPattern.test(d.name))
    if (chapterDirs.length === 0) {
      const candidates = []
      for (const d of subs) {
        if (!d.isDirectory()) continue
        const chDir = path.join(comicDir, d.name)
        try {
          const files = await safeFs.readdir(chDir)
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
        imageFiles = (await safeFs.readdir(chDir)).filter(f => IMG_EXT.test(f))
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
    if (await safeFs.access(coverPath).then(()=>true).catch(()=>false)) {
      cover = coverPath
    }

    // Bug #42 修复: 目录名不等于漫画标题
    // 剥离 Finder 去重后缀( 2 / (2) / _1 / -2 / （2）)后才是真实标题,
    // 用于后续 DB 匹配 / 在线搜索; 目录名本身通过 scanPath+e.name 组装 localPath, 不受影响。
    const cleanTitle = e.name
      .replace(/[\s_\-（(]\s*\d+\s*[)）]?\s*$/g, '')
      .replace(/[\s_\-]\s*\d+\s*$/g, '')
      .trim() || e.name

    comics.push({
      title: cleanTitle,
      dirName: e.name,
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
  try { await safeFs.access(titleDir) } catch (_) { await safeFs.mkdir(titleDir, { recursive: true }) }

  if (comic.coverPath) {
    const srcPath = comic.coverPath.replace('file://', '')
    if (await safeFs.access(srcPath).then(()=>true).catch(()=>false)) {
      fs.copyFileSync(srcPath, path.join(titleDir, 'cover.webp'))
    }
  }

  let dbChapters = []
  for (let i = 0; i < comic.chapters.length; i++) {
    const ch = comic.chapters[i]
    const folderName = `${i + 1}-${core.sanitizeFilename(ch.name)}`
    const destDir = path.join(titleDir, folderName)
    try { await safeFs.access(destDir) } catch (_) { await safeFs.mkdir(destDir, { recursive: true }) }

    const srcFiles = (await safeFs.readdir(ch.path)).filter(f => /\.(webp|jpg|png)$/i.test(f)).sort()
    for (const f of srcFiles) {
      fs.copyFileSync(path.join(ch.path, f), path.join(destDir, f))
    }

    dbChapters.push({ name: ch.name, url: '', index: i, imageCount: ch.imageCount, path: path.join(titleDir, folderName) })
  }

  const now = Date.now()
  const id = sourceUrl || crypto.randomUUID()
  // 实际写入 download_records 的 comic_id: 必须用 comics 表里真实的内部 id,
  // 不能用 sourceUrl 当 id(历史 bug: 产生 URL 型重复记录)。
  let recordComicId = id
  if (sourceUrl) {
    const existing = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (existing) recordComicId = existing.id
  }
  if (sourceUrl) {
    const existing = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (existing) {
      // Bug #26 修复: UPDATE comics + DELETE chapters + INSERT chapters 放进同一个事务
      const updateStmt = db.prepare('UPDATE comics SET chapter_count=?, updatedAt=?, favorited=1 WHERE id=?')
      const deleteStmt = db.prepare('DELETE FROM chapters WHERE comic_id=?')
      runInTransaction(db, () => {
        updateStmt.run(comic.chapters.length, now, existing.id)
        deleteStmt.run(existing.id)
        for (let i = 0; i < dbChapters.length; i++) {
          insertChapterRow(db, existing.id, dbChapters[i], i)
        }
      })
    } else {
      const coverOnDisk = path.join(titleDir, 'cover.webp')
      const localCoverPath = (await safeFs.access(coverOnDisk).then(()=>true).catch(()=>false)) ? coverOnDisk : (comic.coverPath || '')
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
    const localCoverPath2 = (await safeFs.access(coverOnDisk2).then(() => true).catch(() => false)) ? coverOnDisk2 : (comic.coverPath || '')
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
    insertDownloadRecord(db, recordComicId, comic.title, ch, ch.index, now)
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
  // Bug #42 修复: 同名多本漫画的去重后缀 ( 2/_1/(2)) 导致 includes 模糊匹配串目录
  let needsNewRowDueToDirConflict = false

  if (sourceUrl) {
    const r1 = db.prepare('SELECT id, favorited FROM comics WHERE sourceUrl = ?').get(sourceUrl)
    if (r1) {
      finalComicId = r1.id
      wasFavoritedBefore = !!r1.favorited
      matchedBy = 'sourceUrl'
    }
  }

  if (!finalComicId) {
    const allComics = db.prepare('SELECT id, title, favorited, local_path FROM comics').all()
    const match = findExistingComicMatch(allComics, comic.title)
    if (match) {
      // Bug #42 修复: 标题模糊匹配后, 若该行已绑定了一个与当前目录不同的 local_path,
      // 说明是另一本同名漫画 (例: "找回自我" 匹配到 "找回自我 2" 的现有行),
      // 不应合并写入, 否则会把这本的 local_path/local_cover 串写到另一本上。
      const incomingDir = (comic.localPath || '').trim()
      const existingDir = (match.row.local_path || '').trim()
      if (incomingDir && existingDir && incomingDir !== existingDir) {
        console.log(`[registerExistingDownload] 标题匹配到另一本的现有行, 但目录不匹配 -> 新建行避免串写: 输入="${comic.title}"(${incomingDir}) vs 现有="${match.row.title}"(${existingDir})`)
        needsNewRowDueToDirConflict = true
      } else {
        finalComicId = match.row.id
        wasFavoritedBefore = !!match.row.favorited
        matchedBy = match.matchType
      }
    }
  }

  if (!finalComicId || needsNewRowDueToDirConflict) {
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
      // Bug #42 修复: INSERT 失败(多半是 UNIQUE 冲突 sourceUrl 或 id), 改为
      //  按 local_path 精确匹配的单行 UPDATE, 或在无匹配时再新建。之前 WHERE title=?
      //  会把所有同名漫画 (找回自我 x 2~3 本) 的 local_path/local_cover 一起改掉, 造成毁灭性串写。
      console.error(`[DB] registerExistingDownload INSERT《${comic.title}》失败:`, err.message)
      matchedBy = 'title-exact-fallback'
      const inDir = comic.localPath || ''
      if (inDir) {
        const existing = db.prepare('SELECT id FROM comics WHERE local_path = ? LIMIT 1').get(inDir)
        if (existing) {
          db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(cover, ?), local_cover = COALESCE(local_cover, ?), favorited = 1, updatedAt = ? WHERE id = ?').run(
            chapters.length, null, localCover, now, existing.id)
          finalComicId = existing.id
        } else {
          // 再试一次: 同名且没有 local_path 的行, 只会挑一条来 UPDATE
          const row = db.prepare('SELECT id FROM comics WHERE title = ? AND (local_path IS NULL OR local_path = \'\') LIMIT 1').get(comic.title)
          if (row) {
            db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(cover, ?), local_cover = COALESCE(local_cover, ?), favorited = 1, local_path = ?, updatedAt = ? WHERE id = ?').run(
              chapters.length, null, localCover, inDir, now, row.id)
            finalComicId = row.id
          } else {
            // 最后兜底: 再建一条独立行
            const altId = 'local-fb-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
            db.prepare('INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
              altId, null, comic.title, null, localCover, '', '连载中', '', '', '', null, chapters.length, 0, 1, inDir, now, now)
            finalComicId = altId
            comicInserted = true
          }
        }
      } else {
        // 无 local_path 时不做破坏性更新, 只挑 title 匹配的第一条无 local_path 行更新
        const row = db.prepare('SELECT id FROM comics WHERE title = ? AND (local_path IS NULL OR local_path = \'\') LIMIT 1').get(comic.title)
        if (row) {
          db.prepare('UPDATE comics SET chapter_count = ?, cover = COALESCE(cover, ?), local_cover = COALESCE(local_cover, ?), favorited = 1, updatedAt = ? WHERE id = ?').run(
            chapters.length, null, localCover, now, row.id)
          finalComicId = row.id
        }
      }
    }
  } else {
    const effectiveSourceUrl = sourceUrl || (() => {
      const r = db.prepare('SELECT sourceUrl, local_path AS lp FROM comics WHERE id = ?').get(finalComicId)
      return r ? r.sourceUrl : null
    })()
    // Bug #42 修复: 仅当匹配方式是 sourceUrl 精确匹配或该 row 还没有 local_path 时,
    // 才允许用当前扫描到的目录写入。若已有不同目录 (说明是另一本同名漫画合并了数据),
    // 不能串写, 同时新建行隔离。
    const existingRow = db.prepare('SELECT local_path AS lp, title AS t FROM comics WHERE id = ?').get(finalComicId)
    const rowDir = existingRow?.lp || ''
    const inDir = comic.localPath || ''
    const allowWriteLocal = (
      matchedBy === 'sourceUrl' ||
      !rowDir ||
      rowDir === inDir
    )
    if (!allowWriteLocal && inDir && rowDir && inDir !== rowDir) {
      console.log(`[registerExistingDownload] UPDATE 阶段检测到目录冲突, 改为新建独立行: 现有="${rowDir}" vs 本次="${inDir}"`)
      const altId = 'local-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      db.prepare('INSERT INTO comics (id, sourceUrl, title, cover, local_cover, author, status, desc_text, tags, category, updateTime, chapter_count, update_delta, favorited, local_path, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        altId, null, comic.title, null, localCover, '', '连载中', '', '', '', null, chapters.length, 0, 1, inDir, now, now)
      finalComicId = altId
      matchedBy = 'new-dir-conflict-insert'
      comicInserted = true
    } else {
      const fields = ['chapter_count = ?', 'favorited = 1', 'updatedAt = ?']
      const vals = [chapters.length, now]
      if (localCover) {
        fields.push("local_cover = COALESCE(NULLIF(local_cover, ''), ?)")
        vals.push(localCover)
      }
      if (effectiveSourceUrl) {
        fields.push("sourceUrl = COALESCE(NULLIF(sourceUrl, ''), ?)")
        vals.push(effectiveSourceUrl)
      }
      if (comic.localPath) {
        fields.push('local_path = COALESCE(local_path, ?)')
        vals.push(comic.localPath)
      }
      vals.push(finalComicId)
      db.prepare(`UPDATE comics SET ${fields.join(', ')} WHERE id = ?`).run(...vals)
    }
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
    try { await safeFs.access(scanPath) } catch (_) {
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
        // Bug #42 修复: 本地路径必须用真实目录名 dirName, 不能用 clean 过的 title
        // (否则 "找回自我_1" 目录 title 变 "找回自我" -> 拼成了不存在的 ".../找回自我" 路径, 串到另一本的目录上!)
        comic.localPath = path.join(scanPath, comic.dirName || comic.title)
        const result = await registerExistingDownload(comic, sourceUrl)
        if (result.newlyInserted || result.registeredCount > 0) {
          totalImported++
        } else {
          totalSkipped++
        }
      } else {
        comic.localPath = path.join(scanPath, comic.dirName || comic.title)
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
  try { await safeFs.access(dirPath) } catch (_) {
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
      // Bug #42: 用真实目录名 dirName, 不要用 clean 过的 title
      const actualLocalPath = path.join(dirPath, comic.dirName || comic.title)
      if (matched) {
        // 目录冲突检测
        const row = core.getDB().prepare('SELECT local_path AS lp FROM comics WHERE id = ?').get(matched.id)
        if (!row?.lp || row.lp === actualLocalPath) {
          core.getDB().prepare('UPDATE comics SET local_path = ? WHERE id = ?').run(actualLocalPath, matched.id)
          skipped++
        } else {
          // 冲突: 新建独立行, 避免串写
          comic.localPath = actualLocalPath
          await registerExistingDownload(comic, null)
          imported++
        }
      } else {
        comic.localPath = actualLocalPath
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