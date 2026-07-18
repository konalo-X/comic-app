import { reactive, ref } from 'vue'

// ===== 全局持久化状态（模块级单例，路由切换不丢失）=====
export const state = reactive({
  crawling: false,
  enriching: false,
  checking: false,
  enrichingChapterNames: false,
  progress: 0,
  message: '',
  result: null
})

export const refreshCount = ref(0)

function notifyRefresh() {
  refreshCount.value++
}

// 防重入锁：防止自动任务链和用户手动操作同时触发
let _crawlLock = false
let _enrichLock = false
let _checkLock = false
let _enrichChaptersLock = false

// 记录当前正在处理的任务 ID，防止重复处理同一任务的完成事件
let _currentCrawlJobId = null
let _currentEnrichJobId = null
let _currentCheckJobId = null
let _currentEnrichChaptersJobId = null

// ===== IPC 监听器注册（用 window 级标志防止重复注册，避免 Vite HMR 问题）=====
function initListeners() {
  if (!window || !window.crawlerApi) {
    setTimeout(initListeners, 200)
    return
  }
  if (window.__crawlerListenersReady) {
    return
  }

  console.log('[crawler] registering IPC listeners')

  window.crawlerApi.onProgress((data) => {
    // 忽略不属于当前任务的历史进度消息
    if (_currentCrawlJobId && data.jobId && data.jobId !== _currentCrawlJobId) {
      return
    }
    if (!state.crawling) {
      state.crawling = true
      state.progress = 0
    }
    console.log('[crawler] onProgress:', data.page, data.msg)
    state.message = data.msg || state.message
    const page = data.page || data.current || 0
    state.progress = Math.min(99, Math.round((page / 126) * 100))
    notifyRefresh()
    // 每爬完一页主动刷新列表
    if (data.msg && data.msg.includes('完成')) {
      window.dispatchEvent(new CustomEvent('crawler:page-complete'))
    }
  })

  window.crawlerApi.onDone((data) => {
    // 防重：如果已经不在爬取状态，忽略这个事件（可能是重复事件或旧任务）
    if (!state.crawling) {
      console.log('[crawler] onDone ignored: not crawling')
      return
    }
    state.progress = 100
    state.message = `完成！共爬取 ${data?.pages || 0} 页，收录 ${data?.total || 0} 部漫画 → 正在补全标签...`
    state.result = data
    _currentCrawlJobId = null
    notifyRefresh()
    // 自动触发：爬取完成 → 补全标签
    setTimeout(() => {
      state.crawling = false
      startEnrich()
    }, 1500)
  })

  window.crawlerApi.onEnrichProgress((data) => {
    state.message = data.msg || state.message
    notifyRefresh()
  })

  window.crawlerApi.onEnrichDone((data) => {
    if (!state.enriching) {
      console.log('[crawler] onEnrichDone ignored: not enriching')
      return
    }
    state.progress = 100
    state.message = (data?.msg || `补全完成！共处理 ${data?.total || 0} 部`) + ' → 正在章节增强...'
    _currentEnrichJobId = null
    notifyRefresh()
    // 自动触发：补全完成 → 章节增强
    setTimeout(() => {
      state.enriching = false
      startEnrichChapters()
    }, 1500)
  })

  window.crawlerApi.onUpdateProgress((data) => {
    state.message = data.msg || state.message
    notifyRefresh()
  })

  window.crawlerApi.onUpdateDone((data) => {
    if (!state.checking) {
      console.log('[crawler] onUpdateDone ignored: not checking')
      return
    }
    state.progress = 100
    state.message = data?.msg || `检查完成！更新 ${data?.updated || 0} 部`
    _currentCheckJobId = null
    notifyRefresh()
    setTimeout(() => { state.checking = false }, 2500)
  })

  // 章节增强事件（详情页链接文本 → 内容页 h2 + 图片数补全）
  window.crawlerApi.onEnrichChaptersProgress((data) => {
    state.message = `正在章节增强 › ${data?.title || ''} (${data?.chapterIndex || 0}/${data?.totalChapters || 0})`
    notifyRefresh()
  })
  window.crawlerApi.onEnrichChaptersDone((data) => {
    if (!state.enrichingChapterNames) {
      console.log('[crawler] onEnrichChaptersDone ignored: not enriching chapters')
      return
    }
    state.message = `章节增强完成！共处理 ${data?.processed || 0} 部，升级 ${data?.totalImgUpdated || 0} 章 → 正在检查更新...`
    _currentEnrichChaptersJobId = null
    notifyRefresh()
    // 自动触发：章节增强完成 → 检查更新
    setTimeout(() => {
      state.enrichingChapterNames = false
      startCheckUpdates()
    }, 1500)
  })

  window.__crawlerListenersReady = true
  console.log('[crawler] all listeners ready')
}

// 模块加载时立即注册监听器
initListeners()

function waitForCrawlerApi() {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      if (window && window.crawlerApi) {
        resolve(true)
      } else if (attempts < 50) {
        attempts++
        setTimeout(check, 100)
      } else {
        resolve(false)
      }
    }
    check()
  })
}

export async function startCrawl() {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (_crawlLock || state.crawling) {
    console.log('[crawl] 已有爬取任务运行中，跳过')
    return
  }
  _crawlLock = true
  state.crawling = true
  state.progress = 0
  state.message = '正在连接...'
  state.result = null
  notifyRefresh()

  const BASE_URL = 'https://smtt6.com/man-hua-lei-bie/all/ob/time/st/all/page/1'
  try {
    const result = await window.crawlerApi.crawlAll(BASE_URL)
    if (result?.existing) {
      console.log('[crawl] 后端已有爬取作业运行中')
      state.message = '已有爬取任务运行中，正在同步进度...'
      // 不重置 crawling，让全局转发器推送进度
    }
    if (result?.jobId) {
      _currentCrawlJobId = result.jobId
    }
  } catch (e) {
    console.error('[crawl] error:', e)
    state.message = '爬取出错: ' + (e.message || String(e))
    state.crawling = false
    _currentCrawlJobId = null
    notifyRefresh()
  } finally {
    _crawlLock = false
  }
}

export async function startEnrich(force = false) {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (_enrichLock || state.enriching) {
    console.log('[enrich] 已有补全任务运行中，跳过')
    return
  }
  _enrichLock = true
  state.enriching = true
  state.progress = 0
  state.message = force ? '正在获取全部漫画（强制刷新）...' : '正在获取未打标签的漫画...'
  notifyRefresh()

  try {
    const result = await window.crawlerApi.enrich(force)
    if (result?.jobId) {
      _currentEnrichJobId = result.jobId
    }
  } catch (e) {
    console.error('[enrich] error:', e)
    state.message = (force ? '刷新' : '补全') + '出错: ' + (e.message || String(e))
    state.enriching = false
    _currentEnrichJobId = null
    notifyRefresh()
  } finally {
    _enrichLock = false
  }
}

export async function startCheckUpdates() {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (_checkLock || state.checking) {
    console.log('[checkUpdates] 已有检查更新任务运行中，跳过')
    return
  }
  _checkLock = true
  state.checking = true
  state.progress = 0
  state.message = '正在获取连载中的漫画...'
  notifyRefresh()

  try {
    const result = await window.crawlerApi.checkUpdates()
    if (result?.jobId) {
      _currentCheckJobId = result.jobId
    }
  } catch (e) {
    console.error('[checkUpdates] error:', e)
    state.message = '检查更新出错: ' + (e.message || String(e))
    state.checking = false
    _currentCheckJobId = null
    notifyRefresh()
  } finally {
    _checkLock = false
  }
}

export async function startEnrichChapters() {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (_enrichChaptersLock || state.enrichingChapterNames) {
    console.log('[enrichChapters] 已有章节增强任务运行中，跳过')
    return
  }
  _enrichChaptersLock = true
  state.enrichingChapterNames = true
  state.message = '准备章节增强...'
  notifyRefresh()

  try {
    const result = await window.crawlerApi.enrichChapters()
    if (result?.jobId) {
      _currentEnrichChaptersJobId = result.jobId
    }
  } catch (e) {
    console.error('[enrichChapters] error:', e)
    state.message = '章节增强出错: ' + (e.message || String(e))
    state.enrichingChapterNames = false
    _currentEnrichChaptersJobId = null
    notifyRefresh()
  } finally {
    _enrichChaptersLock = false
  }
}

// 兼容旧接口
export function useCrawler() {
  return {
    state,
    refreshCount,
    startCrawl,
    startEnrich,
    startCheckUpdates
  }
}