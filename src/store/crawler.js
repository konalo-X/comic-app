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
    state.progress = 100
    state.message = `完成！共爬取 ${data?.pages || 0} 页，收录 ${data?.total || 0} 部漫画 → 正在补全标签...`
    state.result = data
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
    state.progress = 100
    state.message = (data?.msg || `补全完成！共处理 ${data?.total || 0} 部`) + ' → 正在章节增强...'
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
    state.progress = 100
    state.message = data?.msg || `检查完成！更新 ${data?.updated || 0} 部`
    notifyRefresh()
    setTimeout(() => { state.checking = false }, 2500)
  })

  // 章节增强事件（详情页链接文本 → 内容页 h2 + 图片数补全）
  window.crawlerApi.onEnrichChaptersProgress((data) => {
    state.message = `正在章节增强 › ${data?.title || ''} (${data?.chapterIndex || 0}/${data?.totalChapters || 0})`
    notifyRefresh()
  })
  window.crawlerApi.onEnrichChaptersDone((data) => {
    state.message = `章节增强完成！共处理 ${data?.processed || 0} 部，升级 ${data?.totalImgUpdated || 0} 章 → 正在检查更新...`
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
  if (state.crawling) {
    console.log('[crawl] 已有爬取任务运行中，跳过')
    return
  }
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
  } catch (e) {
    console.error('[crawl] error:', e)
    state.message = '爬取出错: ' + (e.message || String(e))
    state.crawling = false
    notifyRefresh()
  }
}

export async function startEnrich(force = false) {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  state.enriching = true
  state.progress = 0
  state.message = force ? '正在获取全部漫画（强制刷新）...' : '正在获取未打标签的漫画...'
  notifyRefresh()

  try {
    await window.crawlerApi.enrich(force)
  } catch (e) {
    console.error('[enrich] error:', e)
    state.message = (force ? '刷新' : '补全') + '出错: ' + (e.message || String(e))
    state.enriching = false
    notifyRefresh()
  }
}

export async function startCheckUpdates() {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (state.checking) {
    console.log('[checkUpdates] 已有检查更新任务运行中，跳过')
    return
  }
  state.checking = true
  state.progress = 0
  state.message = '正在获取连载中的漫画...'
  notifyRefresh()

  try {
    await window.crawlerApi.checkUpdates()
  } catch (e) {
    console.error('[checkUpdates] error:', e)
    state.message = '检查更新出错: ' + (e.message || String(e))
    state.checking = false
    notifyRefresh()
  }
}

export async function startEnrichChapters() {
  if (!window.crawlerApi) {
    const ok = await waitForCrawlerApi()
    if (!ok) { alert('爬取功能尚未就绪'); return }
  }
  if (state.enrichingChapterNames) return
  state.enrichingChapterNames = true
  state.message = '准备章节增强...'
  notifyRefresh()

  try {
    await window.crawlerApi.enrichChapters()
  } catch (e) {
    console.error('[enrichChapters] error:', e)
    state.message = '章节增强出错: ' + (e.message || String(e))
    state.enrichingChapterNames = false
    notifyRefresh()
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