<template>
  <div class="epub-gen-page">
    <div class="page-header-with-back">
      <button class="back-btn" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        返回
      </button>
      <div class="header-titles">
        <h1 class="page-title">EPUB 生成</h1>
        <p class="page-subtitle">将漫画导出为 EPUB 格式</p>
      </div>
    </div>

    <!-- 加载提示 -->
    <div v-if="loading" class="loading-state">加载中...</div>

    <!-- 步骤1：选择漫画 -->
    <div class="section">
      <h3>① 选择来源</h3>
      <div class="source-tabs">
        <button :class="{ active: sourceType === 'downloaded' }" @click="sourceType = 'downloaded'">已下载漫画</button>
        <button :class="{ active: sourceType === 'history' }" @click="sourceType = 'history'">阅读历史</button>
      </div>
      <!-- 漫画列表 -->
      <div v-if="!loading" class="comic-select">
        <div class="search-bar">
          <input v-model="searchQuery" placeholder="搜索..." />
        </div>
        <div v-if="filteredComics.length === 0" class="empty-state">
          <p v-if="sourceType === 'downloaded'">暂无已下载漫画</p>
          <p v-else>暂无阅读历史</p>
        </div>
        <div
v-for="comic in filteredComics" :key="comic.id"
          class="comic-item"
          :class="{ selected: selectedId === comic.id }"
          @click="selectComic(comic)">
          <div v-if="comic.cover" class="comic-cover">
            <img :src="resolveCover(comic.cover)" :alt="comic.title" />
          </div>
          <div class="comic-info">
            <div class="comic-title">{{ comic.title }}</div>
            <div class="comic-meta">{{ comic.meta || '' }}</div>
          </div>
          <div v-if="selectedId === comic.id" class="check-mark">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        </div>
      </div>
    </div>

    <!-- 步骤2：章节选择 & 选项 -->
    <div v-if="selectedComic" class="section">
      <h3>② 输出选项</h3>
      <div class="options">
        <label class="opt-row"><span>格式</span><select v-model="format"><option value="epub">EPUB</option><option value="cbz">CBZ</option></select></label>
        <label class="opt-row"><span>包含元数据</span><input v-model="includeMeta" type="checkbox" /></label>
        <label class="opt-row"><span>分卷方式</span>
          <select v-model="volumeMode">
            <option value="single">不分卷（单文件）</option>
            <option value="auto">自动分卷（每卷50章）</option>
            <option value="custom">自定义每卷章节数</option>
          </select>
        </label>
        <label v-if="volumeMode === 'custom'" class="opt-row"><span>每卷章节数</span>
          <input v-model.number="chaptersPerVolume" type="number" min="1" max="200" style="width:80px" />
        </label>
        <label class="opt-row"><span>图片质量</span>
          <select v-model="imageQuality">
            <option value="original">原图</option>
            <option value="high">高清（压缩80%）</option>
            <option value="medium">标清（压缩50%）</option>
          </select>
        </label>
        <label class="opt-row"><span>章节范围</span>
          <select v-model.number="rangeStart">
            <option v-for="(ch, i) in chapters" :key="i" :value="i">{{ ch.name || ch.title || `第${i+1}章` }}</option>
          </select>
          ~
          <select v-model.number="rangeEnd">
            <option v-for="(ch, i) in chapters" :key="i" :value="i">{{ ch.name || ch.title || `第${i+1}章` }}</option>
          </select>
          <span class="range-info">{{ Math.max(0, rangeEnd - rangeStart + 1) }} 章</span>
        </label>
        <div v-if="volumeMode !== 'single'" class="opt-row volume-preview">
          <span>预计分卷</span>
          <span class="volume-info">{{ volumeCount }} 卷，每卷约 {{ avgChaptersPerVolume }} 章</span>
        </div>
      </div>
    </div>

    <!-- 生成按钮 & 进度 -->
    <div v-if="selectedComic" class="action-bar">
      <button class="btn-generate" :disabled="generating" @click="startConvert">
        {{ generating ? '生成中...' : `生成 ${format.toUpperCase()}` }}
      </button>
      <div v-if="generating" class="progress-bar">
        <div class="fill" :style="{ width: progress + '%' }"></div>
        <span class="progress-text">{{ Math.round(progress) }}%</span>
      </div>
      <div v-if="resultMsg" :class="['result-msg', resultOk ? 'success' : 'error']">
        <div>{{ resultMsg }}</div>
        <div v-if="resultPaths.length > 0" class="result-paths">
          <div v-for="(p, i) in resultPaths" :key="i" class="result-path-item">
            <span class="path-label">卷 {{ i + 1 }}:</span>
            <span class="path-value">{{ p }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute()

// 将封面路径转换为可加载的 URL（本地文件需通过代理）
function resolveCover(cover) {
  if (!cover) return ''
  const src = String(cover)
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return window.utils ? window.utils.toLocalUrl(src) : src
}

function goBack() {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.push('/settings')
  }
}

const loading = ref(true)
const sourceType = ref('downloaded')
const downloadedComics = ref([])
const historyComics = ref([])
const chapters = ref([])
const selectedComic = ref(null)
const selectedId = ref(null)
const searchQuery = ref('')
const generating = ref(false)
const progress = ref(0)
const resultMsg = ref('')
const resultOk = ref(false)
const resultPaths = ref([])
const format = ref('epub')
const includeMeta = ref(true)
const rangeStart = ref(0)
const rangeEnd = ref(0)
const volumeMode = ref('single')
const chaptersPerVolume = ref(50)
const imageQuality = ref('original')

const selectedChapterCount = computed(() => Math.max(0, rangeEnd.value - rangeStart.value + 1))

const volumeCount = computed(() => {
  if (volumeMode.value === 'single') return 1
  const perVol = chaptersPerVolume.value || 100
  return Math.ceil(selectedChapterCount.value / perVol)
})

const avgChaptersPerVolume = computed(() => {
  if (volumeMode.value === 'single') return selectedChapterCount.value
  const count = volumeCount.value
  return count > 0 ? Math.round(selectedChapterCount.value / count) : 0
})

const filteredComics = computed(() => {
  const arr = sourceType.value === 'downloaded' ? downloadedComics.value : historyComics.value
  if (!searchQuery.value) return arr
  const q = searchQuery.value.toLowerCase()
  return arr.filter(c => (c.title || '').toLowerCase().includes(q))
})

async function loadData() {
  loading.value = true
  try {
    const dl = await window.exportApi?.listDownloads?.() || []
    downloadedComics.value = dl
  } catch (e) { console.warn('listDownloads fail', e) }

  try {
    const hist = await window.progressApi?.history?.() || []
    const seen = new Set()
    historyComics.value = hist.filter(h => {
      const title = h.comic?.title || ''
      if (seen.has(title)) return false
      seen.add(title)
      return true
    })
  } catch (e) { console.warn('history fail', e) }

  try {
    const saved = await window.settingsApi?.get()
    if (saved) {
      if (saved.epubVolumeMode) volumeMode.value = saved.epubVolumeMode
      if (saved.epubChaptersPerVolume) chaptersPerVolume.value = saved.epubChaptersPerVolume
      if (saved.epubImageQuality) imageQuality.value = saved.epubImageQuality
      if (typeof saved.epubIncludeMeta === 'boolean') includeMeta.value = saved.epubIncludeMeta
    }
  } catch (e) { console.warn('load settings fail', e) }

  // 如果从漫画详情页跳转过来，自动选择该漫画
  const comicId = route.query.comicId
  if (comicId && downloadedComics.value.length > 0) {
    const comic = downloadedComics.value.find(c => c.id === comicId || c._id === comicId)
    if (comic) {
      await selectComic(comic)
    }
  }

  loading.value = false
}

async function selectComic(comic) {
  selectedComic.value = comic
  selectedId.value = comic.id
  try {
    // 从下载目录读取真实章节列表
    const chs = await window.exportApi?.getDownloadChapters?.(comic.title) || []
    chapters.value = chs
  } catch (e) {
    chapters.value = []
  }
  rangeStart.value = 0
  rangeEnd.value = Math.max(0, chapters.value.length - 1)
}

async function startConvert() {
  if (!selectedComic.value || generating.value) return
  generating.value = true
  progress.value = 0
  resultMsg.value = ''

  try {
    const selectedChapters = chapters.value.slice(rangeStart.value, rangeEnd.value + 1)
    const payload = {
      comicTitle: selectedComic.value.title,
      format: format.value,
      chapters: selectedChapters.map((ch, i) => ({
        index: rangeStart.value + i,
        name: ch.name || ch.title || `第${rangeStart.value + i + 1}章`
      })),
      volumeMode: volumeMode.value,
      chaptersPerVolume: volumeMode.value === 'single' ? undefined : chaptersPerVolume.value,
      imageQuality: imageQuality.value
    }
    // 传递元数据
    if (includeMeta.value) {
      payload.meta = {
        title: selectedComic.value.title,
        author: '未知',
        description: `《${selectedComic.value.title}》导出`,
        language: 'zh-CN'
      }
    }
    const result = await window.exportApi.fromDownload(payload)

    if (result?.success) {
      resultOk.value = true
      if (result.volumeCount && result.volumeCount > 1) {
        resultMsg.value = `EPUB 分卷生成成功！共 ${result.volumeCount} 卷`
        resultPaths.value = result.paths || []
      } else {
        resultMsg.value = `${format.value.toUpperCase()} 生成成功！${result.path ? '文件: ' + result.path : ''}`
        resultPaths.value = result.path ? [result.path] : []
      }
      progress.value = 100
    } else {
      resultOk.value = false
      resultMsg.value = result?.error || '生成失败'
      resultPaths.value = []
    }
  } catch (e) {
    resultOk.value = false
    resultMsg.value = `错误：${e.message || e}`
    resultPaths.value = []
  } finally {
    generating.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.epub-gen-page { padding: 24px; max-width: 800px; margin: 0 auto; }
h2 { margin-bottom: 28px; font-size: 24px; font-weight: 700; color: var(--text); }
h3 { font-size: 17px; font-weight: 600; margin-bottom: 16px; color: var(--text); }
.section { margin-bottom: 28px; }
.loading-state { text-align: center; padding: 80px; color: var(--text-dim); }

.source-tabs { display: flex; margin-bottom: 16px; background: rgba(255,255,255,0.86); padding: 6px; border-radius: var(--radius-lg); border: 1px solid rgba(255,255,255,0.76); backdrop-filter: blur(14px); }
.source-tabs button { flex: 1; padding: 12px; border: none; cursor: pointer; border-radius: var(--radius); font-size: 14px; font-weight: 500; transition: all .25s cubic-bezier(0.4, 0, 0.2, 1); }
.source-tabs button:not(.active) { color: var(--text-sub); background: transparent; }
.source-tabs button:not(.active):hover { background: rgba(255,245,238,0.9); }
.source-tabs button.active { background: var(--gradient-brand); color: #fff; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3); }

.search-bar input { width: 100%; padding: 10px 14px; border: 1px solid var(--border-light); border-radius: var(--radius-lg); background: var(--bg-card); font-size: 14px; color: var(--text); outline: none; transition: all .25s; box-shadow: var(--shadow-sm); }
.search-bar input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1), var(--shadow); }
.search-bar input::placeholder { color: var(--text-dim); }

.empty-state { text-align: center; padding: 60px; color: var(--text-dim); }

.comic-item { display: flex; align-items: center; gap: 14px; padding: 14px; border: 1px solid rgba(255,255,255,0.75); border-radius: var(--radius-lg); margin-bottom: 10px; cursor: pointer; background: rgba(255,255,255,0.84); transition: all .25s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: var(--shadow-sm); backdrop-filter: blur(14px); }
.comic-item:hover { border-color: var(--brand); transform: translateX(4px); box-shadow: var(--shadow); }
.comic-item.selected { border-color: var(--brand); background: rgba(99, 102, 241, 0.05); }
.comic-cover { width: 52px; height: 68px; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
.comic-cover img { width: 100%; height: 100%; object-fit: cover; }
.comic-info { flex: 1; min-width: 0; }
.comic-title { font-weight: 600; font-size: 14px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.comic-meta { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.check-mark { font-size: 20px; color: var(--brand); font-weight: 700; }

.options { display: flex; flex-direction: column; gap: 16px; background: var(--bg-card); padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--border-light); }
.opt-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.opt-row span:first-child { min-width: 80px; font-size: 14px; color: var(--text-sub); font-weight: 500; }
.opt-row select { padding: 8px 14px; border: 1px solid var(--border-light); border-radius: var(--radius); background: var(--bg-card); font-size: 13px; color: var(--text); outline: none; cursor: pointer; transition: all .2s; }
.opt-row select:hover { border-color: var(--border); }
.opt-row select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); }
.opt-row input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; accent-color: var(--brand); }
.opt-row .range-info { font-size: 12px; color: var(--text-dim); padding: 4px 12px; background: var(--bg-hover); border-radius: 6px; }

.action-bar { margin-top: 28px; }
.btn-generate { padding: 14px 40px; background: var(--gradient-brand); color: #fff; border: none; border-radius: var(--radius-lg); cursor: pointer; font-size: 15px; font-weight: 600; transition: all .25s cubic-bezier(0.4, 0, 0.2, 1); }
.btn-generate:not(:disabled):hover { transform: translateY(-2px); box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4); }
.btn-generate:disabled { opacity: .5; cursor: not-allowed; }

.progress-bar { margin-top: 16px; height: 8px; border-radius: 4px; position: relative; }
.progress-bar .fill { border-radius: 4px; }
.progress-text { position: absolute; top: 14px; right: 0; font-size: 13px; font-weight: 600; color: var(--text-sub); }

.result-msg { margin-top: 16px; padding: 14px 16px; border-radius: var(--radius-lg); font-size: 14px; }
.result-msg.success { background: var(--success-bg); color: var(--success); border: 1px solid rgba(34, 197, 94, 0.2); }
.result-msg.error { background: var(--error-bg); color: var(--error); border: 1px solid rgba(239, 68, 68, 0.2); }
.result-paths { margin-top: 10px; padding-top: 10px; border-top: 1px dashed rgba(0,0,0,0.1); }
.result-path-item { display: flex; gap: 8px; margin-top: 6px; font-size: 12px; }
.result-path-item .path-label { color: var(--text-sub); font-weight: 500; white-space: nowrap; }
.result-path-item .path-value { color: var(--text); word-break: break-all; }

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