<template>
  <div 
    :class="['comic-card', { 'batch-selected': selected, 'skeleton-card': skeleton }]" 
    @click="$emit('click')"
    @dblclick="$emit('dblclick')"
  >
    <div class="card-thumb">
      <div v-if="skeleton" class="skeleton-thumb"></div>
      <template v-else>
        <img
          v-if="coverUrl"
          :src="coverUrl"
          :alt="comic.title"
          class="thumb-img"
          loading="lazy"
          referrerpolicy="no-referrer"
        />
        <div v-else class="thumb-placeholder">
          <span class="thumb-letter">{{ (comic.title || '?')[0] }}</span>
        </div>
        <div v-if="comic.status === 'completed'" class="thumb-badge completed">已完结</div>
        <div v-else-if="comic.status === 'serialized'" class="thumb-badge">连载中</div>
        <div v-if="localStatus === 'local'" class="thumb-badge local">本地</div>
        <div v-else-if="localStatus === 'update'" class="thumb-badge update">{{ updateBadgeText }}</div>
        <div v-else class="thumb-badge online">在线</div>
        <div v-if="comic.epubExists" class="thumb-badge epub-badge-card">EPUB</div>
        <div v-if="progress > 0" class="card-progress-bar">
          <div class="fill" :style="{ width: progress + '%' }"></div>
        </div>
      </template>
      <div v-if="showCheckbox" :class="{ checked: selected }" class="batch-checkbox" @click.stop="$emit('toggle-select')">
        <svg v-if="selected" viewBox="0 0 24 24" width="12" height="12" fill="white" stroke="none"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <!-- 下载按钮 -->
      <button
        v-if="!skeleton && localStatus === 'online'"
        class="card-download-btn"
        title="下载漫画"
        @click.stop="$emit('download')"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    </div>
    <div class="card-text">
      <div v-if="skeleton">
        <div class="skeleton-line w-80"></div>
      </div>
      <template v-else>
        <div class="card-title">{{ comic.title }}</div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  comic: { type: Object, default: null },
  skeleton: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  showCheckbox: { type: Boolean, default: false },
  progress: { type: Number, default: 0 }
})

// 本地状态：local=已下载, update=有更新, online=仅在线
const localStatus = computed(() => {
  if (!props.comic) return 'online'
  const delta = props.comic.updateDelta || 0
  if (props.comic.local_path) {
    if (delta > 0) return 'update'
    return 'local'
  }
  if (delta > 0) return 'update'
  return 'online'
})

// 更新徽章文案
const updateBadgeText = computed(() => {
  const delta = props.comic?.updateDelta || 0
  if (delta > 0) return `+${delta}`
  return '有更新'
})

// 封面 URL：优先在线 cover（通过代理防盗链），回退到本地 local_cover
const coverUrl = computed(() => {
  if (!props.comic) return ''
  // 在线封面（通过代理解决防盗链）
  if (props.comic.cover) {
    const src = String(props.comic.cover)
    if (src.startsWith('http://') || src.startsWith('https://')) {
      // 通过图片代理加载，解决防盗链
      return window.utils ? window.utils.toProxyUrl(src, src) : src
    }
    if (src.startsWith('data:')) return src
    // 其他情况当成本地路径走代理
    return window.utils ? window.utils.toLocalUrl(src) : src
  }
  // 回退到本地封面
  if (props.comic.local_cover) {
    const local = String(props.comic.local_cover)
    return window.utils ? window.utils.toLocalUrl(local) : local
  }
  return ''
})

defineEmits(['click', 'dblclick', 'toggle-select', 'download'])
</script>

<style scoped>
.comic-card {
  display: flex; flex-direction: column;
  cursor: pointer;
  min-width: 0;
  border-radius: var(--radius-lg);
  position: relative;
  border: 1px solid var(--glass-border);
  background: var(--content-bg);
  overflow: hidden;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  animation: cardFadeIn 0.5s ease both;
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.25s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.25s ease;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
}
.comic-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--shell-border);
}
.comic-card:hover .card-thumb::after {
  opacity: 1;
}
@media (hover: none) and (pointer: coarse) {
  .comic-card:active {
    transform: scale(0.97);
    transition: transform 0.1s;
  }
}

@keyframes cardFadeIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.card-thumb {
  display: block; width: 100%; aspect-ratio: 3/4;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; overflow: hidden;
  position: relative; background: var(--bg-hover);
  flex-shrink: 0;
}
.card-thumb::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 50%;
  background: var(--gradient-card);
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
  z-index: 1;
}
.thumb-img {
  width: 100%; height: 100%; object-fit: cover;
  display: block;
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
.comic-card:hover .thumb-img {
  transform: scale(1.05);
}
.thumb-placeholder {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  position: absolute; top: 0; left: 0;
  background: var(--gradient-brand);
}
.thumb-letter {
  font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.9);
  letter-spacing: -1px;
}

.thumb-badge {
  position: absolute; top: 8px; left: 8px;
  padding: 3px 8px; border-radius: 6px;
  font-size: 10px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  z-index: 3;
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
}
.thumb-badge.completed {
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  box-shadow: 0 2px 6px rgba(16, 185, 129, 0.3);
}
.thumb-badge.local {
  left: auto;
  right: 8px;
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
  box-shadow: 0 2px 6px rgba(99, 102, 241, 0.3);
}
.thumb-badge.update {
  left: auto;
  right: 8px;
  background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
  box-shadow: 0 2px 6px rgba(249, 115, 22, 0.4);
  animation: pulseBadge 2s ease-in-out infinite;
}
.thumb-badge.online {
  left: auto;
  right: 8px;
  background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
  box-shadow: 0 2px 6px rgba(107, 114, 128, 0.3);
}

.epub-badge-card {
  left: auto;
  right: 8px;
  top: 36px;
  background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
  box-shadow: 0 2px 6px rgba(139, 92, 246, 0.4);
}

.update-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  z-index: 4;
  box-shadow: 0 2px 6px rgba(249, 115, 22, 0.4);
  animation: pulseBadge 2s ease-in-out infinite;
}

@keyframes pulseBadge {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

.card-progress-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 3px;
  background: rgba(255,255,255,.15);
  z-index: 3;
}
.card-progress-bar .fill {
  height: 100%;
  background: var(--gradient-brand);
  border-radius: 0 3px 3px 0;
  transition: width .3s ease;
  box-shadow: 0 0 6px rgba(99, 102, 241, 0.4);
}

.skeleton-thumb {
  width: 100%;
  aspect-ratio: 3/4;
  background: linear-gradient(135deg, var(--bg-hover) 0%, var(--bg-active) 50%, var(--bg-hover) 100%);
  background-size: 200% 200%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
}
.skeleton-line {
  height: 8px; border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-hover) 0%, var(--bg-active) 50%, var(--bg-hover) 100%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  margin-bottom: 6px;
}
.skeleton-line:last-child { margin-bottom: 0; }
.w-80 { width: 80%; }
.w-60 { width: 60%; }
.w-40 { width: 40%; }
@keyframes shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
.skeleton-card { cursor: default; background: transparent; box-shadow: none; border: 1px solid var(--border-light); }
.skeleton-card:hover { transform: none !important; box-shadow: none !important; }

.card-text { padding: 6px 8px 8px; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.card-title {
  font-size: 11px; font-weight: 600; line-height: 1.3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--text);
}

.batch-checkbox {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 5;
  background: rgba(26, 29, 41, 0.5);
  backdrop-filter: blur(4px);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  cursor: pointer;
  transition: all .2s;
}
.batch-checkbox:hover {
  background: rgba(26, 29, 41, 0.7);
}
.batch-checkbox.checked {
  background: var(--brand);
}
.batch-selected {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}

.card-download-btn {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 5;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(26, 29, 41, 0.7);
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255,255,255,0.15);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 0;
  transform: translateY(4px);
}
.comic-card:hover .card-download-btn {
  opacity: 1;
  transform: translateY(0);
}
.card-download-btn:hover {
  background: var(--brand);
  border-color: var(--brand);
  transform: scale(1.1);
}
@media (hover: none) and (pointer: coarse) {
  .card-download-btn {
    opacity: 1;
    transform: translateY(0);
    width: 28px;
    height: 28px;
  }
}
</style>