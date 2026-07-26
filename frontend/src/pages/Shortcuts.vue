<template>
  <transition name="fade">
    <div v-if="visible" class="shortcuts-overlay" @click.self="close">
      <div class="shortcuts-panel">
        <div class="panel-header">
          <h2 class="panel-title">⌨️ 键盘快捷键</h2>
          <button class="close-btn" title="关闭 (ESC)" @click="close">ESC</button>
        </div>

        <div class="shortcuts-grid">
          <!-- 阅读器 -->
          <div class="shortcut-section">
            <h3 class="section-title">阅读器</h3>
            <div class="shortcut-list">
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">←</kbd>
                  <span class="keycap-separator">/</span>
                  <kbd class="keycap">→</kbd>
                </div>
                <span class="shortcut-desc">翻页</span>
              </div>
              <div class="shortcut-item">
                <kbd class="keycap">Space</kbd>
                <span class="shortcut-desc">翻页（向下滚动）</span>
              </div>
              <div class="shortcut-item">
                <kbd class="keycap">ESC</kbd>
                <span class="shortcut-desc">退出全屏 / 返回</span>
              </div>
              <div class="shortcut-item">
                <kbd class="keycap">F</kbd>
                <span class="shortcut-desc">切换全屏模式</span>
              </div>
              <div class="shortcut-item">
                <kbd class="keycap">B</kbd>
                <span class="shortcut-desc">切换阅读模式（单页/双页）</span>
              </div>
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">1</kbd>
                  <kbd class="keycap">2</kbd>
                  <kbd class="keycap">3</kbd>
                </div>
                <span class="shortcut-desc">切换翻页动画效果</span>
              </div>
            </div>
          </div>

          <!-- 导航 -->
          <div class="shortcut-section">
            <h3 class="section-title">导航</h3>
            <div class="shortcut-list">
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">Ctrl</kbd>
                  <kbd class="keycap">K</kbd>
                </div>
                <span class="shortcut-desc">打开搜索</span>
              </div>
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">Ctrl</kbd>
                  <kbd class="keycap">F</kbd>
                </div>
                <span class="shortcut-desc">打开搜索</span>
              </div>
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">Ctrl</kbd>
                  <kbd class="keycap">1-8</kbd>
                </div>
                <span class="shortcut-desc">侧栏导航（快速跳转）</span>
              </div>
            </div>
          </div>

          <!-- 全局 -->
          <div class="shortcut-section">
            <h3 class="section-title">全局</h3>
            <div class="shortcut-list">
              <div class="shortcut-item">
                <kbd class="keycap">ESC</kbd>
                <span class="shortcut-desc">关闭弹窗 / 返回上一页</span>
              </div>
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">?</kbd>
                </div>
                <span class="shortcut-desc">显示/隐藏帮助面板</span>
              </div>
              <div class="shortcut-item">
                <div class="keycap-group">
                  <kbd class="keycap">Ctrl</kbd>
                  <kbd class="keycap">/</kbd>
                </div>
                <span class="shortcut-desc">显示/隐藏帮助面板</span>
              </div>
            </div>
          </div>
        </div>

        <div class="panel-footer">
          <span class="footer-text">提示：按 <kbd class="keycap-inline">ESC</kbd> 或点击空白处可关闭此面板</span>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const visible = ref(false)

// 暴露 visible 状态供父组件控制
defineExpose({ visible })

function open() {
  visible.value = true
}

function close() {
  visible.value = false
}

// 键盘快捷键监听
function onKeydown(e) {
  // 如果已经在显示 shortcuts，按 ESC 关闭
  if (visible.value && e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }

  // 如果当前有输入框获得焦点，不触发快捷键
  const tag = document.activeElement?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return
  }

  // ? 键打开帮助面板
  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    open()
    return
  }

  // Ctrl+/ 打开帮助面板
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault()
    open()
    return
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
/* ===== 遮罩层 ===== */
.shortcuts-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

/* ===== 主面板 ===== */
.shortcuts-panel {
  width: 640px;
  max-width: 92vw;
  max-height: 85vh;
  background: var(--content-bg);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(30px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ===== 面板头部 ===== */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-light);
}

.panel-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  letter-spacing: -0.3px;
}

.close-btn {
  padding: 8px 14px;
  border: none;
  border-radius: var(--radius);
  background: var(--bg-hover);
  color: var(--text-sub);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
  min-height: auto;
  min-width: auto;
}

.close-btn:hover {
  background: var(--bg-active);
  color: var(--text);
  transform: scale(1.05);
}

/* ===== 快捷键网格 ===== */
.shortcuts-grid {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.shortcut-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--border-light);
  letter-spacing: 0.2px;
}

.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  transition: all .25s cubic-bezier(0.4, 0, 0.2, 1);
}

.shortcut-item:hover {
  background: var(--bg-hover);
  transform: translateX(4px);
}

/* ===== 按键样式 ===== */
.keycap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 34px;
  padding: 0 12px;
  background: linear-gradient(180deg, #ffffff 0%, var(--bg-card) 100%);
  border: 1px solid var(--border-light);
  border-bottom: 3px solid var(--border);
  border-radius: 8px;
  font-family: 'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.06);
  line-height: 1;
  user-select: none;
  transition: all .2s;
}

.keycap:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
}

.keycap-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.keycap-separator {
  color: var(--text-dim);
  font-size: 14px;
  font-weight: 500;
}

.keycap-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 26px;
  height: 26px;
  padding: 0 8px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  font-family: 'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  line-height: 1;
}

/* ===== 描述文字 ===== */
.shortcut-desc {
  font-size: 14px;
  color: var(--text-sub);
  flex: 1;
  line-height: 1.5;
}

/* ===== 面板底部 ===== */
.panel-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--border-light);
  background: var(--bg-card);
}

.footer-text {
  font-size: 13px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ===== 过渡动画 ===== */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ===== 响应式 ===== */
@media (max-width: 640px) {
  .shortcuts-panel {
    width: 100%;
    max-width: 100%;
    max-height: 90vh;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }

  .shortcuts-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .shortcut-item {
    flex-wrap: wrap;
    gap: 10px;
  }

  .shortcut-desc {
    width: 100%;
    margin-top: 4px;
  }
}

/* ===== 滚动条美化 ===== */
.shortcuts-grid::-webkit-scrollbar {
  width: 6px;
}

.shortcuts-grid::-webkit-scrollbar-track {
  background: transparent;
}

.shortcuts-grid::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.shortcuts-grid::-webkit-scrollbar-thumb:hover {
  background: var(--text-dim);
}
</style>