import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const STORAGE_KEY = 'download_store'
const MAX_HISTORY = 100

// 从 localStorage 恢复状态
function loadFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const data = JSON.parse(saved)
      return {
        queue: data.queue || [],
        history: (data.history || []).slice(0, MAX_HISTORY)
      }
    }
  } catch (e) {
    console.warn('[DownloadStore] 恢复状态失败:', e)
  }
  return { queue: [], history: [] }
}

export const useDownloadStore = defineStore('download', () => {
  const saved = loadFromStorage()
  
  const queue = ref(saved.queue)
  const history = ref(saved.history)
  const speed = ref('0 KB/s')
  const concurrentDownloads = ref(0)

  const downloading = computed(() => queue.value.filter(item => item.status === 'downloading'))
  const pending = computed(() => queue.value.filter(item => item.status === 'pending'))
  const completed = computed(() => history.value)

  // 持久化到 localStorage
  function persist() {
    try {
      const data = {
        queue: queue.value.map(item => ({
          ...item,
          // 不保存临时状态
          speed: '0 KB/s',
          progress: item.status === 'downloading' ? 0 : item.progress
        })),
        history: history.value.slice(0, MAX_HISTORY)
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      console.warn('[DownloadStore] 保存状态失败:', e)
    }
  }

  // 监听变化自动保存
  watch(() => queue.value.length, persist)
  watch(() => history.value.length, persist)

  let persistTimer = null
  function persistDebounced() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(persist, 1000)
  }

  function addToQueue(comic) {
    const exists = queue.value.find(q => q.comicId === comic.id || q.comicId === comic._id)
    if (exists) return

    queue.value.push({
      id: Date.now() + Math.random(),
      comicId: comic.id || comic._id,
      title: comic.title,
      cover: comic.cover,
      chapterCount: comic.chapters?.length || 0,
      downloadedChapters: 0,
      status: 'pending',
      progress: 0,
      speed: '0 KB/s'
    })
    persist()
  }

  function removeFromQueue(id) {
    queue.value = queue.value.filter(q => q.id !== id)
    persist()
  }

  function updateProgress(id, progress, downloadedChapters, speed) {
    const item = queue.value.find(q => q.id === id)
    if (item) {
      item.progress = progress
      item.downloadedChapters = downloadedChapters
      item.speed = speed
      persistDebounced()
    }
  }

  function setStatus(id, status) {
    const item = queue.value.find(q => q.id === id)
    if (item) {
      item.status = status
      if (status === 'completed') {
        history.value.unshift({ ...item, completedAt: new Date().toISOString() })
        // 限制历史记录数量
        if (history.value.length > MAX_HISTORY) {
          history.value = history.value.slice(0, MAX_HISTORY)
        }
        removeFromQueue(id)
      }
      persist()
    }
  }

  function pauseDownload(id) {
    const item = queue.value.find(q => q.id === id)
    if (item && item.status === 'downloading') {
      item.status = 'paused'
      persist()
    }
  }

  function resumeDownload(id) {
    const item = queue.value.find(q => q.id === id)
    if (item && item.status === 'paused') {
      item.status = 'pending'
      persist()
    }
  }

  function clearHistory() {
    history.value = []
    persist()
  }

  function setSpeed(value) {
    speed.value = value
  }

  function setConcurrentDownloads(value) {
    concurrentDownloads.value = value
  }

  // 恢复下载（应用启动时调用）
  function restoreDownloads() {
    // 将之前下载中的任务重置为 pending
    queue.value.forEach(item => {
      if (item.status === 'downloading') {
        item.status = 'pending'
        item.progress = 0
      }
    })
    persist()
  }

  return {
    queue,
    history,
    speed,
    concurrentDownloads,
    downloading,
    pending,
    completed,
    addToQueue,
    removeFromQueue,
    updateProgress,
    setStatus,
    pauseDownload,
    resumeDownload,
    clearHistory,
    setSpeed,
    setConcurrentDownloads,
    restoreDownloads
  }
})