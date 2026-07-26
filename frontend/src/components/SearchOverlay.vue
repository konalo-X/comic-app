<template>
  <transition name="fade">
    <div v-if="showSearchOverlay" class="search-overlay" @click.self="closeSearch">
      <div class="search-panel">
        <div class="search-input-row">
          <svg class="search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input
ref="searchInputRef" v-model="searchQuery" 
         :placeholder="searchPlaceholder" 
         class="search-input" 
         @input="onSearchInput" 
         @keydown.escape="closeSearch"
         @keydown.enter="selectFirst" />
          <button class="search-close" @click="closeSearch">ESC</button>
        </div>
        
        <!-- 搜索建议 -->
        <div v-if="searchSuggestions.length > 0 && searchQuery" class="search-suggestions">
          <div v-for="s in searchSuggestions" :key="s" class="suggestion-item" @click="applySuggestion(s)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
            <span v-html="highlightText(s, searchQuery)"></span>
          </div>
        </div>
        
        <!-- 搜索提示 -->
        <div v-if="searchQuery && searchQuery.startsWith('tag:')" class="search-hint">
          <span class="hint-label">标签搜索</span>
          <span class="hint-text">输入标签名，如: tag:日漫</span>
        </div>
        <div v-else-if="searchQuery && searchQuery.startsWith('author:')" class="search-hint">
          <span class="hint-label">作者搜索</span>
          <span class="hint-text">输入作者名，如: author:尾田荣一郎</span>
        </div>
        <div v-else-if="searchQuery && searchQuery.startsWith('status:')" class="search-hint">
          <span class="hint-label">状态搜索</span>
          <span class="hint-text">输入状态，如: status:连载 / status:完结</span>
        </div>
        
        <div class="search-results">
          <div v-if="searchHistory.length > 0 && !searchQuery" class="search-section">
            <div class="section-title">搜索历史</div>
            <div v-for="h in searchHistory" :key="h.query" class="search-item history-item" @click="searchHistoryItem(h.query)">
              <svg class="history-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span class="history-text">{{ h.query }}</span>
            </div>
          </div>
          <div v-if="searchResults.local?.length" class="search-section">
            <div class="section-title">本地漫画 ({{ searchResults.local.length }})</div>
            <div v-for="c in searchResults.local" :key="c._id || c.sourceUrl" class="search-item" @click="goToComic(c)">
              <img v-if="c.cover" :src="resolveCover(c.cover)" class="search-cover" />
              <div v-else class="search-cover-placeholder">{{ (c.title || '?')[0] }}</div>
              <div class="search-info">
                <div class="search-title" v-html="highlightText(c.title, searchQuery)"></div>
                <div class="search-meta">
                  <span v-if="c.author" class="meta-author">{{ c.author }}</span>
                  <span v-if="c.status" class="meta-status" :class="c.status">{{ c.status }}</span>
                  <span class="meta-chapters">{{ c.chapters?.length || c.chapter_count || 0 }}章</span>
                  <span v-if="c.favorited" class="meta-fav">★</span>
                </div>
                <div v-if="c.tags" class="search-tags">
                  <span v-for="tag in (Array.isArray(c.tags) ? c.tags : (c.tags || '').split(',')).slice(0,3)" :key="tag" class="tag">{{ (tag || '').trim() }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="searchResults.remote?.length" class="search-section">
            <div class="section-title">远程源 ({{ searchResults.remote.length }})</div>
            <div v-for="c in searchResults.remote" :key="c.sourceUrl" class="search-item" @click="goToComic(c)">
              <img v-if="c.cover" :src="resolveCover(c.cover)" class="search-cover" />
              <div v-else class="search-cover-placeholder">{{ (c.title || '?')[0] }}</div>
              <div class="search-info">
                <div class="search-title">{{ c.title }}</div>
                <div class="search-meta">{{ c.author || '未知作者' }}</div>
              </div>
            </div>
          </div>
          <div v-if="searchQuery && !searching && !searchResults.local?.length && !searchResults.remote?.length" class="search-empty">
            <div class="empty-icon">🔍</div>
            <div class="empty-text">未找到相关漫画</div>
            <div class="empty-tip">试试: tag:日漫 / author:作者名 / status:连载</div>
          </div>
          <div v-if="searching" class="search-loading">
            <div class="loading-spinner"></div>
            <div class="loading-text">搜索中...</div>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/userStore'

const router = useRouter()
const userStore = useUserStore()

const showSearchOverlay = ref(false)
const searchQuery = ref('')
const searching = ref(false)
const searchResults = ref({ local: [], remote: [] })
const searchInputRef = ref(null)
const searchSuggestions = ref([])

const searchHistory = ref(userStore.searchHistory)

// 常用标签和作者（用于搜索建议）
const commonTags = ['日漫', '国漫', '韩漫', '美漫', '热血', '恋爱', '悬疑', '搞笑', '科幻', '奇幻']
const commonAuthors = []

let searchDebounce = null

onMounted(() => {
  document.addEventListener('keydown', onSearchKeydown)
  loadCommonAuthors()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onSearchKeydown)
  if (searchDebounce) clearTimeout(searchDebounce)
})

async function loadCommonAuthors() {
  try {
    if (window.dbApi?.getComics) {
      const comics = await window.dbApi.getComics(1, 100)
      const authors = new Set()
      comics?.list?.forEach(c => {
        if (c.author) authors.add(c.author)
      })
      commonAuthors.push(...Array.from(authors).slice(0, 20))
    }
  } catch (e) {
    console.warn('加载作者列表失败:', e)
  }
}

function onSearchKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'f')) {
    e.preventDefault()
    openSearch()
  }
}

function openSearch(initialQuery = '') {
  showSearchOverlay.value = true
  searchQuery.value = initialQuery
  searchResults.value = { local: [], remote: [] }
  searchSuggestions.value = []
  searching.value = false
  setTimeout(() => searchInputRef.value?.focus(), 50)
  if (initialQuery) {
    onSearchInput()
  }
}

function closeSearch() {
  showSearchOverlay.value = false
  searchQuery.value = ''
  searchResults.value = { local: [], remote: [] }
  searchSuggestions.value = []
}

// 搜索占位符
const searchPlaceholder = computed(() => {
  const q = searchQuery.value
  if (q.startsWith('tag:')) return '输入标签名...'
  if (q.startsWith('author:')) return '输入作者名...'
  if (q.startsWith('status:')) return '输入状态: 连载/完结...'
  return '搜索漫画 / 作者 / 标签...'
})

// 生成搜索建议
function updateSuggestions(q) {
  if (!q || q.length < 1) {
    searchSuggestions.value = []
    return
  }
  
  const suggestions = []
  const lowerQ = q.toLowerCase()
  
  // 标签建议
  if (!q.includes(':')) {
    commonTags.forEach(tag => {
      if (tag.toLowerCase().includes(lowerQ)) {
        suggestions.push(`tag:${tag}`)
      }
    })
  }
  
  // 作者建议
  if (!q.includes(':')) {
    commonAuthors.forEach(author => {
      if (author.toLowerCase().includes(lowerQ)) {
        suggestions.push(`author:${author}`)
      }
    })
  }
  
  searchSuggestions.value = suggestions.slice(0, 5)
}

function applySuggestion(s) {
  searchQuery.value = s
  searchSuggestions.value = []
  onSearchInput()
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlightText(text, keyword) {
  if (!keyword) return escapeHtml(text)
  const escaped = escapeHtml(text)
  const escapedKeyword = escapeHtml(keyword)
  const regex = new RegExp(`(${escapedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(regex, '<span class="highlight">$1</span>')
}

function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce)
  const q = searchQuery.value.trim()
  
  // 更新搜索建议
  updateSuggestions(q)
  
  if (!q) {
    searchResults.value = { local: [], remote: [] }
    searching.value = false
    return
  }
  searching.value = true
  searchDebounce = setTimeout(() => performSearch(q), 300)
}

async function performSearch(q) {
  searching.value = true
  userStore.addSearchHistory(q)
  searchHistory.value = userStore.searchHistory
  try {
    // 解析高级搜索语法
    const parsedQuery = parseAdvancedQuery(q)
    const res = await window.searchApi.global(parsedQuery.query, parsedQuery.filters)
    searchResults.value = {
      local: res?.local || [],
      remote: res?.remote || []
    }
  } catch {
    searchResults.value = { local: [], remote: [] }
  } finally {
    searching.value = false
  }
}

// 解析高级搜索语法
function parseAdvancedQuery(q) {
  const filters = {}
  let query = q
  
  // 提取 tag:xxx
  const tagMatch = q.match(/tag:([^\s]+)/i)
  if (tagMatch) {
    filters.tag = tagMatch[1]
    query = query.replace(tagMatch[0], '').trim()
  }
  
  // 提取 author:xxx
  const authorMatch = q.match(/author:([^\s]+)/i)
  if (authorMatch) {
    filters.author = authorMatch[1]
    query = query.replace(authorMatch[0], '').trim()
  }
  
  // 提取 status:xxx
  const statusMatch = q.match(/status:([^\s]+)/i)
  if (statusMatch) {
    filters.status = statusMatch[1]
    query = query.replace(statusMatch[0], '').trim()
  }
  
  return { query: query || q, filters }
}

function searchHistoryItem(query) {
  searchQuery.value = query
  onSearchInput()
}

function selectFirst() {
  const all = [...(searchResults.value.local || []), ...(searchResults.value.remote || [])]
  if (all.length) goToComic(all[0])
}

function goToComic(comic) {
  closeSearch()
  const id = comic._id || comic.id || comic.sourceUrl
  if (id) {
    router.push({ name: 'comicDetail', params: { id } })
  }
}

// 将封面路径转换为可加载的 URL（本地文件需通过代理）
function resolveCover(cover) {
  if (!cover) return ''
  const src = String(cover)
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return window.utils ? window.utils.toLocalUrl(src) : src
}

defineExpose({
  openSearch,
  closeSearch
})
</script>

<style scoped>
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(26, 24, 32, 0.5);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 100px;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.search-panel {
  width: 560px;
  max-width: 90vw;
  max-height: 520px;
  background: var(--content-bg);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: searchPanelIn 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  backdrop-filter: blur(20px);
}

@keyframes searchPanelIn {
  from { opacity: 0; transform: translateY(-12px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--glass-border);
}

.search-input-row input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  color: var(--text-primary);
}

.search-input-row input::placeholder {
  color: var(--text-tertiary);
}

.search-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.search-close {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.2s;
}

.search-close:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.search-section {
  margin-bottom: 8px;
}

.section-title {
  padding: 8px 20px 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.search-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  cursor: pointer;
  transition: background 0.15s;
}

.search-item:hover {
  background: var(--bg-hover);
}

.search-item.history-item {
  padding-left: 24px;
}

.history-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.history-text {
  color: var(--text-secondary);
  font-size: 14px;
}

.search-cover {
  width: 40px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}

.search-cover-placeholder {
  width: 40px;
  height: 56px;
  border-radius: 6px;
  background: var(--accent-gradient);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 15px;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}

.search-info {
  flex: 1;
  min-width: 0;
}

.search-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 搜索关键词高亮 */
.highlight {
  color: var(--brand-start);
  font-weight: 600;
  background: var(--brand-bg);
  padding: 0 2px;
  border-radius: 2px;
}

.search-meta {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.search-empty {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 14px;
}

.search-loading {
  padding: 60px 20px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 14px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>