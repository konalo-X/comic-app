<template>
  <div class="filter-card">
    <div class="filter-row">
      <span class="filter-label">分类</span>
      <div class="filter-tags">
        <a 
          v-for="c in categories" 
          :key="c.value"
          :class="['filter-link', { active: activeCategory === c.value }]"
          href="javascript:;" 
          @click="$emit('update:active-category', c.value)"
        >{{ c.label }}</a>
      </div>
    </div>
    <div class="filter-row">
      <span class="filter-label">来源</span>
      <div class="filter-tags">
        <a 
          v-for="s in sourceOptions" 
          :key="s.value"
          :class="['filter-link', { active: activeSource === s.value }]"
          href="javascript:;" 
          @click="$emit('update:active-source', s.value)"
        >{{ s.label }}</a>
      </div>
    </div>
    <div class="filter-row">
      <span class="filter-label">进度</span>
      <div class="filter-tags">
        <a 
          v-for="s in statusOptions" 
          :key="s.value"
          :class="['filter-link', { active: activeStatus === s.value }]"
          href="javascript:;" 
          @click="$emit('update:active-status', s.value)"
        >{{ s.label }}</a>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  activeCategory: { type: String, default: 'all' },
  activeSource: { type: String, default: 'all' },
  activeStatus: { type: String, default: 'all' },
  categories: { type: Array, default: () => [] }
})

defineEmits(['update:active-category', 'update:active-source', 'update:active-status'])

const sourceOptions = [
  { label: '全部', value: 'all' },
  { label: '本地', value: 'local' },
  { label: '在线', value: 'online' }
]

const statusOptions = [
  { label: '全部', value: 'all' },
  { label: '已完结', value: 'completed' },
  { label: '更新中', value: 'serialized' }
]
</script>

<style scoped>
.filter-card {
  background: var(--bg-card); border-radius: var(--radius-lg);
  padding: 12px 16px; margin-bottom: 12px;
  border: 1px solid var(--border-light);
  box-shadow: var(--shadow-sm);
}
.filter-row { display: flex; align-items: center; margin-bottom: 12px; }
.filter-row:last-child { margin-bottom: 0; }
.filter-label {
  font-size: 13px; font-weight: 600; color: var(--text-sub);
  min-width: 44px; flex-shrink: 0;
}
.filter-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-link {
  padding: 6px 14px; font-size: 12px; color: var(--text-sub);
  border-radius: var(--radius); transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.filter-link:hover { color: var(--brand); }
.filter-link.active { color: var(--brand); text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 2px; }
@media (hover: none) and (pointer: coarse) {
  .filter-link:active {
    transform: scale(0.95);
  }
}
</style>