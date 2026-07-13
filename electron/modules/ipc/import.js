'use strict'

const path = require('path')
const fs = require('fs')
const { normalizeName } = require('../../utils')

function register(deps) {
  const {
    app, BrowserWindow, ipcMain, dialog, shell,
    db, sources, getJobQueue, downloadPaths
  } = deps

  const { getDownloadRoots } = downloadPaths

  // --- 本地导入 ---
  ipcMain.handle('import:scanComics', async (_, dirPath) => {
    const dir = dirPath || app.getPath('downloads')
    if (!fs.existsSync(dir)) return []

    const result = await db.scanLocalComics(dir)
    return result || []
  })

  ipcMain.handle('import:commitComic', async (_, { comic, sourceUrl }) => {
    try {
      const matched = sourceUrl ? await db.getComicByUrl(sourceUrl) : null
      if (matched) {
        return { success: true, comicId: matched._id, matched: true }
      }
      const newComic = await db.upsertComic({
        sourceUrl: sourceUrl || '',
        title: comic.title || '',
        cover: comic.cover || '',
        author: comic.author || '',
        status: comic.status || '',
        desc: comic.desc || '',
        tags: comic.tags || [],
        category: comic.category || '',
        chapters: comic.chaptersList || [],
        localPath: comic.localPath
      })
      return { success: true, comicId: newComic._id, matched: false }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('import:matchSource', async (_, title) => {
    try {
      const results = await sources.multiSearch(title)
      return { success: true, results: results || [] }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('import:pickDirectory', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择漫画目录'
    })
    if (result.filePaths?.length) return result.filePaths[0]
    return null
  })

  ipcMain.handle('import:scanPrimaryDownload', async () => {
    const roots = getDownloadRoots()
    const existingRoots = roots.filter(r => fs.existsSync(r))
    if (existingRoots.length === 0) return []

    let allComics = []
    for (const root of existingRoots) {
      try {
        const comics = await db.scanLocalComics(root)
        for (const c of comics) {
          if (!allComics.find(x => x.title === c.title)) {
            allComics.push(c)
          }
        }
      } catch (e) {
        console.warn(`扫描下载目录失败 (${root}):`, e.message)
      }
    }
    return allComics
  })

  ipcMain.handle('import:registerExisting', async (_, { comic, sourceUrl }) => {
    return db.registerExistingDownload(comic, sourceUrl)
  })

  ipcMain.handle('import:checkExistingInDB', async (_, comicTitles) => {
    return db.checkExistingByTitle(comicTitles)
  })

  // --- 磁盘文件名修复：将老版本目录名对齐到当前项目 sanitize() 规则 ---
  function _normName(s) {
    return normalizeName(s)
  }

  async function _matchComicInDB(dirName) {
    const raw = db.getRawDB()
    if (!raw) return null
    const normDir = _normName(dirName)
    if (!normDir) return null

    try {
      const r1 = raw.exec('SELECT DISTINCT comic_id, comic_title FROM download_records')
      if (r1.length > 0) {
        for (const row of r1[0].values) {
          const [comicId, comicTitle] = row
          if (_normName(String(comicTitle || '')) === normDir) {
            const r2 = raw.exec(
              'SELECT name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order',
              [comicId]
            )
            const chapters = r2.length > 0 ? r2[0].values.map(v => ({ name: v[0], index: v[1] })) : []
            return { comicId, title: comicTitle, chapters }
          }
        }
      }
    } catch (_) {}

    try {
      const r3 = raw.exec('SELECT id, title FROM comics')
      if (r3.length > 0) {
        for (const row of r3[0].values) {
          const [comicId, title] = row
          if (_normName(String(title || '')) === normDir) {
            const r4 = raw.exec(
              'SELECT name, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order',
              [comicId]
            )
            const chapters = r4.length > 0 ? r4[0].values.map(v => ({ name: v[0], index: v[1] })) : []
            return { comicId, title, chapters }
          }
        }
      }
    } catch (_) {}

    return null
  }

  // 返回可用的公共 API
  return { _normName, _matchComicInDB }
}

module.exports = { register }