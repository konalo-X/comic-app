#!/usr/bin/env node
'use strict'

const path = require('path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(__dirname, '..', 'comics.sqlite')
const db = new Database(DB_PATH)

const validCategories = ['日漫', '韩漫', '真人', '3D漫画', '同性']

function normalizeCategory(cat) {
  if (!cat) return null
  for (const vc of validCategories) {
    if (cat.includes(vc) || vc.includes(cat)) {
      return vc.includes('3D') ? '3D漫画' : vc
    }
  }
  return null
}

const rows = db.prepare(
  `SELECT id, title, tags, category FROM comics
   WHERE tags IS NOT NULL AND tags != ''
   AND category IS NOT NULL AND category != ''`
).all()

console.log(`找到 ${rows.length} 条有标签和类别的漫画`)

let updated = 0
let skipped = 0

const updateStmt = db.prepare('UPDATE comics SET tags=? WHERE id=?')

const updateAll = db.transaction(() => {
  for (const row of rows) {
    const tags = row.tags.split(',').map(t => t.trim()).filter(Boolean)
    const normCat = normalizeCategory(row.category)

    const tagSet = new Set(tags)
    const before = tags.length

    if (normCat) {
      tagSet.delete(normCat)
    }
    tagSet.delete(row.category)

    const cleaned = [...tagSet]
    const after = cleaned.length

    if (before !== after) {
      updateStmt.run(cleaned.join(','), row.id)
      updated++
      console.log(`  [修复] ${row.title}  |  类别: ${row.category}  |  标签: ${before}→${after}`)
    } else {
      skipped++
    }
  }
})

updateAll()

console.log(`\n完成: 修复 ${updated} 条, 跳过 ${skipped} 条`)
db.close()