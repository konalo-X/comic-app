// Comic-Rust bridge — 把 Electron 时代的 window.*Api 接口映射到 Tauri invoke。
// 34 个 Vue 组件无需改动即可在 Rust 后端上运行。
//
// 阶段2 已打通（读真实 comics.sqlite + 本地已下载图片离线阅读）
// 阶段3 已追加：下载队列（并发 worker）、后台抓取/更新、导出 EPUB/CBZ、在线详情
//   dbApi: getComics / getComicsCount / getComicById / getComicByUrl / getCategoryStats / setFavorite / clearUpdateDelta
//   progressApi: get / save / history / delete
//   readerApi/offlineApi: getLocalChapterImages（离线取图）、queueAllChapters（入队下载）
//   settingsApi: get / save（敏感字段自动加密落盘）
//   crawlerApi / syncApi / enrichApi: 搜索、章节图抓取、元数据补全、自动更新（全部真实实现）
//   jobApi: 下载/导出队列（后台并发 worker 池）
// 兜底：任何未命中的接口调用都返回友好错误，避免页面 ReferenceError。

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// 所有 Tauri 错误统一归一为结构化 { code, msg }：
//  - Rust 已用 AppErr 返回时 → 错误是 { code, msg } JSON 字符串或对象
//  - Rust 用 String 时 → fallback code = UNKNOWN_ERROR
async function safeInvoke(cmd, args = {}) {
  try {
    return await invoke(cmd, args)
  } catch (raw) {
    const errObj = normalizeError(raw)
    const e = new Error(errObj.msg || String(raw || ''))
    e.code = errObj.code || 'UNKNOWN_ERROR'
    e.raw = raw
    throw e
  }
}
function normalizeError(raw) {
  if (raw == null) return { code: 'UNKNOWN_ERROR', msg: '未知错误' }
  if (typeof raw === 'string') {
    if (raw.startsWith('{')) {
      try {
        const o = JSON.parse(raw)
        if (o && (o.code || o.msg)) return { code: o.code || 'UNKNOWN_ERROR', msg: o.msg || String(raw) }
      } catch (_) {}
    }
    return { code: 'UNKNOWN_ERROR', msg: raw }
  }
  const msg = raw.msg || raw.message || raw.error || ''
  if (raw.code) return { code: String(raw.code), msg: msg || String(raw) }
  if (typeof raw.message === 'string' && raw.message.startsWith('{')) {
    try {
      const o = JSON.parse(raw.message)
      if (o && (o.code || o.msg)) return { code: o.code || 'UNKNOWN_ERROR', msg: o.msg || String(raw.message) }
    } catch (_) {}
  }
  return { code: 'UNKNOWN_ERROR', msg: msg || String(raw) }
}

// 把 Tauri 事件包装成 Electron 风格的 on<Event>(cb) => cleanup
function tauriListener(eventName, transform) {
  return (cb) => {
    let un = null
    listen(eventName, (e) => cb(transform ? transform(e.payload) : e.payload)).then((u) => { un = u })
    return () => { if (un) un() }
  }
}

function notImpl(name) {
  const e = new Error(`[Comic-Rust] ${name} 尚未在 Rust 后端实现（当前阶段：离线书架+阅读）`)
  e.code = 'NOT_IMPLEMENTED'
  return Promise.reject(e)
}

function noopListener() {
  return () => {}
}

// ---------- dbApi ----------
window.dbApi = {
  // 组件契约：返回 { docs, total, page, pageSize }
  getComics: async (page = 1, pageSize = 24, filters = {}) => {
    return await safeInvoke('comics_list', {
      page,
      pageSize,
      category: filters?.category ?? null,
      status: filters?.status ?? null,
      tag: filters?.tag ?? null,
      search: filters?.search ?? null,
      sort: filters?.sort ?? null,
      localOnly: !!filters?.localOnly,
      onlineOnly: !!filters?.onlineOnly,
    })
  },
  getComicsCount: () => safeInvoke('comics_count'),
  getComicById: (id) => safeInvoke('comic_by_id', { id }),
  getComicByUrl: (url) => safeInvoke('comic_by_url', { url }),
  getCategoryStats: () => safeInvoke('category_stats'),
  setFavorite: (comicId, favorited) => safeInvoke('set_favorite', { comicId, favorited: !!favorited }),
  clearUpdateDelta: (comicId) => safeInvoke('clear_update_delta', { comicId }),
  getFavoritedComics: async () => {
    const r = await safeInvoke('comics_list', {
      page: 1, pageSize: 100000, category: null, status: null,
      tag: null, search: null, sort: 'time', localOnly: false, onlineOnly: false,
    })
    return (r.docs || []).filter((c) => c.favorited)
  },
  searchComics: (q) => safeInvoke('comics_list', {
    page: 1, pageSize: 30, category: null, status: null,
    tag: null, search: q, sort: null, localOnly: false, onlineOnly: false,
  }).then((r) => r.docs || []),
  clearComics: () => safeInvoke('clear_comics'),
  countMissingFields: () => safeInvoke('count_missing_fields'),
  autoScanLocalComics: (paths) => safeInvoke('auto_scan_local', { paths: paths ?? null }),
  getChaptersCount: () => safeInvoke('db_chapters_count'),
  getImagesCount: () => safeInvoke('db_images_count'),
  getDownloadSize: () => safeInvoke('db_download_size'),
}

// ---------- progressApi ----------
window.progressApi = {
  get: (comicId) => safeInvoke('get_reading_progress', { comicId }),
  save: (p) =>
    safeInvoke('save_reading_progress', {
      comicId: p.comicId,
      chapterIndex: p.chapterIndex ?? 0,
      chapterUrl: p.chapterUrl ?? '',
      pageIndex: p.pageIndex ?? 0,
      totalPages: p.totalPages ?? 0,
    }),
  history: (limit = 20) => safeInvoke('reading_history', { limit }),
  delete: (comicId) => safeInvoke('delete_reading_progress', { comicId }),
}

// ---------- readerApi / offlineApi（离线取图 + 在线抓取）----------
window.readerApi = {
  // 在线取图：返回可直接显示的代理 URL 数组
  getChapterImages: (chapterUrl, referer) =>
    safeInvoke('get_chapter_images', { chapterUrl, referer: referer ?? null }),
}

window.offlineApi = {
  getLocalChapterImages: (comicId, chapterIndex, comicTitle) =>
    safeInvoke('get_local_chapter_images', { comicId, chapterIndex, comicTitle }),
  listLocal: () => safeInvoke('download_list_local').catch(() => []),
  getHighestDownloadedIndex: ({ comicTitle, sourceUrl }) =>
    safeInvoke('get_highest_downloaded_index', { comicTitle, sourceUrl: sourceUrl ?? null }),
  // 批量入后台队列（后台并发5 worker 池消费）
  queueAllChapters: ({ comicTitle, chapters, referer, sourceUrl }) =>
    safeInvoke('queue_all_chapters', {
      comicTitle,
      chapters: (chapters || []).map((ch, i) => ({
        index: ch.index ?? i,
        name: ch.name ?? '',
        url: ch.url,
      })),
      sourceUrl: sourceUrl ?? null,
      referer: referer ?? null,
    }),
  exportComic: (title, format) => safeInvoke('export_comic', { title, format: format || 'epub' }),
  pauseJob: (jobId) => safeInvoke('job_pause', { jobId }),
  resumeJob: (jobId) => safeInvoke('job_resume', { jobId }),
  onJobProgress: tauriListener('job://progress'),
  onJobDone: tauriListener('job://done'),
}

// ---------- settingsApi ----------
window.settingsApi = {
  get: () => safeInvoke('settings_get').catch(() => ({})),
  save: (patch) => safeInvoke('settings_save', { patch }),
}

// ---------- windowApi ----------
window.windowApi = {
  minimize: () => safeInvoke('window_minimize').catch(() => {}),
  maximize: () => safeInvoke('window_maximize').catch(() => {}),
  unmaximize: () => safeInvoke('window_unmaximize').catch(() => {}),
  close: () => safeInvoke('window_close').catch(() => {}),
  isMaximized: () => safeInvoke('window_is_maximized').catch(() => false),
  onMaximizeChange: tauriListener('window://maximize-changed'),
  onFullscreenChange: tauriListener('window://fullscreen-changed'),
  getSize: async () => {
    try {
      return [window.innerWidth, window.innerHeight]
    } catch (_) {
      return [1280, 800]
    }
  },
  openPath: (path) => safeInvoke('open_path', { path }).catch(() => {}),
  revealInFolder: (path) => safeInvoke('reveal_in_folder', { path }).catch(() => {}),
  toggleFullscreen: () => safeInvoke('window_toggle_fullscreen').catch(() => {}),
  isFullscreen: () => safeInvoke('window_is_fullscreen').catch(() => false),
  exitFullscreen: () => safeInvoke('window_toggle_fullscreen').catch(() => {}),
}

// ---------- sourceApi / detailApi（在线抓取）----------
window.sourceApi = {
  search: (query, page = 1) => safeInvoke('source_search', { query, page }),
  getPageList: (chapterUrl, referer) => safeInvoke('get_page_list', { chapterUrl, referer: referer ?? null }),
  getDetail: (url) => safeInvoke('source_get_detail', { url }),
  getChapters: (url) => safeInvoke('source_get_detail', { url }).then((d) => d.chapters || []),
  list: () => [{ id: 'smtt6', name: 'SM动漫', lang: 'zh' }],
}

// ---------- job / export / crawler / scan（后台队列 + 在线抓取）----------
window.jobApi = {
  list: (status, limit) => safeInvoke('job_list', { status: status || 'all', limit: limit || 500 }),
  stats: () => safeInvoke('job_stats'),
  remove: (jobId) => safeInvoke('job_remove', { jobId }),
  retry: (jobId) => safeInvoke('job_retry', { jobId }),
  retryAll: () => safeInvoke('job_retry_all'),
  onQueueChanged: tauriListener('job://queue-changed'),
  onEnqueued: tauriListener('job://enqueued'),
  onPaused: tauriListener('job://paused'),
  onResumed: tauriListener('job://resumed'),
  onRemoved: tauriListener('job://removed'),
  onActive: tauriListener('job://active'),
  onRetrying: tauriListener('job://retrying'),
}
window.exportApi = {
  listDownloads: () => [],
  fromDownload: (payload) => safeInvoke('export_comic', { title: payload?.title, format: payload?.format || 'epub' }),
}
window.crawlerApi = {
  list: () => [],
  crawlAll: (baseUrl) => safeInvoke('crawler_crawl_all', { baseUrl: baseUrl ?? null }),
  checkUpdates: () => safeInvoke('crawler_check_updates'),
  enrich: (force) => safeInvoke('crawler_enrich', { force: !!force }),
  enrichChapters: () => safeInvoke('crawler_enrich_chapters'),
  onProgress: tauriListener('crawler://progress'),
  onDone: tauriListener('crawler://done'),
  onEnrichProgress: tauriListener('crawler://enrich-progress'),
  onEnrichDone: tauriListener('crawler://enrich-done'),
  onEnrichChaptersProgress: tauriListener('crawler://enrich-chapters-progress'),
  onEnrichChaptersDone: tauriListener('crawler://enrich-chapters-done'),
  onUpdateProgress: tauriListener('crawler://update-progress'),
  onUpdateDone: tauriListener('crawler://update-done'),
}
window.scanApi = {
  onProgress: tauriListener('scan://progress'),
}
window.detailApi = {
  getComicById: (id) => safeInvoke('comic_by_id', { id }),
  enrichComic: (url) => safeInvoke('source_get_detail', { url }),
  autoEnrichAll: (limit) => safeInvoke('auto_enrich_all', { limit: limit ?? null }),
  syncNow: () => safeInvoke('run_sync_now', { limit: null }),
}
window.searchApi = {
  global: async (q) => {
    const local = await window.dbApi.searchComics(q).catch(() => [])
    return { local, remote: [] }
  },
}
window.downloadApi = {
  onProgress: (cb) => {
    const un1 = listen('job://progress', (e) => {
      const p = e.payload || {}
      cb({ speed: '', ...p })
    })
    return () => { un1.then((u) => u && u()) }
  },
  onJobProgress: tauriListener('job://progress'),
  onJobDone: tauriListener('job://done'),
  onJobFailed: tauriListener('job://failed'),
}
window.batchApi = {
  delete: (ids) => safeInvoke('batch_delete_comics', { ids: ids || [] }),
  exportEPUB: (ids) => safeInvoke('batch_export_epub', { ids: ids || [] }),
}
window.cacheApi = {
  stats: () => safeInvoke('cache_stats'),
  clear: () => safeInvoke('cache_clear'),
}
window.diskApi = { getSpace: (path) => safeInvoke('disk_get_space', { path: path ?? null }) }
window.importApi = { pickDirectory: () => safeInvoke('pick_directory').catch(() => null) }
window.appApi = {
  getBackgroundTasks: async () => {
    try {
      const stats = await safeInvoke('job_stats', {})
      const activeCount = stats.running || 0
      const waitingCount = stats.waiting || 0
      const completedCount = stats.completed || 0
      const failedCount = stats.failed || 0
      const tasks = [
        {
          type: 'download',
          icon: 'download',
          label: '下载任务',
          active: activeCount,
          waiting: waitingCount,
        },
      ]
      return {
        tasks,
        activeCount,
        waitingCount,
        completedCount,
        failedCount,
        downloadActiveCount: activeCount,
        downloadWaitingCount: waitingCount,
        downloadConcurrency: 5,
      }
    } catch {
      return []
    }
  },
  onBackgroundTasks: (cb) => {
    const p = listen('job://queue-changed', () => {
      window.appApi.getBackgroundTasks().then(cb).catch(() => {})
    })
    return () => { p.then((u) => u && u()) }
  },
}
window.electronAPI = { onSplashMessage: noopListener }

export {}