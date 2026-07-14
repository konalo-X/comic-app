<template>
  <div class="download-page">
    <div class="page-header-with-back">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回
      </button>
      <div class="header-titles">
        <h1 class="page-title">{{ activeTab === 'history' ? '下载历史' : activeTab === 'health' ? '健康检查' : '下载队列' }}</h1>
        <p class="page-subtitle">{{ activeTab === 'history' ? '查看已完成的下载记录' : activeTab === 'health' ? '检测并修复不完整的下载' : '管理正在下载和等待中的任务' }}</p>
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
      <button 
        :class="['tab-item', { active: activeTab === 'health' }]" 
        @click="activeTab = 'health'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <span class="tab-label">健康检查</span>
        <span v-if="healthIssues.length > 0" class="tab-badge">{{ healthIssues.length }}</span>
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
          <button class="btn btn-ghost btn-sm" @click="debugJobs">🔍 调试</button>
          <button class="btn btn-ghost btn-sm" @click="cleanupDuplicates">🧹 清理重复</button>
          <button class="btn btn-secondary btn-sm" @click="pauseAll">⏸ 全部暂停</button>
          <button class="btn btn-primary btn-sm" @click="startAll">▶ 全部开始</button>
        </div>
      </div>

      <div class="card queue-card water-ripple">
        <div v-for="g in taskGroups" :key="g.comic" class="task-group">
          <!-- 漫画分组标题行(可折叠) -->
          <div class="group-header" @click="toggleGroup(g.comic)">
            <span class="group-caret" :class="{ expanded: g.expanded }">▶</span>
            <div class="group-info">
              <div class="group-title">{{ g.comic }}</div>
              <div class="group-meta text-sub">{{ g.count }} 个章节 · {{ groupStatusText(g) }}</div>
            </div>
            <span :class="['task-status-text', statusCls({ status: g.groupStatus })]">
              {{ g.downloadingCount ? '下载中' : g.groupStatus === 'paused' ? '已暂停' : g.groupStatus === 'done' ? '已完成' : '等待中' }}
            </span>
            <div class="row gap-4 group-actions" @click.stop>
              <button v-if="g.downloadingCount" class="btn btn-secondary btn-sm" @click="pauseGroup(g)">全暂停</button>
              <button v-if="g.pausedCount || g.queuedCount" class="btn btn-primary btn-sm" @click="resumeGroup(g)">全继续</button>
              <button class="btn btn-ghost btn-sm" @click="removeGroup(g)">移除全部</button>
            </div>
          </div>
          <!-- 展开后的章节明细 -->
          <div v-show="g.expanded" class="group-children">
            <div v-for="t in g.items" :key="t.id" class="task-row">
              <div class="task-info">
                <div class="task-title">{{ t.chapter }}</div>
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
        </div>
      </div>

      <div v-if="!tasks.length" class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </div>
        <div class="empty-title">暂无下载任务</div>
        <div class="empty-desc">在漫画详情页点击「离线下载」按钮添加下载任务</div>
      </div>

      <!-- 失败任务 -->
      <div v-if="failedJobs.length" class="failed-jobs-section">
        <div class="section-header">
          <div class="row gap-12">
            <h2>❌ 失败任务</h2>
            <span class="tag tag-danger">{{ failedJobs.length }} 个失败</span>
          </div>
          <button class="btn btn-primary btn-sm" @click="retryAllFailed">🔄 全部重试</button>
        </div>
        <div class="card failed-job-card" v-for="fj in failedJobs" :key="fj.id">
          <div class="row between">
            <div>
              <div class="task-title">{{ fj.comic }} · {{ fj.chapter }}</div>
              <div class="text-danger" style="font-size: 12px; margin-top: 4px;">错误：{{ fj.error }}</div>
            </div>
            <div class="row gap-4">
              <button class="btn btn-primary btn-sm" @click="retryFailed(fj)">重试</button>
              <button class="btn btn-ghost btn-sm" @click="removeFailed(fj)">移除</button>
            </div>
          </div>
        </div>
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

      <div v-for="group in downloadGroups" :key="group.title" class="card card-hover water-ripple" style="padding: 16px; margin-bottom: 16px;">
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

    <!-- 健康检查 Tab -->
    <div v-show="activeTab === 'health'" class="download-health">
      <div class="section-header">
        <div class="row gap-12">
          <h2>🩺 健康检查</h2>
          <span v-if="healthIssues.length > 0" class="tag tag-warning">{{ healthIssues.length }} 部漫画有问题</span>
          <span v-else-if="healthScanDone && healthIssues.length === 0" class="tag tag-success">所有漫画健康</span>
        </div>
        <div class="row gap-8">
          <button class="btn btn-ghost btn-sm" :disabled="healthScanning" @click="scanHealth(false)">
            {{ healthScanning ? '扫描中...' : '🔍 快速扫描' }}
          </button>
          <button class="btn btn-ghost btn-sm" :disabled="healthScanning" @click="scanHealth(true)">
            {{ healthScanning ? '扫描中...' : '🔬 深度扫描' }}
          </button>
          <button class="btn btn-primary btn-sm" :disabled="healthScanning || healthIssues.length === 0" @click="repairAll">
            🔧 修复全部
          </button>
        </div>
      </div>

      <div v-if="healthScanning" class="health-scanning">
        <div class="scanning-indicator">
          <div class="scanning-spinner"></div>
          <span>正在扫描已下载漫画...</span>
        </div>
      </div>

      <div v-if="!healthScanning && !healthScanDone" class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        </div>
        <div class="empty-title">点击扫描检查漫画完整性</div>
        <div class="empty-desc">快速扫描检测损坏和缺失文件，深度扫描额外比对在线图片数</div>
      </div>

      <div v-if="!healthScanning && healthScanDone && healthIssues.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        </div>
        <div class="empty-title">所有漫画健康</div>
        <div class="empty-desc">未检测到损坏或缺失的图片</div>
      </div>

      <div v-for="issue in healthIssues" :key="issue.comicDir" class="card card-hover health-issue-card water-ripple">
        <div class="row between" style="margin-bottom: 10px;">
          <div class="row gap-12">
            <h3 style="font-size: 15px; font-weight: 600;">{{ issue.dirName }}</h3>
            <span class="tag tag-warning">{{ issue.totalIssues }} 个问题</span>
            <span class="tag tag-default">{{ issue.totalChapters }} 章</span>
          </div>
          <div class="row gap-8">
            <button class="btn btn-ghost btn-sm" title="打开文件夹" @click="openFolder(issue.comicDir)">打开</button>
            <button class="btn btn-primary btn-sm" :disabled="issue.repairing" @click="repairOne(issue)">
              {{ issue.repairing ? '修复中...' : '🔧 修复' }}
            </button>
          </div>
        </div>

        <div class="issue-chapters">
          <div v-if="issue.missingCover" class="issue-chapter">
            <div class="row gap-8">
              <span class="chapter-name">📔 cover.webp</span>
              <span class="tag tag-warning">缺失封面</span>
            </div>
          </div>
          <div v-for="ch in issue.chapters.filter(c => !c.healthy)" :key="ch.dirName" class="issue-chapter">
            <div class="row gap-8">
              <span class="chapter-name">{{ ch.dirName }}</span>
              <span v-for="i in ch.issues" :key="i.message" :class="['tag', issueTagClass(i.type)]">{{ i.message }}</span>
            </div>
          </div>
        </div>

        <div v-if="issue.repairResult" class="repair-result" :class="{ 'repair-success': issue.repairResult.success, 'repair-fail': !issue.repairResult.success }">
          {{ issue.repairResult.success ? `修复完成: ${issue.repairResult.repairedChapters} 章, 补下 ${issue.repairResult.totalImagesFixed} 张图片` : `修复失败: ${issue.repairResult.error}` }}
        </div>
      </div>

      <div v-if="repairJobs.length > 0" class="repair-jobs-section">
        <div class="section-header" style="margin-top: 20px;">
          <div class="row gap-12">
            <h2>🔧 修复任务</h2>
            <span class="tag tag-info">{{ repairJobs.length }} 个任务</span>
          </div>
        </div>
        <div v-for="rj in repairJobs" :key="rj.jobId" class="card repair-job-card">
          <div class="row between">
            <div>
              <span class="text-sub">{{ rj.comicTitle }}</span>
              <span :class="['tag', rj.status === 'completed' ? 'tag-success' : rj.status === 'failed' ? 'tag-danger' : 'tag-info']" style="margin-left: 8px;">
                {{ rj.status === 'completed' ? '已完成' : rj.status === 'failed' ? '失败' : rj.status === 'running' || rj.status === 'active' ? '修复中' : '等待中' }}
              </span>
            </div>
          </div>
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

// 按漫画分组折叠: 同一本漫画的多个章节任务归为一组
const expandedGroups = ref(new Set())
function toggleGroup(comic) {
  const s = new Set(expandedGroups.value)
  if (s.has(comic)) s.delete(comic); else s.add(comic)
  expandedGroups.value = s
}
const taskGroups = computed(() => {
  const map = new Map()
  for (const t of tasks.value) {
    const key = t.comic || '未知漫画'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(t)
  }
  const groups = []
  for (const [comic, items] of map) {
    const downloadingCount = items.filter(t => t.status === 'downloading').length
    const queuedCount = items.filter(t => t.status === 'queued').length
    const pausedCount = items.filter(t => t.status === 'paused').length
    const doneCount = items.filter(t => t.status === 'done').length
    let groupStatus = 'queued'
    if (downloadingCount > 0) groupStatus = 'downloading'
    else if (pausedCount > 0 && queuedCount === 0) groupStatus = 'paused'
    else if (queuedCount === 0 && doneCount === items.length) groupStatus = 'done'
    groups.push({
      comic,
      items,
      count: items.length,
      downloadingCount,
      queuedCount,
      pausedCount,
      doneCount,
      groupStatus,
      expanded: expandedGroups.value.has(comic)
    })
  }
  // 下载中的组排前面, 其次按任务数降序
  groups.sort((a, b) => {
    if ((b.downloadingCount > 0) !== (a.downloadingCount > 0)) return b.downloadingCount - a.downloadingCount
    return b.count - a.count
  })
  return groups
})
function groupStatusText(g) {
  const parts = []
  if (g.downloadingCount) parts.push(`下载中 ${g.downloadingCount}`)
  if (g.queuedCount) parts.push(`等待 ${g.queuedCount}`)
  if (g.pausedCount) parts.push(`暂停 ${g.pausedCount}`)
  if (g.doneCount) parts.push(`完成 ${g.doneCount}`)
  return parts.join(' · ')
}
function pauseGroup(g) { for (const t of g.items) if (t.status === 'downloading') pauseTask(t) }
function resumeGroup(g) { for (const t of g.items) if (t.status === 'paused' || t.status === 'queued') resumeTask(t) }
function removeGroup(g) {
  if (!confirm(`确定移除「${g.comic}」的 ${g.count} 个下载任务?`)) return
  for (const t of [...g.items]) removeTask(t)
}

const healthIssues = ref([])
const healthScanning = ref(false)
const healthScanDone = ref(false)
const repairJobs = ref([])
const failedJobs = ref([])

function issueTagClass(type) {
  const map = { corrupt: 'tag-danger', empty_file: 'tag-danger', empty: 'tag-danger', gap: 'tag-warning', incomplete: 'tag-warning' }
  return map[type] || 'tag-default'
}

async function scanHealth(deepCheck) {
  healthScanning.value = true
  healthScanDone.value = false
  try {
    const result = await window.offlineApi?.checkAllHealth?.({ limit: 200, deepCheck: !!deepCheck })
    if (result?.success) {
      healthIssues.value = (result.issues || []).map(issue => ({
        ...issue,
        repairing: false,
        repairResult: null
      }))
    } else {
      healthIssues.value = []
    }
    healthScanDone.value = true
  } catch (e) {
    console.error('[健康检查] 扫描失败:', e)
    window.dispatchEvent(new CustomEvent('toast', { detail: `扫描失败: ${e.message}` }))
  } finally {
    healthScanning.value = false
  }
}

async function repairOne(issue) {
  if (!issue.sourceUrl) {
    window.dispatchEvent(new CustomEvent('toast', { detail: '无法修复: 缺少漫画源信息' }))
    return
  }
  issue.repairing = true
  issue.repairResult = null
  try {
    const result = await window.offlineApi?.repairComic?.({ sourceUrl: issue.sourceUrl, deepCheck: false })
    if (result?.success) {
      issue.repairResult = { success: true, repairedChapters: '已加入队列', totalImagesFixed: 0 }
      repairJobs.value.push({ jobId: result.jobId, comicTitle: issue.dirName, status: 'waiting' })
      window.dispatchEvent(new CustomEvent('toast', { detail: `已创建修复任务: ${issue.dirName}` }))
    } else {
      issue.repairResult = { success: false, error: result?.error || '未知错误' }
    }
  } catch (e) {
    issue.repairResult = { success: false, error: e.message }
  } finally {
    issue.repairing = false
  }
}

async function repairAll() {
  try {
    const result = await window.offlineApi?.repairAll?.({ deepCheck: false })
    if (result?.success) {
      window.dispatchEvent(new CustomEvent('toast', { detail: `已创建 ${result.enqueued} 个修复任务` }))
      healthIssues.value.forEach(issue => { issue.repairing = true })
    } else {
      window.dispatchEvent(new CustomEvent('toast', { detail: `修复失败: ${result?.error || '未知错误'}` }))
    }
  } catch (e) {
    window.dispatchEvent(new CustomEvent('toast', { detail: `修复失败: ${e.message}` }))
  }
}

function pct(t) { return t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0 }
function statusCls(t) { return { done: 'text-success', downloading: 'text-brand', queued: 'text-dim', paused: 'text-warning' }[t.status] || '' }

async function pauseAll() {
  for (const t of tasks.value) {
    if (t.status === 'downloading') {
      try {
        if (t.jobId && window.offlineApi) {
          await window.offlineApi.pauseJob(t.jobId)
        }
        t.status = 'paused'
        t.statusText = '暂停中'
      } catch (e) {
        console.error('[暂停] 失败:', t.jobId, e)
      }
    }
  }
}

async function startAll() {
  for (const t of tasks.value) {
    if (t.status === 'paused' || t.status === 'queued') {
      try {
        if (t.jobId && window.offlineApi) {
          await window.offlineApi.resumeJob(t.jobId)
        }
        t.status = 'downloading'
        t.statusText = '下载中'
      } catch (e) {
        console.error('[恢复] 失败:', t.jobId, e)
      }
    }
  }
}

async function pauseTask(task) {
  if (task.status === 'downloading') {
    try {
      if (task.jobId && window.offlineApi) {
        await window.offlineApi.pauseJob(task.jobId)
      }
      task.status = 'paused'
      task.statusText = '暂停中'
    } catch (e) {
      console.error('[暂停] 失败:', task.jobId, e)
    }
  }
}

async function resumeTask(task) {
  if (task.status === 'paused' || task.status === 'queued') {
    try {
      if (task.jobId && window.offlineApi) {
        await window.offlineApi.resumeJob(task.jobId)
      }
      task.status = 'downloading'
      task.statusText = '下载中'
    } catch (e) {
      console.error('[恢复] 失败:', task.jobId, e)
    }
  }
}

async function removeTask(task) {
  try {
    if (task.jobId && window.jobApi) {
      await window.jobApi.cancel(task.jobId)
    }
  } catch (e) {
    console.error('[移除] 取消失败:', task.jobId, e)
  }
  tasks.value = tasks.value.filter(t => t.id !== task.id)
}

async function retryFailed(job) {
  try {
    await window.jobApi?.retry?.(job.jobId)
    failedJobs.value = failedJobs.value.filter(j => j.id !== job.id)
    loadJobs()
    window.dispatchEvent(new CustomEvent('toast', { detail: `已重试：${job.comic}` }))
  } catch (e) {
    console.error('[重试] 失败:', job.jobId, e)
    window.dispatchEvent(new CustomEvent('toast', { detail: `重试失败: ${e.message}` }))
  }
}

async function retryAllFailed() {
  try {
    await window.jobApi?.retryAll?.()
    failedJobs.value = []
    loadJobs()
    window.dispatchEvent(new CustomEvent('toast', { detail: '已重试所有失败任务' }))
  } catch (e) {
    console.error('[全部重试] 失败:', e)
    window.dispatchEvent(new CustomEvent('toast', { detail: `重试失败: ${e.message}` }))
  }
}

async function removeFailed(job) {
  try {
    await window.jobApi?.cancel?.(job.jobId)
  } catch (e) {
    console.error('[移除失败任务] 失败:', job.jobId, e)
  }
  failedJobs.value = failedJobs.value.filter(j => j.id !== job.id)
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
let refreshTimer = null
let cleanupQueueChanged = null

onMounted(async () => {
  await loadRecords()
  await loadJobs()
  await loadFailedJobs()

  // 事件驱动刷新：任务队列变化时即时刷新
  if (window.jobApi?.onQueueChanged) {
    cleanupQueueChanged = window.jobApi.onQueueChanged(() => {
      if (activeTab.value === 'queue') {
        loadJobs()
        loadFailedJobs()
      }
    })
  }

  // 兜底轮询：每 30 秒刷新一次，防止事件丢失
  refreshTimer = setInterval(() => {
    if (activeTab.value === 'queue') {
      loadJobs()
      loadFailedJobs()
    }
  }, 30000)

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
  if (cleanupQueueChanged) cleanupQueueChanged()
  if (refreshTimer) clearInterval(refreshTimer)
})

function getComicDisplayName(payload) {
  if (payload?.comicTitle) return payload.comicTitle
  // 尝试从 sourceUrl 提取漫画名
  if (payload?.sourceUrl) {
    try {
      const url = new URL(payload.sourceUrl)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const lastPart = pathParts[pathParts.length - 1]
      if (lastPart) return `漫画(${lastPart})`
    } catch (_) {}
  }
  // 尝试从 chapter.url 提取
  if (payload?.chapter?.url) {
    try {
      const url = new URL(payload.chapter.url)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const comicPart = pathParts[pathParts.length - 2]
      if (comicPart) return `漫画(${comicPart})`
    } catch (_) {}
  }
  // 尝试从 referer 提取
  if (payload?.referer) {
    try {
      const url = new URL(payload.referer)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const lastPart = pathParts[pathParts.length - 1]
      if (lastPart) return `漫画(${lastPart})`
    } catch (_) {}
  }
  return '未知漫画'
}

function getChapterDisplayName(payload, isComic) {
  if (isComic) {
    const count = payload?.chapters?.length || 0
    return count > 0 ? `${count}个章节` : '整本下载'
  }
  if (payload?.chapter?.name) return payload.chapter.name
  if (payload?.chapter?.index !== undefined) return `第${payload.chapter.index + 1}章`
  // 尝试从 chapter.url 提取章节信息
  if (payload?.chapter?.url) {
    try {
      const url = new URL(payload.chapter.url)
      const pathParts = url.pathname.split('/').filter(Boolean)
      const lastPart = pathParts[pathParts.length - 1]
      if (lastPart) return `章节(${lastPart.substring(0, 20)})`
    } catch (_) {}
  }
  return '未知章节'
}

async function loadJobs() {
  try {
    // 查询所有活跃状态的任务（waiting + running + paused）
    const jobs = await window.jobApi?.list('active', 500) || []
    // 只显示下载相关的任务
    const downloadJobs = jobs.filter(j =>
      (j.type === 'downloadComic' || j.type === 'downloadChapter')
    )
    tasks.value = downloadJobs.map(j => {
      const isComic = j.type === 'downloadComic'
      let status = 'queued'
      let statusText = '等待中'
      if (j.status === 'running' || j.status === 'active') {
        status = 'downloading'
        statusText = '下载中'
      } else if (j.status === 'paused') {
        status = 'paused'
        statusText = '暂停中'
      }
      return {
        id: j.id,
        jobId: j.id,
        comic: getComicDisplayName(j.payload),
        chapter: getChapterDisplayName(j.payload, isComic),
        done: isComic ? (j.progress?.chapter != null ? j.progress.chapter : (j.progressCurrent || 0)) : (j.progress?.downloaded != null ? j.progress.downloaded : (j.progressCurrent || 0)),
        total: isComic ? (j.progress?.totalChapters != null ? j.progress.totalChapters : (j.progressTotal || (j.payload?.chapters?.length || 1))) : (j.progress?.total != null ? j.progress.total : (j.progressTotal || 1)),
        _unit: isComic ? '章' : '页',
        status,
        statusText
      }
    })
  } catch (e) {
    console.error('[下载队列] 加载失败:', e)
  }
}

async function loadFailedJobs() {
  try {
    const jobs = await window.jobApi?.list('failed', 50) || []
    const downloadJobs = jobs.filter(j =>
      j.type === 'downloadComic' || j.type === 'downloadChapter'
    )
    failedJobs.value = downloadJobs.map(j => ({
      id: j.id,
      jobId: j.id,
      comic: getComicDisplayName(j.payload),
      chapter: getChapterDisplayName(j.payload, j.type === 'downloadComic'),
      error: j.error || '未知错误',
      createdAt: j.createdAt
    }))
  } catch (e) {
    console.error('[失败任务] 加载失败:', e)
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

async function debugJobs() {
  try {
    const details = await window.jobApi?.getJobDetails?.()
    console.log('[调试] 任务详情:', details)
    alert('任务详情已输出到 Console，请按 Cmd+Option+I 查看')
  } catch (e) {
    console.error('[调试] 获取失败:', e)
  }
}

async function cleanupDuplicates() {
  try {
    const results = []
    const r1 = await window.jobApi?.cleanupDuplicateSyncs?.()
    if (r1) results.push(`Sync: ${r1.cancelled} 个重复已取消 (共 ${r1.total} 个)`)
    const r2 = await window.jobApi?.cleanupDuplicateDownloads?.()
    if (r2) results.push(`下载: ${r2.cancelled} 个重复已取消 (共 ${r2.total} 个)`)
    alert(results.length ? results.join('\n') : '没有重复任务')
  } catch (e) {
    console.error('[清理] 失败:', e)
    alert('清理失败: ' + e.message)
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

/* 漫画分组折叠 */
.task-group {
  margin-bottom: 12px;
  background: rgba(255,255,255,0.86);
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.76);
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(14px);
  overflow: hidden;
}
.task-group:last-child { margin-bottom: 0; }
.group-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.group-header:hover { background: rgba(255, 140, 90, 0.06); }
.group-caret {
  font-size: 10px; color: var(--text-dim, #999);
  transition: transform 0.2s; flex-shrink: 0;
}
.group-caret.expanded { transform: rotate(90deg); }
.group-info { flex: 1; min-width: 0; }
.group-title { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-meta { font-size: 11px; margin-top: 2px; }
.group-actions { flex-shrink: 0; }
.group-children {
  padding: 0 12px 10px 32px;
  border-top: 1px solid rgba(0,0,0,0.05);
}
.group-children .task-row {
  background: rgba(250,250,252,0.7);
  margin-top: 8px;
  margin-bottom: 0;
  padding: 10px 14px;
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
.task-progress { max-width: 220px; flex: 1; height: 8px; }
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

.health-issue-card {
  padding: 16px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255,255,255,0.75);
  box-shadow: var(--shadow-sm);
  background: rgba(255,255,255,0.88);
  backdrop-filter: blur(14px);
  margin-bottom: 16px;
}
.health-issue-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}
.issue-chapters {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.issue-chapter {
  padding: 6px 10px;
  background: rgba(0,0,0,0.03);
  border-radius: var(--radius);
  font-size: 12px;
}
.chapter-name {
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}
.repair-result {
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  font-weight: 500;
}
.repair-success {
  background: rgba(52, 199, 89, 0.1);
  color: #34c759;
}
.repair-fail {
  background: rgba(255, 59, 48, 0.1);
  color: #ff3b30;
}
.health-scanning {
  padding: 40px 0;
  text-align: center;
}
.scanning-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-sub);
  font-size: 14px;
}
.scanning-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255,95,80,0.2);
  border-top-color: var(--brand, #ff5f50);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.repair-job-card {
  padding: 12px 16px;
  border-radius: var(--radius);
  margin-bottom: 8px;
  font-size: 13px;
}
.download-health {
  animation: fadeIn 0.2s ease;
}

/* 失败任务区域 */
.failed-jobs-section {
  margin-top: 24px;
  animation: fadeIn 0.3s ease;
}
.failed-job-card {
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(239, 68, 68, 0.2);
  background: rgba(255, 255, 255, 0.88);
  backdrop-filter: blur(14px);
  margin-bottom: 12px;
  box-shadow: var(--shadow-sm);
}
.failed-job-card:hover {
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.1);
}
.text-danger {
  color: #ef4444;
}
</style>