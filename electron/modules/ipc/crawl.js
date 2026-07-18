'use strict'

function register(deps) {
  const {
    BrowserWindow, ipcMain,
    db, sources, jobHandlers
  } = deps

  const jq = deps.jq
  const { deriveCategoryFromTags, enrichChapters, addSyncJob } = jobHandlers

  // 通用：创建单个作业的 IPC 处理器（避免重复的 Promise + 事件监听模板代码）
  // 使用 Map 来跟踪每个 prefix 的正在进行的 Promise，防止重复注册监听器
  const _pendingHandlers = new Map()

  function createJobHandler(prefix, addJobFn) {
    return async () => {
      // 如果同一个 prefix 已经有正在进行的请求，返回同一个 Promise
      if (_pendingHandlers.has(prefix)) {
        console.log(`[${prefix}] 已有相同类型的请求在进行中，复用现有 Promise`)
        return _pendingHandlers.get(prefix)
      }

      const promise = new Promise((resolve, reject) => {
        let resolved = false
        let jobId = null

        function cleanup() {
          _pendingHandlers.delete(prefix)
        }

        const unsub = jq.on('progress', (data) => {
          if (jobId && data.jobId === jobId) {
            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send(`${prefix}:progress`, data)
            })
          }
        })
        const unsubDone = jq.on('completed', (data) => {
          if (!resolved && jobId && data.jobId === jobId) {
            resolved = true
            unsub(); unsubDone(); unsubFailed()
            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send(`${prefix}:done`, data.result)
            })
            cleanup()
            resolve(data.result)
          }
        })
        const unsubFailed = jq.on('failed', (data) => {
          if (!resolved && jobId && data.jobId === jobId) {
            resolved = true
            unsub(); unsubDone(); unsubFailed()
            cleanup()
            reject(new Error(data.error || '作业失败'))
          }
        })
        jobId = addJobFn()
        if (!jobId) {
          resolved = true
          unsub(); unsubDone(); unsubFailed()
          cleanup()
          reject(new Error('无法创建作业'))
        }
      })

      _pendingHandlers.set(prefix, promise)
      return promise
    }
  }

  // --- 全局爬取进度转发 ---
  let globalCrawlForwarder = null
  function ensureGlobalCrawlForwarder() {
    if (globalCrawlForwarder) return

    const channelMap = {
      crawlAll: 'crawl',
      update: 'update',
      enrich: 'enrich',
      enrichChapters: 'enrichChapters'
    }

    // 按类型缓存当前活跃的 jobId，避免每次都查询数据库
    const activeJobIdCache = new Map()

    const getActiveJobIdForType = (type) => {
      try {
        const existing = jq.findActiveByType(type)
        if (existing && existing.id) {
          activeJobIdCache.set(type, existing.id)
          return existing.id
        }
        activeJobIdCache.delete(type)
        return null
      } catch (e) {
        return activeJobIdCache.get(type) || null
      }
    }

    const unsubProgress = jq.on('progress', (data) => {
      const prefix = channelMap[data.type]
      if (!prefix) return
      // 关键修复：只转发当前活跃任务的进度，避免多个同类型任务的进度互相干扰
      const activeJobId = getActiveJobIdForType(data.type)
      if (activeJobId && data.jobId !== activeJobId) {
        return
      }
      console.log(`[job:${data.type}] progress:`, data.page || data.current, data.msg || data.title)
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send(`${prefix}:progress`, data)
      })
    })
    const unsubDone = jq.on('completed', (data) => {
      const prefix = channelMap[data.type]
      if (!prefix) return
      const activeJobId = getActiveJobIdForType(data.type)
      if (activeJobId && data.jobId !== activeJobId) {
        return
      }
      activeJobIdCache.delete(data.type)
      console.log(`[job:${data.type}] completed:`, data.result?.updated, data.result?.total)
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send(`${prefix}:done`, data.result)
      })
    })
    const unsubFailed = jq.on('failed', (data) => {
      const prefix = channelMap[data.type]
      if (!prefix) return
      const activeJobId = getActiveJobIdForType(data.type)
      if (activeJobId && data.jobId !== activeJobId) {
        return
      }
      activeJobIdCache.delete(data.type)
      console.error(`[job:${data.type}] failed:`, data.error)
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send(`${prefix}:done`, { error: data.error })
      })
    })
    globalCrawlForwarder = () => { unsubProgress(); unsubDone(); unsubFailed() }
  }

  // --- 全局爬取/同步进度事件转发（确保所有任务的 progress/done/failed 都能到前端） ---
  ensureGlobalCrawlForwarder()

  // crawl:all 防重入：同时只允许一个 Promise 等待
  let _crawlAllPromise = null

  ipcMain.handle('crawl:all', async (event, startUrl) => {
    console.log('[crawl:all] handle called, startUrl=', startUrl)

    // 如果已经有前端在等待这个 IPC 返回，直接返回已有 Promise 的结果
    if (_crawlAllPromise) {
      console.log('[crawl:all] 已有前端请求在等待，返回同一个 Promise')
      return _crawlAllPromise
    }

    const existing = jq.findByType('crawlAll')
    if (existing) {
      console.log('[crawl:all] 已有爬取作业运行中（状态:', existing.status, '），跳过重复请求')
      return { msg: '已有爬取作业运行中', existing: true }
    }

    ensureGlobalCrawlForwarder()

    _crawlAllPromise = new Promise((resolve, reject) => {
      let resolved = false
      let jobId = null

      function cleanup() {
        _crawlAllPromise = null
      }

      const unsubDone = jq.on('completed', (data) => {
        if (!resolved && jobId && data.jobId === jobId && data.type === 'crawlAll') {
          resolved = true
          unsubDone(); unsubFailed()
          cleanup()
          resolve(data.result)
        }
      })
      const unsubFailed = jq.on('failed', (data) => {
        if (!resolved && jobId && data.jobId === jobId && data.type === 'crawlAll') {
          resolved = true
          unsubDone(); unsubFailed()
          cleanup()
          reject(new Error(data.error || '作业失败'))
        }
      })
      jobId = jq.add('crawlAll', { startUrl }, { priority: 0, timeout: 30 * 60 * 1000, maxRetries: 1 })
      if (!jobId) {
        resolved = true
        unsubDone(); unsubFailed()
        cleanup()
        reject(new Error('爬取任务被限速，请稍后再试（15分钟内只能爬取一次）'))
        return
      }
      console.log('[crawl:all] job added, id=', jobId)
    })

    return _crawlAllPromise
  })
  ipcMain.handle('crawl:enrich', createJobHandler('enrich', () => addSyncJob(0)))
  ipcMain.handle('crawl:checkUpdates', createJobHandler('update', () => addSyncJob(0)))
  ipcMain.handle('crawl:enrichChapters', createJobHandler('enrichChapters', () => jq.add('enrichChapters', {}, { priority: 3 })))

  // --- 漫画详情页补全 ---
  ipcMain.handle('detail:enrichComic', async (_, sourceUrl) => {
    try {
      console.log('[detail:enrichComic] step1: get source')
      const source = sourceUrl?.includes('smtt6') ? sources.get('smtt6') : sources.default
      console.log('[detail:enrichComic] step2: getDetail')
      const detail = await source.getDetail(sourceUrl)
      console.log('[detail:enrichComic] step3: getComicByUrl')
      const existing = await db.getComicByUrl(sourceUrl)
      console.log('[detail:enrichComic] step4: upsertComic')
      const category = detail.category || deriveCategoryFromTags(detail.tags, existing?.tags)
      const result = await db.upsertComic({
        sourceUrl,
        title: detail.title || '',
        cover: detail.cover || '',
        author: detail.author || '',
        status: detail.status || '',
        desc: detail.desc || '',
        tags: detail.tags || [],
        category,
        updateTime: detail.updateTime || null,
        chapters: detail.chapters || []
      })
      console.log('[detail:enrichComic] step5: enrichChapters')
      const comicId = result?._id
      const chaptersToEnrich = (detail.chapters || []).slice(0, 5)
        .map((ch, i) => ({ index: i, name: ch.name, url: ch.url }))
      if (chaptersToEnrich.length > 0) {
        try {
          const { imageCountUpdates, chapterNameUpdates } = await enrichChapters({ _id: comicId, sourceUrl }, chaptersToEnrich, source)
          if (comicId && imageCountUpdates.length > 0) {
            await db.updateChapterImageCounts(comicId, imageCountUpdates)
          }
          if (comicId && chapterNameUpdates.length > 0) {
            await db.updateChapterNames(comicId, chapterNameUpdates)
          }
        } catch (e) {
          console.warn(`[detail:enrichComic] 章节增强失败:`, e.message)
        }
      }
      const updated = await db.getComicByUrl(sourceUrl)

      const changed = []
      if (!existing?.desc && updated?.desc) changed.push('简介')
      if (!existing?.author && updated?.author) changed.push('作者')
      if (!existing?.status && updated?.status) changed.push('状态')
      if (!existing?.category && updated?.category) changed.push('TAG')
      if ((!existing?.tags || existing.tags.length === 0) && updated?.tags?.length) changed.push('标签')
      if (updated?.chapters?.length > (existing?.chapters?.length || 0)) changed.push('章节列表')

      return { success: true, comic: updated, changed }
    } catch (e) {
      console.error('[detail:enrichComic] error:', e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('detail:autoEnrichAll', async () => {
    try {
      const existing = jq.db.prepare(
        `SELECT id FROM job_queue WHERE type = 'autoEnrich' AND status IN ('waiting', 'running', 'active', 'paused', 'delayed') LIMIT 1`
      ).get()
      if (existing) {
        return { success: true, jobId: existing.id, status: 'already_running', message: '已有补全任务在执行中' }
      }
      const jobId = jq.add('autoEnrich', {}, { priority: 2, maxRetries: 2, timeout: 10 * 60 * 1000 })
      return { success: true, jobId, status: jobId ? 'queued' : 'skipped' }
    } catch (e) {
      console.error('[detail:autoEnrichAll] error:', e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('detail:scanGenericChapters', async () => {
    try {
      const comics = await db.getComicsWithGenericChapterNames(50)
      return { success: true, comics, count: comics.length }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('detail:enrichAllGenericChapters', async () => {
    try {
      const comics = await db.getComicsWithGenericChapterNames(200)
      if (comics.length === 0) {
        return { success: true, enrichedCount: 0, skippedCount: 0, message: '没有需要修复的漫画' }
      }
      let enrichedCount = 0
      let skippedCount = 0
      const errors = []
      for (const comic of comics) {
        try {
          const source = sources.get('smtt6') || sources.default
          const detail = await source.getDetail(comic.sourceUrl)
          if (detail.chapters && detail.chapters.length > 0) {
            const stillGeneric = detail.chapters.some(ch => db.isChapterNameGeneric?.(ch.name))
            if (stillGeneric) {
              console.log(`[enrich] ${comic.title}: 网站章节名本身就是简单格式，跳过`)
              skippedCount++
            } else {
              await db.upsertComic({
                sourceUrl: comic.sourceUrl,
                title: detail.title || comic.title,
                cover: detail.cover,
                author: detail.author || '',
                status: detail.status || '',
                desc: detail.desc || '',
                tags: detail.tags || [],
                category: detail.category,
                updateTime: detail.updateTime || null,
                chapters: detail.chapters
              })
              enrichedCount++
            }
          }
          await new Promise(r => setTimeout(r, 800))
        } catch (e) {
          errors.push({ title: comic.title, error: e.message })
        }
      }
      return {
        success: true,
        enrichedCount,
        skippedCount,
        total: comics.length,
        errors: errors.length > 0 ? errors : undefined
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  return { ensureGlobalCrawlForwarder }
}

module.exports = { register }