'use strict'

const path = require('path')
const fs = require('fs')
const { sanitizeFilename: sanitize } = require('../../utils')

function register(deps) {
  const {
    app, ipcMain,
    exporter, downloadPaths
  } = deps

  const { findComicDir, getPrimaryDownloadRoot, getDownloadRoots } = downloadPaths

  ipcMain.handle('export:toCBZ', async (_, opts) => exporter.toCBZ(opts))
  ipcMain.handle('export:toEPUB', async (_, opts) => exporter.toEPUB(opts))

  ipcMain.handle('export:listDownloads', async () => {
    const roots = getDownloadRoots()
    const seen = new Set()
    const comics = []
    for (const root of roots) {
      if (!fs.existsSync(root)) continue
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const dirKey = `${root}/${e.name}`
        if (seen.has(dirKey)) continue
        seen.add(dirKey)
        const comicDir = path.join(root, e.name)
        const chEntries = fs.readdirSync(comicDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && /^\d+-/.test(d.name))
        let cover = null
        const coverPath = path.join(comicDir, 'cover.webp')
        if (fs.existsSync(coverPath)) cover = 'file://' + coverPath
        comics.push({
          id: e.name,
          title: e.name,
          cover,
          meta: `${chEntries.length} 章`,
          chapterCount: chEntries.length,
          sourceDir: comicDir
        })
      }
    }
    return comics
  })

  ipcMain.handle('export:fromDownload', async (_, { comicTitle, format, chapters: clientChapters, meta, volumeMode, chaptersPerVolume, imageQuality: imgQuality }) => {
    const root = findComicDir(comicTitle) || path.join(getPrimaryDownloadRoot(), sanitize(comicTitle))
    if (!fs.existsSync(root)) throw new Error(`下载目录不存在: ${root}`)

    let chapters = clientChapters
    if (!chapters || !chapters.length) {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      chapters = entries
        .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
        .sort((a, b) => {
          const na = parseInt(a.name.match(/^\d+/)[0], 10)
          const nb = parseInt(b.name.match(/^\d+/)[0], 10)
          return na - nb
        })
        .map((d, i) => ({ name: d.name.replace(/^\d+-/, ''), dir: path.join(root, d.name), index: i }))
    } else {
      chapters = chapters.map(ch => {
        const folderName = `${ch.index + 1}-${sanitize(ch.name)}`
        return { name: ch.name, dir: path.join(root, folderName), index: ch.index }
      })
    }

    if (!chapters.length) throw new Error('没有已下载的章节')

    let settings = {}
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json')
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) || {}
      }
    } catch (_) {}
    const defaultVolumeMode = settings.epubVolumeMode || 'auto'
    const defaultChaptersPerVolume = settings.epubChaptersPerVolume || 100
    const defaultImageQuality = settings.epubImageQuality || 'original'
    const defaultIncludeMeta = typeof settings.epubIncludeMeta === 'boolean' ? settings.epubIncludeMeta : true

    const outputPath = path.join(app.getPath('downloads'), `${sanitize(comicTitle)}.${format}`)
    let effectiveMeta = undefined
    if (format === 'epub') {
      if (meta) {
        effectiveMeta = meta
      } else if (defaultIncludeMeta) {
        effectiveMeta = {
          title: comicTitle,
          author: 'Unknown',
          description: `${comicTitle}`,
          language: 'zh-CN'
        }
      }
    }
    const opts = {
      sourceDir: root,
      outputPath,
      title: comicTitle,
      chapters,
      onProgress: (p) => console.log(`[导出] ${comicTitle}: ${p.current}/${p.total}`),
      meta: effectiveMeta
    }

    const effectiveVolumeMode = volumeMode || defaultVolumeMode
    const effectiveChaptersPerVolume = chaptersPerVolume || defaultChaptersPerVolume
    const effectiveImageQuality = imgQuality || defaultImageQuality

    if (format === 'epub' && effectiveVolumeMode !== 'single') {
      opts.chaptersPerVolume = effectiveChaptersPerVolume
    }
    if (format === 'epub') {
      opts.imageQuality = effectiveImageQuality
    }

    if (format === 'epub') {
      const result = await exporter.toEPUB(opts)
      if (Array.isArray(result)) {
        return { success: true, files: result, outputPath: result[0]?.outputPath }
      }
      return { success: true, files: [result], outputPath: result.outputPath }
    }

    const result = await exporter.toCBZ(opts)
    return { success: true, files: [result], outputPath: result.outputPath }
  })

  ipcMain.handle('export:checkEpubExists', async (_, comicTitle) => {
    const outputPath = path.join(app.getPath('downloads'), `${sanitize(comicTitle)}.epub`)
    return fs.existsSync(outputPath)
  })

  ipcMain.handle('export:getDownloadChapters', async (_, comicTitle) => {
    const root = findComicDir(comicTitle) || path.join(getPrimaryDownloadRoot(), sanitize(comicTitle))
    if (!fs.existsSync(root)) return []

    const entries = fs.readdirSync(root, { withFileTypes: true })
    const chapters = entries
      .filter(e => e.isDirectory() && /^\d+-/.test(e.name))
      .sort((a, b) => {
        const na = parseInt(a.name.match(/^\d+/)[0], 10)
        const nb = parseInt(b.name.match(/^\d+/)[0], 10)
        return na - nb
      })
      .map((d, i) => ({
        name: d.name.replace(/^\d+-/, ''),
        dir: path.join(root, d.name),
        index: i
      }))

    return chapters
  })
}

module.exports = { register }