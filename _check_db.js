'use strict'
const path = require('path')
const fs = require('fs')
const initSqlJs = require('sql.js')

const dbDir = '/Users/konalo/Library/Application Support/comic-app'
const dbPath = path.join(dbDir, 'comics.sqlite')

console.log('数据库路径:', dbPath)
console.log('数据库存在:', fs.existsSync(dbPath))
if (fs.existsSync(dbPath)) {
  console.log('文件大小:', (fs.statSync(dbPath).size / 1024).toFixed(2), 'KB')
}

;(async () => {
  const SQL = await initSqlJs()
  const buf = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null
  const db = new SQL.Database(buf)

  console.log('\n--- comics 表 ---')
  const c = db.exec('SELECT id, sourceUrl, title, cover, status, chapter_count, createdAt FROM comics ORDER BY createdAt DESC')
  if (c.length > 0) {
    console.log(`共 ${c[0].values.length} 部漫画`)
    for (const row of c[0].values) {
      console.log(`  [${row[0].substring(0, 20)}...] title="${row[2]}" sourceUrl="${row[1] || '(空)'}" chapters=${row[5]} cover=${row[3] ? '有' : '(空)'}`)
    }
  } else {
    console.log('没有数据')
  }

  console.log('\n--- download_records 表 ---')
  const d = db.exec('SELECT comic_id, comic_title, chapter_index, chapter_name, images_count, path FROM download_records ORDER BY comic_id, chapter_index')
  if (d.length > 0) {
    console.log(`共 ${d[0].values.length} 条记录`)
    const byComic = {}
    for (const row of d[0].values) {
      if (!byComic[row[1]]) byComic[row[1]] = 0
      byComic[row[1]]++
    }
    for (const title of Object.keys(byComic)) {
      console.log(`  "${title}": ${byComic[title]} 个章节`)
    }
  } else {
    console.log('没有数据')
  }

  console.log('\n--- 检查没有 chapters 的漫画 ---')
  const orphans = db.exec('SELECT c.id, c.title, c.sourceUrl, c.chapter_count FROM comics c WHERE c.chapter_count > 0 AND NOT EXISTS (SELECT 1 FROM chapters ch WHERE ch.comic_id = c.id)')
  if (orphans.length > 0 && orphans[0].values.length > 0) {
    console.log(`${orphans[0].values.length} 部漫画有 chapter_count 但没有 chapters 记录:`)
    for (const row of orphans[0].values) {
      console.log(`  id=${row[0].substring(0, 30)}... title="${row[1]}" sourceUrl="${row[2]}"`)
    }
  } else {
    console.log('没有这个问题')
  }
})()