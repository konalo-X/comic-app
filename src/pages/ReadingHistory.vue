<template>
  <div class="reading-history-page">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-left">
        <h2 class="page-title">阅读历史</h2>
        <span class="page-sub">共 {{ totalCount }} 条记录 · 连续阅读 {{ streak }} 天</span>
      </div>
      <div class="header-right">
        <div class="search-box">
          <svg class="search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input v-model="searchQuery" placeholder="搜索漫画名称..." @input="onSearchInput" />
        </div>
        <div class="filter-group">
          <select v-model="dateFilter" class="filter-select">
            <option value="all">全部时间</option>
            <option value="today">今天</option>
            <option value="week">本周</option>
            <option value="month">本月</option>
            <option value="custom">自定义</option>
          </select>
          <input v-if="dateFilter === 'custom'" v-model="customDateStart" type="date" class="filter-date" />
          <input v-if="dateFilter === 'custom'" v-model="customDateEnd" type="date" class="filter-date" />
        </div>
      </div>
    </div>

    <!-- 阅读统计 -->
    <div class="stats-bar">
      <div class="stat-item">
        <span class="stat-value">{{ streak }}</span>
        <span class="stat-label">连续阅读天数</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ totalComics }}</span>
        <span class="stat-label">阅读漫画数</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ totalChapters }}</span>
        <span class="stat-label">阅读章节数</span>
      </div>
      <div class="stat-item">
        <span class="stat-value">{{ formatDuration(totalReadTime) }}</span>
        <span class="stat-label">总阅读时长</span>
      </div>
    </div>

    <!-- 时间线分组 -->
    <div v-if="groupedHistory.length > 0" class="timeline-container">
      <div v-for="group in groupedHistory" :key="group.label" class="timeline-group">
        <div class="timeline-date-label">{{ group.label }}</div>
        <div class="timeline-cards">
          <div
            v-for="item in group.items"
            :key="item.comicId + '-' + item.lastRead"
            class="timeline-card card"
            @click="goToReader(item)"
          >
            <!-- 封面 -->
            <div class="card-cover">
              <img v-if="item.cover" :src="resolveCover(item.cover)" :alt="item.title" referrerpolicy="no-referrer" @error="onImgError" />
              <div v-else class="cover-placeholder" :style="{ background: gradient(item.title) }">
                {{ (item.title || '?')[0] }}
              </div>
              <!-- 进度百分比 -->
              <div class="progress-badge">{{ item.progressPercent }}%</div>
            </div>

            <!-- 信息 -->
            <div class="card-info">
              <div class="card-title" :title="item.title">{{ item.title }}</div>
              <div class="card-meta">
                <span class="meta-chapter">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                  第 {{ item.currentChapter + 1 }} 章
                </span>
                <span class="meta-time">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  {{ formatReadTime(item.lastRead) }}
                </span>
              </div>
              <!-- 进度条 -->
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: item.progressPercent + '%' }"></div>
              </div>
              <div v-if="item.tags && item.tags.length" class="card-tags">
                <span v-for="tag in item.tags.slice(0, 3)" :key="tag" class="tag">{{ tag }}</span>
              </div>
            </div>

            <!-- 操作按钮 -->
            <div class="card-actions">
              <button class="btn btn-icon" title="继续阅读" @click.stop="goToReader(item)">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4Z" fill="#fff"/></svg>
              </button>
              <button class="btn btn-icon btn-danger" title="删除记录" @click.stop="deleteRecord(item)">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 15 14"/></svg>
      </div>
      <div class="empty-title">暂无阅读记录</div>
      <div class="empty-sub">开始阅读漫画，记录将显示在这里</div>
      <button class="btn btn-primary" @click="goToComicList">去漫画列表</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 将封面路径转换为可加载的 URL（本地文件需通过代理）
function resolveCover(cover) {
  if (!cover) return ''
  const src = String(cover)
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return window.utils ? window.utils.toLocalUrl(src) : src
}

// 数据
const historyList = ref([])
const searchQuery = ref('')
const dateFilter = ref('all')
const customDateStart = ref('')
const customDateEnd = ref('')

// 加载阅读历史
async function loadHistory() {
  try {
    const result = await window.progressApi.history(200)
    if (!result || !result.length) {
      historyList.value = []
      return
    }
    historyList.value = result.map(item => ({
      comicId: item.comic?.id || item.comic?.comicId || item.progress?.comicId || '',
      title: item.comic?.title || item.progress?.comicTitle || '未知漫画',
      cover: item.comic?.cover || item.progress?.cover || '',
      tags: item.comic?.tags || [],
      currentChapter: item.progress?.chapterIndex ?? 0,
      currentPage: item.progress?.pageIndex ?? 0,
      progressPercent: Math.round((item.progress?.pct || 0) * 100),
      lastRead: item.progress?.updatedAt ? new Date(item.progress.updatedAt).getTime() : Date.now(),
      totalChapters: item.comic?.chapters?.length || item.progress?.totalChapters || 0,
      _raw: item
    }))
  } catch (err) {
    console.error('加载阅读历史失败:', err)
    historyList.value = []
  }
}

onMounted(() => {
  loadHistory()
})

// 搜索防抖
let searchDebounce = null
function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => {
    // 触发重新计算
  }, 300)
}

// 计算连续阅读天数
const streak = computed(() => {
  if (!historyList.value.length) return 0

  const dates = new Set()
  historyList.value.forEach(item => {
    const d = new Date(item.lastRead)
    const dateStr = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    dates.add(dateStr)
  })

  let streakCount = 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today)
    checkDate.setDate(checkDate.getDate() - i)
    const dateStr = `${checkDate.getFullYear()}-${checkDate.getMonth() + 1}-${checkDate.getDate()}`

    if (dates.has(dateStr)) {
      streakCount++
    } else {
      break
    }
  }

  return streakCount
})

// 总漫画数
const totalComics = computed(() => {
  const ids = new Set(historyList.value.map(item => item.comicId))
  return ids.size
})

// 总章节数
const totalChapters = computed(() => {
  return historyList.value.length
})

// 总阅读时长（估算：每个章节平均10分钟）
const totalReadTime = computed(() => {
  return historyList.value.length * 10 * 60 * 1000 // 毫秒
})

// 总记录数
const totalCount = computed(() => {
  return filteredHistory.value.length
})

// 过滤后的历史
const filteredHistory = computed(() => {
  let list = [...historyList.value]

  // 搜索过滤
  const kw = searchQuery.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(item =>
      (item.title || '').toLowerCase().includes(kw)
    )
  }

  // 日期过滤
  const now = new Date()
  now.setHours(0, 0, 0, 0)

  if (dateFilter.value === 'today') {
    const todayStart = now.getTime()
    const todayEnd = todayStart + 86400000
    list = list.filter(item => item.lastRead >= todayStart && item.lastRead < todayEnd)
  } else if (dateFilter.value === 'week') {
    const weekStart = now.getTime() - (now.getDay() * 86400000)
    list = list.filter(item => item.lastRead >= weekStart)
  } else if (dateFilter.value === 'month') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    list = list.filter(item => item.lastRead >= monthStart)
  } else if (dateFilter.value === 'custom') {
    if (customDateStart.value) {
      const start = new Date(customDateStart.value).getTime()
      list = list.filter(item => item.lastRead >= start)
    }
    if (customDateEnd.value) {
      const end = new Date(customDateEnd.value).getTime() + 86400000
      list = list.filter(item => item.lastRead < end)
    }
  }

  return list
})

// 按日期分组
const groupedHistory = computed(() => {
  const list = filteredHistory.value
  const groups = []
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const todayStart = now.getTime()
  const yesterdayStart = todayStart - 86400000
  const weekStart = todayStart - (now.getDay() * 86400000)

  const today = []
  const yesterday = []
  const thisWeek = []
  const older = []

  list.forEach(item => {
    const t = item.lastRead
    if (t >= todayStart) {
      today.push(item)
    } else if (t >= yesterdayStart) {
      yesterday.push(item)
    } else if (t >= weekStart) {
      thisWeek.push(item)
    } else {
      older.push(item)
    }
  })

  // 按时间倒序
  today.sort((a, b) => b.lastRead - a.lastRead)
  yesterday.sort((a, b) => b.lastRead - a.lastRead)
  thisWeek.sort((a, b) => b.lastRead - a.lastRead)
  older.sort((a, b) => b.lastRead - a.lastRead)

  if (today.length) groups.push({ label: '今天', items: today })
  if (yesterday.length) groups.push({ label: '昨天', items: yesterday })
  if (thisWeek.length) groups.push({ label: '本周', items: thisWeek })
  if (older.length) {
    // 更早的按月份分组
    const monthGroups = {}
    older.forEach(item => {
      const d = new Date(item.lastRead)
      const monthKey = `${d.getFullYear()}年${d.getMonth() + 1}月`
      if (!monthGroups[monthKey]) monthGroups[monthKey] = []
      monthGroups[monthKey].push(item)
    })
    Object.keys(monthGroups).forEach(month => {
      groups.push({ label: month, items: monthGroups[month] })
    })
  }

  return groups
})

// 格式化阅读时间
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

// 格式化时长
function formatDuration(ms) {
  if (!ms) return '0 分钟'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时`
}

// 跳转到阅读器
function goToReader(item) {
  if (!item.comicId) return
  router.push({ name: 'readerChapter', params: { comicId: item.comicId, chapterIndex: String(item.currentChapter || 0) } })
}

// 跳转到漫画列表
function goToComicList() {
  router.push({ name: 'comicList' })
}

// 删除记录
async function deleteRecord(item) {
  if (!confirm(`确定要删除「${item.title}」的阅读记录吗？`)) return

  try {
    await window.progressApi.delete(item.comicId)
    await loadHistory()
  } catch (err) {
    console.error('删除记录失败:', err)
    alert('删除失败，请重试')
  }
}

// 封面占位符渐变色
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

function onImgError(e) {
  e.target.style.display = 'none'
}
</script>

<style scoped>
.reading-history-page {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

/* 页面头部 */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.page-sub {
  font-size: 13px;
  color: var(--text-dim);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border-light);
  border-radius: 12px;
  background: var(--bg-card);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--shadow-sm);
}

.search-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1), var(--shadow);
}

.search-box input {
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  outline: none;
  width: 200px;
}

.search-box input::placeholder {
  color: var(--text-dim);
}

.search-icon {
  color: var(--text-dim);
  flex-shrink: 0;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter-select {
  padding: 8px 14px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  outline: none;
  cursor: pointer;
  transition: all .2s;
}

.filter-select:hover {
  border-color: var(--border);
}

.filter-select:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

.filter-date {
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: all .2s;
}

.filter-date:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

/* 统计栏 */
.stats-bar {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
  margin-bottom: 28px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}

.stat-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}

.stat-icon {
  font-size: 28px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
}

.stat-label {
  font-size: 12px;
  color: var(--text-dim);
}

/* 时间线容器 */
.timeline-container {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.timeline-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.timeline-date-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  padding: 8px 0;
  border-bottom: 2px solid var(--border-light);
}

.timeline-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

/* 时间线卡片 */
.timeline-card {
  display: flex;
  gap: 14px;
  padding: 14px;
  background: rgba(255,255,255,0.84);
  border: 1px solid rgba(255,255,255,0.75);
  border-radius: var(--radius-lg);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  backdrop-filter: blur(14px);
}

.timeline-card:hover {
  background: var(--bg-hover);
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--brand);
}

.card-cover {
  position: relative;
  width: 64px;
  height: 86px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
}

.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 26px;
}

.progress-badge {
  position: absolute;
  bottom: 4px;
  right: 4px;
  padding: 2px 8px;
  background: rgba(0, 0, 0, 0.75);
  color: white;
  font-size: 10px;
  font-weight: 600;
  border-radius: 6px;
}

.card-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-sub);
}

.meta-chapter,
.meta-time {
  display: flex;
  align-items: center;
  gap: 5px;
}

.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--bg-hover);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--brand-start, #6366f1), var(--brand-end, #8b5cf6));
  border-radius: 2px;
  transition: width 0.3s ease;
  box-shadow: 0 0 6px rgba(99, 102, 241, 0.3);
}

.card-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.tag {
  padding: 2px 10px;
  background: var(--brand-bg);
  color: var(--brand);
  font-size: 10px;
  border-radius: 6px;
}

.card-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}

.btn-icon {
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-sub);
  cursor: pointer;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}

.btn-icon:hover {
  background: var(--gradient-brand);
  color: #fff;
  transform: scale(1.05);
}

.btn-danger {
  background: var(--error-bg);
  color: var(--error);
}

.btn-danger:hover {
  background: var(--error);
  color: #fff;
  transform: scale(1.05);
}

.btn-primary {
  background: var(--gradient-brand);
  color: white;
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  text-align: center;
}

.empty-icon {
  font-size: 72px;
  margin-bottom: 20px;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 10px;
}

.empty-sub {
  font-size: 14px;
  color: var(--text-dim);
  margin-bottom: 24px;
}

/* 响应式 */
@media (max-width: 768px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .header-right {
    width: 100%;
    flex-direction: column;
  }

  .search-box {
    width: 100%;
  }

  .search-box input {
    width: 100%;
  }

  .filter-group {
    width: 100%;
    flex-wrap: wrap;
  }

  .timeline-cards {
    grid-template-columns: 1fr;
  }

  .stats-bar {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>