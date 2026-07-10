<template>
  <div class="category-page">
    <!-- 页面头部 -->
    <div class="page-header-with-back">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回
      </button>
      <div class="header-titles">
        <h1 class="page-title">分类管理</h1>
        <p class="page-subtitle">查看和管理漫画分类</p>
      </div>
    </div>

    <!-- 统计概览 -->
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ totalCount }}</div>
        <div class="stat-label">全部漫画</div>
      </div>
      <div class="stat-card accent">
        <div class="stat-value">{{ categoryCount }}</div>
        <div class="stat-label">分类数量</div>
      </div>
      <div class="stat-card danger">
        <div class="stat-value">{{ untaggedCount }}</div>
        <div class="stat-label">未分类</div>
      </div>
    </div>

    <!-- 搜索栏 -->
    <div class="search-bar">
      <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <input
        v-model="searchQuery"
        placeholder="搜索分类名称..."
        class="search-input"
      />
      <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">✕</button>
    </div>

    <!-- 分类网格 -->
    <div class="section-header">
      <span class="section-title">所有分类</span>
      <span class="section-count">{{ filteredCategories.length }} 个分类</span>
    </div>

    <div v-if="filteredCategories.length > 0" class="category-grid">
      <!-- 未分类卡片 -->
      <div
        v-if="untaggedCount > 0 && (!searchQuery || '未分类'.includes(searchQuery))"
        class="category-card untagged"
        @click="goToCategory('__untagged__')"
      >
        <div class="card-accent" :style="{ background: 'linear-gradient(135deg, #95a5a6, #7f8c8d)' }"></div>
        <div class="card-body">
          <div class="card-name">未分类</div>
          <div class="card-count">{{ untaggedCount }} 本漫画</div>
        </div>
        <div class="card-icon">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
        </div>
      </div>

      <!-- 分类卡片 -->
      <div
        v-for="cat in filteredCategories"
        :key="cat.name"
        class="category-card"
        @click="goToCategory(cat.name)"
      >
        <div class="card-accent" :style="{ background: cat.gradient }"></div>
        <div class="card-body">
          <div class="card-name">{{ cat.name }}</div>
          <div class="card-count">{{ cat.count }} 本漫画</div>
        </div>
        <div class="card-icon" :style="{ color: cat.color }">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5v5H4z"/><path d="M15 4h5v5h-5V4z"/><path d="M4 15h5v5H4v-5z"/><path d="M15 15h5v5h-5v-5z"/></svg>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
        </div>
        <div class="empty-title">{{ searchQuery ? '没有匹配的分类' : '暂无分类数据' }}</div>
        <div class="empty-sub">{{ searchQuery ? '尝试更换关键词搜索' : '漫画数据加载后可在此管理分类' }}</div>
      </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const searchQuery = ref('')
const categoryStats = ref({})       // { categoryName: count }
const untaggedCount = ref(0)
const totalCount = ref(0)
const allCategories = ref([])      // from getAllCategories

// 预设渐变色彩盘
const colorPalette = [
  { color: '#6366f1', gradient: 'linear-gradient(135deg, #6366f1, #818cf8)' },
  { color: '#ec4899', gradient: 'linear-gradient(135deg, #ec4899, #f472b6)' },
  { color: '#f59e0b', gradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)' },
  { color: '#10b981', gradient: 'linear-gradient(135deg, #10b981, #34d399)' },
  { color: '#3b82f6', gradient: 'linear-gradient(135deg, #3b82f6, #60a5fa)' },
  { color: '#8b5cf6', gradient: 'linear-gradient(135deg, #8b5cf6, #a78bfa)' },
  { color: '#ef4444', gradient: 'linear-gradient(135deg, #ef4444, #f87171)' },
  { color: '#14b8a6', gradient: 'linear-gradient(135deg, #14b8a6, #2dd4bf)' },
  { color: '#f97316', gradient: 'linear-gradient(135deg, #f97316, #fb923c)' },
  { color: '#06b6d4', gradient: 'linear-gradient(135deg, #06b6d4, #22d3ee)' },
  { color: '#84cc16', gradient: 'linear-gradient(135deg, #84cc16, #a3e635)' },
  { color: '#d946ef', gradient: 'linear-gradient(135deg, #d946ef, #e879f9)' },
]

// 根据分类名哈希选取颜色（保证同一分类颜色稳定）
function getColorForCategory(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colorPalette[Math.abs(hash) % colorPalette.length]
}

const categoryCount = computed(() => allCategories.value.length)

const categories = computed(() => {
  return allCategories.value.map(name => {
    const c = getColorForCategory(name)
    return {
      name,
      count: categoryStats.value[name] || 0,
      color: c.color,
      gradient: c.gradient,
    }
  }).sort((a, b) => b.count - a.count)
})

const filteredCategories = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return categories.value
  return categories.value.filter(c => c.name.toLowerCase().includes(q))
})

function goToCategory(name) {
  const cat = name === '__untagged__' ? '__untagged__' : name
  router.push({ name: 'comicList', query: { category: cat } })
}

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/settings')
  }
}

async function loadData() {
  try {
    // 并行加载
    const [statsRes, catsRes] = await Promise.all([
      window.dbApi?.getCategoryStats?.() || null,
      window.dbApi?.getAllCategories?.() || null,
    ])
    if (statsRes) {
      categoryStats.value = statsRes.stats || {}
      untaggedCount.value = statsRes.untagged || 0
      totalCount.value = statsRes.total || 0
    }
    if (catsRes) {
      allCategories.value = catsRes
    }
  } catch (e) {
    console.error('加载分类数据失败:', e)
  }
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.category-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ===== 统计概览 ===== */
.stats-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: var(--shadow-sm);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}
.stat-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}
.stat-card.accent {
  border-color: rgba(99, 102, 241, 0.2);
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.08), rgba(139, 92, 246, 0.08));
  color: var(--brand);
}
.stat-card.accent .stat-label {
  color: var(--brand);
}
.stat-card.danger {
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.04);
}
.stat-card.danger .stat-value {
  color: var(--error);
}
.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.1;
}
.stat-label {
  font-size: 13px;
  color: var(--text-dim);
  font-weight: 500;
}

/* ===== 搜索栏 ===== */
.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  height: 42px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}
.search-bar:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1), var(--shadow);
}
.search-icon {
  color: var(--text-dim);
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  outline: none;
  min-height: auto;
}
.search-input::placeholder {
  color: var(--text-dim);
}
.search-clear {
  font-size: 14px;
  color: var(--text-dim);
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--bg-hover);
  border: none;
  min-height: auto;
  transition: all .2s;
}
.search-clear:hover {
  color: var(--text);
  background: var(--bg-active);
}

/* ===== 区域标题 ===== */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 4px;
}
.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.section-count {
  font-size: 13px;
  color: var(--text-dim);
}

/* ===== 分类网格 ===== */
.category-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.category-card {
  position: relative;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  padding: 18px;
  display: flex;
  align-items: center;
  gap: 14px;
  cursor: pointer;
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.category-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
}
@media (hover: none) and (pointer: coarse) {
  .category-card:active {
    transform: scale(0.98);
    transition: transform 0.1s;
  }
}

/* 左侧彩色条 */
.card-accent {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 4px;
  border-radius: var(--radius-lg) 0 0 var(--radius-lg);
}

.card-body {
  flex: 1;
  min-width: 0;
  margin-left: 6px;
}
.card-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-count {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}

.card-icon {
  flex-shrink: 0;
  color: var(--text-dim);
  opacity: 0.5;
  transition: opacity 0.25s, color 0.25s;
}
.category-card:hover .card-icon {
  opacity: 1;
}

/* 未分类卡片 */
.category-card.untagged {
  border-style: dashed;
  border-color: var(--border);
}
.category-card.untagged:hover {
  border-color: var(--text-dim);
  background: var(--bg-hover);
}

/* ===== 空状态 ===== */
.empty-state {
  text-align: center;
  padding: 80px 20px;
}
.empty-icon {
  font-size: 56px;
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
}

/* ===== 页面头部与返回键 ===== */
.page-header-with-back {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-light);
}
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
  margin-top: 2px;
}
.back-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-bg);
  transform: translateX(-2px);
}
.back-btn svg {
  flex-shrink: 0;
}
.header-titles { flex: 1; min-width: 0; }
.page-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 6px 0;
  letter-spacing: -0.5px;
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  display: inline-block;
}
.page-subtitle {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0;
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .page-header-with-back {
    flex-direction: column;
    gap: 12px;
  }
  .page-title {
    font-size: 20px;
  }
  .stats-row {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .category-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .stat-value {
    font-size: 26px;
  }
}
</style>