'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, protocol } = require('electron')

async function startup(deps) {
  const {
    imageProxy, cache, db, downloadPaths, jobHandlers, sources, createWindow, ipcApi
  } = deps

  imageProxy.startImageProxyServer()

  protocol.handle('comic-cache', async (request) => {
    try {
      const filePath = decodeURIComponent(request.url.replace('comic-cache://', ''))
      const fullPath = path.join(cache.CACHE_ROOT || app.getPath('userData'), 'cache', filePath)
      const data = await fs.promises.readFile(fullPath)
      return new Response(data)
    } catch {
      return new Response('', { status: 404 })
    }
  })

  db.initDB()
  console.log('[DB] SQLite 数据库就绪')
  await cache.warmup()
  console.log('[Cache] 图片缓存就绪')

  loadDownloadPath(downloadPaths)

  jobHandlers.initJobQueue()
  createWindow()

  scheduleCleanup(db)
  scheduleAutoScan(db, sources)

  ipcApi.ensureGlobalCrawlForwarder()
  ipcApi.ensureGlobalBackgroundTaskForwarder()
  jobHandlers.startAutoTasks()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

function loadDownloadPath(downloadPaths) {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      if (stored.downloadDir && fs.existsSync(stored.downloadDir)) {
        downloadPaths.setExternalRoot(stored.downloadDir)
        console.log(`[Download] 外部下载目录已加载: ${stored.downloadDir}`)
      }
    }
  } catch (e) {
    console.warn('[Download] 加载外部下载目录失败:', e.message)
  }
}

function scheduleCleanup(db) {
  setTimeout(async () => {
    try {
      console.log('[Cleanup] 启动自动清理未命名漫画...')
      const raw = db.getRawDB()
      if (!raw) return
      const unnamedRows = raw.prepare(
        `SELECT id, sourceUrl, title, favorited FROM comics
         WHERE title = '未命名漫画'
         OR TRIM(title) = ''
         OR title IS NULL
         OR title LIKE 'http%'
         OR title LIKE '/%'`
      ).all()
      const results = { totalFound: unnamedRows.length, deleted: 0, skipped: 0, details: [] }
      for (const row of unnamedRows) {
        try {
          const hasRecords = raw.prepare('SELECT COUNT(*) as c FROM download_records WHERE comic_id = ?').get(row.id)
          const recordCount = hasRecords?.c || 0
          const hasChapters = raw.prepare('SELECT COUNT(*) as c FROM chapters WHERE comic_id = ?').get(row.id)
          const chapterCount = hasChapters?.c || 0
          if (row.sourceUrl && chapterCount > 0) {
            results.details.push({ id: row.id, title: row.title, action: 'skipped_has_chapters', reason: `有 ${chapterCount} 个章节，保留`, sourceUrl: row.sourceUrl })
            results.skipped++
            continue
          }
          raw.prepare('DELETE FROM chapters WHERE comic_id = ?').run(row.id)
          raw.prepare('DELETE FROM download_records WHERE comic_id = ?').run(row.id)
          raw.prepare('DELETE FROM comics WHERE id = ?').run(row.id)
          results.deleted++
          results.details.push({ id: row.id, title: row.title || '(空)', action: 'deleted', reason: recordCount > 0 ? `有 ${recordCount} 条下载记录但无标题，已清理` : '无内容，已删除' })
        } catch (e) {
          results.details.push({ id: row.id, title: row.title || '(空)', action: 'error', reason: e.message })
        }
      }
      console.log(`[Cleanup] 清理完成: 找到 ${results.totalFound} 条, 删除 ${results.deleted} 条, 跳过 ${results.skipped} 条`)
    } catch (e) {
      console.warn('[Cleanup] 自动清理失败:', e.message)
    }
  }, 3000)
}

function scheduleAutoScan(db, sources) {
  setTimeout(async () => {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json')
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
        if (settings.autoScanOnStartup && settings.autoScanPaths && settings.autoScanPaths.length > 0) {
          console.log('[AutoScan] 启动自动扫描，路径:', settings.autoScanPaths)
          const result = await db.autoScanLocalComics(settings.autoScanPaths, sources)
          console.log(`[AutoScan] 完成: 扫描 ${result.total} 本，新增 ${result.imported} 本，联网匹配 ${result.matched} 本`)
        }
      }
    } catch (e) {
      console.warn('[AutoScan] 自动扫描失败:', e.message)
    }
  }, 5000)
}

module.exports = { startup }