<template>
  <header class="header">
    <div class="header-left">
      <div class="header-search">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input v-model="globalSearch" placeholder="搜索漫画名称 / 作者..." @keydown.enter="triggerSearch" />
      </div>
    </div>
    <div class="header-right">
      <div class="window-controls">
        <button class="win-btn win-min" title="最小化" @click="minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" rx="0.5" fill="currentColor"/></svg>
        </button>
        <button class="win-btn win-max" :title="isMaximized ? '还原' : '最大化'" @click="toggleMaximize">
          <svg v-if="isMaximized" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="2.5" y="1.5" width="6" height="6" rx="1"/><rect x="1.5" y="2.5" width="6" height="6" rx="1"/></svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>
        </button>
        <button class="win-btn win-close" title="关闭" @click="closeWin">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, inject, provide } from 'vue'

const openSearch = inject('openSearch', () => {})

const globalSearch = ref('')
const searchTrigger = ref(0)

provide('globalSearch', globalSearch)
provide('searchTrigger', searchTrigger)

const triggerSearch = () => {
  const q = globalSearch.value.trim()
  searchTrigger.value++
  openSearch(q)
  globalSearch.value = ''
}

// 窗口控制
const isMaximized = ref(false)

let _removeMaximizeChange = null
onMounted(async () => {
  if (window.windowApi) {
    try {
      isMaximized.value = await window.windowApi.isMaximized()
    } catch (_) {}
    try {
      if (window.windowApi.onMaximizeChange) {
        _removeMaximizeChange = window.windowApi.onMaximizeChange((v) => { isMaximized.value = v })
      }
    } catch (_) {}
  }
})
onBeforeUnmount(() => { if (_removeMaximizeChange) { try { _removeMaximizeChange() } catch (_) {} } })

function minimize() { window.windowApi?.minimize?.() }
function toggleMaximize() { window.windowApi?.maximize?.() }
function closeWin() { window.windowApi?.close?.() }
</script>

<style scoped>
.header {
  grid-column: 2;
  grid-row: 1;
  height: var(--header-h);
  background: var(--shell-bg);
  border-bottom: 1px solid var(--shell-border);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 24px 0 12px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(20px);
  -webkit-app-region: drag;
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.header-search {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(100%, 440px);
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--glass-border);
  background: var(--content-bg);
  border-radius: 14px;
  transition: all 0.25s ease;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(16px);
  -webkit-app-region: no-drag;
}

.header-search:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 4px var(--brand-bg), var(--shadow-sm);
  background: var(--bg-elevated);
}

.header-search input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
  min-height: auto;
}

.header-search input::placeholder {
  color: var(--text-dim);
}

.search-icon {
  color: var(--text-dim);
  flex-shrink: 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  -webkit-app-region: no-drag;
}

.window-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.win-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-dim);
  cursor: pointer;
  transition: all 0.2s ease;
}

.win-btn:hover {
  background: var(--bg-active);
  color: var(--text);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

.win-close:hover {
  background: #FF5E4F;
  color: #fff;
  box-shadow: 0 4px 12px rgba(255, 94, 79, 0.3);
}

.win-min:hover { color: #FFB020; }
.win-max:hover { color: #22C55E; }
</style>