<template>
  <div class="detail-page">
    <!-- 返回按钮 -->
    <div class="back-bar">
      <a class="back-link" href="javascript:;" @click="goBack">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        <span>返回列表</span>
      </a>
    </div>

    <div v-if="loadError" class="load-error card">
      <span class="load-error-text">加载失败，请重试</span>
      <button class="btn btn-sm btn-primary" @click="loadComics">重新加载</button>
    </div>

    <!-- 通过URL加载漫画 -->
    <div v-if="!selectedComic || !selectedComic.sourceUrl" class="url-load-section card">
      <div class="url-load-header">
        <h3>通过URL加载漫画</h3>
        <span class="url-load-hint">粘贴漫画详情页URL，直接获取漫画信息（无需搜索）</span>
      </div>
      <div class="url-load-form">
        <input
          v-model="urlInput"
          type="text"
          class="url-input"
          placeholder="例如: https://smtt6.com/man-hua-yue-du/12348418.html"
          @keyup.enter="loadByUrl"
        />
        <button class="btn btn-primary" :disabled="loadingByUrl || !urlInput.trim()" @click="loadByUrl">
          {{ loadingByUrl ? '加载中...' : '加载漫画' }}
        </button>
      </div>
    </div>

    <!-- 顶部信息区 -->
    <div v-if="selectedComic" class="detail-hero">
      <div class="hero-bg" :style="heroBgStyle"></div>
      <div class="hero-mask"></div>
      <div class="hero-content">
        <div class="hero-pic">
          <img v-if="selectedComic.cover" :src="resolveCover(selectedComic.cover)" :alt="selectedComic.title" referrerpolicy="no-referrer" @error="onImgError" />
          <div v-else class="hero-pic-placeholder" :style="{ background: gradient(selectedComic.title) }">
            <span>{{ selectedComic.title[0] }}</span>
          </div>
          <span v-if="epubExists" class="epub-badge">EPUB</span>
        </div>
        <div class="hero-info">
          <h1 class="hero-title">{{ selectedComic.title }}</h1>
          <div class="hero-meta-section">
            <span class="meta-label">状态：</span>
            <span v-if="selectedComic.status" class="meta-badge" :class="{ completed: isCompleted(selectedComic.status) }">{{ selectedComic.status }}</span>
          </div>
          <div v-if="selectedComic.tags && selectedComic.tags.length" class="hero-tags-section">
            <span class="meta-label">TAG：</span>
            <span v-for="tag in selectedComic.tags" :key="tag" class="tag-pill">{{ tag }}</span>
          </div>
          <div class="hero-meta-section">
            <span class="meta-label">作者：</span>
            <span v-if="selectedComic.author" class="meta-tag author-tag">{{ selectedComic.author }}</span>
          </div>
          <div class="hero-desc-section">
            <span class="meta-label">简介：</span>
            <div class="hero-desc-box">
              <p v-if="selectedComic.desc" class="hero-desc">{{ selectedComic.desc }}</p>
              <p v-else class="hero-desc hero-desc-empty">暂无简介，点击「补全详情」获取</p>
            </div>
          </div>
          <div class="hero-actions">
            <button 
              class="btn-read" 
              :class="{ disabled: !hasChapters }"
              :disabled="!hasChapters"
              @click="startReading"
            >
              <i class="icon">▶</i> {{ hasChapters ? '开始阅读' : '暂无章节' }}
            </button>
            <button 
              class="btn-fav" 
              :class="{ active: isFav }" 
              :disabled="!selectedComic"
              @click="toggleFav"
            >
              <i class="icon">{{ isFav ? '★' : '☆' }}</i> {{ isFav ? '已在书架' : '加入书架' }}
            </button>
            <button 
              class="btn-cache" 
              :class="{ loading: caching || isInQueue, disabled: isDownloadDisabled }" 
              :disabled="isDownloadDisabled"
              @click="cacheComic"
            >
              <i class="icon">{{ caching || isInQueue ? '⟳' : '⬇' }}</i> 
              {{ caching ? '下载中...' : (isInQueue ? '排队中...' : (!hasChapters ? '暂无章节' : (hasUpdate ? '下载更新' : (isDownloaded ? '已下载' : '下载漫画')))) }}
            </button>
            <button 
              class="btn-enrich" 
              :class="{ loading: enriching, disabled: !canEnrich }" 
              :disabled="enriching || !canEnrich"
              @click="enrichComic"
            >
              <i class="icon">{{ enriching ? '⟳' : 'ⓘ' }}</i> {{ enriching ? '补全中...' : '补全详情' }}
            </button>
            <button 
              class="btn-epub" 
              :class="{ loading: exportingEpub, disabled: !isDownloaded || epubExists }" 
              :disabled="exportingEpub || !isDownloaded || epubExists"
              @click="generateEpub"
            >
              <i class="icon">{{ exportingEpub ? '⟳' : '📖' }}</i> 
              {{ exportingEpub ? '生成中...' : (epubExists ? '已生成 EPUB' : '生成 EPUB') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 主体内容 -->
    <div class="detail-body">
      <!-- 左侧：章节列表 -->
      <div class="detail-main">
        <div class="section-card">
          <div class="section-header">
            <h3>漫画章节</h3>
            <div class="section-tools">
              <span class="chapter-count">共 {{ chapters.length }} 话</span>
              <button class="btn-sort" @click="sortDesc = !sortDesc">
                <i class="icon">{{ sortDesc ? '↓' : '↑' }}</i> 当前: {{ sortDesc ? '倒序' : '正序' }}
              </button>
            </div>
          </div>

          <div v-if="chapters.length === 0" class="empty-chapters">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
            </div>
            <div class="empty-text">暂无章节数据</div>
            <div class="empty-sub">请先爬取漫画详情</div>
          </div>

          <div v-else class="chapter-grid">
            <div
              v-for="(ch, idx) in sortedChapters"
              :key="ch.url"
              class="chapter-item"
              :class="{
                active: selectedChapter === ch.url,
                downloaded: downloadedChapterIndices.has(ch.sort_order ?? idx)
              }"
              @click="selectChapter(ch)"
            >
              <div class="ch-number">{{ ch.name }}</div>
              <div v-if="ch.title && ch.title !== ch.name" class="ch-title">{{ ch.title }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：漫画列表 + 推荐 -->
      <div class="detail-side">
        <!-- 漫画选择 -->
        <div class="section-card">
          <div class="section-header">
            <h3>漫画列表</h3>
          </div>
          <div class="comic-list-mini">
            <div
              v-for="c in comics"
              :key="c._id || c.sourceUrl"
              :class="['mini-item', { active: selectedId === (c._id || c.sourceUrl) }]"
              @click="selectComic(c)"
            >
              <div class="mini-thumb">
                <img v-if="c.cover" :src="resolveCover(c.cover)" referrerpolicy="no-referrer" @error="onImgError" />
                <div v-else class="mini-placeholder" :style="{ background: gradient(c.title) }">{{ c.title[0] }}</div>
                <span v-if="c.local_path" class="mini-source-badge local" title="本地漫画">本</span>
                <span v-else-if="c.sourceUrl" class="mini-source-badge online" title="在线漫画">线</span>
              </div>
              <div class="mini-info">
                <div class="mini-title">{{ c.title }}</div>
                <div class="mini-meta">
                  <span v-if="c.status">{{ c.status }}</span>
                  <span v-if="c.chapters">{{ c.chapters.length }}话</span>
                  <span v-if="c.local_path" class="meta-local">本地</span>
                  <span v-else-if="c.sourceUrl" class="meta-online">在线</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

const props = defineProps({
  id: { type: String, default: '' }
})

const comics = ref([])
const selectedId = ref('')
const selectedChapter = ref('')
const sortDesc = ref(false)
const caching = ref(false)
const enriching = ref(false)
const exportingEpub = ref(false)
const epubExists = ref(false)
const loadError = ref(false)
const urlInput = ref('')
const loadingByUrl = ref(false)
const downloadedChapterIndices = ref(new Set())

// 是否已下载
const isDownloaded = computed(() => {
  return !!selectedComic.value?.local_path
})

// 计算是否有更新（在线章节数 > 本地章节数）
const hasUpdate = computed(() => {
  if (!selectedComic.value) return false
  const onlineCount = selectedComic.value.chapter_count || 0
  const localCount = selectedComic.value.local_chapter_count || 0
  return isDownloaded.value && onlineCount > localCount
})

// 跟踪当前漫画是否在下载队列中
const isInQueue = ref(false)

// 跟踪是否正在自动获取章节
const autoFetchingChapters = ref(false)

// 计算是否有章节可下载
const hasChapters = computed(() => {
  return (selectedComic.value?.chapters?.length || 0) > 0
})

// 计算是否可以补全详情（需要 sourceUrl）
const canEnrich = computed(() => {
  return !!selectedComic.value?.sourceUrl
})

// 计算下载按钮是否应该禁用
const isDownloadDisabled = computed(() => {
  // 下载中或已在队列中 → 禁用（防止重复点击）
  if (caching.value || isInQueue.value) return true
  // 没有章节数据 → 禁用
  if (!hasChapters.value) return true
  // 已下载且无更新时禁用
  return isDownloaded.value && !hasUpdate.value
})

const selectedComic = computed(() => {
  return comics.value.find(c => (c._id || c.sourceUrl) === selectedId.value) || null
})

const chapters = computed(() => {
  return selectedComic.value?.chapters || []
})

const sortedChapters = computed(() => {
  const list = [...chapters.value]
  if (sortDesc.value) list.reverse()
  return list
})

const isFav = ref(false)

// 将封面路径转换为可加载的 URL（本地文件需通过代理）
function resolveCover(cover) {
  if (!cover) return ''
  const src = String(cover)
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src
  return window.utils ? window.utils.toLocalUrl(src) : src
}

function updateFavStatus() {
  if (!selectedComic.value) {
    isFav.value = false
    return
  }
  isFav.value = selectedComic.value.favorited || false
}

const heroBgStyle = computed(() => {
  if (!selectedComic.value?.cover) return {}
  return { backgroundImage: `url(${resolveCover(selectedComic.value.cover)})` }
})

const palette = [
  '#e5e5e5',
  '#dcdcdc',
  '#d4d4d4',
  '#cccccc',
  '#c5c5c5',
  '#bdbdbd',
  '#b5b5b5',
  '#adadad',
]

function gradient(title) {
  let hash = 0
  for (let i = 0; i < title.length; i++) hash = title.charCodeAt(i) + ((hash << 5) - hash)
  return palette[Math.abs(hash) % palette.length]
}

function onImgError(e) {
  e.target.style.display = 'none'
}

function isCompleted(status) {
  return /(完结|已完结)/.test(status)
}

function selectComic(c) {
  const id = c._id || c.sourceUrl
  selectedId.value = id
  selectedChapter.value = ''
  // 更新路由，但不触发页面刷新
  router.replace({ name: 'comicDetail', params: { id } })
}

function goBack() {
  router.push({ name: 'comicList' })
}

function selectChapter(ch) {
  selectedChapter.value = ch.url
  const comicId = selectedComic.value._id || selectedComic.value.sourceUrl
  const chapterIndex = sortedChapters.value.findIndex(c => c.url === ch.url)
  if (chapterIndex >= 0) {
    router.push({ name: 'readerChapter', params: { comicId, chapterIndex: String(chapterIndex) } })
  }
}

function startReading() {
  const chs = sortedChapters.value
  if (chs.length > 0) {
    const comicId = selectedComic.value._id || selectedComic.value.sourceUrl
    router.push({ name: 'reader', params: { comicId } })
    ensureFavorite()
  } else {
    alert('该漫画暂无章节内容，请先爬取漫画详情')
  }
}

// 自动加收藏: 点击阅读/下载时确保已在书架(不阻塞主流程, 失败仅记日志)
async function ensureFavorite() {
  if (!selectedComic.value || isFav.value) return
  const id = selectedComic.value._id || selectedComic.value.sourceUrl
  if (!window.dbApi?.setFavorite) return
  try {
    await window.dbApi.setFavorite(id, 1)
    selectedComic.value.favorited = 1
    isFav.value = true
  } catch (e) {
    console.error('[自动收藏] 失败:', e)
  }
}

async function toggleFav() {
  if (!selectedComic.value) return
  const id = selectedComic.value._id || selectedComic.value.sourceUrl
  const newFav = !isFav.value

  if (window.dbApi?.setFavorite) {
    try {
      await window.dbApi.setFavorite(id, newFav)
    } catch (e) {
      console.error('[收藏] 操作失败:', e)
      return
    }
  }

  selectedComic.value.favorited = newFav
  isFav.value = newFav
}

// 检查当前漫画是否在下载队列中
async function checkQueueStatus() {
  if (!selectedComic.value || !window.jobApi) return
  try {
    const jobs = await window.jobApi.list('active', 100)
    const inQueue = jobs.some(j =>
      j.type === 'downloadComic' &&
      (j.payload?.sourceUrl === selectedComic.value.sourceUrl ||
       j.payload?.comicTitle === selectedComic.value.title)
    )
    isInQueue.value = inQueue
  } catch (e) {
    console.error('[队列检查] 失败:', e)
  }
}

async function cacheComic() {
  if (!selectedComic.value) {
    alert('请先选择一本漫画')
    return
  }
  await ensureFavorite()
  if (caching.value || isInQueue.value) return

  if (!window.offlineApi) {
    alert('下载功能未初始化，请重启应用后重试')
    return
  }

  caching.value = true
  let wasSkipped = false

  try {
    // 查询磁盘目录数，仅用于显示信息（不用于确定下载起始位置）
    const info = await window.offlineApi.getHighestDownloadedIndex({
      comicTitle: selectedComic.value.title,
      sourceUrl: selectedComic.value.sourceUrl || ''
    })
    const diskChapterCount = info.diskChapterCount || 0

    // ⚠️ 关键：必须使用网站返回的章节列表（selectedComic.chapters）
    // 不能用磁盘目录编号推断（目录编号 ≠ 章节号）
    // 例如「100-第99話」表示：网站第 100 个条目，内容是「第99話」
    let allChapters = selectedComic.value.chapters || []

    // 如果章节为空但漫画是在线漫画，先自动获取章节
    if (allChapters.length === 0 && selectedComic.value.sourceUrl && !selectedComic.value.local_path) {
      // 如果正在自动获取章节，等待完成
      if (autoFetchingChapters.value) {
        while (autoFetchingChapters.value) {
          await new Promise(r => setTimeout(r, 200))
        }
        allChapters = selectedComic.value.chapters || []
      }
      // 如果仍然为空，主动触发获取
      if (allChapters.length === 0 && window.detailApi) {
        try {
          const result = await window.detailApi.enrichComic(selectedComic.value.sourceUrl)
          if (result.success && result.comic) {
            const idx = comics.value.findIndex(c => (c._id || c.sourceUrl) === selectedId.value)
            if (idx >= 0) comics.value[idx] = result.comic
            allChapters = result.comic.chapters || []
          }
        } catch (e) {
          console.warn('[下载前获取章节] 失败:', e.message)
        }
      }
    }

    if (allChapters.length === 0) {
      alert('该漫画暂无章节可下载，请先从网站打开该漫画以获取章节列表')
      caching.value = false
      return
    }

    const chaptersForQueue = allChapters.map(ch => ({
      name: ch.name,
      url: ch.url
    }))

    // 确保漫画标题不为空，防止生成"未知漫画"任务
    let comicTitle = selectedComic.value.title?.trim()
    if (!comicTitle) {
      // 尝试从 sourceUrl 提取标题
      try {
        const url = new URL(selectedComic.value.sourceUrl)
        const pathParts = url.pathname.split('/').filter(Boolean)
        const lastPart = pathParts[pathParts.length - 1]
        if (lastPart) {
          comicTitle = lastPart.replace(/\.html?$/, '').replace(/[-_]/g, ' ')
        }
      } catch (_) {}
    }
    if (!comicTitle) {
      comicTitle = '未命名漫画'
    }

    const isFirstDownload = diskChapterCount === 0

    console.log(`[缓存] ${isFirstDownload ? '首次下载' : '增量更新'}: ${comicTitle}`)
    console.log(`[缓存] 网站共 ${allChapters.length} 章，磁盘已有 ${diskChapterCount} 个目录`)
    console.log(`[缓存] 后端将逐个检测，已存在则跳过，不存在则下载`)

    // ⚠️ 关键：把网站的全部章节加入队列
    // 由后端的 downloadChapter 函数逐个检测是否已下载
    // 检测到目录存在且有图片 → skip（跳过）
    // 检测不到 → 真正下载
    const result = await window.offlineApi.queueAllChapters({
      comicTitle,
      chapters: chaptersForQueue,
      referer: selectedComic.value.sourceUrl || '',
      sourceUrl: selectedComic.value.sourceUrl || '',
      coverUrl: selectedComic.value.cover || ''
    })
    wasSkipped = result.skipped

    console.log('[缓存] 已添加到队列, jobIds:', result.jobIds)
    if (result.skipped) {
      alert(`《${selectedComic.value.title}》已在下载队列中，请勿重复添加`)
    } else if (isFirstDownload) {
      alert(`已添加《${selectedComic.value.title}》共 ${chaptersForQueue.length} 章到下载队列，可在「下载管理」页面查看进度`)
    } else {
      alert(`增量更新：已添加《${selectedComic.value.title}》共 ${chaptersForQueue.length} 章到下载队列\n\n前 ${diskChapterCount} 章检测到已存在会自动跳过，新增章节将下载`)
    }
  } catch (e) {
    console.error('[缓存] 添加下载失败:', e)
    alert('添加下载失败: ' + (e.message || '未知错误'))
  } finally {
    caching.value = false
    if (!wasSkipped) {
      isInQueue.value = true
    }
  }
}

async function generateEpub() {
  if (!selectedComic.value || !selectedComic.value.local_path) {
    alert('该漫画尚未下载，无法生成 EPUB')
    return
  }
  if (exportingEpub.value) return
  exportingEpub.value = true
  
  try {
    const title = selectedComic.value.title
    await window.offlineApi.exportComic(title, 'epub')
    epubExists.value = true
    alert(`${title}.epub 已导出到下载目录`)
  } catch (e) {
    console.error('生成 EPUB 异常:', e)
    alert('生成 EPUB 失败: ' + (e.message || '未知错误'))
  } finally {
    exportingEpub.value = false
  }
}

async function enrichComic() {
  if (!selectedComic.value || !selectedComic.value.sourceUrl) {
    alert('无法获取漫画信息')
    return
  }
  if (enriching.value) return
  enriching.value = true
  try {
    if (!window.detailApi) {
      alert('详情API未初始化，请重启应用后重试')
      return
    }
    const result = await window.detailApi.enrichComic(selectedComic.value.sourceUrl)
    if (result.success && result.comic) {
      const idx = comics.value.findIndex(c => (c._id || c.sourceUrl) === selectedId.value)
      if (idx >= 0) {
        comics.value[idx] = result.comic
      }
      if (result.changed && result.changed.length > 0) {
        alert('已补全: ' + result.changed.join('、'))
      } else {
        alert('网站上没有更多信息可补全')
      }
    } else {
      alert('补全失败: ' + (result.error || '未知错误'))
    }
  } catch (e) {
    console.error('[补全详情] 异常:', e)
    alert('补全失败: ' + (e.message || '未知错误'))
  } finally {
    enriching.value = false
  }
}

async function loadByUrl() {
  const url = urlInput.value.trim()
  if (!url) {
    alert('请输入漫画详情页URL')
    return
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    alert('URL格式不正确，请以 http:// 或 https:// 开头')
    return
  }
  if (loadingByUrl.value) return

  loadingByUrl.value = true
  try {
    if (!window.detailApi) {
      alert('详情API未初始化，请重启应用后重试')
      return
    }
    const result = await window.detailApi.enrichComic(url)
    if (result.success && result.comic) {
      const idx = comics.value.findIndex(c => c._id === result.comic._id || c.sourceUrl === url)
      if (idx >= 0) {
        comics.value[idx] = result.comic
      } else {
        comics.value.push(result.comic)
      }
      selectedId.value = result.comic._id || result.comic.sourceUrl
      urlInput.value = ''
      await loadComics()
      const msg = result.changed && result.changed.length > 0
        ? '加载成功！已获取: ' + result.changed.join('、')
        : '加载成功！'
      alert(msg)
    } else {
      alert('加载失败: ' + (result.error || '未知错误'))
    }
  } catch (e) {
    console.error('[URL加载] 异常:', e)
    alert('加载失败: ' + (e.message || '未知错误'))
  } finally {
    loadingByUrl.value = false
  }
}

async function loadComics() {
  if (!window.dbApi) {
    loadError.value = true
    return
  }
  loadError.value = false
  try {
    const result = await window.dbApi.getComics(1, 200)
    comics.value = result.docs
    // 优先使用路由参数中的 id
    const targetId = props.id || route.params.id
    if (targetId) {
      // 如果当前列表里匹配不到，则尝试按 id/sourceUrl 单独加载
      const matched = comics.value.find(c => c._id === targetId || c.sourceUrl === targetId)
      if (!matched) {
        try {
          let direct = await window.dbApi.getComicById?.(targetId)
          if (!direct) direct = await window.dbApi.getComicByUrl?.(targetId)
          if (direct) {
            comics.value.push(direct)
            selectedId.value = direct._id
          }
        } catch {}
      } else {
        selectedId.value = matched._id
      }
    } else if (comics.value.length > 0 && !selectedId.value) {
      selectedId.value = comics.value[0]._id || comics.value[0].sourceUrl
    }
    updateFavStatus()
  } catch (e) {
    console.error('加载漫画失败:', e)
    loadError.value = true
  }
}

// 监听路由参数变化，切换漫画
watch(() => route.params.id, async (newId) => {
  if (!newId) return
  const matched = comics.value.find(c => c._id === newId || c.sourceUrl === newId)
  if (matched) {
    selectedId.value = matched._id
  } else {
    // 尝试单独加载
    try {
      let direct = window.dbApi?.getComicById ? await window.dbApi.getComicById(newId) : null
      if (!direct && window.dbApi?.getComicByUrl) direct = await window.dbApi.getComicByUrl(newId)
      if (direct) {
        comics.value.push(direct)
        selectedId.value = direct._id
      }
    } catch {}
  }
})

// 监听 selectedId 变化，更新收藏状态
watch(selectedId, () => {
  updateFavStatus()
  checkEpubExists()
  loadDownloadedChapterIndices()
  checkQueueStatus()  // 检查是否在下载队列中
  autoFetchChapters() // 自动获取在线漫画章节
  // 记录阅读历史
  if (selectedComic.value) {
    window.__recordHistory?.({
      _id: selectedComic.value._id,
      sourceUrl: selectedComic.value.sourceUrl,
      title: selectedComic.value.title,
      cover: selectedComic.value.cover
    })
  }
})

// 监听 comics 变化，确保 selectedComic 更新后重新加载下载状态
watch(comics, () => {
  if (selectedId.value && selectedComic.value) {
    loadDownloadedChapterIndices()
  }
}, { deep: true })

async function autoFetchChapters() {
  const comic = selectedComic.value
  if (!comic || !comic.sourceUrl) return
  if (comic.local_path) return
  if (comic.chapters && comic.chapters.length > 0) return
  if (autoFetchingChapters.value) return
  if (!window.detailApi) return

  autoFetchingChapters.value = true
  try {
    const result = await window.detailApi.enrichComic(comic.sourceUrl)
    if (result.success && result.comic) {
      const idx = comics.value.findIndex(c => (c._id || c.sourceUrl) === selectedId.value)
      if (idx >= 0) {
        comics.value[idx] = result.comic
      }
    }
  } catch (e) {
    console.warn('[自动获取章节] 失败:', e.message)
  } finally {
    autoFetchingChapters.value = false
  }
}

async function checkEpubExists() {
  if (!selectedComic.value?.title) return
  try {
    epubExists.value = await window.exportApi?.checkEpubExists?.(selectedComic.value.title) || false
  } catch {
    epubExists.value = false
  }
}

async function loadDownloadedChapterIndices() {
  const comic = selectedComic.value
  if (!comic) { downloadedChapterIndices.value = new Set(); return }
  try {
    const indices = await window.offlineApi?.getLocalChapterIndices?.({
      comicTitle: comic.title,
      sourceUrl: comic.sourceUrl || ''
    }) || []
    downloadedChapterIndices.value = new Set(indices)
  } catch {
    downloadedChapterIndices.value = new Set()
  }
}

onMounted(() => {
  loadComics()
})
</script>

<style scoped>
.detail-page {
  height: 100%;
  overflow-y: auto;
}

/* 加载错误提示 */
.load-error {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin: 12px 16px;
}
.load-error-text {
  font-size: 13px;
  color: var(--error);
}

/* ===== URL加载区域 ===== */
.url-load-section {
  margin: 12px 16px;
  padding: 16px 20px;
}
.url-load-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
  flex-wrap: wrap;
}
.url-load-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}
.url-load-hint {
  font-size: 12px;
  color: var(--text-sub);
}
.url-load-form {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.url-input {
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
.url-input:focus {
  border-color: var(--brand);
  background: var(--input-bg);
}
.url-input::placeholder {
  color: var(--text-sub-2);
}

/* ===== 返回栏 ===== */
.back-bar {
  padding: 8px 28px;
  position: relative;
  z-index: 10;
  background: var(--bg);
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-sub);
  text-decoration: none;
  padding: 4px 10px;
  border-radius: 0;
  transition: all .15s;
}
.back-link:hover {
  color: var(--brand);
  background: var(--brand-light);
}

/* ===== 顶部 Hero 区域 ===== */
.detail-hero {
  position: relative;
  min-height: 340px;
  display: flex;
  align-items: flex-end;
  padding: 32px 36px;
  overflow: hidden;
  border-radius: 0 0 var(--radius-xl) var(--radius-xl);
  margin: 12px -20px 20px;
}

.hero-bg {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background-size: cover;
  background-position: center 30%;
  filter: blur(60px) brightness(0.4);
  transform: scale(1.3);
}

.hero-mask {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, rgba(99, 102, 241, 0.15) 0%, rgba(0,0,0,0.4) 100%);
}

.hero-content {
  position: relative;
  display: flex;
  gap: 28px;
  align-items: flex-end;
  width: 100%;
  z-index: 1;
}

.hero-pic {
  position: relative;
  width: 160px;
  height: 214px;
  border-radius: var(--radius-lg);
  overflow: hidden;
  flex-shrink: 0;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  border: 2px solid rgba(255,255,255,0.15);
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.4s ease;
}

.hero-pic:hover {
  transform: translateY(-4px) scale(1.02);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
}

.hero-pic img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-pic-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 56px;
  font-weight: 700;
  color: rgba(255,255,255,0.9);
  background: linear-gradient(135deg, var(--brand-start) 0%, var(--brand-end) 100%);
}

.epub-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  background: var(--brand);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  letter-spacing: 0.5px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
}

.hero-info {
  flex: 1;
  min-width: 0;
  padding-bottom: 6px;
}

.hero-title {
  font-size: 28px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 14px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  letter-spacing: -0.5px;
  line-height: 1.3;
}

.hero-meta-section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.hero-tags-section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.meta-badge {
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);
  display: inline-flex;
  align-items: center;
}

.meta-badge.completed {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  box-shadow: 0 2px 8px rgba(16, 185, 129, 0.3);
}

.meta-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  font-weight: 500;
  margin-right: 4px;
}

.meta-tag {
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.2);
}

.author-tag {
  background: rgba(139, 92, 246, 0.25);
  border: 1px solid rgba(139, 92, 246, 0.4);
}



.tag-pill {
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255,255,255,0.15);
  font-weight: 500;
}

.hero-desc-section {
  margin-bottom: 12px;
}

.hero-desc-section .meta-label {
  display: block;
  margin-bottom: 6px;
}

.hero-desc-box {
  padding: 12px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.hero-desc {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.7;
  margin: 0;
  max-width: 640px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.btn-read {
  padding: 12px 28px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: var(--gradient-brand);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
}

.btn-read:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.5);
}

@media (hover: none) and (pointer: coarse) {
  .btn-read:active {
    transform: scale(0.96);
    transition: transform 0.1s;
  }
}

.btn-read.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: rgba(255, 255, 255, 0.08);
}

.btn-read.disabled:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.08);
}

.btn-fav {
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.2);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-fav:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255,255,255,0.3);
  transform: translateY(-2px);
}

.btn-fav.active {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.15);
  border-color: rgba(251, 191, 36, 0.4);
}

@media (hover: none) and (pointer: coarse) {
  .btn-fav:active {
    transform: scale(0.96);
    transition: transform 0.1s;
  }
}

.btn-fav:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-fav:disabled:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.12);
}

.btn-cache {
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(16, 185, 129, 0.2);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(16, 185, 129, 0.4);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-cache:hover {
  background: rgba(16, 185, 129, 0.3);
  border-color: rgba(16, 185, 129, 0.5);
  transform: translateY(-2px);
}

.btn-cache.loading {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-cache.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.1);
}

.btn-cache.disabled:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.08);
}

@media (hover: none) and (pointer: coarse) {
  .btn-cache:active {
    transform: scale(0.96);
    transition: transform 0.1s;
  }
}

.btn-cache .icon {
  display: inline-block;
}

.btn-cache.loading .icon {
  animation: spin 1s linear infinite;
}

.btn-enrich {
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.2);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-enrich:hover {
  background: rgba(255, 255, 255, 0.2);
  border-color: rgba(255,255,255,0.3);
  color: #fff;
  transform: translateY(-2px);
}

.btn-enrich.loading {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-enrich.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-enrich.disabled:hover {
  transform: none;
  background: rgba(255, 255, 255, 0.12);
}

.btn-enrich .icon {
  display: inline-block;
  font-style: normal;
}

.btn-enrich.loading .icon {
  animation: spin 1s linear infinite;
}

.btn-epub {
  padding: 12px 24px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(139, 92, 246, 0.2);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(139, 92, 246, 0.4);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.btn-epub:hover {
  background: rgba(139, 92, 246, 0.3);
  border-color: rgba(139, 92, 246, 0.5);
  transform: translateY(-2px);
}

.btn-epub:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  transform: none;
}

.btn-epub.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  background: rgba(139, 92, 246, 0.1);
}

.btn-epub.disabled:hover {
  transform: none;
  background: rgba(139, 92, 246, 0.1);
}

.btn-epub.loading {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-epub .icon {
  display: inline-block;
  font-style: normal;
}

.btn-epub.loading .icon {
  animation: spin 1s linear infinite;
}

.hero-desc-empty {
  color: rgba(255, 255, 255, 0.5);
  font-style: italic;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ===== 主体内容区 ===== */
.detail-body {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 16px;
  padding: 16px;
}

.section-card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-light);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: box-shadow .25s;
}

.section-card:hover {
  box-shadow: var(--shadow-md);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-light);
}

.section-header h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.section-tools {
  display: flex;
  align-items: center;
  gap: 12px;
}

.chapter-count {
  font-size: 12px;
  color: var(--text-sub);
}

.btn-sort {
  padding: 4px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--text-sub);
  background: var(--bg-hover);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}

.btn-sort:hover {
  color: var(--brand);
  background: var(--brand-light);
  transform: translateY(-1px);
}

/* ===== 章节网格 ===== */
.chapter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
  padding: 14px;
  max-height: 500px;
  overflow-y: auto;
}

.chapter-item {
  padding: 12px 14px;
  border-radius: var(--radius);
  background: var(--bg-hover);
  cursor: pointer;
  text-align: center;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  border: 1px solid transparent;
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.chapter-item:hover {
  background: var(--brand-light);
  border-color: var(--brand);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}

@media (hover: none) and (pointer: coarse) {
  .chapter-item:active {
    transform: scale(0.97);
    background: var(--brand-light);
    border-color: var(--brand);
    transition: transform 0.1s;
  }
}

.chapter-item.active {
  background: var(--brand);
  color: #fff;
  box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3);
}

.ch-number {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-dim);
  font-style: italic;
  transition: color 0.2s;
}

.chapter-item.downloaded .ch-number {
  color: var(--text);
  font-weight: 700;
  font-style: normal;
}

.ch-title {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  white-space: nowrap;
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chapter-item.downloaded .ch-title {
  color: var(--text);
  font-weight: 600;
  font-style: normal;
}

.chapter-item.active .ch-number {
  color: #fff;
  font-style: normal;
}

.chapter-item.active .ch-title {
  color: rgba(255, 255, 255, 0.8);
  font-style: normal;
}

/* ===== 空状态 ===== */
.empty-chapters {
  text-align: center;
  padding: 48px 20px;
}

.empty-icon {
  font-size: 36px;
  margin-bottom: 10px;
}

.empty-text {
  font-size: 14px;
  color: var(--text-sub);
  margin-bottom: 4px;
}

.empty-sub {
  font-size: 12px;
  color: var(--text-dim);
}

/* ===== 侧边栏漫画列表 ===== */
.comic-list-mini {
  padding: 8px;
  max-height: 600px;
  overflow-y: auto;
}

.mini-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: 48px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

.mini-item:hover {
  background: var(--bg-hover);
  transform: translateX(4px);
}

@media (hover: none) and (pointer: coarse) {
  .mini-item:active {
    transform: scale(0.98);
    background: var(--bg-hover);
    transition: transform 0.1s;
  }
}

.mini-item.active {
  background: rgba(99, 102, 241, 0.08);
  border-left: 3px solid var(--brand);
}

.mini-thumb {
  width: 48px;
  height: 64px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg-hover);
  position: relative;
}

.mini-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mini-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-dim);
}

/* 封面角标 */
.mini-source-badge {
  position: absolute;
  bottom: 2px;
  right: 2px;
  font-size: 9px;
  font-weight: 700;
  padding: 1px 3px;
  border-radius: 3px;
  line-height: 1;
  pointer-events: none;
}
.mini-source-badge.local {
  background: rgba(34, 197, 94, 0.9);
  color: #fff;
}
.mini-source-badge.online {
  background: rgba(99, 102, 241, 0.9);
  color: #fff;
}

.mini-info {
  flex: 1;
  min-width: 0;
}

.mini-title {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.mini-meta {
  font-size: 11px;
  color: var(--text-sub);
  display: flex;
  gap: 8px;
  align-items: center;
}

.mini-meta .meta-local {
  color: #22c55e;
  font-weight: 600;
}
.mini-meta .meta-online {
  color: #6366f1;
  font-weight: 600;
}

/* ===== 响应式 ===== */
@media (max-width: 900px) {
  .detail-body {
    grid-template-columns: 1fr;
  }
  .detail-side {
    order: -1;
  }
  .hero-content {
    flex-direction: column;
    align-items: flex-start;
  }
  .hero-pic {
    width: 100px;
    height: 133px;
  }
  .hero-title {
    font-size: 18px;
  }
}
</style>