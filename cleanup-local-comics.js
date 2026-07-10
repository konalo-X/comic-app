#!/usr/bin/env node
/**
 * 清理纯本地漫画脚本
 * 功能：
 * 1. 从数据库中找出 sourceUrl 为 NULL 的漫画（匹配不上在线源的）
 * 2. 删除这些漫画在本地磁盘上的文件夹
 * 3. 从数据库中删除这些漫画记录
 *
 * 用法：node cleanup-local-comics.js [--dry-run]
 *   --dry-run: 只预览，不真正删除
 */

const fs = require('fs')
const path = require('path')

// 数据库路径（注意：comics.db 是 JSON，comics.sqlite 才是真正的 SQLite 数据库）
const DB_PATH = path.join(require('os').homedir(), 'Library/Application Support/comic-app/comics.sqlite')
const LOCAL_ROOT = '/Volumes/可移动磁盘/ComicDownloads'

const dryRun = process.argv.includes('--dry-run')

async function main() {
  console.log(`[Cleanup] 模式: ${dryRun ? '预览' : '实际删除'}`)
  console.log(`[Cleanup] 数据库: ${DB_PATH}`)
  console.log(`[Cleanup] 本地目录: ${LOCAL_ROOT}`)

  // 加载 sql.js (sql.js 使用不同的导出方式)
  const initSqlJs = require('sql.js')
  const SQL = await initSqlJs()
  const dbBuffer = fs.readFileSync(DB_PATH)
  const db = new SQL.Database(dbBuffer)

  // 1. 找出所有 sourceUrl 为 NULL 的漫画
  const result = db.exec("SELECT id, title, local_path FROM comics WHERE sourceUrl IS NULL")

  if (!result || result.length === 0 || result[0].values.length === 0) {
    console.log('[Cleanup] 没有找到纯本地漫画，无需清理')
    db.close()
    return
  }

  const toDelete = result[0].values.map(row => ({
    id: row[0],
    title: row[1],
    localPath: row[2]
  }))

  console.log(`[Cleanup] 找到 ${toDelete.length} 本纯本地漫画:`)
  for (const comic of toDelete) {
    console.log(`  - ${comic.title}`)
    if (comic.localPath) {
      console.log(`    路径: ${comic.localPath}`)
    }
  }

  if (dryRun) {
    console.log('[Cleanup] 预览模式结束，未执行任何删除操作')
    console.log('[Cleanup] 如需真正删除，请去掉 --dry-run 参数重新运行')
    db.close()
    return
  }

  // 2. 删除本地文件夹
  let deletedFolders = 0
  let skippedFolders = 0

  for (const comic of toDelete) {
    // 尝试多个可能的路径
    const possiblePaths = []

    // 从 local_path 推断
    if (comic.localPath) {
      possiblePaths.push(comic.localPath)
      // 如果 local_path 不是完整路径，尝试拼接
      if (!comic.localPath.startsWith('/')) {
        possiblePaths.push(path.join(LOCAL_ROOT, comic.localPath))
      }
    }

    // 直接用标题作为文件夹名
    possiblePaths.push(path.join(LOCAL_ROOT, comic.title))

    // 去重
    const uniquePaths = [...new Set(possiblePaths)]

    let deleted = false
    for (const folderPath of uniquePaths) {
      if (fs.existsSync(folderPath)) {
        try {
          fs.rmSync(folderPath, { recursive: true, force: true })
          console.log(`[Cleanup] 已删除文件夹: ${folderPath}`)
          deleted = true
          deletedFolders++
          break
        } catch (e) {
          console.warn(`[Cleanup] 删除失败: ${folderPath} -> ${e.message}`)
        }
      }
    }

    if (!deleted) {
      console.log(`[Cleanup] 跳过（文件夹不存在）: ${comic.title}`)
      skippedFolders++
    }
  }

  // 3. 从数据库中删除记录
  let deletedDbRecords = 0
  for (const comic of toDelete) {
    try {
      db.run('DELETE FROM chapters WHERE comic_id = ?', [comic.id])
      db.run('DELETE FROM comics WHERE id = ?', [comic.id])
      deletedDbRecords++
    } catch (e) {
      console.warn(`[Cleanup] 删除数据库记录失败: ${comic.title} -> ${e.message}`)
    }
  }

  // 4. 保存数据库
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
  db.close()

  console.log('\n[Cleanup] 清理完成!')
  console.log(`  - 删除文件夹: ${deletedFolders} 个`)
  console.log(`  - 跳过（不存在）: ${skippedFolders} 个`)
  console.log(`  - 删除数据库记录: ${deletedDbRecords} 条`)
}

main().catch(err => {
  console.error('[Cleanup] 脚本执行失败:', err)
  process.exit(1)
})