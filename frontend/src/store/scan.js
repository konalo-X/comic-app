import { reactive, ref } from 'vue'

// ===== 全局扫描状态（模块级单例，路由切换不丢失）=====
export const scanState = reactive({
  scanning: false,
  progressText: '',
  current: 0,
  total: 0,
  pct: 0
})

export const scanRefresh = ref(0)

// ===== IPC 监听器注册（全局只注册一次）=====
function initListeners() {
  if (!window || !window.scanApi) {
    setTimeout(initListeners, 200)
    return
  }
  if (window.__scanListenersReady) return

  console.log('[scan] registering IPC listeners')

  window.scanApi.onProgress((p) => {
    if (!p) return
    scanState.scanning = true
    scanState.total = p.total || 0
    scanState.current = p.index || 0
    scanState.pct = scanState.total > 0
      ? Math.min(100, Math.round((scanState.current / scanState.total) * 100))
      : 0

    const stageMap = {
      scan: '扫描目录',
      prep: '准备导入',
      exists: '已在书架',
      match: '联网匹配',
      'import-matched': '导入 (匹配成功)',
      'import-local': '导入',
      done: '完成'
    }
    const stageName = stageMap[p.stage] || p.stage || '处理中'

    if (p.stage === 'done') {
      scanState.progressText = '扫描完成！'
      scanState.scanning = false
    } else if (p.title) {
      scanState.progressText = `[${stageName}] ${p.title}`
    } else if (p.dir) {
      if (scanState.total === 0) {
        const dirName = p.dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || p.dir
        scanState.progressText = `扫描目录中... ${dirName}`
      } else {
        scanState.progressText = `[${stageName}] ${p.dir}`
      }
    } else {
      scanState.progressText = stageName
    }

    scanRefresh.value++
  })

  window.__scanListenersReady = true
  console.log('[scan] listeners ready')
}

initListeners()

export function resetScanState() {
  scanState.scanning = false
  scanState.progressText = ''
  scanState.current = 0
  scanState.total = 0
  scanState.pct = 0
}