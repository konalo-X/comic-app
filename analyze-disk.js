'use strict'
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')

const EXTERNAL_ROOT = '/Volumes/可移动磁盘/ComicDownloads'
const DB_PATH = path.join(__dirname, 'comics.sqlite')

let SQL = null
let db = null

async function initDB() {
  SQL = await initSqlJs()
  const buf = fs.readFileSync(DB_PATH)
  db = new SQL.Database(buf)
}

function sanitize(n) {
  return n
    .replace(/[<>"/\\|*\x00-\x1F]/g, '_')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .trim()
}

function normalizeName(n) {
  return n.toLowerCase().replace(/\s+/g, '').replace(/_/g, '').replace(/[·•・・・.。,，、？?！!：:（）《》【】]/g, '')
}

function scanDisk() {
  if (!fs.existsSync(EXTERNAL_ROOT)) {
    console.error(`目录不存在: ${EXTERNAL_ROOT}`)
    return []
  }
  const entries = fs.readdirSync(EXTERNAL_ROOT, { withFileTypes: true })
  const comics = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const comicDir = path.join(EXTERNAL_ROOT, entry.name)
    try {
      const chEntries = fs.readdirSync(comicDir, { withFileTypes: true })
      const chapters = chEntries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => {
          const na = parseInt(a.match(/^(\d+)/)?.[1] || '0', 10)
          const nb = parseInt(b.match(/^(\d+)/)?.[1] || '0', 10)
          return na - nb
        })
      comics.push({
        dirName: entry.name,
        chapters: chapters.slice(0, 15)
      })
    } catch (_) {}
  }
  return comics
}

async function getAllDBComics() {
  const rows = db.exec('SELECT id, title FROM comics')
  if (rows.length === 0) return []
  return rows[0].values.map(r => ({ id: r[0], title: r[1] }))
}

async function getDBChapters(comicId) {
  const rows = db.exec('SELECT name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order', [comicId])
  if (rows.length === 0) return []
  return rows[0].values.map(r => ({ name: r[0], sortOrder: r[1] }))
}

async function main() {
  console.log('='.repeat(70))
  console.log('磁盘文件名 vs 数据库真实名称 对比分析')
  console.log('='.repeat(70))
  console.log(`扫描路径: ${EXTERNAL_ROOT}`)
  console.log(`数据库: ${DB_PATH}`)
  console.log()

  if (!fs.existsSync(DB_PATH)) {
    console.error('数据库文件不存在!')
    return
  }

  await initDB()

  const diskComics = scanDisk()
  const dbComics = await getAllDBComics()

  console.log(`磁盘漫画总数: ${diskComics.length}`)
  console.log(`数据库漫画总数: ${dbComics.length}`)
  console.log()

  // 建立数据库漫画的 normalize 索引
  const dbIndex = new Map()
  for (const c of dbComics) {
    dbIndex.set(normalizeName(c.title), c)
  }

  const analysis = {
    totalDisk: diskComics.length,
    totalDB: dbComics.length,
    matched: 0,
    unmatched: [],
    comicDirDiff: [],
    chapterNameDiff: [],
    samples: []
  }

  // 取前 30 部进行详细分析
  const samples = diskComics.slice(0, 30)

  for (let i = 0; i < samples.length; i++) {
    const diskComic = samples[i]
    console.log(`[${i + 1}/${samples.length}] ${diskComic.dirName}`)

    // 用 normalize 名匹配数据库
    const normalized = normalizeName(diskComic.dirName)
    const dbComic = dbIndex.get(normalized)

    if (!dbComic) {
      console.log('  ❌ 数据库中未找到匹配')
      analysis.unmatched.push(diskComic.dirName)
      continue
    }

    analysis.matched++
    console.log(`  ✅ 数据库匹配: "${dbComic.title}"`)

    const dbChapters = await getDBChapters(dbComic.id)
    console.log(`  数据库章节数: ${dbChapters.length}, 磁盘章节数: ${diskComic.chapters.length}`)

    const sample = {
      diskDir: diskComic.dirName,
      dbTitle: dbComic.title,
      currentSanitize: sanitize(dbComic.title),
      dirMatchesCurrent: diskComic.dirName === sanitize(dbComic.title),
      dirMatchesOriginal: diskComic.dirName === dbComic.title,
      chapters: []
    }

    if (!sample.dirMatchesCurrent) {
      analysis.comicDirDiff.push({
        disk: diskComic.dirName,
        dbTitle: dbComic.title,
        currentSanitize: sample.currentSanitize
      })
    }

    // 章节对比
    for (let j = 0; j < Math.min(diskComic.chapters.length, dbChapters.length); j++) {
      const diskChapter = diskComic.chapters[j]
      const dbChapter = dbChapters[j]
      const diskMatch = diskChapter.match(/^(\d+)-(.*)$/)
      const diskChapterName = diskMatch ? diskMatch[2] : diskChapter
      const currentSanitized = sanitize(dbChapter.name)

      const matchesCurrent = diskChapterName === currentSanitized
      const matchesReal = diskChapterName === dbChapter.name

      if (!matchesCurrent || !matchesReal) {
        analysis.chapterNameDiff.push({
          comic: dbComic.title,
          index: j + 1,
          real: dbChapter.name,
          disk: diskChapterName,
          currentSanitize: currentSanitized,
          matchesCurrent,
          matchesReal
        })
      }

      sample.chapters.push({
        index: j + 1,
        real: dbChapter.name,
        disk: diskChapterName,
        currentSanitize: currentSanitized,
        matchesCurrent
      })
    }

    analysis.samples.push(sample)
    console.log()
  }

  console.log('='.repeat(70))
  console.log('分析报告')
  console.log('='.repeat(70))

  console.log(`\n📊 总览`)
  console.log(`  磁盘漫画总数: ${analysis.totalDisk}`)
  console.log(`  数据库漫画总数: ${analysis.totalDB}`)
  console.log(`  成功匹配: ${analysis.matched}`)
  console.log(`  未匹配: ${analysis.unmatched.length}`)
  console.log(`  漫画目录名与当前sanitize一致: ${analysis.matched - analysis.comicDirDiff.length}`)
  console.log(`  漫画目录名不一致: ${analysis.comicDirDiff.length}`)
  console.log(`  章节名存在差异的数量: ${analysis.chapterNameDiff.length}`)

  console.log(`\n📖 漫画目录名差异 (全部):`)
  if (analysis.comicDirDiff.length === 0) {
    console.log(`  (无差异)`)
  } else {
    analysis.comicDirDiff.forEach((d, i) => {
      console.log(`  ${i + 1}. 数据库原名: "${d.dbTitle}"`)
      console.log(`     磁盘命名:   "${d.disk}"`)
      console.log(`     当前sanitize: "${d.currentSanitize}"`)
      console.log(`     磁盘 = 当前sanitize? ${d.disk === d.currentSanitize ? '✅ 一致' : '❌ 不一致'}`)
      console.log()
    })
  }

  console.log(`\n📚 章节名差异 (前30条):`)
  if (analysis.chapterNameDiff.length === 0) {
    console.log(`  (无差异)`)
  } else {
    analysis.chapterNameDiff.slice(0, 30).forEach((c, i) => {
      console.log(`  ${i + 1}. [${c.comic}] 第${c.index}章`)
      console.log(`     数据库原名: "${c.real}"`)
      console.log(`     磁盘命名:   "${c.disk}"`)
      console.log(`     当前sanitize: "${c.currentSanitize}"`)
      console.log(`     磁盘与当前一致: ${c.matchesCurrent ? '✅' : '❌'}`)
      console.log(`     磁盘与原名一致: ${c.matchesReal ? '✅' : '❌'}`)
      console.log()
    })
  }

  // 逐章完整对比
  console.log(`\n🔬 逐章完整对比 (每个漫画前5章):`)
  analysis.samples.forEach((s, idx) => {
    console.log(`\n  【${idx + 1}】${s.diskDir}`)
    console.log(`     数据库: "${s.dbTitle}"`)
    console.log(`     当前sanitize: "${s.currentSanitize}"`)
    console.log(`     漫画目录名匹配当前sanitize: ${s.dirMatchesCurrent ? '✅' : '❌'}`)
    console.log(`     漫画目录名匹配原名: ${s.dirMatchesOriginal ? '✅' : '❌'}`)
    s.chapters.slice(0, 5).forEach(ch => {
      const marker = ch.matchesCurrent ? '✅' : '❌'
      console.log(`       ${marker} 第${ch.index}章: 数据库="${ch.real}" → 磁盘="${ch.disk}"`)
    })
  })

  // 逆向分析老版本处理规则
  console.log(`\n\n🔍 逆向分析 - 老版本可能做了哪些特殊处理:`)
  const charReplacements = new Map()
  const specialCharsFound = new Set()
  let keepOriginalCount = 0
  let matchCurrentSanitizeCount = 0

  analysis.samples.forEach(s => {
    if (s.dirMatchesOriginal) keepOriginalCount++
    if (s.dirMatchesCurrent) matchCurrentSanitizeCount++

    // 分析字符差异
    if (s.dbTitle && s.diskDir) {
      const minLen = Math.min(s.dbTitle.length, s.diskDir.length)
      for (let k = 0; k < minLen; k++) {
        if (s.dbTitle[k] !== s.diskDir[k]) {
          const key = `"${s.dbTitle[k]}" → "${s.diskDir[k]}"`
          charReplacements.set(key, (charReplacements.get(key) || 0) + 1)
          if (/[：:！!【】（）《》·•・・・.。,，、？?\/\\|]/.test(s.dbTitle[k])) {
            specialCharsFound.add(s.dbTitle[k])
          }
        }
      }
    }
  })

  analysis.chapterNameDiff.forEach(c => {
    if (c.real && c.disk) {
      const minLen = Math.min(c.real.length, c.disk.length)
      for (let k = 0; k < minLen; k++) {
        if (c.real[k] !== c.disk[k]) {
          if (/[：:！!【】（）《》·•・・・.。,，、？?\/\\|]/.test(c.real[k])) {
            specialCharsFound.add(c.real[k])
          }
        }
      }
    }
  })

  console.log(`  发现的特殊字符: ${Array.from(specialCharsFound).join(' ')}`)
  console.log(`  字符替换统计 (前20):`)
  const sorted = Array.from(charReplacements.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
  sorted.forEach(([k, v]) => console.log(`    ${k} × ${v}`))

  console.log(`\n  📌 关键发现:`)
  console.log(`     漫画目录名中直接用数据库原名（含特殊字符）的比例: ${keepOriginalCount}/${analysis.matched}`)
  console.log(`     漫画目录名与当前sanitize一致的比例: ${matchCurrentSanitizeCount}/${analysis.matched}`)

  // 保存完整结果到文件
  const outputFile = path.join(__dirname, 'disk-analysis-result.json')
  fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2), 'utf-8')
  console.log(`\n\n💾 完整分析结果已保存: ${outputFile}`)
}

main().catch(console.error)