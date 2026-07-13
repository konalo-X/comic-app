<template>
  <div ref="readerPageRef" class="reader-page">
    <!-- ===== 顶部工具栏 ===== -->
    <transition name="slide-down">
      <div v-show="showToolbar" class="reader-toolbar">
        <div class="toolbar-left">
          <button class="tool-btn" title="返回" @click.stop="goBack">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
          </button>
          <div class="chapter-info">
            <span class="comic-title">{{ comic?.title || '' }}</span>
            <span class="chapter-name">{{ currentChapter?.name || '' }}</span>
          </div>
        </div>
        <div class="toolbar-right">
          <select v-model="chapterIndex" class="chapter-select" @change="onChapterChange" @click.stop>
            <option v-for="(ch, i) in chapters" :key="ch.url" :value="i">{{ ch.name }}</option>
          </select>
          <button class="tool-btn" title="阅读模式" @click.stop="toggleReadingMode">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <!-- 单页 --><rect v-if="mode === 'single'" x="3" y="3" width="18" height="18" rx="1"/><line v-if="mode === 'single'" x1="12" y1="3" x2="12" y2="21"/>
              <!-- 双页 --><template v-if="mode === 'double'"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="15" y="4" width="6" height="16" rx="1"/></template>
              <!-- 卷轴 --><template v-if="mode === 'scroll'"><rect x="3" y="3" width="16" height="6" rx="1"/><rect x="3" y="12" width="16" height="6" rx="1"/></template>
            </svg>
          </button>
          <button class="tool-btn" title="翻页效果" @click.stop="togglePageEffect">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              <text x="12" y="16" text-anchor="middle" fill="currentColor" font-size="8">{{ effectLabel }}</text>
            </svg>
          </button>
          <button class="tool-btn" :title="useCanvas ? '切换到普通模式' : '切换到性能模式'" @click.stop="togglePerformanceMode">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </button>
        </div>
      </div>
    </transition>

    <!-- ===== 阅读内容 ===== -->
    <div
ref="contentRef"
      class="reader-content"
      @click="onContentClick"
      @mousemove="onMouseMove"
      @touchstart="onTouchStart"
      @touchend="onTouchEnd"
    >
      <!-- 加载中 -->
      <div v-if="loading" class="reader-loading">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载中...</div>
      </div>

      <!-- 错误 -->
      <div v-else-if="loadError" class="reader-empty">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <div class="empty-text">章节加载失败</div>
        <button class="btn-retry" @click="loadChapter">重试</button>
      </div>

      <!-- 无图片数据 -->
      <div v-else-if="images.length === 0" class="reader-empty">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14l4-4h10l4 4z"/></svg>
        </div>
        <div class="empty-text">没有可阅读的图片</div>
      </div>

      <!-- ===== Canvas 渲染模式 ===== -->
      <div v-if="useCanvas && images.length > 0" class="canvas-container">
        <canvas
          ref="canvasRef"
          class="comic-canvas"
          @click="onCanvasClick"
          @wheel="onCanvasWheel"
          @mousedown="onCanvasMouseDown"
          @mousemove="onCanvasMouseMove"
          @mouseup="onCanvasMouseUp"
          @mouseleave="onCanvasMouseUp"
          @dblclick="onCanvasDblClick"
          @touchstart="onCanvasTouchStartZoom"
          @touchmove="onCanvasTouchMoveZoom"
          @touchend="onCanvasTouchEndZoom"
        ></canvas>
        <div class="canvas-page-info">第 {{ currentImageIndex + 1 }} 页 / 共 {{ images.length }} 页</div>
      </div>

      <!-- ===== 单页模式（DOM 渲染） ===== -->
      <div v-else-if="mode === 'single' && !useCanvas">
        <div class="single-page-wrapper" :style="{ transform: `translateX(${singleOffset}px)` }">
          <!-- 当前页 -->
          <div v-for="p in singlePages" :key="p.key" class="page-flip-wrapper">
            <transition :name="pageEffect" mode="out-in">
              <div v-if="p.src" :key="p.src" class="single-page-container">
                <div class="page-label-top">第 {{ p.idx + 1 }} 页 / 共 {{ images.length }} 页</div>
                <img
                  :src="loadedImages[p.idx] === 'error' ? errorImg : p.src"
                  :alt="`第${p.idx + 1}页`"
                  class="comic-image single"
                  :class="{
                    loaded: loadedImages[p.idx] === true,
                    loading: loadedImages[p.idx] !== true && loadedImages[p.idx] !== 'error',
                    placeholder: loadedImages[p.idx] === 'error'
                  }"
                  @load="onImageLoad(p.idx)" @error="onImageError(p.idx)"
                />
              </div>
            </transition>
          </div>
        </div>
      </div>

      <!-- ===== 双页模式 ===== -->
      <div v-else-if="mode === 'double'" class="double-page" @click="onDoubleClick">
        <div class="page-left">
          <transition :name="pageEffect" mode="out-in">
            <div v-if="doubleLeft.src" :key="doubleLeft.src" class="double-page-container">
              <div class="page-label-top">第 {{ doubleLeft.idx + 1 }} 页</div>
              <img
                :src="loadedImages[doubleLeft.idx] === 'error' ? errorImg : doubleLeft.src"
                :alt="`第${doubleLeft.idx + 1}页`"
                class="comic-image double"
                :class="{
                  loaded: loadedImages[doubleLeft.idx] === true,
                  loading: loadedImages[doubleLeft.idx] !== true && loadedImages[doubleLeft.idx] !== 'error',
                  placeholder: loadedImages[doubleLeft.idx] === 'error'
                }"
                @load="onImageLoad(doubleLeft.idx)" @error="onImageError(doubleLeft.idx)"
              />
            </div>
          </transition>
        </div>
        <div class="page-gutter"></div>
        <div class="page-right">
          <transition :name="pageEffect" mode="out-in">
            <div v-if="doubleRight.src && !doubleRight.dummy" :key="doubleRight.src" class="double-page-container">
              <div class="page-label-top">第 {{ doubleRight.idx + 1 }} 页</div>
              <img
                :src="loadedImages[doubleRight.idx] === 'error' ? errorImg : doubleRight.src"
                :alt="`第${doubleRight.idx + 1}页`"
                class="comic-image double"
                :class="{
                  loaded: loadedImages[doubleRight.idx] === true,
                  loading: loadedImages[doubleRight.idx] !== true && loadedImages[doubleRight.idx] !== 'error',
                  placeholder: loadedImages[doubleRight.idx] === 'error'
                }"
                @load="onImageLoad(doubleRight.idx)" @error="onImageError(doubleRight.idx)"
              />
            </div>
            <img
v-else-if="doubleRight.dummy"
              :key="'dummy'"
              :src="`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3Crect fill='%23111' width='800' height='600'/%3E%3C/svg%3E`"
              :alt="''"
              class="comic-image double placeholder"
            />
          </transition>
        </div>
      </div>

      <!-- ===== 卷轴模式（纵滑） ===== -->
      <div v-else-if="mode === 'scroll'" ref="scrollRef" class="scroll-mode" @scroll="onScroll">
        <div class="scroll-images">
          <div v-for="(img, idx) in images" :key="idx" class="scroll-page">
            <div class="page-number">{{ idx + 1 }} / {{ images.length }}</div>
            <img
              :src="loadedImages[idx] === 'error' ? errorImg : img"
              :alt="`第${idx + 1}页`"
              class="comic-image scroll"
              :class="{
                loaded: loadedImages[idx] === true,
                loading: loadedImages[idx] !== true && loadedImages[idx] !== 'error',
                placeholder: loadedImages[idx] === 'error'
              }"
              loading="lazy"
              @load="onImageLoad(idx)"
              @error="onImageError(idx)"
            />
            <div v-if="loadedImages[idx] === 'error'" class="image-error-label">图片加载失败</div>
          </div>
        </div>
        <div class="page-end" :class="{ allDone: loadStats.isAllLoaded, hasFailed: loadStats.failed > 0 }">
          <template v-if="images.length === 0">
            — 暂无图片 —
          </template>
          <template v-else-if="loadStats.isAllLoaded">
            <div class="end-title">✅ 本章全部加载完毕</div>
            <div class="end-detail">共 {{ images.length }} 张图片{{ loadStats.failed > 0 ? `（${loadStats.failed} 张失败）` : '' }}</div>
            <div v-if="chapterIndex < chapters.length - 1" class="end-next">继续下滑进入下一章 →</div>
            <div v-else class="end-next">已经是最后一章</div>
          </template>
          <template v-else>
            <div class="loading-dots">
              <span>正在加载</span>
              <span class="dots">
                <span>.</span><span>.</span><span>.</span>
              </span>
            </div>
            <div class="end-detail">{{ loadStats.loaded }} / {{ images.length }} 已加载{{ loadStats.failed > 0 ? `（${loadStats.failed} 张失败）` : '' }}</div>
            <div class="end-progress">
              <div class="end-progress-fill" :style="{ width: loadStats.percent + '%' }"></div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ===== 底部导航 ===== -->
    <transition name="slide-up">
      <div v-show="showToolbar" class="reader-nav water-ripple">
        <button class="nav-btn" :disabled="chapterIndex <= 0" @click.stop="prevChapter">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
          上一章
        </button>
        <div class="nav-center">
          <span class="nav-info">{{ pageLabel }}</span>
          <div class="progress-bar-mini">
            <div class="fill" :style="{ width: chapterProgress + '%' }"></div>
          </div>
        </div>
        <button class="nav-btn" :disabled="chapterIndex >= chapters.length - 1" @click.stop="nextChapter">
          下一章
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
    </transition>

    <!-- ===== 模式选择菜单 ===== -->
    <transition name="fade">
      <div v-if="showModeMenu" class="mode-overlay" @click.self="showModeMenu = false">
        <div class="mode-menu">
          <div class="mode-item" :class="{ active: mode === 'single' }" @click="setMode('single')">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
            <span>单页阅读</span>
          </div>
          <div class="mode-item" :class="{ active: mode === 'double' }" @click="setMode('double')">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="9" height="16" rx="1"/><rect x="13" y="4" width="9" height="16" rx="1"/></svg>
            <span>双页阅读</span>
          </div>
          <div class="mode-item" :class="{ active: mode === 'scroll' }" @click="setMode('scroll')">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="7" rx="1"/><rect x="4" y="10" width="16" height="7" rx="1"/><rect x="4" y="18" width="16" height="4" rx="1"/></svg>
            <span>卷轴模式</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()

// ===== 状态 =====
const comic = ref(null)
const chapters = ref([])
const chapterIndex = ref(0)
const loadChapterToken = ref(0)
const images = ref([])
const loading = ref(false)
const loadError = ref(false)
const loadedImages = ref({})
const currentPage = ref(0)
const showToolbar = ref(true)
const showModeMenu = ref(false)
const mode = ref('single')
const pageEffect = ref('fade')
const useCanvas = ref(false)
const singleOffset = ref(0)
const contentRef = ref(null)
const readerPageRef = ref(null)
const scrollRef = ref(null)
let hideTimer = null
let touchStartX = 0
let touchStartTime = 0

// ===== 从 localStorage 恢复阅读器设置 + 加载漫画 =====
onMounted(async () => {
  const saved = localStorage.getItem('reader_settings')
  if (saved) {
    try {
      const s = JSON.parse(saved)
      mode.value = s.mode || 'single'
      pageEffect.value = s.effect || 'fade'
    } catch {}
  }
  setupIntersectionObserver()

  const comicId = route.params.comicId
  console.log('[Reader] 加载漫画:', comicId)
  if (!comicId) return

  let found = null
  try {
    if (window.dbApi) {
      found = await window.dbApi.getComicById(comicId)
      if (!found) {
        found = await window.dbApi.getComicByUrl(comicId)
      }
    }
    if (!found && window.detailApi) {
      found = await window.detailApi.getComicById(comicId)
    }
  } catch (e) {
    console.error('[Reader] 加载漫画失败:', e)
  }

  if (found && found.chapters && found.chapters.length > 0) {
    comic.value = found
    chapters.value = found.chapters
    console.log('[Reader] 找到:', found.title, '章节:', chapters.value.length)
    const chIdx = parseInt(route.params.chapterIndex || '0')
    if (chIdx >= 0 && chIdx < chapters.value.length) chapterIndex.value = chIdx
    loadChapter()
  } else if (found && found.sourceUrl && window.detailApi) {
    console.log('[Reader] 漫画存在但无章节，尝试在线获取章节:', found.sourceUrl)
    try {
      const enriched = await window.detailApi.enrichComic(found.sourceUrl)
      if (enriched && enriched.success && enriched.comic && enriched.comic.chapters && enriched.comic.chapters.length > 0) {
        comic.value = enriched.comic
        chapters.value = enriched.comic.chapters
        console.log('[Reader] 在线获取章节成功:', chapters.value.length)
        const chIdx = parseInt(route.params.chapterIndex || '0')
        if (chIdx >= 0 && chIdx < chapters.value.length) chapterIndex.value = chIdx
        loadChapter()
      } else {
        loadError.value = true
        console.warn('[Reader] 在线获取章节失败')
      }
    } catch (e) {
      console.error('[Reader] enrichComic 失败:', e)
      loadError.value = true
    }
  } else if (!found && typeof comicId === 'string' && comicId.startsWith('http') && window.detailApi) {
    console.log('[Reader] 未找到漫画，comicId 是 URL，尝试在线获取:', comicId)
    try {
      const enriched = await window.detailApi.enrichComic(comicId)
      if (enriched && enriched.success && enriched.comic && enriched.comic.chapters && enriched.comic.chapters.length > 0) {
        comic.value = enriched.comic
        chapters.value = enriched.comic.chapters
        console.log('[Reader] 在线获取成功:', chapters.value.length, '章')
        const chIdx = parseInt(route.params.chapterIndex || '0')
        if (chIdx >= 0 && chIdx < chapters.value.length) chapterIndex.value = chIdx
        loadChapter()
      } else {
        loadError.value = true
      }
    } catch (e) {
      console.error('[Reader] enrichComic 失败:', e)
      loadError.value = true
    }
  } else {
    loadError.value = true
    console.warn('[Reader] 未找到漫画或无章节:', comicId)
  }

  resetHideTimer()
  document.addEventListener('keydown', onKeyDown)
})

// ===== 计算属性 =====
const currentChapter = computed(() => chapters.value[chapterIndex.value] || null)

const chapterProgress = computed(() => {
  const total = images.value.length || 1
  return ((currentPage.value + 1) / total) * 100
})

// 加载状态统计
const loadStats = computed(() => {
  const total = images.value.length || 0
  let loaded = 0
  let failed = 0
  for (let i = 0; i < total; i++) {
    const s = loadedImages.value[i]
    if (s === true) loaded++
    else if (s === 'error') failed++
  }
  const remaining = total - loaded - failed
  return {
    total,
    loaded,
    failed,
    remaining,
    percent: total > 0 ? Math.round(((loaded + failed) / total) * 100) : 0,
    isAllLoaded: total > 0 && loaded + failed >= total
  }
})

const pageLabel = computed(() => {
  const total = images.value.length || 1
  const cp = currentPage.value + 1
  if (mode.value === 'scroll') return `已加载 ${loadStats.value.loaded} / ${total}${loadStats.value.failed > 0 ? `（${loadStats.value.failed}失败）` : ''}`
  return `${cp} / ${total}（已加载 ${loadStats.value.loaded}）`
})

const effectLabel = computed(() => pageEffect.value === 'fade' ? '淡' : pageEffect.value === 'slide' ? '滑' : '卷')

// ===== 单页分页状态 =====
const singlePages = computed(() => {
  const pages = images.value
  if (pages.length === 0) return []
  const idx = currentPage.value
  return [{ key: idx, src: pages[idx], idx }]
})

// ===== 双页分页 =====
const doubleLeft = computed(() => {
  const idx = currentPage.value
  if (idx < 0 || idx >= images.value.length) return { idx: -1, src: null }
  return { idx, src: images.value[idx] }
})
const doubleRight = computed(() => {
  const idx = currentPage.value + 1
  if (idx >= images.value.length) return { idx: -1, src: null, dummy: true }
  return { idx, src: images.value[idx] }
})

// ===== 阅读模式 =====
function toggleReadingMode() {
  showModeMenu.value = !showModeMenu.value
}

function setMode(m) {
  mode.value = m
  showModeMenu.value = false
  localStorage.setItem('reader_settings', JSON.stringify({ mode: m, effect: pageEffect.value }))
  nextTick(() => {
    if (m === 'scroll' && scrollRef.value) {
      scrollRef.value.scrollTop = 0
    }
    // 重新绑定懒加载
    rebindLazyLoad()
  })
}

function togglePageEffect() {
  const effects = ['fade', 'slide', 'page-flip']
  const idx = effects.indexOf(pageEffect.value)
  pageEffect.value = effects[(idx + 1) % effects.length]
  localStorage.setItem('reader_settings', JSON.stringify({ mode: mode.value, effect: pageEffect.value }))
}

function togglePerformanceMode() {
  useCanvas.value = !useCanvas.value
  localStorage.setItem('reader_perf_mode', useCanvas.value ? 'canvas' : 'dom')
  if (useCanvas.value) {
    nextTick(() => drawImageToCanvas())
  }
}

// ===== 页导航 =====
function nextPage() {
  if (mode.value === 'single' || mode.value === 'scroll') {
    if (currentPage.value < images.value.length - 1) {
      currentPage.value++
      saveProgress()
      // 预加载当前章后续图片
      preloadCurrentChapterAhead()
    } else if (chapterIndex.value < chapters.value.length - 1) {
      nextChapter()
    }
  } else {
    // 双页模式一次翻两页
    if (currentPage.value + 2 < images.value.length) {
      currentPage.value += 2
      saveProgress()
      // 预加载当前章后续图片
      preloadCurrentChapterAhead()
    } else if (chapterIndex.value < chapters.value.length - 1) {
      nextChapter()
    }
  }
}

function prevPage() {
  if (mode.value === 'single') {
    if (currentPage.value > 0) {
      currentPage.value--
      saveProgress()
    } else if (chapterIndex.value > 0) {
      prevChapter()
    }
  } else if (mode.value === 'double') {
    if (currentPage.value - 2 >= 0) {
      currentPage.value -= 2
      saveProgress()
    } else if (chapterIndex.value > 0) {
      prevChapter()
    }
  } else {
    // scroll 用 scrollTop 翻页
    if (scrollRef.value) {
      const el = scrollRef.value
      const target = Math.max(0, el.scrollTop - el.clientHeight * 0.9)
      el.scrollTo({ top: target, behavior: 'smooth' })
    }
  }
}

function prevChapter() {
  if (chapterIndex.value > 0) {
    chapterIndex.value--
    currentPage.value = 0
    loadChapter()
  }
}

function nextChapter() {
  if (chapterIndex.value < chapters.value.length - 1) {
    chapterIndex.value++
    currentPage.value = 0
    loadChapter()
  }
}

function onChapterChange() {
  currentPage.value = 0
  loadChapter()
}

// ===== 点击/手势处理 =====
function onContentClick(e) {
  if (mode.value === 'scroll') return // scroll 用滚动
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const w = rect.width
  const third = w / 3

  if (x < third) {
    prevPage()
  } else if (x > third * 2) {
    nextPage()
  } else {
    toggleToolbar()
  }
}

function onDoubleClick(e) {
  // 双页模式下左右各半
  const rect = e.currentTarget.getBoundingClientRect()
  if (e.clientX - rect.left < rect.width / 2) {
    prevPage()
  } else {
    nextPage()
  }
}

function onTouchStart(e) {
  touchStartX = e.touches[0].clientX
  touchStartTime = Date.now()
}

function onTouchEnd(e) {
  const deltaX = e.changedTouches[0].clientX - touchStartX
  const deltaTime = Date.now() - touchStartTime
  if (Math.abs(deltaX) < 10 && deltaTime < 300) {
    // 短点击处理
    if (mode.value === 'scroll') {
      toggleToolbar()
    }
    return
  }
  if (Math.abs(deltaX) > 60) {
    if (deltaX > 0) prevPage()
    else nextPage()
  }
}

// ===== 工具栏 =====
function onMouseMove() {
  if (!showToolbar.value) showToolbar.value = true
  resetHideTimer()
}

function resetHideTimer() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!showModeMenu.value) showToolbar.value = false
  }, 2500)
}

function toggleToolbar() {
  showToolbar.value = !showToolbar.value
  if (showToolbar.value) resetHideTimer()
}

// ===== 卷轴模式滚动 =====
function onScroll() {
  if (mode.value !== 'scroll') return
  const el = scrollRef.value
  if (!el) return
  const scrollPct = el.scrollTop / (el.scrollHeight - el.clientHeight)
  // 映射到当前页
  const pageIdx = Math.round(scrollPct * (images.value.length - 1))
  if (pageIdx >= 0 && pageIdx !== currentPage.value) {
    currentPage.value = pageIdx
    debounceSaveProgress()
  }
}

// ===== IntersectionObserver 懒加载 =====
let imageObserver = null
let observerImages = new Map() // 跟踪待观察的图片

function setupIntersectionObserver() {
  // 清理旧的观察者
  if (imageObserver) {
    imageObserver.disconnect()
    observerImages.clear()
  }

  imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target
        const dataSrc = img.dataset.src
        if (dataSrc && !img.src) {
          img.src = dataSrc
          img.removeAttribute('data-src')
          imageObserver.unobserve(img)
          observerImages.delete(img)
        }
      }
    })
  }, {
    root: null,
    rootMargin: '200px', // 提前 200px 开始加载
    threshold: 0.01
  })
}

function observeImage(imgEl) {
  if (!imgEl) return
  if (imgEl.src && imgEl.src !== window.location.href && imgEl.getAttribute('data-src') == null) return
  const dataSrc = imgEl.getAttribute('data-src')
  if (!dataSrc) return
  if (imageObserver) {
    imageObserver.observe(imgEl)
    observerImages.set(imgEl, true)
  }
  setTimeout(() => {
    if (imgEl && !imgEl.src && imgEl.getAttribute('data-src')) {
      const ds = imgEl.getAttribute('data-src')
      if (ds) {
        imgEl.src = ds
        imgEl.removeAttribute('data-src')
        if (imageObserver) imageObserver.unobserve(imgEl)
        observerImages.delete(imgEl)
      }
    }
  }, 300)
}

function unobserveImage(imgEl) {
  if (!imgEl || !imageObserver) return
  imageObserver.unobserve(imgEl)
  observerImages.delete(imgEl)
}

function rebindLazyLoad() {
  nextTick(() => {
    const imgs = contentRef.value?.querySelectorAll('img[data-src]') || []
    imgs.forEach(img => observeImage(img))
  })
}

let saveTimer = null
function debounceSaveProgress() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveProgress(), 1000)
}

// ===== 进度保存 =====
async function saveProgress() {
  if (!comic.value || !window.progressApi) return
  const comicId = comic.value._id || comic.value.sourceUrl
  if (!comicId) return
  try {
    await window.progressApi.save({
      comicId,
      chapterIndex: chapterIndex.value,
      chapterUrl: currentChapter.value?.url || '',
      pageIndex: currentPage.value,
      totalPages: images.value.length
    })
  } catch {}
}

async function restoreProgress() {
  if (!comic.value || !window.progressApi) return
  const comicId = comic.value._id || comic.value.sourceUrl
  if (!comicId) return
  try {
    const p = await window.progressApi.get(comicId)
    if (p) {
      // 只恢复同一章节，不同章节则从 0 开始
      if (p.chapterIndex === chapterIndex.value) {
        currentPage.value = p.pageIndex || 0
      }
    }
  } catch {}
}

// ===== 图片加载 =====
const retryCount = {} // 记录每张图片的重试次数
const imageCache = new Map() // 图片解码缓存

function onImageLoad(idx) {
  loadedImages.value[idx] = true
  delete retryCount[idx]
  
  // 缓存解码后的图片（Canvas 模式使用）
  if (useCanvas.value) {
    const url = images.value[idx]
    if (url && !imageCache.has(url)) {
      const img = new Image()
      img.onload = () => {
        imageCache.set(url, img)
        // 限制缓存大小
        if (imageCache.size > 20) {
          const firstKey = imageCache.keys().next().value
          imageCache.delete(firstKey)
        }
      }
      img.src = url
    }
  }
}

function onImageError(idx) {
  const url = images.value[idx]
  console.warn('图片加载失败:', idx, url)

  retryCount[idx] = (retryCount[idx] || 0) + 1
  if (retryCount[idx] <= 3) {
    console.log(`[Reader] 重试第 ${retryCount[idx]} 次: ${url}`)
    setTimeout(() => {
      const separator = url.includes('?') ? '&' : '?'
      images.value[idx] = url + separator + '_retry=' + Date.now()
      loadedImages.value[idx] = undefined
    }, 500)
  } else {
    loadedImages.value[idx] = 'error'
  }
}

// 获取缓存的图片
function getCachedImage(url) {
  return imageCache.get(url) || null
}

// ===== 智能预加载系统 =====
let preloadImages = []
let preloadQueue = [] // 预加载队列
let isPreloading = false

// 预加载策略配置
const PRELOAD_CONFIG = {
  nextChapterImages: 5,      // 预加载下一章前N张
  currentChapterAhead: 3,    // 当前章提前预加载N张
  maxConcurrent: 3,          // 最大并发预加载数
  priority: 'next'           // 优先级: 'next'(下一章优先) | 'ahead'(当前章优先)
}

function preloadNextChapter() {
  // 清理旧的预加载
  clearPreload()

  const nextIdx = chapterIndex.value + 1
  if (nextIdx >= chapters.value.length) return

  const nextChapter = chapters.value[nextIdx]
  if (!nextChapter || !window.readerApi) return

  console.log('[Reader] 预加载下一章:', nextChapter.name)
  
  const chapterUrl = nextChapter.url
  const referer = comic.value?.sourceUrl || chapterUrl
  
  window.readerApi.getChapterImages(chapterUrl, referer)
    .then(imgs => {
      if (!imgs || imgs.length === 0) return
      // 预加载前N张
      const preloadCount = Math.min(PRELOAD_CONFIG.nextChapterImages, imgs.length)
      for (let i = 0; i < preloadCount; i++) {
        queuePreload(imgs[i], `next-ch-${i}`)
      }
      processPreloadQueue()
      console.log(`[Reader] 队列预加载下一章 ${preloadCount} 张图片`)
    })
    .catch(err => {
      console.warn('[Reader] 预加载失败:', err)
    })
}

// 预加载当前章后续图片
function preloadCurrentChapterAhead() {
  if (!images.value.length) return
  
  const currentIdx = currentPage.value
  const total = images.value.length
  const aheadCount = Math.min(PRELOAD_CONFIG.currentChapterAhead, total - currentIdx - 1)
  
  if (aheadCount <= 0) return
  
  for (let i = 1; i <= aheadCount; i++) {
    const idx = currentIdx + i
    if (idx < total && loadedImages.value[idx] !== true) {
      queuePreload(images.value[idx], `current-${idx}`)
    }
  }
  processPreloadQueue()
}

// 添加图片到预加载队列
function queuePreload(url, id) {
  if (!url) return
  // 避免重复
  if (preloadQueue.some(item => item.url === url)) return
  preloadQueue.push({ url, id, priority: id.startsWith('next') ? 1 : 2 })
}

// 处理预加载队列（控制并发）
function processPreloadQueue() {
  if (isPreloading || preloadQueue.length === 0) return
  
  isPreloading = true
  
  // 按优先级排序
  preloadQueue.sort((a, b) => a.priority - b.priority)
  
  // 批量处理
  const batch = preloadQueue.splice(0, PRELOAD_CONFIG.maxConcurrent)
  let completed = 0
  
  batch.forEach(item => {
    const img = new Image()
    img._preload = true
    img._id = item.id
    
    img.onload = () => {
      completed++
      if (completed >= batch.length) {
        isPreloading = false
        // 继续处理队列
        if (preloadQueue.length > 0) {
          setTimeout(() => processPreloadQueue(), 50)
        }
      }
    }
    
    img.onerror = () => {
      completed++
      if (completed >= batch.length) {
        isPreloading = false
        if (preloadQueue.length > 0) {
          setTimeout(() => processPreloadQueue(), 50)
        }
      }
    }
    
    img.src = item.url
    preloadImages.push(img)
  })
}

// 清理预加载
function clearPreload() {
  preloadImages.forEach(img => {
    if (img._preload) {
      img._preload = null
      img.src = ''
    }
  })
  preloadImages = []
  preloadQueue = []
  isPreloading = false
}

// ===== 缓存命中统计（调试用）=====
const cacheHits = ref(0) // 0=网络, 1=离线下载, 2=本地缓存
const cacheHitLabel = computed(() => ['网络', '离线下载', '本地缓存'][cacheHits.value])
const errorImg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3Crect fill='%23222' width='800' height='600'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='24' x='50%25' y='50%25' text-anchor='middle' dominant-baseline='middle'%3E图片加载失败%3C/text%3E%3C/svg%3E`

// ===== 章节加载 =====
async function loadChapter() {
  if (!currentChapter.value) return
  const token = ++loadChapterToken.value
  loading.value = true
  loadError.value = false
  images.value = []
  loadedImages.value = {}
  currentPage.value = 0
  singleOffset.value = 0
  cacheHits.value = 0

  if (contentRef.value) contentRef.value.scrollTop = 0
  if (scrollRef.value) scrollRef.value.scrollTop = 0

  const chapterUrl = currentChapter.value.url
  const referer = comic.value?.sourceUrl || chapterUrl
  const comicId = comic.value?._id || comic.value?.sourceUrl || ''
  const comicTitle = comic.value?.title || ''
  const chIndex = chapterIndex.value

  console.log('[Reader] 加载章节:', chapterUrl, 'comicId:', comicId, 'title:', comicTitle)

  let imgs = []
  let loaded = false

  if (window.offlineApi?.getLocalChapterImages) {
    try {
      console.log('[Reader] 尝试离线下载...')
      const localPaths = await window.offlineApi.getLocalChapterImages(comicId, chIndex, comicTitle)
      if (loadChapterToken.value !== token) return
      if (localPaths && localPaths.length > 0) {
        imgs = localPaths
        cacheHits.value = 1
        loaded = true
        console.log('[Reader] 使用离线下载:', localPaths.length, '张')
      }
    } catch (e) {
      console.warn('[Reader] 离线下载获取失败', e)
    }
  }

  if (!loaded) {
    if (!window.readerApi) {
      if (loadChapterToken.value !== token) return
      console.error('[Reader] readerApi 不可用')
      loadError.value = true
      loading.value = false
      return
    }
    try {
      console.log('[Reader] 调用 getChapterImages...')
      imgs = await window.readerApi.getChapterImages(chapterUrl, referer)
      if (loadChapterToken.value !== token) return
      cacheHits.value = 0
      console.log('[Reader] 网络加载返回:', imgs ? imgs.length : 0, '张')
    } catch (e) {
      console.error('[Reader] getChapterImages 失败:', e)
    }
  }

  if (loadChapterToken.value !== token) return

  if (!imgs || imgs.length === 0) {
    console.warn('[Reader] 没有图片数据')
    images.value = []
    loadError.value = true
    loading.value = false
    return
  }

  images.value = imgs

  await nextTick()
  if (loadChapterToken.value !== token) return
  try {
    await restoreProgress()
  } catch {}

  if (cacheHits.value === 0) {
    preloadNextChapter()
  }

  rebindLazyLoad()
  loading.value = false
  console.log('[Reader] 加载完成')

  // ✅ 打开即更新阅读时间：确保按"最近阅读"排序时这本漫画排第一
  // （即使读者不翻页，只是点开看看，也应该更新排序时间）
  saveProgress()
}



// ===== Canvas 渲染相关 =====
const canvasRef = ref(null)
const currentImageIndex = ref(0)
let canvasCtx = null
let currentImage = null

// 缩放相关状态
const zoomScale = ref(1.0)
const zoomOffsetX = ref(0)
const zoomOffsetY = ref(0)
const isDragging = ref(false)
const dragStartX = ref(0)
const dragStartY = ref(0)
const minScale = 0.5
const maxScale = 3.0



// 初始化 Canvas
async function initCanvas() {
  await nextTick()
  const canvas = canvasRef.value
  if (!canvas) return
  
  // 设置 Canvas 尺寸
  const container = canvas.parentElement
  canvas.width = container.clientWidth
  canvas.height = container.clientHeight
  
  // 获取绘图上下文
  canvasCtx = canvas.getContext('2d')
  
  // 加载并显示第一张图片
  currentImageIndex.value = currentPage.value
  await drawImageToCanvas()
}

// 绘制图片到 Canvas
async function drawImageToCanvas() {
  if (!canvasCtx || currentImageIndex.value < 0 || currentImageIndex.value >= images.value.length) return
  
  const imgUrl = images.value[currentImageIndex.value]
  if (!imgUrl) return
  
  // 尝试从缓存获取
  let img = getCachedImage(imgUrl)
  
  if (img) {
    // 使用缓存的图片直接绘制
    renderToCanvas(img)
  } else {
    // 加载新图片
    img = new Image()
    img.onload = () => {
      // 存入缓存
      imageCache.set(imgUrl, img)
      if (imageCache.size > 20) {
        const firstKey = imageCache.keys().next().value
        imageCache.delete(firstKey)
      }
      renderToCanvas(img)
    }
    
    img.onerror = () => {
      console.error('[Canvas] 图片加载失败:', imgUrl)
    }
    
    img.src = imgUrl
  }
}

// 实际绘制到 Canvas
function renderToCanvas(img) {
  const canvas = canvasRef.value
  const ctx = canvasCtx
  
  // 清空 Canvas
  ctx.fillStyle = '#0f0f0f'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  
  // 计算图片基础尺寸（保持宽高比，居中显示）
  const imgRatio = img.width / img.height
  const canvasRatio = canvas.width / canvas.height
  
  let baseWidth, baseHeight, baseOffsetX, baseOffsetY
  
  if (imgRatio > canvasRatio) {
    baseWidth = canvas.width
    baseHeight = canvas.width / imgRatio
    baseOffsetX = 0
    baseOffsetY = (canvas.height - baseHeight) / 2
  } else {
    baseHeight = canvas.height
    baseWidth = canvas.height * imgRatio
    baseOffsetX = (canvas.width - baseWidth) / 2
    baseOffsetY = 0
  }
  
  // 应用缩放
  const scaledWidth = baseWidth * zoomScale.value
  const scaledHeight = baseHeight * zoomScale.value
  const scaledOffsetX = baseOffsetX + zoomOffsetX.value
  const scaledOffsetY = baseOffsetY + zoomOffsetY.value
  
  // 绘制图片
  ctx.drawImage(img, scaledOffsetX, scaledOffsetY, scaledWidth, scaledHeight)
  
  currentImage = img
}

// Canvas 点击事件
function onCanvasClick(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  const w = rect.width
  const third = w / 3
  
  if (x < third) {
    // 上一页
    if (currentImageIndex.value > 0) {
      currentImageIndex.value--
      drawImageToCanvas()
      currentPage.value = currentImageIndex.value
      saveProgress()
    } else if (chapterIndex.value > 0) {
      // 上一章
      prevChapter()
    }
  } else if (x > third * 2) {
    // 下一页
    if (currentImageIndex.value < images.value.length - 1) {
      currentImageIndex.value++
      drawImageToCanvas()
      currentPage.value = currentImageIndex.value
      saveProgress()
    } else if (chapterIndex.value < chapters.value.length - 1) {
      // 下一章
      nextChapter()
    }
  } else {
    // 中间区域，显示/隐藏工具栏
    toggleToolbar()
  }
}

// Canvas 触摸事件
let canvasTouchStartX = 0
let canvasTouchStartY = 0

function onCanvasTouchStart(e) {
  canvasTouchStartX = e.touches[0].clientX
  canvasTouchStartY = e.touches[0].clientY
}

function onCanvasTouchEnd(e) {
  const deltaX = e.changedTouches[0].clientX - canvasTouchStartX
  const deltaY = e.changedTouches[0].clientY - canvasTouchStartY
  
  if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
    // 短点击，显示/隐藏工具栏
    toggleToolbar()
    return
  }
  
  if (Math.abs(deltaX) > 60) {
    if (deltaX > 0) {
      // 右滑，上一页
      if (currentImageIndex.value > 0) {
        currentImageIndex.value--
        drawImageToCanvas()
        currentPage.value = currentImageIndex.value
        saveProgress()
      } else if (chapterIndex.value > 0) {
        prevChapter()
      }
    } else {
      // 左滑，下一页
      if (currentImageIndex.value < images.value.length - 1) {
        currentImageIndex.value++
        drawImageToCanvas()
        currentPage.value = currentImageIndex.value
        saveProgress()
      } else if (chapterIndex.value < chapters.value.length - 1) {
        nextChapter()
      }
    }
  }
}


// ===== 缩放功能函数 =====

// 鼠标滚轮事件
function onCanvasWheel(e) {
  e.preventDefault()
  
  if (e.ctrlKey || e.metaKey) {
    // Ctrl+滚轮 = 缩放
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    const newScale = Math.max(minScale, Math.min(maxScale, zoomScale.value + delta))
    
    // 计算缩放中心点（鼠标位置）
    const canvas = canvasRef.value
    const rect = canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top
    
    // 调整偏移量，使缩放中心保持在鼠标位置
    const scaleRatio = newScale / zoomScale.value
    zoomOffsetX.value = mouseX - (mouseX - zoomOffsetX.value) * scaleRatio
    zoomOffsetY.value = mouseY - (mouseY - zoomOffsetY.value) * scaleRatio
    
    zoomScale.value = newScale
    drawImageToCanvas()
  } else {
    // 普通滚轮 = 翻页
    if (e.deltaY > 0) {
      // 下滚 = 下一页
      if (currentImageIndex.value < images.value.length - 1) {
        currentImageIndex.value++
        drawImageToCanvas()
        currentPage.value = currentImageIndex.value
        saveProgress()
      } else if (chapterIndex.value < chapters.value.length - 1) {
        nextChapter()
      }
    } else {
      // 上滚 = 上一页
      if (currentImageIndex.value > 0) {
        currentImageIndex.value--
        drawImageToCanvas()
        currentPage.value = currentImageIndex.value
        saveProgress()
      } else if (chapterIndex.value > 0) {
        prevChapter()
      }
    }
  }
}

// 鼠标拖拽开始
function onCanvasMouseDown(e) {
  if (zoomScale.value <= 1.0) return // 未放大时不拖拽
  
  isDragging.value = true
  dragStartX.value = e.clientX - zoomOffsetX.value
  dragStartY.value = e.clientY - zoomOffsetY.value
}

// 鼠标拖拽移动
function onCanvasMouseMove(e) {
  if (!isDragging.value) return
  
  e.preventDefault()
  zoomOffsetX.value = e.clientX - dragStartX.value
  zoomOffsetY.value = e.clientY - dragStartY.value
  
  drawImageToCanvas()
}

// 鼠标拖拽结束
function onCanvasMouseUp() {
  isDragging.value = false
}

// 双击重置缩放
function onCanvasDblClick(e) {
  e.preventDefault()
  zoomScale.value = 1.0
  zoomOffsetX.value = 0
  zoomOffsetY.value = 0
  drawImageToCanvas()
}

// 触摸缩放（双指捏合）
let initialTouchDistance = 0
let initialScale = 1.0

function onCanvasTouchStartZoom(e) {
  if (e.touches.length === 2) {
    // 双指触摸，计算初始距离
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    initialTouchDistance = Math.sqrt(dx * dx + dy * dy)
    initialScale = zoomScale.value
  } else if (e.touches.length === 1 && zoomScale.value > 1.0) {
    // 单指触摸（拖拽）
    isDragging.value = true
    dragStartX.value = e.touches[0].clientX - zoomOffsetX.value
    dragStartY.value = e.touches[0].clientY - zoomOffsetY.value
  }
}

function onCanvasTouchMoveZoom(e) {
  e.preventDefault()
  
  if (e.touches.length === 2) {
    // 双指缩放
    const dx = e.touches[0].clientX - e.touches[1].clientX
    const dy = e.touches[0].clientY - e.touches[1].clientY
    const currentDistance = Math.sqrt(dx * dx + dy * dy)
    
    const scaleRatio = currentDistance / initialTouchDistance
    const newScale = Math.max(minScale, Math.min(maxScale, initialScale * scaleRatio))
    
    // 计算缩放中心（两指中点）
    const canvas = canvasRef.value
    const rect = canvas.getBoundingClientRect()
    const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left
    const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
    
    // 调整偏移量
    const scaleChange = newScale / zoomScale.value
    zoomOffsetX.value = centerX - (centerX - zoomOffsetX.value) * scaleChange
    zoomOffsetY.value = centerY - (centerY - zoomOffsetY.value) * scaleChange
    
    zoomScale.value = newScale
    drawImageToCanvas()
  } else if (e.touches.length === 1 && isDragging.value) {
    // 单指拖拽
    zoomOffsetX.value = e.touches[0].clientX - dragStartX.value
    zoomOffsetY.value = e.touches[0].clientY - dragStartY.value
    
    drawImageToCanvas()
  }
}

function onCanvasTouchEndZoom(e) {
  if (e.touches.length < 2) {
    initialTouchDistance = 0
  }
  if (e.touches.length === 0) {
    isDragging.value = false
  }
}

function onCanvasResize() {
  if (useCanvas.value && canvasRef.value) {
    const canvas = canvasRef.value
    const container = canvas.parentElement
    canvas.width = container.clientWidth
    canvas.height = container.clientHeight
    drawImageToCanvas()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', onCanvasResize)
}

function goBack() {
  const comicId = comic.value?._id || comic.value?.sourceUrl || route.params.comicId
  router.push({ name: 'comicDetail', params: { id: comicId } })
}

// ===== 键盘快捷键 =====
function onKeyDown(e) {
  if (e.key === 'ArrowRight' || e.key === ' ') {
    e.preventDefault()
    nextPage()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    prevPage()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (mode.value === 'scroll' && scrollRef.value) {
      scrollRef.value.scrollBy({ top: 400, behavior: 'smooth' })
    } else {
      nextChapter()
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    prevChapter()
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    toggleFullscreen()
  } else if (e.key === 'b' || e.key === 'B') {
    e.preventDefault()
    toggleSingleDouble()
  } else if (e.key === '1' || e.key === '2' || e.key === '3') {
    e.preventDefault()
    const effects = ['fade', 'slide', 'none']
    setPageEffect(effects[parseInt(e.key) - 1])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    handleEscape()
  }
}

function toggleFullscreen() {
  if (!window.windowApi?.toggleFullscreen) return
  window.windowApi.toggleFullscreen()
}

function toggleSingleDouble() {
  const next = mode.value === 'single' ? 'double' : mode.value === 'double' ? 'scroll' : 'single'
  setMode(next)
}

function setPageEffect(effect) {
  pageEffect.value = effect
  localStorage.setItem('reader_settings', JSON.stringify({ mode: mode.value, effect }))
}

async function handleEscape() {
  if (window.windowApi?.isFullscreen) {
    const isFs = await window.windowApi.isFullscreen()
    if (isFs) {
      window.windowApi.exitFullscreen()
      return
    }
  }
  router.back()
}

onBeforeUnmount(() => {
  if (hideTimer) clearTimeout(hideTimer)
  if (saveTimer) clearTimeout(saveTimer)
  if (imageObserver) {
    imageObserver.disconnect()
    observerImages.clear()
  }
  // 清理预加载
  clearPreload()
  // 清理图片缓存
  imageCache.clear()
  document.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', onCanvasResize)
})
</script>

<style scoped>
.reader-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0f0f0f;
  overflow: hidden;
  position: relative;
}

/* ===== 顶部工具栏 ===== */
.reader-toolbar {
  position: absolute;
  top: 0; left: 0; right: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  padding-top: max(8px, env(safe-area-inset-top));
  background: rgba(10, 10, 10, 0.88);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

.toolbar-left {
  display: flex; align-items: center; gap: 12px;
  min-width: 0; flex: 1;
}
.tool-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px;
  color: rgba(255,255,255,.65);
  background: rgba(255,255,255,.04);
  border: none; cursor: pointer;
  border-radius: 10px; transition: all .2s cubic-bezier(0.4, 0, 0.2, 1); flex-shrink: 0;
}
.tool-btn:hover { 
  background: rgba(255,255,255,.12); 
  color: #fff; 
  transform: scale(1.05);
  box-shadow: 0 2px 8px rgba(255, 255, 255, 0.1);
}
.tool-btn:active {
  transform: scale(0.95);
}

.chapter-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.comic-title { font-size: 13px; font-weight: 600; color: rgba(255,255,255,.95); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chapter-name { font-size: 11px; color: rgba(255,255,255,.4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.chapter-select {
  padding: 6px 12px; border-radius: 8px;
  background: rgba(255,255,255,.06); color: rgba(255,255,255,.85);
  border: 1px solid rgba(255,255,255,.08); font-size: 12px;
  max-width: 160px; cursor: pointer; outline: none;
  appearance: none;
  position: relative;
  transition: all .2s;
}
.chapter-select:hover {
  background: rgba(255,255,255,.1);
  border-color: rgba(255,255,255,.15);
}
.chapter-select:focus {
  border-color: var(--brand, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
}
.chapter-select::after {
  content: '▼';
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 8px;
  color: rgba(255,255,255,.4);
}

/* ===== 阅读内容区 ===== */
.reader-content {
  flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
  -webkit-overflow-scrolling: touch;
}

/* ===== 加载中 ===== */
.reader-loading {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  color: rgba(255,255,255,.4);
}
.loading-spinner {
  width: 32px; height: 32px;
  border: 2px solid rgba(255,255,255,.1);
  border-top-color: rgba(255,255,255,.6); border-radius: 50%;
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-text { font-size: 12px; }

/* ========== 单页模式 ========== */

/* ===== Canvas 渲染模式 ===== */
.canvas-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.comic-canvas {
  max-width: 100%;
  max-height: 100%;
  display: block;
  cursor: pointer;
}

.canvas-page-info {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
  letter-spacing: 2px;
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  pointer-events: none;
  z-index: 10;
}

.single-page-wrapper {
  display: flex; align-items: flex-start; justify-content: center;
  min-height: 100%; position: relative;
  transition: transform .3s ease;
}
.page-flip-wrapper { width: 100%; min-height: 100%; display: flex; align-items: flex-start; justify-content: center; }
.single-page-container {
  width: 100%; max-width: 100%;
  display: flex; flex-direction: column; align-items: center;
  padding-top: 8px;
}
.page-label-top {
  font-size: 11px;
  color: rgba(255,255,255,.35);
  letter-spacing: 2px;
  padding: 4px 10px;
  background: rgba(0,0,0,.3);
  border-radius: 8px;
  margin-bottom: 8px;
}
.comic-image.single {
  width: 100%; height: auto;
  max-width: 100%;
  display: block;
  opacity: 1; transition: opacity .3s;
  min-height: 200px;
}
.comic-image.single.loading {
  opacity: 0.35;
  background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  animation: scrollShimmer 1.5s infinite;
}
.comic-image.single.loaded { opacity: 1; }
.comic-image.placeholder {
  opacity: 1;
  background: #222;
}

/* ========== 双页模式 ========== */
.double-page {
  display: flex; height: 100%; align-items: flex-start;
  padding: 0;
}
.page-left, .page-right {
  flex: 1;
  min-width: 0;
  display: flex; align-items: flex-start; justify-content: center;
}
.double-page-container {
  width: 100%;
  display: flex; flex-direction: column; align-items: center;
  padding-top: 8px;
}
.page-gutter {
  width: 20px; flex-shrink: 0;
  position: relative;
}
.page-gutter::after {
  content: ''; position: absolute;
  top: 10%; bottom: 10%; left: 50%;
  width: 2px;
  background: linear-gradient(to bottom, transparent 0%, rgba(255,255,255,.1) 50%, transparent 100%);
  transform: translateX(-50%);
}
.comic-image.double {
  width: 100%; height: auto;
  max-width: 100%;
  display: block;
  opacity: 1; transition: opacity .3s;
  min-height: 200px;
}
.comic-image.double.loading {
  opacity: 0.35;
  background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  animation: scrollShimmer 1.5s infinite;
}
.comic-image.double.loaded { opacity: 1; }
.comic-image.placeholder {
  opacity: 1;
  background: #222;
}

/* ========== 卷轴模式 ========== */
.scroll-mode {
  height: 100%; overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
.scroll-images { display: flex; flex-direction: column; align-items: stretch; }
.scroll-page { position: relative; }
.page-number {
  position: absolute; top: 12px; left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,.55);
  color: rgba(255,255,255,.7);
  font-size: 11px; padding: 4px 10px; border-radius: 10px;
  letter-spacing: 1px; z-index: 5; pointer-events: none;
}
.image-error-label {
  position: absolute; bottom: 16px; left: 50%;
  transform: translateX(-50%);
  background: rgba(255,80,80,.85);
  color: #fff; font-size: 11px; padding: 4px 10px; border-radius: 10px;
  z-index: 5; pointer-events: none;
}
.comic-image.scroll {
  width: 100%; height: auto; max-width: 100%;
  display: block; opacity: 1;
  transition: opacity .3s;
  min-height: 200px;
}
.comic-image.scroll.loaded { opacity: 1; }
.comic-image.scroll.loading {
  opacity: 0.4;
  background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
  background-size: 200% 100%;
  animation: scrollShimmer 1.5s infinite;
}
.comic-image.scroll.placeholder { opacity: 1; background: #222; }

@keyframes scrollShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.page-end {
  padding: 32px 20px 48px;
  text-align: center;
  font-size: 12px;
  color: rgba(255,255,255,.25);
  letter-spacing: 1px;
}
.page-end .end-title {
  font-size: 15px;
  color: rgba(255,255,255,.75);
  letter-spacing: 2px;
  margin-bottom: 8px;
}
.page-end.allDone .end-title { color: #6cc28a; }
.page-end.hasFailed .end-detail { color: rgba(255,140,140,.7); }
.page-end .end-detail {
  font-size: 12px;
  color: rgba(255,255,255,.4);
  margin-bottom: 12px;
}
.page-end .end-next {
  font-size: 11px;
  color: rgba(255,255,255,.3);
  margin-top: 16px;
  animation: blinkSoft 2s infinite;
}
@keyframes blinkSoft {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}
.page-end .loading-dots {
  font-size: 14px;
  color: rgba(255,255,255,.55);
  margin-bottom: 8px;
  display: inline-flex; align-items: center; gap: 2px;
}
.page-end .dots span {
  animation: dotPulse 1.4s infinite;
  display: inline-block;
}
.page-end .dots span:nth-child(2) { animation-delay: 0.2s; }
.page-end .dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dotPulse {
  0%, 60%, 100% { opacity: 0.2; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-3px); }
}
.page-end .end-progress {
  width: 180px; height: 3px;
  background: rgba(255,255,255,.08);
  border-radius: 2px;
  margin: 12px auto 0;
  overflow: hidden;
}
.page-end .end-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4a90e2, #6cc28a);
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* 空/错误 */
.reader-empty {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  color: rgba(255,255,255,.4);
}
.empty-icon { font-size: 36px; }
.empty-text { font-size: 14px; }
.btn-retry {
  padding: 6px 20px; border-radius: 6px;
  background: rgba(255,255,255,.08); color: rgba(255,255,255,.75);
  border: 1px solid rgba(255,255,255,.12); font-size: 12px; cursor: pointer;
}
.btn-retry:hover { background: rgba(255,255,255,.16); color: #fff; }

/* ===== 底部导航 ===== */
.reader-nav {
  position: absolute; bottom: 0; left: 0; right: 0; z-index: 100;
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 16px;
  padding-bottom: max(8px, env(safe-area-inset-bottom));
  background: rgba(10,10,10,.88);
  backdrop-filter: blur(20px); border-top: 1px solid rgba(255,255,255,.04);
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.nav-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 10px;
  background: rgba(255,255,255,.04); color: rgba(255,255,255,.65);
  border: none; font-size: 12px; font-weight: 500; cursor: pointer; transition: all .2s cubic-bezier(0.4, 0, 0.2, 1); white-space: nowrap;
}
.nav-btn:hover:not(:disabled) { 
  background: rgba(255,255,255,.12); 
  color: #fff; 
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(255, 255, 255, 0.1);
}
.nav-btn:active:not(:disabled) {
  transform: translateY(0);
}
.nav-btn:disabled { opacity: .2; cursor: not-allowed; }
.nav-center { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 1; }
.nav-info { font-size: 12px; color: rgba(255,255,255,.4); font-weight: 500; }
.progress-bar-mini {
  width: 180px; height: 4px; background: rgba(255,255,255,.08); border-radius: 2px; overflow: hidden;
}
.progress-bar-mini .fill { 
  height: 100%; 
  background: linear-gradient(90deg, var(--brand-start, #6366f1), var(--brand-end, #8b5cf6)); 
  background-size: 300% 100%;
  animation: progressShimmer 2s linear infinite;
  border-radius: 2px; 
  transition: width .3s ease; 
}

/* ===== 模式菜单 ===== */
.mode-overlay {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(0,0,0,.6);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
}
.mode-menu {
  display: flex; flex-direction: column; gap: 4px;
  background: rgba(26, 26, 26, 0.95); border-radius: 16px; padding: 8px; min-width: 200px;
  border: 1px solid rgba(255,255,255,.06);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
.mode-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-radius: 10px;
  color: rgba(255,255,255,.55); cursor: pointer; transition: all .2s cubic-bezier(0.4, 0, 0.2, 1);
}
.mode-item:hover { 
  background: rgba(255,255,255,.06); 
  color: #fff; 
  transform: translateX(4px);
}
.mode-item.active { 
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(139, 92, 246, 0.2)); 
  color: #c7d2fe; 
  border: 1px solid rgba(99, 102, 241, 0.2);
}

/* ===== 翻页过渡 ===== */
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.slide-enter-active, .slide-leave-active { transition: all .2s ease; position: absolute; width: 100%; }
.slide-enter-from { transform: translateX(30px); opacity: 0; }
.slide-leave-to { transform: translateX(-30px); opacity: 0; }

.page-flip-enter-active { animation: pageSlideIn .25s ease-out; }
.page-flip-leave-active { animation: pageSlideOut .2s ease-in; position: absolute; }
@keyframes pageSlideIn {
  from { transform: perspective(1200px) rotateY(-8deg) scale(.95); opacity: 0; }
  to { transform: perspective(1200px) rotateY(0) scale(1); opacity: 1; }
}
@keyframes pageSlideOut {
  to { transform: perspective(1200px) rotateY(8deg) scale(.95); opacity: 0; }
}

/* 工具栏过渡 */
.slide-down-enter-active, .slide-down-leave-active { transition: transform .2s ease; }
.slide-down-enter-from, .slide-down-leave-to { transform: translateY(-100%); }
.slide-up-enter-active, .slide-up-leave-active { transition: transform .2s ease; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateY(100%); }

/* 滚动条 */
.scroll-mode::-webkit-scrollbar { width: 4px; }
.scroll-mode::-webkit-scrollbar-track { background: transparent; }
.scroll-mode::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 2px; }
</style>