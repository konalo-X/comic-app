import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useCrawlerStore = defineStore('crawler', () => {
  const crawling = ref(false)
  const enriching = ref(false)
  const checking = ref(false)
  const enrichingChapterNames = ref(false)
  const progress = ref(0)
  const message = ref('')
  const result = ref(null)

  async function startCrawl() {
    if (!window.crawlerApi) {
      const ok = await waitForCrawlerApi()
      if (!ok) { alert('爬取功能尚未就绪'); return }
    }
    crawling.value = true
    progress.value = 0
    message.value = '正在连接...'
    result.value = null

    const BASE_URL = 'https://smtt6.com/man-hua-lei-bie/all/ob/time/st/all/page/1'
    try {
      await window.crawlerApi.crawlAll(BASE_URL)
    } catch (e) {
      console.error('[crawl] error:', e)
      message.value = '爬取出错: ' + (e.message || String(e))
      crawling.value = false
    }
  }

  async function startEnrich(force = false) {
    if (!window.crawlerApi) {
      const ok = await waitForCrawlerApi()
      if (!ok) { alert('爬取功能尚未就绪'); return }
    }
    enriching.value = true
    progress.value = 0
    message.value = force ? '正在获取全部漫画（强制刷新）...' : '正在获取未打标签的漫画...'

    try {
      await window.crawlerApi.enrich(force)
    } catch (e) {
      console.error('[enrich] error:', e)
      message.value = (force ? '刷新' : '补全') + '出错: ' + (e.message || String(e))
      enriching.value = false
    }
  }

  async function startCheckUpdates() {
    if (!window.crawlerApi) {
      const ok = await waitForCrawlerApi()
      if (!ok) { alert('爬取功能尚未就绪'); return }
    }
    checking.value = true
    progress.value = 0
    message.value = '正在获取连载中的漫画...'

    try {
      await window.crawlerApi.checkUpdates()
    } catch (e) {
      console.error('[checkUpdates] error:', e)
      message.value = '检查更新出错: ' + (e.message || String(e))
      checking.value = false
    }
  }

  async function startEnrichChapterNames() {
    if (!window.crawlerApi) {
      const ok = await waitForCrawlerApi()
      if (!ok) { alert('爬取功能尚未就绪'); return }
    }
    if (enrichingChapterNames.value) return
    enrichingChapterNames.value = true
    message.value = '准备升级章节名...'

    try {
      await window.crawlerApi.enrichChapterNames()
    } catch (e) {
      console.error('[enrichChapterNames] error:', e)
      message.value = '升级章节名出错: ' + (e.message || String(e))
      enrichingChapterNames.value = false
    }
  }

  function setProgress(value) {
    progress.value = value
  }

  function setMessage(msg) {
    message.value = msg
  }

  function setResult(data) {
    result.value = data
  }

  function setCrawling(value) {
    crawling.value = value
  }

  function setEnriching(value) {
    enriching.value = value
  }

  function setChecking(value) {
    checking.value = value
  }

  function setEnrichingChapterNames(value) {
    enrichingChapterNames.value = value
  }

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

  return {
    crawling,
    enriching,
    checking,
    enrichingChapterNames,
    progress,
    message,
    result,
    startCrawl,
    startEnrich,
    startCheckUpdates,
    startEnrichChapterNames,
    setProgress,
    setMessage,
    setResult,
    setCrawling,
    setEnriching,
    setChecking,
    setEnrichingChapterNames
  }
})