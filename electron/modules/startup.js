'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, protocol } = require('electron')
const { initAutoUpdater } = require('./updater')
const logger = require('../logger')

async function startup(deps) {
  const {
    imageProxy, cache, db, downloadPaths, jobHandlers, sources, createWindow, ipcApi, closeSplashWindow
  } = deps

  imageProxy.startImageProxyServer()

  protocol.handle('comic-cache', async (request) => {
    try {
      // 安全解析路径,防止 ../ 穿越、绝对路径、double-encode
      const cacheRoot = cache.CACHE_ROOT || app.getPath('userData')
      const cacheDir = path.resolve(cacheRoot, 'cache')
      let raw = request.url
      const qi = raw.indexOf('?'); if (qi >= 0) raw = raw.substring(0, qi)
      const hi = raw.indexOf('#'); if (hi >= 0) raw = raw.substring(0, hi)
      raw = raw.replace('comic-cache://', '')
      raw = raw.replace(/\\/g, '/')
      // 绝对路径(以 / 开头)→ 非法
      if (raw.startsWith('/')) return new Response('', { status: 400 })
      // 去掉 Windows 盘符 C:/D:
      raw = raw.replace(/^[A-Za-z]\:(\/|\\)?/, '')
      // decode 最多两次,兼容 double-encode
      let filePath
      try {
        filePath = decodeURIComponent(raw)
        if (filePath.indexOf('%') >= 0) { try { filePath = decodeURIComponent(filePath) } catch {} }
      } catch { filePath = raw }
      // resolve 规范化,最终检查是否仍在 cacheDir 下
      const resolved = path.resolve(cacheDir, filePath)
      const prefix = cacheDir + path.sep
      if (resolved !== cacheDir && !resolved.startsWith(prefix)) {
        return new Response('', { status: 400 })
      }
      const data = await fs.promises.readFile(resolved)
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

  // Bug #2 修复: 设置 /local 代理端点允许读取的白名单目录
  // 只允许读取: 所有用户配置的下载根目录(及其所有子目录)、系统缓存目录
  try {
    const allowedDirs = new Set()
    // 所有下载根 (getDownloadRoots 包含默认 downloads 目录 + 用户自定义根)
    const roots = downloadPaths.getDownloadRoots ? downloadPaths.getDownloadRoots() : []
    for (const r of roots) if (r) allowedDirs.add(path.resolve(String(r)))
    // 缓存目录 (CACHE_ROOT 可能是 app.getPath('userData') + '/cache')
    const cacheDir = path.resolve(cache.CACHE_ROOT || path.join(app.getPath('userData'), 'cache'))
    allowedDirs.add(cacheDir)
    // userData 本身(有些缩略图在 settings/其他子目录)
    allowedDirs.add(path.resolve(app.getPath('userData')))
    imageProxy.setAllowedLocalDirs([...allowedDirs])
    console.log('[Proxy] /local 白名单目录已设置:', [...allowedDirs].join(', '))
  } catch (e) {
    console.warn('[Proxy] 设置白名单目录失败:', e.message)
  }

  jobHandlers.initJobQueue()
  createWindow()

  initAutoUpdater()

  // 关闭启动画面
  if (closeSplashWindow) {
    closeSplashWindow()
  }

  scheduleCleanup(db)
  scheduleJobFailureStatsCleanup(db)
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
      const deleteStmt = {
        ch: raw.prepare('DELETE FROM chapters WHERE comic_id = ?'),
        dr: raw.prepare('DELETE FROM download_records WHERE comic_id = ?'),
        // Bug #39 修复: comics 主键是 id 不是 comic_id (之前错误用 comic_id -> SqliteError: no such column: comic_id)
        co: raw.prepare('DELETE FROM comics WHERE id = ?'),
        rp: raw.prepare('DELETE FROM reading_progress WHERE comic_id = ?'),
      }
      // Bug #32 修复: 4 条 DELETE 包进事务, 避免中途崩溃产生孤儿记录
      const txDelete = raw.transaction((id) => {
        deleteStmt.ch.run(id)
        deleteStmt.dr.run(id)
        deleteStmt.rp.run(id)
        deleteStmt.co.run(id)
      })
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
          txDelete(row.id)
          results.deleted++
          results.details.push({ id: row.id, title: row.title || '(空)', action: 'deleted', reason: recordCount > 0 ? `有 ${recordCount} 条下载记录但无标题，已清理` : '无内容，已删除' })
        } catch (e) {
          results.details.push({ id: row.id, title: row.title || '(空)', action: 'error', reason: e.message })
        }
      }
      console.log(`[Cleanup] 清理完成: 找到 ${results.totalFound} 条, 删除 ${results.deleted} 条, 跳过 ${results.skipped} 条`)
    } catch (e) {
      console.warn('[Cleanup] 自动清理失败:', e.message, e.stack?.split('\n').slice(0, 3).join('\n'))
    }
  }, 3000)
}

function scheduleJobFailureStatsCleanup(db) {
  setTimeout(() => {
    try {
      const raw = db.getRawDB()
      if (!raw) return
      // Bug #34 修复: job_failure_stats 中 parse_error 等类型累计 42 次失败计数, 每次启动都会告警并占用日志/存储。
      // 启动时清理所有 failure_stats 中累计计数超过阈值但最近 7 天无更新的条目, 以及 job_queue 中超过 30 天的
      // completed/failed 任务, 减少 job 库存储膨胀和不必要的告警。
      const ONE_WEEK = 7 * 24 * 60 * 60 * 1000
      const ONE_MONTH = 30 * 24 * 60 * 60 * 1000
      const now = Date.now()
      const staleStats = raw.prepare(
        'SELECT reason, count FROM job_failure_stats WHERE last_update IS NULL OR last_update < ?'
      ).all(now - ONE_WEEK)
      if (staleStats && staleStats.length > 0) {
        const info = staleStats.map(s => `${s.reason}=${s.count}`).join(', ')
        raw.prepare('DELETE FROM job_failure_stats WHERE last_update IS NULL OR last_update < ?').run(now - ONE_WEEK)
        console.log(`[Cleanup] 已清理 ${staleStats.length} 条过期失败统计: ${info}`)
      }
      // 清理超过 30 天的 completed/failed/cancelled 任务(比 JobQueue 内置的更激进)
      const old = raw.prepare(
        `DELETE FROM job_queue
         WHERE status IN ('completed', 'failed', 'cancelled')
           AND (completed_at IS NULL OR completed_at < ?)`
      ).run(now - ONE_MONTH)
      if (old.changes > 0) {
        console.log(`[Cleanup] 已清理 ${old.changes} 条过期任务记录 (>30天)`)
      }
    } catch (e) {
      console.warn('[Cleanup] 失败统计清理失败:', e.message)
    }
  }, 2000)
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