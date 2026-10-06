'use strict'
// [自动导出EPUB 2026-10-06]
// 把"已完结 + 已全本下载完成"的漫画自动打包成 EPUB, 输出到 ~/Downloads 或设置目录。
// 复用 JobQueue (持久化 / 可重启续跑 / 单例防重复) + exporter.toEPUB (单本/分卷)。

const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const db = require('../../db')
const safeFs = require('../safeFs')
const exporter = require('../../exporter')
const { getJobQueue } = require('./index')

function sanitize(name) {
  return (name || 'comic')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function loadExportSettings() {
  try {
    const p = path.join(app.getPath('userData'), 'settings.json')
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'))
      // 返回顶层 settings(epubAutoExportDir / epubAutoExportEnabled 等均为顶层键)
      return s || {}
    }
  } catch (_) {}
  return {}
}

async function isComicFullyDownloaded(comic) {
  if (!comic.local_path || !(await safeFs.access(comic.local_path).then(() => true).catch(() => false))) return false
  const cid = comic._id || comic.id
  const total = await db.getChapterCount(cid).catch(() => 0)
  if (!total) return false
  const done = await db.getDownloadedChapterCount(cid).catch(() => 0)
  return done >= total
}

async function jobHandlerExportEpub(job, onProgress) {
  const { sourceUrl, comicTitle, comicDir } = job.payload
  console.log(`[AutoEpub] === HANDLER 进入 sourceUrl=${sourceUrl} title=${comicTitle}`)
  if (!sourceUrl) throw new Error('exportEpub 需要 sourceUrl')

  const st = loadExportSettings()
  if (st.epubAutoExportEnabled === false) {
    console.log('[AutoEpub] 自动导出未开启, 跳过')
    return { skipped: true }
  }

  const comic = await db.getComicByUrl(sourceUrl)
  if (!comic) throw new Error(`未找到漫画: ${sourceUrl}`)
  if (!/已完结/.test(comic.status || '')) {
    console.log(`[AutoEpub] ${comic.title} 非已完结(${comic.status}), 跳过`)
    return { skipped: true }
  }

  const root = comicDir || comic.local_path
  if (!(await safeFs.access(root).then(() => true).catch(() => false))) {
    throw new Error(`下载目录不存在: ${root}`)
  }

  const fully = await isComicFullyDownloaded(comic)
  if (!fully) {
    console.log(`[AutoEpub] ${comic.title} 尚未全本下载完成, 跳过`)
    return { skipped: true }
  }

  const entries = await safeFs.readdir(root, { withFileTypes: true })
  const chapters = entries
    .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
    .sort((a, b) => parseInt(a.name.match(/^\d+/)[0], 10) - parseInt(b.name.match(/^\d+/)[0], 10))
    .map((d, i) => ({ name: d.name.replace(/^\d+-/, ''), dir: path.join(root, d.name), index: i }))
  if (!chapters.length) throw new Error('没有已下载的章节')

  const outDir = st.epubAutoExportDir && st.epubAutoExportDir.trim()
    ? st.epubAutoExportDir.trim()
    : app.getPath('downloads')
  try { await safeFs.mkdir(outDir, { recursive: true }) } catch (_) {}

  const outName = sanitize(comicTitle) + '.epub'
  const outputPath = path.join(outDir, outName)

  // 已存在则跳过(幂等, 避免重复生成)
  if (await safeFs.access(outputPath).then(() => true).catch(() => false)) {
    console.log(`[AutoEpub] ${comicTitle} EPUB 已存在, 跳过: ${outputPath}`)
    return { skipped: true, outputPath }
  }

  const defaultVolumeMode = st.epubVolumeMode || 'auto'
  const defaultChaptersPerVolume = st.epubChaptersPerVolume || 100
  const defaultImageQuality = st.epubImageQuality || 'original'
  const effectiveMeta = {
    title: comicTitle,
    author: 'Unknown',
    description: comicTitle,
    language: 'zh-CN'
  }

  const opts = {
    sourceDir: root,
    outputPath,
    title: comicTitle,
    chapters,
    meta: effectiveMeta,
    onProgress: (p) => {
      if (onProgress) onProgress({ current: p.current, total: p.total, title: comicTitle })
    }
  }
  const volMode = st.epubVolumeMode || defaultVolumeMode
  if (volMode !== 'single') opts.chaptersPerVolume = defaultChaptersPerVolume
  opts.imageQuality = defaultImageQuality

  console.log(`[AutoEpub] 开始生成 ${comicTitle} (${chapters.length}章) -> ${outputPath}`)
  const result = await exporter.toEPUB(opts)
  const files = Array.isArray(result) ? result : [result]
  console.log(`[AutoEpub] 完成 ${comicTitle}: ${files.map(f => f.outputPath).join(', ')}`)

  // 标记已导出 EPUB (sync/repair 据此跳过, 不再重新下载)
  if (comic._id || sourceUrl) {
    try { await db.setEpubExported(comic._id || sourceUrl, 1) } catch (e) { console.warn('[AutoEpub] 标记 epub_exported 失败:', e.message) }
  }

  // 生成成功后自动删除原图(设置 epubAutoDeleteImages=true 时)
  // A 方案: EPUB 已含全部图片, 原图可删, 且 epub_exported 标记保证不会重下
  if (st.epubAutoDeleteImages === true && root && root !== outDir && (await safeFs.access(root).then(() => true).catch(() => false))) {
    try {
      const entries = await safeFs.readdir(root)
      // 只删图片文件(.webp/.jpg/.jpeg/.png), 保留目录结构以便后续导出可重新扫描
      const imgExt = /\.(webp|jpe?g|png)$/i
      let delCount = 0
      for (const e of entries) {
        if (imgExt.test(e)) {
          const fp = path.join(root, e)
          try { await safeFs.unlink(fp); delCount++ } catch (_) {}
        }
      }
      if (delCount > 0) console.log(`[AutoEpub] 已删除原图 ${delCount} 张: ${comicTitle}`)
    } catch (e) { console.warn('[AutoEpub] 删除原图失败:', e.message) }
  }

  return { success: true, files: files.map(f => f.outputPath), outputPath: files[0]?.outputPath }
}

module.exports = { jobHandlerExportEpub, isComicFullyDownloaded }
