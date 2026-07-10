const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('windowApi', {
  minimize: () => ipcRenderer.invoke('app:minimize'),
  maximize: () => ipcRenderer.invoke('app:maximize'),
  close: () => ipcRenderer.invoke('app:close'),
  isMaximized: () => ipcRenderer.invoke('app:isMaximized'),
  onMaximizeChange: (cb) => {
    const handler = (_, isMaximized) => cb(isMaximized)
    ipcRenderer.on('window:maximize-change', handler)
    return () => ipcRenderer.removeListener('window:maximize-change', handler)
  },
  getSize: () => ipcRenderer.invoke('window:getSize'),
  setSize: (w, h) => ipcRenderer.invoke('window:setSize', w, h),
  openPath: (path) => ipcRenderer.invoke('window:openPath', path),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggleFullscreen'),
  isFullscreen: () => ipcRenderer.invoke('app:isFullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('app:exitFullscreen')
})

// ============ 源站 API ============
contextBridge.exposeInMainWorld('sourceApi', {
  search: (query, sourceId) => ipcRenderer.invoke('source:search', query, sourceId || 'all'),
  getDetail: (url) => ipcRenderer.invoke('source:getDetail', url),
  getChapters: (url) => ipcRenderer.invoke('source:getChapters', url),
  getPageList: (chapterUrl, referer) => ipcRenderer.invoke('source:getPageList', chapterUrl, referer || ''),
  /** 获取缓存优先的图片列表：已缓存返回 comic-cache:// 路径，未缓存则下载后缓存再返回 */
  getCachedPageList: (chapterUrl, referer) => ipcRenderer.invoke('source:getCachedPageList', chapterUrl, referer || ''),
  list: () => ipcRenderer.invoke('source:list')
})

// ============ 作业队列 API ============
contextBridge.exposeInMainWorld('jobApi', {
  add: (type, payload, opts) => ipcRenderer.invoke('job:add', type, payload, opts || {}),
  cancel: (id) => ipcRenderer.invoke('job:cancel', id),
  retry: (id) => ipcRenderer.invoke('job:retry', id),
  retryAll: () => ipcRenderer.invoke('job:retryAll'),
  clear: () => ipcRenderer.invoke('job:clear'),
  list: (status, limit) => ipcRenderer.invoke('job:list', status || 'all', limit || 50),
  stats: () => ipcRenderer.invoke('job:stats'),
  get: (id) => ipcRenderer.invoke('job:get', id),
  failureStats: () => ipcRenderer.invoke('job:failureStats')  // 新增：获取失败统计
})

// ============ 导出 API ============
contextBridge.exposeInMainWorld('exportApi', {
  toCBZ: (opts) => ipcRenderer.invoke('export:toCBZ', opts),
  toEPUB: (opts) => ipcRenderer.invoke('export:toEPUB', opts),
  fromDownload: (opts) => ipcRenderer.invoke('export:fromDownload', opts),
  listDownloads: () => ipcRenderer.invoke('export:listDownloads'),
  getDownloadChapters: (title) => ipcRenderer.invoke('export:getDownloadChapters', title),
  checkEpubExists: (title) => ipcRenderer.invoke('export:checkEpubExists', title)
})

// ============ 工具函数 API ============
// 将本地文件路径转换为图片代理 URL（Vue 前端无法直接加载 file://）
// 与 main.js 中的 getLocalProxyUrl() 保持一致
const _PROXY_BASE = 'http://127.0.0.1:48123'
function _toLocalUrl(filePath) {
  if (!filePath) return ''
  const cleanPath = String(filePath).replace(/^file:\/\//, '')
  const encoded = Buffer.from(cleanPath).toString('base64')
  return `${_PROXY_BASE}/local?p=${encodeURIComponent(encoded)}`
}
// 将在线图片 URL 通过代理加载（解决防盗链）
function _toProxyUrl(imageUrl, referer) {
  if (!imageUrl) return ''
  const encodedUrl = Buffer.from(imageUrl).toString('base64')
  const encodedRef = Buffer.from(referer || imageUrl).toString('base64')
  return `${_PROXY_BASE}/img?u=${encodeURIComponent(encodedUrl)}&r=${encodeURIComponent(encodedRef)}`
}
// 从 Vue 响应式对象中提取纯数据（避免 IPC 结构化克隆失败）
function _toPlain(obj) {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(_toPlain)
  if (typeof obj === 'object') {
    const plain = {}
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'function') continue
      plain[k] = _toPlain(v)
    }
    return plain
  }
  return obj
}
contextBridge.exposeInMainWorld('utils', {
  toLocalUrl: _toLocalUrl,
  toProxyUrl: _toProxyUrl,
  toPlain: _toPlain
})

// ============ 旧兼容层（保持既有前端代码可用）============
contextBridge.exposeInMainWorld('crawlerApi', {
  detail: (url) => ipcRenderer.invoke('source:getDetail', url),
  list: (url) => ipcRenderer.invoke('source:search', url, 'smtt6'),
  raw: (url) => ipcRenderer.invoke('source:search', url),
  crawlAll: (startUrl) => ipcRenderer.invoke('crawl:all', startUrl),
  enrich: (force) => ipcRenderer.invoke('crawl:enrich', force || false),
  checkUpdates: () => ipcRenderer.invoke('crawl:checkUpdates'),
  onProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('crawl:progress', handler)
    return () => ipcRenderer.removeListener('crawl:progress', handler)
  },
  onDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('crawl:done', handler)
    return () => ipcRenderer.removeListener('crawl:done', handler)
  },
  onEnrichProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('enrich:progress', handler)
    return () => ipcRenderer.removeListener('enrich:progress', handler)
  },
  onEnrichDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('enrich:done', handler)
    return () => ipcRenderer.removeListener('enrich:done', handler)
  },
  onUpdateProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  onUpdateDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('update:done', handler)
    return () => ipcRenderer.removeListener('update:done', handler)
  },
  enrichChapterNames: () => ipcRenderer.invoke('crawl:enrichChapterNames'),
  onEnrichChapterNamesProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('enrichChapterNames:progress', handler)
    return () => ipcRenderer.removeListener('enrichChapterNames:progress', handler)
  },
  onEnrichChapterNamesDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('enrichChapterNames:done', handler)
    return () => ipcRenderer.removeListener('enrichChapterNames:done', handler)
  }
})

contextBridge.exposeInMainWorld('scanApi', {
  onProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('scan:progress', handler)
    return () => ipcRenderer.removeListener('scan:progress', handler)
  }
})

contextBridge.exposeInMainWorld('dbApi', {
  getComics: (page, pageSize, filters) => ipcRenderer.invoke('db:getComics', page, pageSize, filters),
  getComicById: (id) => ipcRenderer.invoke('db:getComicById', id),
  getComicByUrl: (url) => ipcRenderer.invoke('db:getComicByUrl', url),
  getFavoritedComics: () => ipcRenderer.invoke('db:getFavoritedComics'),
  clearComics: () => ipcRenderer.invoke('db:clearComics'),
  getComicsCount: () => ipcRenderer.invoke('db:getComicsCount'),
  getDbPath: () => ipcRenderer.invoke('db:getDbPath'),
  getChaptersCount: () => ipcRenderer.invoke('db:getChaptersCount'),
  getImagesCount: () => ipcRenderer.invoke('db:getImagesCount'),
  getDownloadSize: () => ipcRenderer.invoke('db:getDownloadSize'),
  getBooksReadCount: () => ipcRenderer.invoke('db:getBooksReadCount'),
  getChaptersReadCount: () => ipcRenderer.invoke('db:getChaptersReadCount'),
  getReadingStreak: () => ipcRenderer.invoke('db:getReadingStreak'),
  getTotalReadTime: () => ipcRenderer.invoke('db:getTotalReadTime'),
  updateComic: (id, changes) => ipcRenderer.invoke('db:updateComic', id, changes),
  getCategoryStats: () => ipcRenderer.invoke('db:getCategoryStats'),
  getAllCategories: () => ipcRenderer.invoke('db:getAllCategories'),
  searchComics: (q) => ipcRenderer.invoke('db:searchComics', q),
  setFavorite: (id, favorited) => ipcRenderer.invoke('db:setFavorite', id, favorited),
  clearUpdateDelta: (id) => ipcRenderer.invoke('db:clearUpdateDelta', id),
  autoScanLocalComics: (paths) => ipcRenderer.invoke('db:autoScanLocalComics', paths),
  // 导入本地漫画
  importLocalComics: (dir, onProgress) => ipcRenderer.invoke('db:importLocalComics', dir, onProgress)
})

contextBridge.exposeInMainWorld('dataApi', {
  getStats: () => ipcRenderer.invoke('data:getStats')
})

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (settings) => ipcRenderer.invoke('settings:save', settings)
})

contextBridge.exposeInMainWorld('batchApi', {
  delete: (ids) => ipcRenderer.invoke('batch:delete', ids),
  exportEPUB: (ids) => ipcRenderer.invoke('batch:exportEPUB', ids)
})

contextBridge.exposeInMainWorld('readerApi', {
  getChapterImages: (chapterUrl, referer) => ipcRenderer.invoke('source:getCachedPageList', chapterUrl, referer || '')
})

contextBridge.exposeInMainWorld('downloadApi', {
  comic: (comicData) => ipcRenderer.invoke('download:comic', comicData),
  onProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:progress', handler)
    return () => ipcRenderer.removeListener('download:progress', handler)
  }
})

// ============ 阅读进度 API ============
contextBridge.exposeInMainWorld('progressApi', {
  save: (data) => ipcRenderer.invoke('progress:save', data),
  get: (comicId) => ipcRenderer.invoke('progress:get', comicId),
  history: (limit) => ipcRenderer.invoke('progress:history', limit || 20),
  delete: (comicId) => ipcRenderer.invoke('progress:delete', comicId)
})

// ============ 详情页 API ============
contextBridge.exposeInMainWorld('detailApi', {
  getComicById: (id) => ipcRenderer.invoke('detail:getComicById', id),
  enrichComic: (sourceUrl) => ipcRenderer.invoke('detail:enrichComic', sourceUrl),
  autoEnrichAll: () => ipcRenderer.invoke('detail:autoEnrichAll'),
  // 防御：扫描章节名过于简单（占位符）的漫画
  scanGenericChapters: () => ipcRenderer.invoke('detail:scanGenericChapters'),
  // 防御：批量重新爬取详情页，修复章节名
  enrichAllGenericChapters: () => ipcRenderer.invoke('detail:enrichAllGenericChapters')
})

// ============ 全局搜索 API ============
contextBridge.exposeInMainWorld('searchApi', {
  global: (query, filters) => ipcRenderer.invoke('search:global', query, filters)
})

// ============ 缓存 API ============
contextBridge.exposeInMainWorld('cacheApi', {
  stats: () => ipcRenderer.invoke('cache:stats'),
  clear: () => ipcRenderer.invoke('cache:clear'),
  fixDiskNames: () => ipcRenderer.invoke('cache:fixDiskNames'),
  scanDiskNames: () => ipcRenderer.invoke('cache:scanDiskNames'),
  analyzeDiskNames: (limit) => ipcRenderer.invoke('cache:analyzeDiskNames', limit || 20)
})

// ============ 磁盘空间 API ============
contextBridge.exposeInMainWorld('diskApi', {
  getSpace: (path) => ipcRenderer.invoke('disk:getSpace', path)
})

// ============ 本地漫画导入 API ============
contextBridge.exposeInMainWorld('importApi', {
  scanComics: (dir) => ipcRenderer.invoke('import:scanComics', dir),
  commitComic: (data) => ipcRenderer.invoke('import:commitComic', data),
  matchSource: (title) => ipcRenderer.invoke('import:matchSource', title),
  pickDirectory: () => ipcRenderer.invoke('import:pickDirectory'),
  scanPrimaryDownload: () => ipcRenderer.invoke('import:scanPrimaryDownload'),
  registerExisting: (data) => ipcRenderer.invoke('import:registerExisting', data),
  checkExistingInDB: (titles) => ipcRenderer.invoke('import:checkExistingInDB', titles)
})

// ============ 离线下载 API ============
contextBridge.exposeInMainWorld('offlineApi', {
  queueChapter: (opts) => ipcRenderer.invoke('download:queueChapter', opts),
  queueAllChapters: (opts) => ipcRenderer.invoke('download:queueAllChapters', opts),
  getHighestDownloadedIndex: (opts) => ipcRenderer.invoke('download:getHighestDownloadedIndex', opts),
  getLocalChapterIndices: (opts) => ipcRenderer.invoke('download:getLocalChapterIndices', opts),
  listLocal: () => ipcRenderer.invoke('download:listLocal'),
  deleteLocal: (id) => ipcRenderer.invoke('download:deleteLocal', id),
  /** 获取已下载章节的本地图片路径列表，未下载返回 null */
  getLocalChapterImages: (comicId, chapterIndex, comicTitle) => ipcRenderer.invoke('download:getLocalChapterImages', comicId, chapterIndex, comicTitle),
  exportComic: (title, format) => ipcRenderer.invoke('export:fromDownload', { comicTitle: title, format }),
  // 下载暂停/恢复
  pauseJob: (jobId) => ipcRenderer.invoke('download:pauseJob', jobId),
  resumeJob: (jobId) => ipcRenderer.invoke('download:resumeJob', jobId),
  getJobStatus: (jobId) => ipcRenderer.invoke('download:getJobStatus', jobId),
  listQueue: (status) => ipcRenderer.invoke('download:listQueue', status),
  onJobProgress: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:jobProgress', handler)
    return () => ipcRenderer.removeListener('download:jobProgress', handler)
  },
  onJobDone: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('download:jobDone', handler)
    return () => ipcRenderer.removeListener('download:jobDone', handler)
  }
})

// ============ 后台任务状态 API ============
contextBridge.exposeInMainWorld('appApi', {
  getBackgroundTasks: () => ipcRenderer.invoke('app:backgroundTasks'),
  onBackgroundTasks: (cb) => {
    const handler = (_, data) => cb(data)
    ipcRenderer.on('app:backgroundTasks', handler)
    return () => ipcRenderer.removeListener('app:backgroundTasks', handler)
  }
})