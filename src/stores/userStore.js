import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useUserStore = defineStore('user', () => {
  const theme = ref(localStorage.getItem('theme') || 'light')
  const readingProgress = ref({})
  const bookmarks = ref([])
  const searchHistory = ref([])
  const lastReadComic = ref(null)

  const isDark = computed(() => theme.value === 'dark')

  const themeOptions = [
    { id: 'light', label: '默认', iconClass: 'theme-light' },
    { id: 'dark', label: '深色', iconClass: 'theme-dark' },
    { id: 'warm', label: '护眼黄', iconClass: 'theme-warm' },
    { id: 'forest', label: '森系绿', iconClass: 'theme-forest' }
  ]

  function toggleTheme() {
    // 添加过渡动画类
    document.documentElement.classList.add('theme-transitioning')
    
    const themes = ['light', 'dark', 'warm', 'forest']
    const currentIdx = themes.indexOf(theme.value)
    theme.value = themes[(currentIdx + 1) % themes.length]
    document.documentElement.setAttribute('data-theme', theme.value)
    localStorage.setItem('theme', theme.value)
    
    // 移除过渡动画类（延迟以完成动画）
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning')
    }, 350)
  }

  function setTheme(newTheme) {
    // 添加过渡动画类
    document.documentElement.classList.add('theme-transitioning')
    
    theme.value = newTheme
    document.documentElement.setAttribute('data-theme', newTheme)
    localStorage.setItem('theme', newTheme)
    
    // 移除过渡动画类（延迟以完成动画）
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transitioning')
    }, 350)
  }

  function saveReadingProgress(comicId, chapterIndex, pageIndex) {
    readingProgress.value[comicId] = {
      chapterIndex,
      pageIndex,
      savedAt: new Date().toISOString()
    }
    localStorage.setItem('readingProgress', JSON.stringify(readingProgress.value))
  }

  function getReadingProgress(comicId) {
    return readingProgress.value[comicId] || null
  }

  function addBookmark(comicId, chapterIndex) {
    const exists = bookmarks.value.find(b => b.comicId === comicId && b.chapterIndex === chapterIndex)
    if (!exists) {
      bookmarks.value.push({
        comicId,
        chapterIndex,
        addedAt: new Date().toISOString()
      })
      localStorage.setItem('bookmarks', JSON.stringify(bookmarks.value))
    }
  }

  function removeBookmark(comicId, chapterIndex) {
    bookmarks.value = bookmarks.value.filter(b => !(b.comicId === comicId && b.chapterIndex === chapterIndex))
    localStorage.setItem('bookmarks', JSON.stringify(bookmarks.value))
  }

  function toggleBookmark(comicId, chapterIndex) {
    const exists = bookmarks.value.find(b => b.comicId === comicId && b.chapterIndex === chapterIndex)
    if (exists) {
      removeBookmark(comicId, chapterIndex)
    } else {
      addBookmark(comicId, chapterIndex)
    }
  }

  function isBookmarked(comicId, chapterIndex) {
    return bookmarks.value.some(b => b.comicId === comicId && b.chapterIndex === chapterIndex)
  }

  function addSearchHistory(query) {
    const exists = searchHistory.value.find(h => h.query === query)
    if (!exists) {
      searchHistory.value.unshift({
        query,
        timestamp: Date.now()
      })
      if (searchHistory.value.length > 20) {
        searchHistory.value = searchHistory.value.slice(0, 20)
      }
      localStorage.setItem('searchHistory', JSON.stringify(searchHistory.value))
    }
  }

  function removeSearchHistory(query) {
    searchHistory.value = searchHistory.value.filter(h => h.query !== query)
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory.value))
  }

  function clearSearchHistory() {
    searchHistory.value = []
    localStorage.setItem('searchHistory', JSON.stringify(searchHistory.value))
  }

  function setLastReadComic(comic) {
    lastReadComic.value = comic
    localStorage.setItem('lastReadComic', JSON.stringify(comic))
  }

  function loadFromStorage() {
    const savedProgress = localStorage.getItem('readingProgress')
    if (savedProgress) {
      try {
        readingProgress.value = JSON.parse(savedProgress)
      } catch (e) {
        console.error('Failed to parse readingProgress:', e)
      }
    }

    const savedBookmarks = localStorage.getItem('bookmarks')
    if (savedBookmarks) {
      try {
        bookmarks.value = JSON.parse(savedBookmarks)
      } catch (e) {
        console.error('Failed to parse bookmarks:', e)
      }
    }

    const savedSearchHistory = localStorage.getItem('searchHistory')
    if (savedSearchHistory) {
      try {
        searchHistory.value = JSON.parse(savedSearchHistory)
      } catch (e) {
        console.error('Failed to parse searchHistory:', e)
      }
    }

    const savedLastRead = localStorage.getItem('lastReadComic')
    if (savedLastRead) {
      try {
        lastReadComic.value = JSON.parse(savedLastRead)
      } catch (e) {
        console.error('Failed to parse lastReadComic:', e)
      }
    }
  }

  return {
    theme,
    themeOptions,
    readingProgress,
    bookmarks,
    searchHistory,
    lastReadComic,
    isDark,
    toggleTheme,
    setTheme,
    saveReadingProgress,
    getReadingProgress,
    addBookmark,
    removeBookmark,
    toggleBookmark,
    isBookmarked,
    addSearchHistory,
    removeSearchHistory,
    clearSearchHistory,
    setLastReadComic,
    loadFromStorage
  }
})