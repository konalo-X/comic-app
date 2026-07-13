import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'path'
import fs from 'fs'

// 自定义插件：复制 splash.html 到 dist 目录
function copySplashPlugin() {
  return {
    name: 'copy-splash',
    closeBundle() {
      const src = resolve(__dirname, 'public', 'splash.html')
      const dest = resolve(__dirname, 'dist', 'splash.html')
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest)
        console.log('[copy-splash] splash.html copied to dist')
      }
    }
  }
}

export default defineConfig({
  plugins: [vue(), copySplashPlugin()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist'
  }
})