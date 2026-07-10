<template>
  <div class="settings-page">
    <div class="page-header">
      <h1 class="page-title">设置</h1>
      <p class="page-subtitle">管理和配置应用偏好</p>
    </div>

    <div class="settings-grid">
      <!-- 漫画目录设置 -->
      <div class="card settings-card">
        <div class="card-header">
          <h2 class="card-title">
            <svg class="card-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
            漫画目录
          </h2>
        </div>
        <div class="card-body">
          <p class="form-hint" style="margin-bottom: 16px;">
            下载的漫画会保存到这里，也会从这里扫描本地漫画。目录结构：<code style="background: var(--bg-muted); padding: 1px 6px; border-radius: 4px;">{漫画名}/{章节名}/001.webp</code>
          </p>

          <!-- 主路径设置 -->
          <div class="form-group">
            <label class="form-label">漫画目录</label>
            <div class="path-input-group">
              <input v-model="settings.downloadDir" type="text" class="form-input" placeholder="选择漫画存放目录" readonly />
              <button class="btn btn-secondary" @click="pickDownloadDir">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                选择文件夹
              </button>
            </div>
          </div>

          <!-- 额外扫描路径 -->
          <div class="form-group">
            <label class="form-label">额外扫描路径（可选）</label>
            <div class="path-input-group">
              <input v-model="newScanPath" type="text" class="form-input" placeholder="选择或输入其他漫画目录" />
              <button class="btn btn-secondary" @click="pickScanPath">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                选择文件夹
              </button>
              <button class="btn btn-primary" :disabled="!newScanPath.trim()" @click="addScanPath">添加</button>
            </div>
          </div>

          <!-- 已配置路径列表 -->
          <div v-if="settings.autoScanPaths && settings.autoScanPaths.length > 0" class="form-group">
            <label class="form-label">已配置路径</label>
            <div class="scan-paths-list">
              <div v-for="(p, idx) in settings.autoScanPaths" :key="idx" class="scan-path-item">
                <svg class="path-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                <span class="path-text">{{ p }}</span>
                <button class="btn-icon btn-icon-danger" title="移除" @click="removeScanPath(idx)">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 立即扫描按钮 -->
          <div class="form-group" style="margin-top: 12px;">
            <button class="btn btn-primary" :disabled="scanningNow || !settings.autoScanPaths || settings.autoScanPaths.length === 0" @click="testScanNow">
              <span v-if="scanningNow" class="spinner-sm"></span>
              {{ scanningNow ? '扫描中...' : '立即扫描并加入书架' }}
            </button>

            <!-- 扫描进度条与状态文字 -->
            <div v-if="scanningNow || scanProgressText" class="scan-progress-box">
              <div class="scan-progress-text">{{ scanProgressText || '准备扫描...' }}</div>
              <div class="scan-progress-bar">
                <div class="scan-progress-fill" :style="{ width: scanProgressPct + '%' }"></div>
              </div>
              <div class="scan-progress-meta">
                <span>{{ scanProgressCurrent }} / {{ scanProgressTotal }}</span>
                <span>{{ scanProgressPct }}%</span>
              </div>
            </div>

            <p v-if="testScanResult" class="form-hint" :style="{ color: testScanResult.success ? 'var(--success)' : 'var(--danger)' }">
              {{ testScanResult.text }}
            </p>
          </div>
        </div>
      </div>

      <!-- 阅读设置 -->
      <div class="card settings-card">
        <div class="card-header">
          <h2 class="card-title">
            <svg class="card-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
            阅读设置
          </h2>
        </div>
        <div class="card-body">
          <div class="form-group form-group-row">
            <label class="form-label">自动预加载下一章</label>
            <label class="switch">
              <input v-model="settings.autoPreload" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="form-group form-group-row">
            <label class="form-label">双击放大</label>
            <label class="switch">
              <input v-model="settings.doubleTapZoom" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="form-group form-group-row">
            <label class="form-label">显示页码</label>
            <label class="switch">
              <input v-model="settings.showPageNumber" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- 下载设置 -->
      <div class="card settings-card">
        <div class="card-header">
          <h2 class="card-title">
            <svg class="card-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            下载设置
          </h2>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">同时下载章节数</label>
            <p class="form-hint">不同章节之间可并行下载（最多 N 章同时下载），章节内图片最多 5 张同时下载，图片写入文件时严格按顺序编号，保证阅读顺序不乱</p>
            <div class="number-input-group">
              <button class="btn-icon" @click="settings.downloadConcurrency > 1 && settings.downloadConcurrency--">-</button>
              <input v-model.number="settings.downloadConcurrency" type="number" class="form-input text-center" min="1" max="10" />
              <button class="btn-icon" @click="settings.downloadConcurrency < 10 && settings.downloadConcurrency++">+</button>
            </div>
          </div>
        </div>
      </div>

      <!-- EPUB 导出设置 -->
      <div class="card settings-card">
        <div class="card-header">
          <h2 class="card-title">
            <svg class="card-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
            </svg>
            EPUB 导出设置
          </h2>
        </div>
        <div class="card-body">
          <div class="form-group">
            <label class="form-label">默认分卷方式</label>
            <select v-model="settings.epubVolumeMode" class="form-input">
              <option value="single">不分卷（单文件）</option>
              <option value="auto">自动分卷（每卷50章）</option>
              <option value="custom">自定义每卷章节数</option>
            </select>
          </div>
          <div v-if="settings.epubVolumeMode === 'custom'" class="form-group">
            <label class="form-label">每卷章节数</label>
            <div class="number-input-group">
              <button class="btn-icon" @click="settings.epubChaptersPerVolume > 1 && settings.epubChaptersPerVolume--">-</button>
              <input v-model.number="settings.epubChaptersPerVolume" type="number" class="form-input text-center" min="1" max="200" />
              <button class="btn-icon" @click="settings.epubChaptersPerVolume < 200 && settings.epubChaptersPerVolume++">+</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">默认图片质量</label>
            <select v-model="settings.epubImageQuality" class="form-input">
              <option value="original">原图</option>
              <option value="high">高清（压缩80%）</option>
              <option value="medium">标清（压缩50%）</option>
            </select>
          </div>
          <div class="form-group form-group-row">
            <label class="form-label">包含元数据</label>
            <label class="switch">
              <input v-model="settings.epubIncludeMeta" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>

    </div>

    <!-- 保存按钮 -->
    <div class="settings-actions">
      <button class="btn btn-primary" :disabled="saving" @click="saveSettings">
        {{ saving ? '保存中...' : '保存设置' }}
      </button>
    </div>

    <!-- 版本信息 -->
    <div class="version-footer">
      漫画阅读器 v{{ appVersion }}
    </div>
  </div>
</template>

<script>
import { scanState, resetScanState } from '../store/scan.js'

export default {
  name: 'SettingsPage',
  data() {
    return {
      settings: {
        concurrency: 3,
        downloadConcurrency: 3,
        autoUpdateEnabled: true,
        autoUpdateIntervalHours: 2,
        theme: 'light',
        autoScanPaths: [],
        autoScanOnStartup: true,
        autoPreload: true,
        doubleTapZoom: true,
        showPageNumber: true,
        epubVolumeMode: 'auto',
        epubChaptersPerVolume: 50,
        epubImageQuality: 'original',
        epubIncludeMeta: true
      },
      saving: false,
      appVersion: '1.0.0',
      newScanPath: '',
      testScanResult: null
    }
  },
  computed: {
    scanningNow() { return scanState.scanning },
    scanProgressText() { return scanState.progressText },
    scanProgressCurrent() { return scanState.current },
    scanProgressTotal() { return scanState.total },
    scanProgressPct() { return scanState.pct }
  },
  mounted() {
    this.loadSettings()
  },
  methods: {
    async loadSettings() {
      try {
        if (window.settingsApi?.get) {
          const saved = await window.settingsApi.get()
          if (saved) {
            this.settings = { ...this.settings, ...saved }
          }
        } else {
          const saved = localStorage.getItem('comicAppSettings')
          if (saved) {
            this.settings = { ...this.settings, ...JSON.parse(saved) }
          }
        }
      } catch (error) {
        console.error('加载设置失败:', error)
      }
    },
    async saveSettings() {
      if (this.saving) return
      this.saving = true
      try {
        if (window.settingsApi?.save) {
          const plain = JSON.parse(JSON.stringify(this.settings))
          await window.settingsApi.save(plain)
        }
        localStorage.setItem('comicAppSettings', JSON.stringify(this.settings))
        alert('设置已保存')
      } catch (error) {
        console.error('保存设置失败:', error)
        alert('保存设置失败: ' + error.message)
      } finally {
        this.saving = false
      }
    },
    addScanPath() {
      const p = this.newScanPath.trim()
      if (!p) return
      if (!this.settings.autoScanPaths) this.settings.autoScanPaths = []
      if (this.settings.autoScanPaths.includes(p)) {
        this.testScanResult = { success: false, text: '该路径已存在' }
        return
      }
      this.settings.autoScanPaths.push(p)
      this.newScanPath = ''
      this.saveSettings()
    },
    removeScanPath(idx) {
      this.settings.autoScanPaths.splice(idx, 1)
      this.saveSettings()
    },
    async pickScanPath() {
      try {
        if (window.importApi && window.importApi.pickDirectory) {
          const p = await window.importApi.pickDirectory()
          if (p) this.newScanPath = p
        }
      } catch (e) {
        console.warn('pickScanPath failed:', e)
      }
    },
    async pickDownloadDir() {
      try {
        if (window.importApi && window.importApi.pickDirectory) {
          const p = await window.importApi.pickDirectory()
          if (p) {
            this.settings.downloadDir = p
            // 自动将下载路径也添加到扫描路径
            if (!this.settings.autoScanPaths) this.settings.autoScanPaths = []
            if (!this.settings.autoScanPaths.includes(p)) {
              this.settings.autoScanPaths.push(p)
            }
            this.saveSettings()
          }
        }
      } catch (e) {
        console.warn('pickDownloadDir failed:', e)
      }
    },
    async testScanNow() {
      scanState.scanning = true
      scanState.progressText = ''
      scanState.current = 0
      scanState.total = 0
      scanState.pct = 0
      this.testScanResult = null
      try {
        if (window.dbApi && window.dbApi.autoScanLocalComics) {
          const paths = JSON.parse(JSON.stringify(this.settings.autoScanPaths || []))
          const result = await window.dbApi.autoScanLocalComics(paths)
          const total = result.totalCount || 0
          const added = result.newCount || 0
          const onlineMatched = result.onlineMatched || 0
          this.testScanResult = {
            success: true,
            text: `扫描完成：共扫描 ${total} 本，新增 ${added} 本，联网匹配 ${onlineMatched} 本（已写入 sourceUrl 以支持追更），已自动加入书架`
          }
        } else {
          this.testScanResult = { success: false, text: 'dbApi.autoScanLocalComics 不可用，请确保使用最新版本' }
        }
      } catch (e) {
        this.testScanResult = { success: false, text: '扫描失败: ' + e.message }
      } finally {
        scanState.scanning = false
      }
    }
  }
}
</script>

<style scoped>
.settings-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.page-header {
  margin-bottom: 28px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-light);
}

.page-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 6px 0;
  letter-spacing: -0.5px;
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  display: inline-block;
}

.page-subtitle {
  font-size: 14px;
  color: var(--text-dim);
  margin: 0;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 24px;
  margin-bottom: 32px;
}

.settings-card {
  background: rgba(255,255,255,0.82);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.3s ease, border-color 0.3s ease;
  backdrop-filter: blur(16px);
}

.settings-card:hover {
  box-shadow: var(--shadow-lg);
}

.card-header {
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-light);
  background: var(--bg-card);
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-icon {
  color: var(--brand);
  width: 22px;
  height: 22px;
}

.card-body {
  padding: 22px;
}

.form-group {
  margin-bottom: 20px;
}
.form-group-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.form-group-row .form-label {
  margin-bottom: 0;
  flex: 1;
}
.form-hint {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin: 8px 0 0;
  line-height: 1.5;
}
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.switch .slider {
  position: absolute;
  cursor: pointer;
  top: 0; left: 0; right: 0; bottom: 0;
  background-color: #ccc;
  border-radius: 24px;
  transition: 0.2s;
}
.switch .slider::before {
  position: absolute;
  content: '';
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  border-radius: 50%;
  transition: 0.2s;
}
.switch input:checked + .slider {
  background-color: var(--primary, #4f7cff);
}
.switch input:checked + .slider::before {
  transform: translateX(20px);
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}

.form-input {
  width: 100%;
  padding: 9px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  transition: all 0.25s;
}

.form-input:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-bg);
  outline: none;
}

.form-input::placeholder {
  color: var(--text-dim);
}

.path-input-group {
  display: flex;
  gap: 8px;
}

.path-input-group .form-input {
  flex: 1;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.btn-primary {
  background: var(--gradient-brand);
  color: #fff;
  box-shadow: 0 8px 18px rgba(255, 95, 80, 0.2);
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
}

.btn-secondary {
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  border-color: var(--brand);
  color: var(--brand);
  background: var(--brand-bg);
}

.spinner-sm {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  opacity: 0.8;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}

.number-input-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.number-input-group .form-input {
  width: 80px;
  text-align: center;
}

.btn-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}

.btn-icon-danger {
  border-color: transparent;
  color: var(--danger);
  background: transparent;
  transition: all 0.2s;
}

.btn-icon-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.scan-paths-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scan-path-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-muted);
  border-radius: var(--radius);
  border: 1px solid var(--border-light);
}

.scan-path-item .path-icon {
  color: var(--brand);
  flex-shrink: 0;
}

.path-text {
  flex: 1;
  font-size: 13px;
  color: var(--text);
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.empty-paths {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  background: var(--bg-muted);
  border-radius: var(--radius);
  border: 1px dashed var(--border);
  color: var(--text-dim);
  font-size: 13px;
}

.scan-progress-box {
  margin-top: 14px;
  padding: 12px 14px;
  background: var(--bg-muted);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
}

.scan-progress-text {
  font-size: 13px;
  color: var(--text);
  margin-bottom: 8px;
  word-break: break-all;
  line-height: 1.5;
}

.scan-progress-bar {
  width: 100%;
  height: 6px;
  background: var(--border-light);
  border-radius: 999px;
  overflow: hidden;
}

.scan-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--brand), #60a5fa);
  border-radius: 999px;
  transition: width 0.2s ease;
}

.scan-progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 6px;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
}

.version-footer {
  text-align: center;
  padding: 24px 0;
  font-size: 12px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-light);
  margin-top: 16px;
}
</style>