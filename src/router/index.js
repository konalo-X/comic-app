import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/comic-list' },
  { path: '/comic-list', name: 'comicList', component: () => import('@/pages/ComicList.vue'), meta: { transition: 'slide-left' } },
  { path: '/comic-detail/:id', name: 'comicDetail', component: () => import('@/pages/ChapterMgr.vue'), props: true, meta: { transition: 'slide-right' } },
  { path: '/reader/:comicId', name: 'reader', component: () => import('@/pages/Reader.vue'), props: true, meta: { transition: 'fade' } },
  { path: '/reader/:comicId/:chapterIndex', name: 'readerChapter', component: () => import('@/pages/Reader.vue'), props: true, meta: { transition: 'fade' } },
  { path: '/bookshelf', name: 'bookshelf', component: () => import('@/pages/Bookshelf.vue'), meta: { transition: 'slide-left' } },
  { path: '/epub-gen', name: 'epubGen', component: () => import('@/pages/EpubGen.vue'), meta: { transition: 'slide-right' } },
  { path: '/download-queue', name: 'downloadQueue', component: () => import('@/pages/DownloadPage.vue'), meta: { transition: 'slide-right' } },
  { path: '/download-history', name: 'downloadHistory', component: () => import('@/pages/DownloadPage.vue'), meta: { transition: 'slide-right' } },
  { path: '/settings', name: 'settings', component: () => import('@/pages/Settings.vue'), meta: { transition: 'slide-right' } },
  { path: '/categories', name: 'categories', component: () => import('@/pages/CategoryMgr.vue'), meta: { transition: 'slide-right' } },
  { path: '/data-manager', name: 'dataManager', component: () => import('@/pages/DataManager.vue'), meta: { transition: 'slide-right' } },
  { path: '/shortcuts', name: 'shortcuts', component: () => import('@/pages/Shortcuts.vue'), meta: { transition: 'slide-right' } },
  { path: '/history', name: 'history', component: () => import('@/pages/ReadingHistory.vue'), meta: { transition: 'slide-left' } }
]

const router = createRouter({ 
  history: createWebHashHistory(), 
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) {
      return savedPosition
    } else {
      return { top: 0 }
    }
  }
})

export default router