<template>
  <div class="data-manager">
    <div class="page-header-with-back">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回
      </button>
      <div class="header-titles">
        <h1 class="page-title">数据管理</h1>
        <p class="page-subtitle">管理漫画数据、缓存和统计信息</p>
      </div>
    </div>

    <!-- 下载统计 -->
    <div class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <h2>下载统计</h2>
      </div>
      <div v-if="downloadStats" class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ downloadStats.totalComics || 0 }}</div>
          <div class="stat-label">漫画总数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ downloadStats.totalChapters || 0 }}</div>
          <div class="stat-label">章节总数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ downloadStats.totalImages || 0 }}</div>
          <div class="stat-label">图片总数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ formatSize(downloadStats.totalSize || 0) }}</div>
          <div class="stat-label">下载大小</div>
        </div>
      </div>
      <div v-else class="loading-placeholder">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>

    <!-- 阅读统计 -->
    <div class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <h2>阅读统计</h2>
      </div>
      <div v-if="readingStats" class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ readingStats.booksRead || 0 }}</div>
          <div class="stat-label">已读漫画</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ readingStats.chaptersRead || 0 }}</div>
          <div class="stat-label">已读章节</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ readingStats.streakDays || 0 }}</div>
          <div class="stat-label">连续阅读天数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ readingStats.totalReadTime || '0h' }}</div>
          <div class="stat-label">总阅读时长</div>
        </div>
      </div>
      <div v-else class="loading-placeholder">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>

    <!-- 缓存管理 -->
    <div class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
        <h2>缓存管理</h2>
      </div>
      <div v-if="cacheStats" class="cache-info">
        <div class="cache-stats">
          <div class="cache-item">
            <span class="cache-label">缓存大小</span>
            <span class="cache-value">{{ formatSize(cacheStats.size || 0) }}</span>
          </div>
          <div class="cache-item">
            <span class="cache-label">文件数量</span>
            <span class="cache-value">{{ cacheStats.fileCount || 0 }} 个文件</span>
          </div>
          <div class="cache-item">
            <span class="cache-label">缓存路径</span>
            <span class="cache-value path-value">{{ cacheStats.path || '未设置' }}</span>
          </div>
        </div>
        <div class="cache-actions">
          <button class="btn btn-secondary" @click="refreshCacheStats">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            刷新
          </button>
          <button class="btn btn-danger" :disabled="clearing" @click="clearCache">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            {{ clearing ? '清理中...' : '清理缓存' }}
          </button>
        </div>
      </div>
      <div v-else class="loading-placeholder">
        <div class="skeleton-line"></div>
        <div class="skeleton-line short"></div>
      </div>
    </div>

    <!-- 数据目录 -->
    <div class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <h2>数据目录</h2>
      </div>
      <div class="db-actions">
        <div class="action-item">
          <div class="action-info">
            <h3>数据目录位置</h3>
            <p>{{ dbPath || '未设置' }}</p>
          </div>
          <button class="btn btn-secondary" @click="openDataDirectory">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            打开目录
          </button>
        </div>
      </div>
    </div>

    <!-- 分类统计 -->
    <div v-if="categoryStats && categoryStats.length" class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 9V4h5v5H4z"/>
          <path d="M15 4h5v5h-5V4z"/>
          <path d="M4 15h5v5H4v-5z"/>
          <path d="M15 15h5v5h-5v-5z"/>
        </svg>
        <h2>分类统计</h2>
      </div>
      <div class="category-list">
        <div v-for="cat in categoryStats" :key="cat.name" class="category-item">
          <div class="category-info">
            <span class="category-name">{{ cat.name || '未分类' }}</span>
            <span class="category-count">{{ cat.count || 0 }} 部漫画</span>
          </div>
          <div class="category-bar">
            <div class="category-fill" :style="{ width: getCategoryPercentage(cat) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 数据修复 -->
    <div class="card">
      <div class="section-header">
        <svg class="section-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        <h2>数据修复</h2>
      </div>
      <div class="action-item">
        <div class="action-info">
          <h3>修复章节名错误</h3>
          <p>扫描章节名为「第N话」等占位符的漫画，重新爬取详情页以获取正确名称（防止下载到错误目录）</p>
          <p v-if="genericChaptersCount !== null" class="result-info" :class="{ 'has-error': genericChaptersCount > 0 }">
            <span v-if="genericChaptersCount > 0">⚠️ 发现 <strong>{{ genericChaptersCount }}</strong> 本漫画可能是占位符章节名（部分网站本身就用「第N话」，会自动跳过）</span>
            <span v-else-if="genericChaptersCount === 0">✅ 所有漫画章节名正常</span>
          </p>
        </div>
        <div class="action-buttons">
          <button class="btn btn-secondary" :disabled="scanning" @click="scanGenericChapters">
            {{ scanning ? '扫描中...' : '扫描' }}
          </button>
          <button class="btn btn-primary" :disabled="fixing || genericChaptersCount === 0" @click="enrichAllGenericChapters">
            {{ fixing ? '修复中...' : '批量修复' }}
          </button>
        </div>
      </div>
    </div>


  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/settings')
  }
}

// 响应式数据
const downloadStats = ref(null)
const readingStats = ref(null)
const cacheStats = ref(null)
const categoryStats = ref(null)
const dbPath = ref('')
const clearing = ref(false)
const scanning = ref(false)
const fixing = ref(false)
const genericChaptersCount = ref(null)

// 加载所有数据
onMounted(async () => {
  await Promise.all([
    loadDownloadStats(),
    loadReadingStats(),
    loadCacheStats(),
    loadCategoryStats(),
    loadDbPath()
  ])
})

// 加载下载统计
async function loadDownloadStats() {
  try {
    const [comicsResult, chaptersResult, imagesResult] = await Promise.all([
      window.dbApi?.getComicsCount?.() || Promise.resolve(0),
      window.dbApi?.getChaptersCount?.() || Promise.resolve(0),
      window.dbApi?.getImagesCount?.() || Promise.resolve(0)
    ])

    const sizeResult = await window.dbApi?.getDownloadSize?.() || Promise.resolve(0)

    downloadStats.value = {
      totalComics: comicsResult || 0,
      totalChapters: chaptersResult || 0,
      totalImages: imagesResult || 0,
      totalSize: sizeResult || 0
    }
  } catch (error) {
    console.error('加载下载统计失败:', error)
    downloadStats.value = {
      totalComics: 0,
      totalChapters: 0,
      totalImages: 0,
      totalSize: 0
    }
  }
}

// 加载阅读统计
async function loadReadingStats() {
  try {
    const [booksResult, chaptersResult, streakResult, timeResult] = await Promise.all([
      window.dbApi?.getBooksReadCount?.() || Promise.resolve(0),
      window.dbApi?.getChaptersReadCount?.() || Promise.resolve(0),
      window.dbApi?.getReadingStreak?.() || Promise.resolve(0),
      window.dbApi?.getTotalReadTime?.() || Promise.resolve('0h')
    ])

    readingStats.value = {
      booksRead: booksResult || 0,
      chaptersRead: chaptersResult || 0,
      streakDays: streakResult || 0,
      totalReadTime: timeResult || '0h'
    }
  } catch (error) {
    console.error('加载阅读统计失败:', error)
    readingStats.value = {
      booksRead: 0,
      chaptersRead: 0,
      streakDays: 0,
      totalReadTime: '0h'
    }
  }
}

// 加载缓存统计
async function loadCacheStats() {
  try {
    const result = await window.cacheApi?.stats?.() || { size: 0, fileCount: 0, path: '' }
    cacheStats.value = {
      size: result.size || 0,
      fileCount: result.fileCount || 0,
      path: result.path || '未设置'
    }
  } catch (error) {
    console.error('加载缓存统计失败:', error)
    cacheStats.value = {
      size: 0,
      fileCount: 0,
      path: '未设置'
    }
  }
}

// 加载分类统计
async function loadCategoryStats() {
  try {
    const result = await window.dbApi?.getCategoryStats?.() || { stats: {} }
    const stats = result.stats || {}
    categoryStats.value = Object.entries(stats).map(([name, count]) => ({
      name: name || '未分类',
      count: count || 0
    })).sort((a, b) => b.count - a.count)
  } catch (error) {
    console.error('加载分类统计失败:', error)
    categoryStats.value = []
  }
}

// 加载数据库路径
async function loadDbPath() {
  try {
    const result = await window.dbApi?.getDbPath?.() || ''
    dbPath.value = result || '未设置'
  } catch (error) {
    console.error('加载数据库路径失败:', error)
    dbPath.value = '未设置'
  }
}

// 刷新缓存统计
async function refreshCacheStats() {
  await loadCacheStats()
}

// 清理缓存
async function clearCache() {
  if (clearing.value) return

  const confirmed = confirm('确定要清理所有缓存吗？此操作不可恢复。')
  if (!confirmed) return

  clearing.value = true
  try {
    await window.cacheApi?.clear?.()
    await loadCacheStats()
    alert('缓存清理成功！')
  } catch (error) {
    console.error('清理缓存失败:', error)
    alert('清理缓存失败：' + error.message)
  } finally {
    clearing.value = false
  }
}

// 打开数据目录
async function openDataDirectory() {
  try {
    if (window.windowApi?.openPath) {
      await window.windowApi.openPath(dbPath.value || '.')
    } else if (window.shell?.openPath) {
      await window.shell.openPath(dbPath.value || '.')
    } else {
      alert(`数据目录路径:\n${dbPath.value}`)
    }
  } catch (error) {
    console.error('打开目录失败:', error)
    alert('打开目录失败：' + error.message)
  }
}

// 计算分类百分比
function getCategoryPercentage(category) {
  if (!categoryStats.value?.length) return 0
  const maxCount = Math.max(...categoryStats.value.map(c => c.count || 0))
  if (maxCount === 0) return 0
  return ((category.count || 0) / maxCount) * 100
}

// 扫描章节名异常的漫画
async function scanGenericChapters() {
  if (scanning.value) return
  scanning.value = true
  try {
    const result = await window.detailApi?.scanGenericChapters?.()
    if (result?.success) {
      genericChaptersCount.value = result.count || 0
    } else {
      alert('扫描失败：' + (result?.error || '未知错误'))
    }
  } catch (e) {
    console.error('扫描失败:', e)
    alert('扫描失败：' + e.message)
  } finally {
    scanning.value = false
  }
}

// 批量修复章节名
async function enrichAllGenericChapters() {
  if (fixing.value) return
  if (!confirm('确定要批量重新爬取详情页修复章节名吗？此操作可能需要较长时间。')) return
  fixing.value = true
  try {
    const result = await window.detailApi?.enrichAllGenericChapters?.()
    if (result?.success) {
      const skippedMsg = result.skippedCount > 0 ? `\n跳过（网站本身就是简单命名）: ${result.skippedCount}` : ''
      alert(`修复完成！\n成功修复: ${result.enrichedCount}\n总数: ${result.total || 0}${skippedMsg}`)
      genericChaptersCount.value = 0
    } else {
      alert('修复失败：' + (result?.error || '未知错误'))
    }
  } catch (e) {
    console.error('修复失败:', e)
    alert('修复失败：' + e.message)
  } finally {
    fixing.value = false
  }
}

// 格式化文件大小
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
</script>

<style scoped>
.data-manager {
  padding: 24px;
  max-width: 1180px;
  margin: 0 auto;
}

.card {
  background: var(--content-bg);
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-xl);
  padding: 24px;
  margin-bottom: 24px;
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(16px);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 22px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.65);
}

.section-icon {
  color: var(--brand);
  flex-shrink: 0;
  width: 28px;
  height: 28px;
}

.section-header h2 {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  background: linear-gradient(135deg, var(--brand-start), var(--brand-end));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.stat-card {
  background: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.75));
  border: 1px solid rgba(255,255,255,0.75);
  border-radius: var(--radius-xl);
  padding: 24px 22px;
  text-align: center;
  box-shadow: var(--shadow-sm);
  transition: transform .25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow .25s ease, border-color .25s ease;
}

.stat-card:hover {
  transform: translateY(-5px);
  box-shadow: var(--shadow-lg);
  border-color: rgba(255,255,255,0.9);
}

.stat-value {
  font-size: 30px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.stat-label {
  font-size: 13px;
  color: var(--text-dim);
  font-weight: 500;
}

.cache-info {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cache-stats {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cache-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  background: var(--content-bg);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.72);
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s ease, border-color 0.25s ease, background 0.25s ease;
}

.cache-item:hover {
  transform: translateY(-2px);
  border-color: rgba(255,255,255,0.92);
  background: rgba(255,255,255,0.96);
}

.cache-label {
  font-size: 14px;
  color: var(--text-sub);
  font-weight: 600;
}

.cache-value {
  font-size: 14px;
  color: var(--text);
  font-weight: 600;
}

.path-value {
  font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
  font-size: 12px;
  max-width: 400px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cache-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
}

.db-actions {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.action-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 18px;
  gap: 20px;
  background: var(--content-bg);
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s ease, border-color 0.25s ease, background 0.25s ease;
}

.action-item:hover {
  transform: translateY(-2px);
  border-color: rgba(255,255,255,0.92);
  background: rgba(255,255,255,0.95);
}

.action-item:first-child {
  padding-top: 0;
}

.action-info {
  flex: 1;
}

.action-info h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 6px 0;
}

.action-info p {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0;
  line-height: 1.5;
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.result-info {
  margin-top: 8px !important;
  font-weight: 500;
}
.result-info.has-error {
  color: #d4380d;
}
.result-info strong {
  color: #d4380d;
  font-size: 15px;
}

.divider {
  height: 1px;
  background: var(--border-light);
  margin: 0;
}


.category-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 14px;
}

.category-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  background: var(--content-bg);
  border: 1px solid rgba(255,255,255,0.72);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition: transform 0.25s ease, border-color 0.25s ease, background 0.25s ease;
}

.category-item:hover {
  transform: translateY(-2px);
  border-color: rgba(255,255,255,0.92);
  background: rgba(255,255,255,0.95);
}

.category-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.category-name {
  font-size: 14px;
  color: var(--text);
  font-weight: 500;
}

.category-count {
  font-size: 12px;
  color: var(--text-dim);
}

.category-bar {
  height: 8px;
  background: var(--bg-hover);
  border-radius: 999px;
  overflow: hidden;
}

.category-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--brand-start, #ff4d4f), var(--brand-end, #ff7a45));
  border-radius: 999px;
  transition: width 0.3s ease;
}

.loading-placeholder {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skeleton-line {
  height: 20px;
  background: var(--bg-hover);
  border-radius: 6px;
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-line.short {
  width: 60%;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* 响应式设计 */
@media (max-width: 768px) {
  .data-manager {
    padding: 16px;
  }

  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .stat-card {
    padding: 16px;
  }

  .stat-value {
    font-size: 24px;
  }

  .action-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .btn {
    width: 100%;
    justify-content: center;
  }

  .cache-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .path-value {
    max-width: 100%;
  }
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
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
  margin-top: 2px;
}
.back-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-bg);
  transform: translateX(-2px);
}
.back-btn svg { flex-shrink: 0; }
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

@media (max-width: 480px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .cache-actions {
    flex-direction: column;
  }

  .page-title {
    font-size: 22px;
  }
}
</style>