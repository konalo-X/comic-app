'use strict'
const fs = require('fs')
const path = require('path')

// 扫描所有候选下载目录中的漫画
const roots = [
  '/Volumes/可移动磁盘/ComicDownloads',
  '/Users/konalo/Documents/comic-downloads',
  '/Users/konalo/Downloads'
]

console.log('扫描候选下载目录：')
console.log('='.repeat(60))

for (const root of roots) {
  console.log(`\n[${root}]`)
  if (!fs.existsSync(root)) {
    console.log('  ✗ 目录不存在')
    continue
  }
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
  if (entries.length === 0) {
    console.log('  (空目录)')
    continue
  }
  console.log(`  找到 ${entries.length} 个目录`)

  // 打印前 10 个示例目录的结构
  for (let i = 0; i < Math.min(entries.length, 15); i++) {
    const e = entries[i]
    const comicDir = path.join(root, e.name)
    try {
      const subEntries = fs.readdirSync(comicDir, { withFileTypes: true }).filter(se => se.isDirectory())
      const hasCover = fs.existsSync(path.join(comicDir, 'cover.webp'))
      console.log(`  ├── ${e.name}  (${subEntries.length} 个章节目录, cover=${hasCover ? '✓' : '✗'})`)
      if (subEntries.length > 0) {
        // 显示前 3 个章节的目录名示例
        for (let j = 0; j < Math.min(subEntries.length, 3); j++) {
          const ch = subEntries[j]
          const chDir = path.join(comicDir, ch.name)
          try {
            const imgCount = fs.readdirSync(chDir).filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f)).length
            console.log(`  │     ├── ${ch.name}  (${imgCount} 张图片)`)
          } catch {}
        }
        if (subEntries.length > 3) console.log(`  │     └── ... 等 ${subEntries.length} 个`)
      }
    } catch (err) {
      console.log(`  ├── ${e.name}  (无法读取: ${err.message})`)
    }
  }
}

console.log('\n' + '='.repeat(60))
console.log('扫描完成。\n')