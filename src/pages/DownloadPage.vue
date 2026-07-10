<template>
  <div class="download-page">
    <div class="page-header-with-back">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回
      </button>
      <div class="header-titles">
        <h1 class="page-title">{{ activeTab === 'history' ? '下载历史' : '下载队列' }}</h1>
        <p class="page-subtitle">{{ activeTab === 'history' ? '查看已完成的下载记录' : '管理正在下载和等待中的任务' }}</p>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="download-tabs">
      <button 
        :class="['tab-item', { active: activeTab === 'queue' }]" 
        @click="activeTab = 'queue'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        <span class="tab-label">下载队列</span>
        <span v-if="downloading.length > 0" class="tab-badge">{{ downloading.length }}</span>
      </button>
      <button 
        :class="['tab-item', { active: activeTab === 'history' }]" 
        @click="activeTab = 'history'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="tab-label">下载历史</span>
        <span v-if="downloadGroups.length > 0" class="tab-badge">{{ downloadGroups.length }}</span>
      </button>
    </div>

    <!-- 队列 Tab -->
    <div v-show="activeTab === 'queue'" class="download-queue">
      <div class="section-header">
        <div class="row gap-12">
          <h2>⬇ 下载队列</h2>
          <span class="tag tag-info">进行中 {{ downloading.length }} · 等待 {{ queued.length }}</span>
        </div>
        <div class="row gap-8">
          <button class="btn btn-secondary btn-sm" @click="pauseAll">⏸ 全部暂停</button>
          <button class="btn btn-primary btn-sm" @click="startAll">▶ 全部开始</button>
        </div>
      </div>

      <div class="card queue-card">
        <div v-for="t in tasks" :key="t.id" class="task-row">
          <div class="task-info">
            <div class="task-title">{{ t.comic }} · {{ t.chapter }}</div>
            <div class="row gap-8 mt-4">
              <span class="text-sub task-meta">{{ t.done }} / {{ t.total }} {{ t._unit || '页' }}</span>
              <span v-if="t.speed" class="text-sub task-meta">{{ t.speed }}</span>
            </div>
          </div>
          <div class="progress-bar task-progress">
            <div class="fill download" :style="{ width: pct(t) + '%' }"></div>
          </div>
          <span class="task-status">{{ pct(t) }}%</span>
          <span :class="['task-status-text', statusCls(t)]">{{ t.statusText }}</span>
          <div class="row gap-4 task-actions">
            <button v-if="t.status === 'downloading'" class="btn btn-secondary btn-sm" @click="pauseTask(t)">暂停</button>
            <button v-if="t.status === 'paused' || t.status === 'queued'" class="btn btn-primary btn-sm" @click="resumeTask(t)">继续</button>
            <button class="btn btn-ghost btn-sm" @click="removeTask(t)">移除</button>
            <button v-if="t.status === 'done'" class="btn btn-ghost btn-sm" title="打开文件夹" @click="openFolder(t.path)">打开</button>
          </div>
        </div>
      </div>

      <div v-if="!tasks.length" class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
        <div class="empty-title">暂无下载任务</div>
        <div class="empty-desc">在漫画详情页点击「离线下载」按钮添加下载任务</div>
      </div>
    </div>

    <!-- 历史 Tab -->
    <div v-show="activeTab === 'history'" class="download-history">
      <div class="section-header">
        <div class="row gap-12">
          <h2>下载历史</h2>
          <span class="tag tag-info">共 {{ downloadGroups.length }} 部漫画</span>
        </div>
      </div>

      <div v-if="!downloadGroups.length" class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>
        </div>
        <div class="empty-title">暂无下载记录</div>
        <div class="empty-desc">下载完成的漫画会显示在这里</div>
      </div>

      <div v-for="group in downloadGroups" :key="group.title" class="card card-hover" style="padding: 16px; margin-bottom: 16px;">
        <div class="row between" style="margin-bottom: 12px;">
          <div class="row gap-12">
            <h3 style="font-size: 15px; font-weight: 600;">{{ group.title }}</h3>
            <span class="tag tag-info">{{ group.chapters }} 章</span>
            <span class="tag tag-default">{{ group.path }}</span>
          </div>
          <div class="row gap-8">
            <button class="btn btn-ghost btn-sm" title="打开文件夹" @click="openFolder(group.path)">打开</button>
            <button class="btn btn-primary btn-sm" @click="exportComic(group.title, 'epub')">导出 EPUB</button>
            <button class="btn btn-secondary btn-sm" @click="exportComic(group.title, 'cbz')">导出 CBZ</button>
          </div>
        </div>

        <div class="text-sub" style="font-size: 11px;">
          最后下载：{{ group.latestDate }} · 共 {{ group.chapters }} 章 / {{ group.imagesCount }} 张图片
        </div>

        <div v-if="exporting === group.title" class="mt-8 text-accent" style="font-size: 12px;">
          正在导出 {{ group.title }}.{{ formatExport }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDownloadStore } from '../stores/downloadStore'

const route = useRoute()
const router = useRouter()
const downloadStore = useDownloadStore()
const activeTab = ref('queue')

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/settings')
  }
}

watch(() => route.name, (name) => {
  activeTab.value = name === 'downloadHistory' ? 'history' : 'queue'
}, { immediate: true })

const tasks = ref([])
const downloading = computed(() => tasks.value.filter(t => t.status === 'downloading'))
const queued = computed(() => tasks.value.filter(t => t.status === 'queued'))

function pct(t) { return t.total ? Math.round((t.done / t.total) * 100) : 0 }
function statusCls(t) { return { done: 'text-success', downloading: 'text-brand', queued: 'text-dim', paused: 'text-warning' }[t.status] || '' }

function pauseAll() {
  tasks.value.forEach(t => {
    if (t.status === 'downloading') {
      t.status = 'paused'
      t.statusText = '暂停中'
      if (t.jobId && window.jobApi) {
        window.jobApi.cancel(t.jobId)
      }
    }
  })
}

function startAll() {
  tasks.value.forEach(t => {
    if (t.status === 'paused' || t.status === 'queued') {
      t.status = 'downloading'
      t.statusText = '下载中'
      if (t.jobId && window.jobApi) {
        window.jobApi.retry(t.jobId)
      }
    }
  })
}

function pauseTask(task) {
  if (task.status === 'downloading') {
    task.status = 'paused'
    task.statusText = '暂停中'
    if (task.jobId && window.jobApi) {
      window.jobApi.cancel(task.jobId)
    }
  }
}

function resumeTask(task) {
  if (task.status === 'paused' || task.status === 'queued') {
    task.status = 'downloading'
    task.statusText = '下载中'
    if (task.jobId && window.jobApi) {
      window.jobApi.retry(task.jobId)
    }
  }
}

function removeTask(task) {
  if (task.jobId && window.jobApi) {
    window.jobApi.cancel(task.jobId)
  }
  tasks.value = tasks.value.filter(t => t.id !== task.id)
}

function openFolder(path) {
  if (!path) return
  if (window.windowApi?.openPath) {
    window.windowApi.openPath(path)
  }
}

const downloadGroups = ref([])
const exporting = ref('')
const formatExport = ref('epub')

let cleanupProgress = null
let cleanupDone = null

onMounted(async () => {
  await loadRecords()
  await loadJobs()

  if (window.offlineApi?.onJobProgress) {
    cleanupProgress = window.offlineApi.onJobProgress((data) => {
      const task = tasks.value.find(t => t.jobId === data.jobId)
      if (task) {
        if (data.totalChapters != null) {
          task.done = data.chapter || 0
          task.total = data.totalChapters
          task._unit = '章'
        } else {
          task.done = data.downloaded || data.current || 0
          task.total = data.total || 1
          task._unit = '页'
        }
        task.status = 'downloading'
        task.statusText = '下载中'
      }
    })
  }

  if (window.offlineApi?.onJobDone) {
    cleanupDone = window.offlineApi.onJobDone((data) => {
      const task = tasks.value.find(t => t.jobId === data.jobId)
      if (task) {
        task.status = 'done'
        task.statusText = '已完成'
        task.done = task.total
        loadRecords()
      }
    })
  }
})

onUnmounted(() => {
  if (cleanupProgress) cleanupProgress()
  if (cleanupDone) cleanupDone()
})

async function loadJobs() {
  try {
    const jobs = await window.jobApi?.list('active', 20) || []
    tasks.value = jobs.map(j => {
      const isComic = j.type === 'downloadComic'
      return {
        id: j.id,
        jobId: j.id,
        comic: isComic ? (j.payload?.comicTitle || '未知漫画') : (j.payload?.comicTitle || '未知漫画'),
        chapter: isComic ? (j.payload?.chapters?.length + '个章节') : (j.payload?.chapter?.name || '未知章节'),
        done: isComic ? (j.progress?.chapter || 0) : (j.progress?.downloaded || j.progress?.current || 0),
        total: isComic ? (j.progress?.totalChapters || 1) : (j.progress?.total || 1),
        _unit: isComic ? '章' : '页',
        status: j.status === 'running' ? 'downloading' : 'queued',
        statusText: j.status === 'running' ? '下载中' : '等待中'
      }
    })
  } catch (e) {
    console.error('[下载队列] 加载失败:', e)
  }
}

async function loadRecords() {
  try {
    const records = await window.offlineApi.listLocal()
    if (!records?.length) { downloadGroups.value = []; return }

    const map = {}
    for (const r of records) {
      if (!map[r.comicTitle]) {
        map[r.comicTitle] = { title: r.comicTitle, chapters: 0, imagesCount: 0, latestDate: '', path: r.path || '' }
      }
      map[r.comicTitle].chapters++
      map[r.comicTitle].imagesCount += r.imagesCount || 0
      const d = new Date(r.downloadedAt).toLocaleDateString('zh-CN')
      if (d > map[r.comicTitle].latestDate || !map[r.comicTitle].latestDate) map[r.comicTitle].latestDate = d
    }
    downloadGroups.value = Object.values(map).sort((a, b) => b.latestDate.localeCompare(a.latestDate))
  } catch (e) {
    console.error('[下载历史] 加载失败:', e)
  }
}

async function exportComic(title, format) {
  exporting.value = title
  formatExport.value = format
  try {
    const out = await window.offlineApi.exportComic(title, format)
    if (out) {
      window.dispatchEvent(new CustomEvent('toast', { detail: `${title}.${format} 已导出到下载目录` }))
    }
  } catch (e) {
    window.dispatchEvent(new CustomEvent('toast', { detail: `导出失败: ${e.message}` }))
  } finally {
    exporting.value = ''
  }
}
</script>

<style scoped>
.download-page {
  padding-top: 8px;
}

.download-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 20px;
  background: rgba(255,255,255,0.88);
  padding: 6px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.76);
  backdrop-filter: blur(16px);
}

.queue-card {
  padding: 2px;
  background: transparent;
  border: none;
  box-shadow: none;
}

.task-row {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 16px;
  background: rgba(255,255,255,0.86);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.76);
  margin-bottom: 12px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(14px);
}
.task-row:last-child { margin-bottom: 0; }
.task-info { flex: 1; min-width: 0; }
.task-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-meta { font-size: 11px; }
.task-progress { max-width: 220px; flex: 1; }
.task-progress .fill {
  border-radius: 999px;
}
.task-status {
  min-width: 52px;
  font-size: 12px;
  color: var(--text-sub);
  text-align: center;
}
.task-status-text {
  min-width: 72px;
  font-size: 12px;
  text-align: center;
}
.task-actions {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.download-history .card {
  padding: 16px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.75);
  box-shadow: var(--shadow-sm);
  background: rgba(255,255,255,0.88);
  backdrop-filter: blur(14px);
}
.download-history .card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.tab-item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  border: none;
  background: rgba(255,255,255,0.78);
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--text-sub);
  font-size: 14px;
  font-weight: 500;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.tab-item:hover {
  background: rgba(255,245,238,0.92);
  color: var(--text);
}

.tab-item.active {
  background: var(--gradient-brand);
  color: #fff;
  box-shadow: 0 8px 22px rgba(255, 95, 80, 0.2);
}

.tab-icon {
  transition: transform 0.25s;
}

.tab-item.active .tab-icon {
  transform: translateY(-1px);
}

.tab-badge {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  min-width: 20px;
  text-align: center;
}

.tab-item:not(.active) .tab-badge {
  background: var(--bg-hover);
  color: var(--text-sub);
}

.download-queue,
.download-history {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ===== 页面头部与返回键 ===== */
.page-header-with-back {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 20px;
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

@media (max-width: 768px) {
  .page-header-with-back {
    flex-direction: column;
    gap: 12px;
  }
  .page-title { font-size: 20px; }
}
</style>