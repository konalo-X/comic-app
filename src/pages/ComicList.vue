<template>
  <div class="catalog-page">
    <FilterBar 
      :active-category="activeCategory" 
      :active-source="activeSource"
      :active-status="activeStatus"
      :categories="categories"
      @update:active-category="onCategoryChange"
      @update:active-source="onSourceChange"
      @update:active-status="onStatusChange"
    />

    <div class="list-head">
      <div class="head-tabs">
        <a :class="['head-tab', { active: activeSort === 'time' }]" href="javascript:;" @click="activeSort = 'time'">按时间</a>
        <a :class="['head-tab', { active: activeSort === 'hits' }]" href="javascript:;" @click="activeSort = 'hits'">按阅读</a>
      </div>
      <div class="head-actions">
        <button class="text-btn" :disabled="crawlState.crawling || crawlState.enriching || crawlState.checking" @click="clearAll">清空</button>
        <button class="text-btn text-btn-primary" :disabled="crawlState.crawling || crawlState.enriching || crawlState.checking || crawlState.enrichingChapterNames" @click="startCrawl">
          {{ buttonText }}
        </button>
        <button class="text-btn text-btn-success" :disabled="crawlState.crawling || crawlState.enriching || crawlState.checking || crawlState.enrichingChapterNames" @click="startCheckUpdates">
          {{ crawlState.checking ? '检查中...' : '检查更新' }}
        </button>
        <button v-if="!batchMode" class="text-btn" @click="toggleBatchMode">多选</button>
        <button v-else class="text-btn text-btn-warning" @click="toggleBatchMode">取消多选</button>
      </div>
      <div class="head-page-info">
        <span class="page-total">{{ page }} / {{ totalPages }} 页</span>
      </div>
      <span class="head-count">共<em>{{ totalComics }}</em>个结果</span>
      <span v-if="categoryStatsText" class="head-count stats-text">{{ categoryStatsText }}</span>
    </div>

    <div v-if="crawlState.crawling || crawlState.enriching || crawlState.checking" class="crawl-status card" :class="{ 'is-checking': crawlState.checking }">
      <div class="progress-bar" :class="{ 'is-checking': crawlState.checking }">
        <div class="fill" :style="{ width: crawlState.progress + '%' }"></div>
      </div>
      <span class="crawl-text">{{ crawlState.message }}</span>
    </div>

    <div v-if="comics.length === 0 && !crawlState.crawling && !crawlState.enriching && !crawlState.checking" class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
      </div>
      <div class="empty-title">暂无漫画数据</div>
      <div class="empty-sub">点击「爬取漫画」从 smtt6.com 获取最新漫画列表</div>
      <div class="empty-actions">
        <button class="btn btn-primary" @click="startCrawl">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>
          开始爬取
        </button>
        <button class="btn btn-secondary" @click="goToSettings">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          导入本地漫画
        </button>
      </div>
    </div>

    <div v-if="loadError" class="load-error card">
      <span class="load-error-text">加载失败，请重试</span>
      <button class="btn btn-sm btn-primary" @click="loadPage(page)">重新加载</button>
    </div>

    <div v-if="comics.length > 0 || !initialLoaded" class="comic-grid">
      <template v-if="!initialLoaded">
        <ComicCard v-for="i in 12" :key="'skel-' + i" :skeleton="true" />
      </template>
      <ComicCard 
        v-for="c in pagedComics" 
        :key="c._id || c.sourceUrl"
        :comic="c"
        :selected="batchMode && selectedIds.has(c._id || c.sourceUrl)"
        :show-checkbox="batchMode"
        :progress="(progressMap[c._id || c.sourceUrl]?.pct || 0) * 100"
        @click="goToDetail(c)"
        @toggle-select="toggleSelect(null, c._id || c.sourceUrl)"
        @download="downloadComic(c)"
      />
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <a v-if="page > 1" class="page-btn" href="javascript:;" @click="loadPage(page - 1)">
        <span class="prev-icon">◂</span><span class="prev-text">上一页</span>
      </a>
      <a
v-for="p in visiblePages" :key="p"
        :class="['page-num', { active: p === page }]"
        href="javascript:;" @click="loadPage(p)">{{ p }}</a>
      <a v-if="page < totalPages" class="page-btn" href="javascript:;" @click="loadPage(page + 1)">
        <span class="next-text">下一页</span><span class="next-icon">▸</span>
      </a>
      <a v-if="totalPages > 8" class="page-btn" href="javascript:;" @click="loadPage(totalPages)">
        <span class="last-icon">▸▸</span>
      </a>
    </div>

    <div v-if="batchMode && selectedIds.size > 0" class="batch-bar">
      <span class="batch-info">已选 <strong>{{ selectedIds.size }}</strong> 部</span>
      <button class="text-btn" :disabled="batchProcessing" @click="selectAll">全选</button>
      <button class="text-btn" :disabled="batchProcessing" @click="deselectAll">取消</button>
      <span class="batch-spacer"></span>
      <button class="text-btn text-btn-success" :disabled="batchProcessing" @click="batchDownload">
        {{ batchProcessing ? '处理中...' : '批量下载' }}
      </button>
      <button class="text-btn text-btn-danger" :disabled="batchProcessing" @click="batchDelete">
        {{ batchProcessing ? '处理中...' : '删除' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, inject, watch, onMounted, onUnmounted, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { state as crawlState, refreshCount, startCrawl, startCheckUpdates } from '../store/crawler.js'
import ComicCard from '../components/ComicCard.vue'
import FilterBar from '../components/FilterBar.vue'

const router = useRouter()
const route = useRoute()

const globalSearch = inject('globalSearch', ref(''))
const searchTrigger = inject('searchTrigger', ref(0))
const searchKeyword = ref('')

const activeCategory = ref('all')
const activeSource = ref('all')
const activeSort = ref('time')
const activeStatus = ref('all')
const page = ref(1)
const pageSize = ref(24)
const comics = ref([])
const totalComics = ref(0)
const totalPages = ref(1)
const categoryStatsText = ref('')
const loadError = ref(false)

// ===== 批量选择 =====
const batchMode = ref(false)
const selectedIds = ref(new Set())
const batchProcessing = ref(false)

function toggleBatchMode() {
  batchMode.value = !batchMode.value
  if (!batchMode.value) selectedIds.value = new Set()
}
function toggleSelect(e, id) {
  if (e) e.stopPropagation()
  const s = selectedIds.value
  if (s.has(id)) s.delete(id); else s.add(id)
  selectedIds.value = new Set(s)
}
function onCategoryChange(val) {
  activeCategory.value = val
  page.value = 1
  loadPage(1)
}
function onStatusChange(val) {
  activeStatus.value = val
  page.value = 1
  loadPage(1)
}
function onSourceChange(val) {
  activeSource.value = val
  page.value = 1
  loadPage(1)
}
watch(activeSort, () => {
  page.value = 1
  loadPage(1)
})
function selectAll() {
  selectedIds.value = new Set(pagedComics.value.map(c => c._id || c.sourceUrl))
}
function deselectAll() {
  selectedIds.value = new Set()
}
async function batchDelete() {
  if (selectedIds.value.size === 0) return
  const ids = [...selectedIds.value]
  const ok = confirm(`确定删除选中的 ${ids.length} 部漫画？`)
  if (!ok) return
  batchProcessing.value = true
  try {
    await window.batchApi?.delete(ids)
    selectedIds.value = new Set()
    loadPage(page.value)
  } catch (e) { console.error('batch delete error:', e) }
  finally { batchProcessing.value = false }
}

// 批量操作工具函数：并行处理
async function batchProcess(items, processor, concurrency = 5) {
  const results = { success: 0, failed: 0, errors: [] }
  const queue = [...items]
  
  async function processOne() {
    while (queue.length > 0) {
      const item = queue.shift()
      try {
        await processor(item)
        results.success++
      } catch (e) {
        results.failed++
        results.errors.push({ item, error: e.message })
      }
    }
  }
  
  // 启动多个并发 worker
  const workers = Array(Math.min(concurrency, items.length)).fill().map(() => processOne())
  await Promise.all(workers)
  
  return results
}

async function batchDownload() {
  if (selectedIds.value.size === 0) return
  const ids = [...selectedIds.value]
  const ok = confirm(`确定下载选中的 ${ids.length} 部漫画？`)
  if (!ok) return
  batchProcessing.value = true
  try {
    // 并行下载，最多 3 个并发
    const results = await batchProcess(ids, async (id) => {
      const comic = comics.value.find(c => (c._id || c.sourceUrl) === id)
      if (comic && comic.chapters && comic.chapters.length > 0) {
        const chapters = comic.chapters.map(ch => ({
          name: ch.name,
          url: ch.url
        }))
        const comicData = {
          title: comic.title,
          cover: comic.cover || '',
          chapters: chapters,
          referer: comic.sourceUrl || ''
        }
        await window.downloadApi?.comic?.(comicData)
      } else {
        throw new Error('无章节数据')
      }
    }, 3)
    
    showToast(`✅ 下载完成：成功 ${results.success} 部，失败 ${results.failed} 部`)
    selectedIds.value = new Set()
  } catch (e) { 
    console.error('batch download error:', e)
    showToast(`❌ 下载出错: ${e.message}`)
  }
  finally { batchProcessing.value = false }
}

// Toast 提示
function showToast(message) {
  // 创建 toast 元素
  const toast = document.createElement('div')
  toast.textContent = message
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-card, #fff);
    color: var(--text, #333);
    padding: 12px 24px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    font-size: 14px;
    font-weight: 500;
    z-index: 9999;
    animation: toastIn 0.3s ease;
    border: 1px solid var(--border-light, #eee);
  `
  document.body.appendChild(toast)
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards'
    setTimeout(() => toast.remove(), 300)
  }, 3000)
}
const progressMap = reactive({})
const initialLoaded = ref(false)

const categories = [
  { label: '全部', value: 'all' },
  { label: '日漫', value: '日漫' },
  { label: '韩漫', value: '韩漫' },
  { label: '真人', value: '真人' },
  { label: '3D漫画', value: '3D漫画' },
  { label: '同性', value: '同性' }
]

function goToDetail(comic) {
  const id = comic._id || comic.sourceUrl
  window.__recordHistory?.(comic)
  router.push({ name: 'comicDetail', params: { id } })
}

function goToSettings() {
  router.push({ name: 'settings' })
}

const pagedComics = computed(() => comics.value)

const buttonText = computed(() => {
  if (crawlState.crawling) return '爬取中...'
  if (crawlState.enriching) return '补全标签中...'
  if (crawlState.checking) return '检查更新中...'
  if (crawlState.enrichingChapterNames) return '升级章节名中...'
  return '爬取漫画'
})

const visiblePages = computed(() => {
  const tp = totalPages.value
  if (tp <= 8) return Array.from({ length: tp }, (_, i) => i + 1)
  const p = page.value
  if (p <= 4) return [1, 2, 3, 4, 5, 6, 7, 8]
  if (p >= tp - 3) return Array.from({ length: 8 }, (_, i) => tp - 7 + i)
  return Array.from({ length: 8 }, (_, i) => p - 3 + i)
})

let progressRefreshTimer = null
let progressRefreshActive = false

function startProgressPolling() {
  if (progressRefreshActive) return
  progressRefreshActive = true
  const poll = async () => {
    if (!progressRefreshActive) return
    await loadProgressMap()
    if (progressRefreshActive) {
      progressRefreshTimer = setTimeout(poll, 5000)
    }
  }
  poll()
}

function stopProgressPolling() {
  progressRefreshActive = false
  if (progressRefreshTimer) {
    clearTimeout(progressRefreshTimer)
    progressRefreshTimer = null
  }
}

function onVisibilityChange() {
  if (document.hidden) {
    stopProgressPolling()
  } else {
    startProgressPolling()
  }
}

// 加载所有阅读进度
async function loadProgressMap() {
  if (!window.progressApi) return
  try {
    const history = await window.progressApi.history(200)
    const map = {}
    for (const item of history) {
      if (item?.progress?.comicId) {
        map[item.progress.comicId] = item.progress
      }
    }
    Object.assign(progressMap, map)
  } catch {}
}

let searchTimer = null
watch(globalSearch, (val) => {
  // 防抖 300ms
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchKeyword.value = val.trim()
    page.value = 1
    loadPage(1)
  }, 300)
})

// 按回车立即搜索
watch(searchTrigger, () => {
  clearTimeout(searchTimer)
  searchKeyword.value = globalSearch.value.trim()
  page.value = 1
  loadPage(1)
})

async function loadPage(p) {
  page.value = p
  loadError.value = false
  if (!window.dbApi) {
    console.warn('dbApi not available')
    loadError.value = true
    return
  }
  try {
    const filters = {
      category: activeCategory.value,
      status: activeStatus.value,
      search: searchKeyword.value || undefined,
      sort: activeSort.value
    }
    if (activeSource.value === 'local') {
      filters.localOnly = true
    } else if (activeSource.value === 'online') {
      filters.onlineOnly = true
    }
    console.log('[Filter] 加载页面，筛选条件:', filters)
    const result = await window.dbApi.getComics(p, pageSize.value, filters)
    let docs = result.docs

    totalComics.value = result.total
    totalPages.value = Math.max(1, Math.ceil(result.total / pageSize.value))

    comics.value = docs
    console.log(`[Filter] 结果: ${docs.length} 条（当前页）, 总计: ${totalComics.value} 部`)
    initialLoaded.value = true
  } catch (e) {
    console.error('加载漫画失败:', e)
    loadError.value = true
  }
}

async function loadCategoryStats() {
  if (!window.dbApi || !window.dbApi.getCategoryStats) return
  try {
    const stats = await window.dbApi.getCategoryStats()
    console.log('[Stats] 分类统计:', stats)
    if (stats && stats.stats) {
      const parts = Object.entries(stats.stats).map(([k, v]) => `${k}:${v}`)
      categoryStatsText.value = `数据库: ${parts.join(' ')} | 未分类:${stats.untagged}`
    }
  } catch (e) {
    console.error('加载分类统计失败:', e)
  }
}

async function clearAll() {
  if (!window.dbApi) return
  if (!confirm('确定要清空所有漫画数据吗？此操作不可恢复！')) return
  await window.dbApi.clearComics()
  comics.value = []
  totalComics.value = 0
  totalPages.value = 1
  page.value = 1
}

// 下载单个漫画
async function downloadComic(comic) {
  if (!comic || !comic.chapters || comic.chapters.length === 0) {
    alert('该漫画暂无章节可下载')
    return
  }
  if (!window.downloadApi) {
    alert('下载功能未初始化，请重启应用后重试')
    return
  }
  
  const chapters = comic.chapters.map(ch => ({
    name: ch.name,
    url: ch.url
  }))
  
  const comicData = {
    title: comic.title,
    cover: comic.cover || '',
    chapters: chapters,
    referer: comic.sourceUrl || ''
  }
  
  try {
    const result = await window.downloadApi.comic(comicData)
    if (result.success) {
      alert(`下载完成！\n保存路径: ${result.path}\n成功: ${result.successImages} 张图片\n失败: ${result.failedChapters} 章`)
      // 刷新列表
      loadPage(page.value)
    } else {
      alert(`下载失败: ${result.error}`)
    }
  } catch (e) {
    console.error('下载异常:', e)
    alert('下载失败: ' + (e.message || '未知错误'))
  }
}

// 监听爬取进度，每爬完一页自动刷新列表
watch(refreshCount, (newVal, oldVal) => {
  console.log('[ComicList] refreshCount changed:', oldVal, '→', newVal, ', reloading list')
  loadPage(1)
  loadCategoryStats()
})

// 双重保障：也监听 window 事件
const onPageComplete = () => {
  console.log('[ComicList] received crawler:page-complete event, reloading list')
  loadPage(1)
  loadCategoryStats()
}
window.addEventListener('crawler:page-complete', onPageComplete)

// 监听下载进度事件
function onDownloadProgress(e) {
  const { comicId, progress, status } = e.detail || {}
  if (comicId && progressMap[comicId]) {
    progressMap[comicId].pct = progress
    progressMap[comicId].status = status
  }
}
window.addEventListener('download:progress', onDownloadProgress)

onMounted(async () => {
  const catFromUrl = route.query.category
  if (catFromUrl && catFromUrl !== 'all') {
    activeCategory.value = catFromUrl
  }
  await loadPage(1)
  await loadCategoryStats()
  startProgressPolling()
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  stopProgressPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('crawler:page-complete', onPageComplete)
  window.removeEventListener('download:progress', onDownloadProgress)
})
</script>

<style scoped>
.catalog-page { display: flex; flex-direction: column; gap: 0; }

 .list-head {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 20px;
  padding: 16px;
  flex-wrap: wrap;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.head-tabs { display: flex; gap: 6px; }
.head-tab {
  padding: 8px 18px; font-size: 13px; font-weight: 600;
  color: var(--text-sub); border-radius: var(--radius);
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  text-decoration: none;
  background: transparent;
}
.head-tab.active { color: var(--brand); text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
.head-tab:hover:not(.active) { color: var(--brand); }
.head-actions { display: flex; gap: 10px; margin-left: auto; flex-wrap: wrap; }
.head-page-info { font-size: 12px; color: var(--text-dim); margin-left: auto; }
.head-count { font-size: 12px; color: var(--text-dim); }
.head-count em { color: var(--brand); font-style: normal; font-weight: 600; }
.head-count.stats-text { margin-left: 8px; font-size: 11px; color: var(--text-sub); background: var(--bg-hover); padding: 4px 10px; border-radius: var(--radius-sm); }

/* 加载错误提示 */
.load-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  margin-bottom: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.load-error-text {
  font-size: 13px;
  color: var(--error);
}

/* URL输入区域 */
.url-input-section {
  margin-bottom: 16px;
  padding: 16px 20px;
}
.url-input-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.url-input-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.url-input-hint {
  font-size: 12px;
  color: var(--text-sub);
}
.url-input-form {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.url-input-box {
  flex: 1;
  padding: 10px 14px;
  font-size: 13px;
  background: var(--input-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  transition: all .15s;
  font-family: inherit;
}
.url-input-box:focus {
  border-color: var(--brand);
}
.url-input-box::placeholder {
  color: var(--text-sub-2);
}

.text-btn-info {
  color: var(--brand);
  background: transparent;
  border: 1px solid var(--brand);
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all .15s;
}
.text-btn-info:hover:not(:disabled) {
  background: var(--brand);
  color: #fff;
}
.text-btn-info:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 爬虫进度条条纹动画 */
.crawl-status {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 18px; margin-bottom: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}
.crawl-status .progress-bar {
  flex: 1; height: 8px;
  position: relative;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-hover);
}
.crawl-status .progress-bar .fill {
  height: 100%;
  background: var(--gradient-brand);
  background-size: 20px 20px;
  animation: progressStripes 1s linear infinite;
}
.crawl-status.is-checking .progress-bar .fill {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  background-size: 20px 20px;
  animation: progressStripes 1s linear infinite;
}
.crawl-text { font-size: 12px; color: var(--text-sub); white-space: nowrap; }

@keyframes progressStripes {
  from { background-position: 20px 0; }
  to   { background-position: 0 0; }
}

/* 空状态优化 - 番茄小说风格 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 100px 20px;
  text-align: center;
  animation: fadeInUp 0.5s ease;
  background: var(--content-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
}
.empty-icon {
  width: 80px;
  height: 80px;
  margin-bottom: 24px;
  border-radius: 22px;
  background: linear-gradient(135deg, rgba(255,237,225,0.95), rgba(255,154,120,0.28));
  display: flex;
  align-items: center;
  justify-content: center;
  animation: pulse-soft 2s ease-in-out infinite;
}
.empty-icon svg {
  width: 36px;
  height: 36px;
  stroke: var(--brand);
}
.empty-title { 
  font-size: 16px; 
  font-weight: 600; 
  color: var(--text); 
  margin-bottom: 8px;
}
.empty-sub { 
  font-size: 13px; 
  color: var(--text-sub);
  max-width: 300px;
  line-height: 1.6;
  margin-bottom: 24px;
}

.empty-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

.empty-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  border: 1px solid var(--glass-border);
  background: var(--content-bg);
  box-shadow: var(--shadow-sm);
}

.empty-actions .btn-primary {
  background: var(--gradient-brand);
  color: white;
}

.empty-actions .btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
}

.empty-actions .btn-secondary {
  background: var(--bg-hover);
  color: var(--text);
  border: 1px solid var(--border-color);
}

.empty-actions .btn-secondary:hover {
  background: var(--bg-active);
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes pulse-soft {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.comic-grid {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  gap: 12px;
}

@media (max-width: 1600px) { .comic-grid { grid-template-columns: repeat(8, 1fr); } }
@media (max-width: 1400px) { .comic-grid { grid-template-columns: repeat(7, 1fr); } }
@media (max-width: 1200px) { .comic-grid { grid-template-columns: repeat(6, 1fr); } }
@media (max-width: 1000px) { .comic-grid { grid-template-columns: repeat(5, 1fr); } }
@media (max-width: 800px) { .comic-grid { grid-template-columns: repeat(4, 1fr); } }

.pagination {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  padding: 24px 0 8px;
}
.page-btn {
  padding: 10px 16px; font-size: 14px; color: var(--text-sub);
  border-radius: var(--radius); text-decoration: none; transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex; align-items: center; gap: 4px;
  min-height: 44px;
  min-width: 44px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.page-btn:hover { background: var(--bg-hover); color: var(--text); }
@media (hover: none) and (pointer: coarse) {
  .page-btn:active {
    transform: scale(0.95);
    background: var(--bg-hover);
  }
}
.page-num {
  width: 44px; height: 44px; border-radius: var(--radius);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: var(--text-sub); text-decoration: none;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.page-num:hover { background: var(--bg-hover); color: var(--text); }
.page-num.active { background: var(--gradient-brand); color: #fff; font-weight: 600; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3); }
@media (hover: none) and (pointer: coarse) {
  .page-num:active {
    transform: scale(0.95);
    background: var(--bg-hover);
  }
  .page-num.active:active {
    background: var(--brand);
  }
}
.prev-text, .next-text { font-size: 12px; }
@media (max-width: 768px) { .prev-text, .next-text, .last-icon { display: none; } }

/* ===== 批量选择 ===== */
.batch-checkbox {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 5;
  background: rgba(0,0,0,0.45);
  backdrop-filter: blur(4px);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  cursor: pointer;
  transition: all .2s;
}
.batch-checkbox:hover {
  background: rgba(0,0,0,0.6);
}
.batch-checkbox.checked {
  background: rgba(99, 102, 241, 0.9);
}
.batch-selected {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--brand);
  border-radius: var(--radius-lg);
  margin-top: 10px;
  box-shadow: var(--shadow-sm);
}
.batch-info {
  font-size: 13px;
  color: var(--text);
}
.batch-spacer {
  flex: 1;
}

/* 纯文字按钮 - 手机APP风格 */
.text-btn {
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-sub);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  border-radius: var(--radius-sm);
}
.text-btn:hover {
  color: var(--brand);
  background: var(--brand-bg);
}
.text-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.text-btn-primary {
  color: var(--brand);
  font-weight: 600;
}
.text-btn-success {
  color: var(--success);
}
.text-btn-success:hover {
  background: var(--success-bg);
}
.text-btn-warning {
  color: var(--warning);
}
.text-btn-warning:hover {
  background: var(--warning-bg);
}
.text-btn-danger {
  color: var(--error);
}
.text-btn-danger:hover {
  background: var(--error-bg);
}
</style>