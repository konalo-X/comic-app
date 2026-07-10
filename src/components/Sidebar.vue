<template>
  <aside class="sidebar">
    <nav class="sidebar-nav">
      <router-link 
        v-for="n in navItems" 
        :key="n.path" 
        :to="n.path" 
        class="nav-item" 
        :title="n.label"
      >
        <svg class="nav-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" v-html="n.iconSvg"></svg>
      </router-link>
    </nav>
    <div class="sidebar-bottom">
      <button class="nav-item theme-toggle" :title="themeLabel" @click="toggleTheme">
        <svg v-if="isDark" class="nav-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        <svg v-else class="nav-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { useUserStore } from '@/stores/userStore'

const userStore = useUserStore()
const isDark = userStore.isDark

const themeLabel = computed(() => {
  const themes = userStore.themeOptions
  const currentIdx = themes.findIndex(t => t.id === userStore.theme)
  const next = themes[(currentIdx + 1) % themes.length]
  return `切换到${next.label}模式`
})

function toggleTheme() {
  userStore.toggleTheme()
}

const navItems = [
  { 
    path: '/comic-list', 
    label: '漫画列表', 
    iconSvg: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>'
  },
  {
    path: '/bookshelf',
    label: '漫画书架',
    iconSvg: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7" stroke-width="1.2"/><line x1="8" y1="11" x2="14" y2="11" stroke-width="1.2"/>'
  },
  { 
    path: '/download-queue', 
    label: '下载', 
    iconSvg: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
  },
  { 
    path: '/settings', 
    label: '设置', 
    iconSvg: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
  }
]
</script>

<style scoped>
.sidebar {
  grid-row: 1 / -1;
  grid-column: 1;
  background: var(--shell-bg);
  border-right: 1px solid var(--shell-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 72px;
  z-index: 1;
  padding-top: calc(var(--header-h) + 24px);
  padding-bottom: 14px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(22px);
}

.sidebar-nav {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
}

.nav-item {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  color: var(--text-dim);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  text-decoration: none;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
}

.nav-item:hover {
  color: var(--brand);
  background: var(--bg-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}

.nav-item.router-link-active {
  color: #fff;
  background: var(--gradient-brand);
  box-shadow: var(--shadow-md);
  transform: translateY(-3px);
}

.nav-item.router-link-active::before {
  content: '';
  position: absolute;
  left: -16px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--brand-start);
  border-radius: 0 2px 2px 0;
}

.nav-icon {
  width: 22px;
  height: 22px;
}

.sidebar-bottom {
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--shell-border);
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.theme-toggle {
  color: var(--text-dim);
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.theme-toggle:hover {
  color: var(--accent);
  background: var(--accent-bg);
  transform: rotate(15deg);
}
</style>