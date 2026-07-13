<template>
  <div class="app-layout">
    <Sidebar />
    <Header />
    <main ref="mainContentRef" class="main-content">
      <router-view v-slot="{ Component, route }">
        <transition :name="route.meta.transition || 'page'" mode="out-in">
          <component :is="Component" :key="route.path" />
        </transition>
      </router-view>
    </main>

    <footer class="footer-bar water-ripple" :class="{ 'footer-expanded': footerExpanded }">
      <div class="footer-row">
        <div class="footer-left" @click="footerExpanded = !footerExpanded">
          <div v-if="footerTasks.length > 0" class="footer-item">
            <span class="dot green pulse"></span>
            <span class="footer-rotate-text">
              <span class="footer-task-label">{{ footerTasks[footerRotateIndex]?.label || '' }}</span>
              <span v-if="footerTasks[footerRotateIndex]?.active > 0" class="tag tag-info">运行中 {{ footerTasks[footerRotateIndex].active }}</span>
              <span v-if="footerTasks[footerRotateIndex]?.waiting > 0" class="tag tag-default">等待 {{ footerTasks[footerRotateIndex].waiting }}</span>
            </span>
          </div>
          <div v-else class="footer-item">
            <span class="dot idle"></span> 空闲
          </div>
          <div class="footer-item">总漫画：<strong>{{ footerData.totalComics }}</strong></div>
          <div class="footer-item">并发：<strong>{{ footerData.activeDownloads }} / {{ footerData.downloadConcurrency }}</strong></div>
          <div v-if="footerData.downloadSpeed !== '0 B/s'" class="footer-item">速度：<strong>{{ footerData.downloadSpeed }}</strong></div>
          <div class="footer-item">硬盘：<strong>{{ footerData.diskFree }}</strong> 可用 / 共 {{ footerData.diskTotal }}</div>
          <div class="footer-item footer-expand-hint">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline :points="footerExpanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'"/>
            </svg>
          </div>
        </div>
        <div class="footer-right">
          <div class="resize-handle" title="拖拽调整窗口大小"></div>
        </div>
      </div>

      <div v-if="footerExpanded" class="footer-task-panel">
        <div v-if="footerTasks.length === 0" class="task-panel-empty">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>
          当前没有后台任务运行
        </div>
        <div v-for="task in footerTasks" :key="task.type" class="task-panel-item">
          <div class="task-panel-header">
            <span class="task-panel-icon">{{ taskIcons[task.icon] || '📋' }}</span>
            <span class="task-panel-label">{{ task.label }}</span>
            <span class="task-panel-stats">
              <span v-if="task.active > 0" class="tag tag-info">运行中 {{ task.active }}</span>
              <span v-if="task.waiting > 0" class="tag tag-default">等待 {{ task.waiting }}</span>
            </span>
          </div>
        </div>
        <div class="task-panel-footer">
          <span>作业队列：{{ footerData.activeDownloads }} 活跃 / {{ footerData.waitingCount }} 等待 / {{ footerData.completedCount }} 完成</span>
          <span v-if="footerData.failedCount > 0" style="color: var(--danger)"> / {{ footerData.failedCount }} 失败</span>
        </div>
      </div>
    </footer>

    <div class="notification-container">
      <div
v-for="n in notifications" :key="n.id"
        :class="['notification-toast', 'notification-' + n.type]"
        @click="removeNotification(n.id)">
        <span class="notification-title">{{ n.title }}</span>
        <span class="notification-body">{{ n.body }}</span>
      </div>
    </div>

    <nav class="mobile-nav">
      <router-link v-for="n in navItems" :key="n.path" :to="n.path" class="mobile-nav-item" active-class="active">
        <svg class="icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="n.iconSvg"></svg>
        <span>{{ n.label }}</span>
      </router-link>
    </nav>

    <SearchOverlay ref="searchOverlayRef" />
  </div>
</template>

<script setup>
import { ref, provide, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from '@/components/Sidebar.vue'
import Header from '@/components/Header.vue'
import SearchOverlay from '@/components/SearchOverlay.vue'

const route = useRoute()

const mainContentRef = ref(null)

watch(() => route.path, () => {
  if (mainContentRef.value) {
    mainContentRef.value.scrollTop = 0
  }
})

const notifications = ref([])
const searchOverlayRef = ref(null)

function addNotification(type, title, body) {
  const id = Date.now() + Math.random()
  notifications.value.push({ id, type, title, body })
  setTimeout(() => {
    notifications.value = notifications.value.filter(n => n.id !== id)
  }, 5000)
  try {
    new Notification(title, { body })
  } catch { /* 浏览器不支持 Electron Notification API */ }
}

function removeNotification(id) {
  notifications.value = notifications.value.filter(n => n.id !== id)
}

provide('notifications', notifications)
provide('addNotification', addNotification)

function openSearch(initialQuery = '') {
  searchOverlayRef.value?.openSearch?.(initialQuery)
}

provide('openSearch', openSearch)

const footerData = ref({
  downloadSpeed: '0 KB/s',
  finishedChapters: '-',
  totalComics: '-',
  diskFree: '-',
  diskTotal: '-',
  activeDownloads: 0,
  downloadConcurrency: 3,
  waitingCount: 0,
  completedCount: 0,
  failedCount: 0
})

const footerTasks = ref([])
const footerExpanded = ref(false)
const footerRotateIndex = ref(0)

let footerRotateTimer = null

const taskIcons = {
  sync: '🔄',
  crawl: '🕷️',
  enrich: '📝',
  download: '⬇️',
  task: '📋'
}

let footerTimer = null
let cleanupBgTasks = null

async function refreshFooterData() {
  try {
    const total = await window.dbApi?.getComicsCount?.() ?? '-'
    footerData.value.totalComics = total

    const stats = await window.jobApi?.stats?.() ?? {}
    footerData.value.activeDownloads = stats.active || 0
    footerData.value.waitingCount = stats.waiting || 0
    footerData.value.completedCount = stats.completed || 0
    footerData.value.failedCount = stats.failed || 0

    const bgTasks = await window.appApi?.getBackgroundTasks?.()
    if (bgTasks) {
      footerData.value.downloadConcurrency = bgTasks.downloadConcurrency || 3
      footerTasks.value = bgTasks.tasks || []
    }

    try {
      const settings = await window.settingsApi?.get?.()
      const downloadDir = settings?.downloadDir || '/Volumes/可移动磁盘/ComicDownloads'
      const diskInfo = await window.diskApi?.getSpace?.(downloadDir)
      if (diskInfo?.success) {
        footerData.value.diskFree = formatBytes(diskInfo.free || 0)
        footerData.value.diskTotal = formatBytes(diskInfo.total || 0)
      } else {
        footerData.value.diskFree = '-'
        footerData.value.diskTotal = '-'
      }
    } catch (e) {
      footerData.value.diskFree = '-'
      footerData.value.diskTotal = '-'
    }
  } catch (e) {
    console.warn('[footer] refresh failed', e)
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

let cleanupJobDone = null
let cleanupCrawlDone = null
let cleanupEnrichDone = null
let cleanupDownloadProgress = null
let cleanupJobProgress = null
let downloadSpeedTimer = null

let autoEnrichTimer = null

onMounted(() => {
  refreshFooterData()
  footerTimer = setInterval(refreshFooterData, 5000)
  footerRotateTimer = setInterval(() => {
    if (footerTasks.value.length > 0) {
      footerRotateIndex.value = (footerRotateIndex.value + 1) % footerTasks.value.length
    }
  }, 3000)

  if (window.appApi?.onBackgroundTasks) {
    cleanupBgTasks = window.appApi.onBackgroundTasks((data) => {
      footerData.value.downloadConcurrency = data.downloadConcurrency || 3
      footerData.value.activeDownloads = data.activeCount || 0
      footerData.value.waitingCount = data.waitingCount || 0
      footerData.value.completedCount = data.completedCount || 0
      footerData.value.failedCount = data.failedCount || 0
      footerTasks.value = data.tasks || []
      if (footerTasks.value.length > 0 && footerRotateIndex.value >= footerTasks.value.length) {
        footerRotateIndex.value = 0
      }
    })
  }

  if (window.offlineApi?.onJobDone) {
    cleanupJobDone = window.offlineApi.onJobDone((data) => {
      addNotification('success', '下载完成', `${data.comicTitle || data.title || '漫画'} 已下载到本地`)
    })
  }
  if (window.crawlerApi?.onDone) {
    cleanupCrawlDone = window.crawlerApi.onDone((data) => {
      addNotification('info', '爬虫抓取完成', `新增 ${data?.added || '若干'} 部漫画`)
    })
  }
  if (window.crawlerApi?.onEnrichDone) {
    cleanupEnrichDone = window.crawlerApi.onEnrichDone((data) => {
      addNotification('info', '标签补全完成', `共处理 ${data?.enriched || '若干'} 部漫画`)
    })
  }

  if (window.downloadApi?.onProgress) {
    cleanupDownloadProgress = window.downloadApi.onProgress((data) => {
      if (data?.speed) {
        footerData.value.downloadSpeed = data.speed
        if (downloadSpeedTimer) clearTimeout(downloadSpeedTimer)
        downloadSpeedTimer = setTimeout(() => {
          footerData.value.downloadSpeed = '0 KB/s'
        }, 5000)
      }
    })
  }

  if (window.downloadApi?.onJobProgress) {
    cleanupJobProgress = window.downloadApi.onJobProgress((data) => {
      if (data?.speed) {
        footerData.value.downloadSpeed = data.speed
        if (downloadSpeedTimer) clearTimeout(downloadSpeedTimer)
        downloadSpeedTimer = setTimeout(() => {
          footerData.value.downloadSpeed = '0 KB/s'
        }, 5000)
      }
    })
  }

  // 延迟10秒后自动补全：一次爬取详情页，把简介/分类/作者/状态/章节数等所有字段一次性写入数据库
  autoEnrichTimer = setTimeout(async () => {
    try {
      if (window.detailApi?.autoEnrichAll) {
        console.log('[Auto Enrich] 开始补全漫画字段（一次性）...')
        const result = await window.detailApi.autoEnrichAll()
        if (result.success && result.enrichedCount > 0) {
          addNotification('success', '字段补全完成', `成功补全 ${result.enrichedCount} 部漫画的所有字段`)
        }
      }
    } catch (e) {
      console.warn('[Auto Enrich] 补全失败:', e)
    }
  }, 10000)

  window.addEventListener('keydown', handleGlobalKeydown)
})

onBeforeUnmount(() => {
  if (footerTimer) clearInterval(footerTimer)
  if (footerRotateTimer) clearInterval(footerRotateTimer)
  if (cleanupBgTasks) cleanupBgTasks()
  if (autoEnrichTimer) clearTimeout(autoEnrichTimer)
  if (cleanupJobDone) cleanupJobDone()
  if (cleanupCrawlDone) cleanupCrawlDone()
  if (cleanupEnrichDone) cleanupEnrichDone()
  if (cleanupDownloadProgress) cleanupDownloadProgress()
  if (cleanupJobProgress) cleanupJobProgress()
  if (downloadSpeedTimer) clearTimeout(downloadSpeedTimer)
  window.removeEventListener('keydown', handleGlobalKeydown)
})

function handleGlobalKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    openSearch()
  }
}

const navItems = [
  { 
    path: '/comic-list', 
    label: '漫画列表', 
    iconSvg: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'
  },
  { 
    path: '/bookshelf', 
    label: '漫画书架', 
    iconSvg: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'
  },
  { 
    path: '/download-queue', 
    label: '下载', 
    iconSvg: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
  },
  { 
    path: '/epub-gen', 
    label: 'EPub 生成', 
    iconSvg: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>'
  },
  { 
    path: '/settings', 
    label: '设置', 
    iconSvg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  }
]
</script>

<style scoped>
.app-layout {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: var(--header-h) 1fr auto;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
  background-image: radial-gradient(circle at top left, rgba(255,255,255,0.4), transparent 24%), radial-gradient(circle at bottom right, var(--brand-bg), transparent 20%);
}

.main-content {
  grid-column: 2;
  grid-row: 2;
  overflow-y: auto;
  padding: 24px 28px;
  background: var(--content-bg);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(18px);
}

.footer-bar {
  grid-column: 2;
  grid-row: 3;
  background: var(--shell-bg);
  border-top: 1px solid var(--shell-border);
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: var(--text-sub);
  z-index: 10;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(18px);
  position: relative;
  overflow: hidden;
}

.footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: var(--footer-h);
  min-height: var(--footer-h);
  flex-shrink: 0;
}

.footer-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.footer-expand-hint {
  margin-left: auto;
  color: var(--text-dim);
  opacity: 0.5;
  transition: opacity 0.2s;
}

.footer-bar:hover .footer-expand-hint {
  opacity: 1;
}

.footer-task-panel {
  width: 100%;
  padding: 12px 24px 16px;
  border-top: 1px solid var(--shell-border);
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-sizing: border-box;
}

.task-panel-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 0;
}

.task-panel-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task-panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-panel-icon {
  font-size: 14px;
}

.task-panel-label {
  font-weight: 600;
  color: var(--text);
  font-size: 13px;
}

.task-panel-stats {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.task-panel-footer {
  font-size: 11px;
  color: var(--text-dim);
  padding-top: 4px;
  border-top: 1px solid var(--glass-border);
}

.notification-toast {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 18px;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  animation: notifIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-width: 340px;
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid var(--shell-border);
  background: var(--shell-bg);
  color: var(--text);
  backdrop-filter: blur(16px);
}

.mobile-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: var(--shell-bg);
  border-top: 1px solid var(--shell-border);
  z-index: 100;
  justify-content: space-around;
  align-items: center;
  padding-bottom: env(safe-area-inset-bottom);
  backdrop-filter: blur(18px);
}

.mobile-nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  height: 100%;
  color: var(--text-dim);
  font-size: 10px;
  transition: color 0.15s;
  text-decoration: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-nav-item.active {
  color: var(--brand);
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 20px;
  cursor: pointer;
  user-select: none;
  flex: 1;
  overflow: hidden;
  min-width: 0;
}

.footer-right {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  app-region: no-drag;
  flex-shrink: 0;
  margin-left: 12px;
}

.resize-handle {
  width: 20px;
  height: 14px;
  cursor: nwse-resize;
  position: relative;
}

.resize-handle::after {
  content: '';
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--text-dim);
  border-bottom: 2px solid var(--text-dim);
}

.footer-item strong {
  color: var(--text);
  font-weight: 600;
}

.notification-container {
  position: fixed;
  bottom: calc(var(--footer-h) + 12px);
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.notification-toast {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  animation: notifIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-width: 340px;
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid;
  backdrop-filter: blur(12px);
}
.notification-success { background: rgba(16, 185, 129, 0.08); color: var(--success); border-color: rgba(16, 185, 129, 0.2); }
.notification-info    { background: rgba(99, 102, 241, 0.08); color: var(--brand); border-color: rgba(99, 102, 241, 0.2); }
.notification-warning { background: rgba(245, 158, 11, 0.08); color: var(--warning); border-color: rgba(245, 158, 11, 0.2); }
.notification-error   { background: rgba(239, 68, 68, 0.08); color: var(--error); border-color: rgba(239, 68, 68, 0.2); }
.notification-title { font-weight: 600; white-space: nowrap; font-size: 13px; }
.notification-body { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
@keyframes notifIn {
  from { opacity: 0; transform: translateX(30px) translateY(4px); }
  to   { opacity: 1; transform: translateX(0) translateY(0); }
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}

.dot.green {
  background: var(--success);
}

.dot.pulse {
  animation: dotPulse 1.5s ease-in-out infinite;
}

.dot.idle {
  background: var(--text-dim);
  opacity: 0.4;
}

.footer-rotate-text {
  display: flex;
  align-items: center;
  gap: 8px;
  transition: opacity 0.3s ease;
}

.footer-task-label {
  font-weight: 600;
  color: var(--text);
}

@keyframes dotPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.dot.blue {
  background: var(--brand);
}

.mobile-nav {
  display: none;
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 56px;
  background: var(--shell-bg);
  border-top: 1px solid var(--shell-border);
  z-index: 100;
  justify-content: space-around;
  align-items: center;
  padding-bottom: env(safe-area-inset-bottom);
  backdrop-filter: blur(18px);
}

.mobile-nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  flex: 1;
  height: 100%;
  color: var(--text-dim);
  font-size: 10px;
  transition: color 0.15s;
  text-decoration: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mobile-nav-item.active {
  color: var(--brand);
}

.mobile-nav-item .icon {
  width: 24px;
  height: 24px;
}

@media (max-width: 768px) {
  .sidebar {
    display: none;
  }

  .mobile-nav {
    display: flex;
  }

  .main-content {
    padding: 4px 8px;
    padding-bottom: 68px;
  }

  .footer-bar {
    display: none;
  }
}
</style>