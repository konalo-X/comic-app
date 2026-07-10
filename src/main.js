import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/global.css'
import './styles/touch.css'
import { useUserStore } from './stores/userStore'
import { useDownloadStore } from './stores/downloadStore'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)

app.mount('#app')

const userStore = useUserStore()
userStore.loadFromStorage()

// 恢复下载队列状态
const downloadStore = useDownloadStore()
downloadStore.restoreDownloads()

const savedTheme = localStorage.getItem('theme') || 'light'
document.documentElement.setAttribute('data-theme', savedTheme)