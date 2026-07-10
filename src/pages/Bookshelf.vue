<template>
  <div class="bookshelf-page">
    <div class="page-header">
      <h2 class="page-title">漫画书架</h2>
      <span class="page-sub">本地漫画与阅读记录</span>
      <div class="page-search">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input v-model="localSearch" :placeholder="activeTab === 'local' ? '搜索本地漫画...' : '搜索历史...'" @keydown.enter="searchNow" />
      </div>
    </div>

    <div class="tabs">
      <div
        :class="['tab', { active: activeTab === 'local' }]"
        @click="activeTab = 'local'"
      >
        <span class="tab-text">本地漫画</span>
        <span v-if="localComics.length > 0" class="tab-badge">{{ localComics.length }}</span>
      </div>
      <div
        :class="['tab', { active: activeTab === 'history' }]"
        @click="activeTab = 'history'"
      >
        <span class="tab-text">阅读历史</span>
        <span v-if="historyList.length > 0" class="tab-badge">{{ historyList.length }}</span>
      </div>
    </div>

    <div v-show="activeTab === 'local'" class="tab-content">
      <div v-if="filteredLocal.length > 0" class="comic-grid">
        <ComicCard
          v-for="c in filteredLocal"
          :key="c._id || c.sourceUrl"
          :comic="c"
          @click="goToDetail(c)"
        />
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </div>
        <div class="empty-title">{{ localSearch ? '未找到匹配的本地漫画' : '书库中没有本地漫画' }}</div>
        <div class="empty-sub">在设置中扫描本地目录，或在漫画列表中下载漫画到本地</div>
      </div>
    </div>

    <div v-show="activeTab === 'history'" class="tab-content">
      <div v-if="historyList.length > 0">
        <div class="stats-bar">
          <div class="stat-item">
            <div class="stat-value">{{ streak }}</div>
            <div class="stat-label">连续阅读天数</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">{{ totalComics }}</div>
            <div class="stat-label">阅读漫画数</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">{{ historyList.length }}</div>
            <div class="stat-label">阅读章节数</div>
          </div>
        </div>

        <div class="timeline-container">
          <div v-for="group in groupedHistory" :key="group.label" class="timeline-group">
            <div class="timeline-date-label">{{ group.label }}</div>
            <div class="comic-grid timeline-grid">
              <div
                v-for="item in group.items"
                :key="item.comicId + '-' + item.lastRead"
                class="history-card"
                @click="goToReader(item)"
              >
                <div class="hc-cover">
                  <img v-if="item.cover" :src="resolveCover(item.cover)" :alt="item.title" referrerpolicy="no-referrer" @error="onImgError" />
                  <div v-else class="hc-placeholder" :style="{ background: gradient(item.title) }">
                    {{ (item.title || '?')[0] }}
                  </div>
                  <div v-if="item.progress > 0" class="hc-progress-badge">{{ item.progress }}%</div>
                </div>
                <div class="hc-info">
                  <div class="hc-title" :title="item.title">{{ item.title }}</div>
                  <div class="hc-meta">
                    <span>第 {{ (item.chapterIndex ?? 0) + 1 }} 章</span>
                    <span class="hc-dot">·</span>
                    <span>{{ formatReadTime(item.lastRead) }}</span>
                  </div>
                  <div v-if="item.progress > 0" class="hc-bar">
                    <div class="hc-bar-fill" :style="{ width: item.progress + '%' }"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
        </div>
        <div class="empty-title">{{ localSearch ? '未找到匹配的历史' : '还没有阅读记录' }}</div>
        <div class="empty-sub">打开一本漫画开始阅读吧</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, inject, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import ComicCard from '../components/ComicCard.vue'

const router = useRouter()

// 将封面路径转换为可加载的 URL（本地文件需通过代理）
function resolveCover(cover) {
  if (!cover) return ''
  const src = String(cover)
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return window.utils ? window.utils.toLocalUrl(src) : src
}
const globalSearch = inject('globalSearch', ref(''))
const searchTrigger = inject('searchTrigger', ref(0))
const localSearch = ref('')
const activeTab = ref('local')
const localComics = ref([])
const historyList = ref([])

// ------ 本地漫画 ------
async function loadLocalComics() {
  try {
    if (window.dbApi?.getComics) {
      const result = await window.dbApi.getComics(1, 50000, { localOnly: true })
      localComics.value = result.docs || []
      console.log(`[Bookshelf] 加载本地漫画: ${localComics.value.length} 本`)
      return
    }
    console.warn('[Bookshelf] dbApi.getComics 不可用')
  } catch (e) {
    console.warn('[Bookshelf] loadLocalComics 失败:', e)
  }
}

// ------ 阅读历史 ------
async function loadHistory() {
  try {
    if (window.progressApi?.history) {
      const result = await window.progressApi.history(200)
      if (result && result.length) {
        historyList.value = result.map(item => ({
          comicId: item.progress?.comicId || item.comic?.sourceUrl || item.comic?.id || '',
          title: item.comic?.title || item.progress?.comicTitle || '未知漫画',
          cover: item.comic?.cover || item.progress?.cover || '',
          tags: item.comic?.tags || [],
          chapterIndex: item.progress?.chapterIndex ?? 0,
          progress: Math.round((item.progress?.pct || 0) * 100),
          lastRead: item.progress?.updatedAt ? new Date(item.progress.updatedAt).getTime() : Date.now(),
        }))
        return
      }
    }
    const stored = JSON.parse(localStorage.getItem('comic-history') || '[]')
    historyList.value = stored
  } catch {
    const stored = JSON.parse(localStorage.getItem('comic-history') || '[]')
    historyList.value = stored
  }
}

// ------ 搜索 ------
watch(globalSearch, (val) => { localSearch.value = val })
watch(searchTrigger, () => { localSearch.value = globalSearch.value })
function searchNow() { globalSearch.value = localSearch.value }

const keyword = computed(() => localSearch.value.trim().toLowerCase())

const filteredLocal = computed(() => {
  const kw = keyword.value
  if (!kw) return localComics.value
  return localComics.value.filter(c => {
    const title = (c.title || '').toLowerCase()
    const author = (c.author || '').toLowerCase()
    const tags = (c.tags || []).join(' ').toLowerCase()
    return title.includes(kw) || author.includes(kw) || tags.includes(kw)
  })
})

const filteredHistory = computed(() => {
  const kw = keyword.value
  if (!kw) return historyList.value
  return historyList.value.filter(item => {
    const title = (item.title || '').toLowerCase()
    return title.includes(kw)
  })
})

// ------ 阅读统计 ------
const streak = computed(() => {
  if (!historyList.value.length) return 0
  const dates = new Set()
  historyList.value.forEach(item => {
    const d = new Date(item.lastRead)
    dates.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`)
  })
  let count = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let i = 0; i < 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    if (dates.has(key)) count++
    else break
  }
  return count
})

const totalComics = computed(() => {
  const ids = new Set(historyList.value.map(i => i.comicId))
  return ids.size
})

// ------ 按日期分组 ------
const groupedHistory = computed(() => {
  const list = filteredHistory.value
  const groups = []
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const todayStart = now.getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - (now.getDay() * 86400000)

  const today = [], yesterday = [], thisWeek = [], older = []
  list.forEach(item => {
    const t = item.lastRead
    if (t >= todayStart) today.push(item)
    else if (t >= yesterdayStart) yesterday.push(item)
    else if (t >= weekStart) thisWeek.push(item)
    else older.push(item)
  })

  today.sort((a, b) => b.lastRead - a.lastRead)
  yesterday.sort((a, b) => b.lastRead - a.lastRead)
  thisWeek.sort((a, b) => b.lastRead - a.lastRead)
  older.sort((a, b) => b.lastRead - a.lastRead)

  if (today.length) groups.push({ label: '今天', items: today })
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday })
  if (thisWeek.length) groups.push({ label: '本周', items: thisWeek })
  if (older.length) {
    const monthGroups = {}
    older.forEach(item => {
      const d = new Date(item.lastRead)
      const key = `${d.getFullYear()}年${d.getMonth() + 1}月`
      if (!monthGroups[key]) monthGroups[key] = []
      monthGroups[key].push(item)
    })
    Object.keys(monthGroups).forEach(m => {
      groups.push({ label: m, items: monthGroups[m] })
    })
  }
  return groups
})

// ------ 导航 ------
function goToDetail(comic) {
  const id = comic._id || comic.sourceUrl || comic.id
  router.push({ name: 'comicDetail', params: { id } })
}

function goToReader(item) {
  if (!item.comicId) return
  const chIdx = item.chapterIndex || 0
  router.push({ name: 'readerChapter', params: { comicId: item.comicId, chapterIndex: String(chIdx) } })
}

// ------ 工具 ------
const palette = [
  '#e5e5e5', '#dcdcdc', '#d4d4d4', '#cccccc',
  '#c5c5c5', '#bdbdbd', '#b5b5b5', '#adadad',
  '#a5a5a5', '#9e9e9e'
]
function gradient(title) {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash)
  return palette[Math.abs(hash) % palette.length]
}

function formatReadTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  return `${month} 个月前`
}

function onImgError(e) { e.target.style.display = 'none' }

onMounted(async () => {
  // 优先从缓存加载，减少等待时间
  const cachedLocal = sessionStorage.getItem('bookshelf-local')
  const cachedHistory = sessionStorage.getItem('bookshelf-history')
  
  if (cachedLocal) {
    try {
      localComics.value = JSON.parse(cachedLocal)
      console.log('[Bookshelf] 从缓存加载本地漫画:', localComics.value.length)
    } catch (e) { /* ignore */ }
  }
  if (cachedHistory) {
    try {
      historyList.value = JSON.parse(cachedHistory)
      console.log('[Bookshelf] 从缓存加载历史:', historyList.value.length)
    } catch (e) { /* ignore */ }
  }
  
  // 后台刷新数据
  await loadLocalComics()
  await loadHistory()
})

// 数据更新时写入缓存
watch(localComics, (val) => {
  if (val.length > 0) {
    sessionStorage.setItem('bookshelf-local', JSON.stringify(val))
  }
}, { deep: true })

watch(historyList, (val) => {
  if (val.length > 0) {
    sessionStorage.setItem('bookshelf-history', JSON.stringify(val))
  }
}, { deep: true })
</script>

<style scoped>
.bookshelf-page { padding: 20px; }

.page-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 20px;
}

.page-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
  letter-spacing: -0.3px;
}

.page-sub {
  font-size: 12px;
  color: var(--text-dim);
}

.page-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  width: 300px;
  height: 38px;
  padding: 0 14px;
  border: 1px solid var(--glass-border);
  background: rgba(255,255,255,0.8);
  border-radius: 14px;
  transition: all 0.2s ease;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
}
.page-search:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 4px rgba(255, 143, 92, 0.12), var(--shadow-sm);
}
.page-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--text);
}
.page-search input::placeholder { color: var(--text-dim); }

/* Tab 切换栏 */
.tabs {
  display: inline-flex;
  gap: 4px;
  margin-bottom: 20px;
  padding: 6px;
  background: rgba(255,255,255,0.82);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-sub);
  background: transparent;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}
.tab:hover:not(.active) {
  color: var(--text);
  background: var(--bg-hover);
}
.tab.active {
  color: #fff;
  background: linear-gradient(135deg, rgba(255,95,80,0.95), rgba(255,148,109,0.96));
  box-shadow: 0 4px 18px rgba(255, 95, 80, 0.22);
}
.tab-badge {
  padding: 1px 7px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 10px;
  background: rgba(255,255,255,0.32);
}
.tab:not(.active) .tab-badge {
  background: var(--bg-hover);
  color: var(--text-sub);
}

.tab-content {
  animation: tabFadeIn 0.25s ease;
}
@keyframes tabFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 通用网格 - 更紧凑 */
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

/* 阅读统计 */
.stats-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}
.stat-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 3px;
  height: 100%;
  background: var(--brand);
  opacity: 0.8;
}
.stat-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}
.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.5px;
}
.stat-label {
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 500;
}

/* 时间线 */
.timeline-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.timeline-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.timeline-date-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-sub);
  padding: 6px 0;
  border-bottom: 1px solid var(--border-light);
  letter-spacing: 0.3px;
}

/* 历史卡片 */
.history-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(255, 77, 79, 0.08), 0 1px 4px rgba(255, 77, 79, 0.06);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 0;
}
.history-card:hover {
  transform: translateY(-4px) scale(1.02);
  box-shadow: 0 12px 24px rgba(255, 77, 79, 0.15), 0 4px 12px rgba(255, 77, 79, 0.1);
  border-color: var(--brand-start);
}

.hc-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3/4;
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-hover);
}
.hc-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hc-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 700;
  color: #fff;
  letter-spacing: -1px;
}
.hc-progress-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  padding: 2px 6px;
  background: rgba(26, 29, 41, 0.75);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.hc-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0 2px 2px;
}
.hc-title {
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  line-height: 1.3;
}
.hc-meta {
  font-size: 10px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
}
.hc-dot { opacity: 0.4; margin: 0 2px; }

.hc-bar {
  width: 100%;
  height: 3px;
  background: var(--bg-hover);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}
.hc-bar-fill {
  height: 100%;
  background: var(--brand);
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* 空状态 */
/* 空状态优化 - 番茄小说风格 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 100px 20px;
  text-align: center;
  animation: fadeInUp 0.5s ease;
}
.empty-icon {
  width: 80px;
  height: 80px;
  margin-bottom: 24px;
  border-radius: 20px;
  background: var(--brand-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: pulse-soft 2s ease-in-out infinite;
}
.empty-icon svg {
  width: 36px;
  height: 36px;
  stroke: var(--brand-start);
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.empty-sub {
  font-size: 12px;
  color: var(--text-dim);
}
</style>

/* 空状态动画 */
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