'use strict'

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')

// ============ 单实例锁（防止多个 Electron 主进程抢同一数据库 / job_queue）============
// 两层防护：
//  1) Electron 原生 singleInstanceLock（主防，第二个实例会拿到 lock 失败并退出）
//  2) 文件锁 single-instance.lock（兜底，崩溃残留时按 PID 校验，避免死锁）
const LOCK_PATH = path.join(app.getPath('userData'), 'single-instance.lock')

function _readLockPid() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').trim()
    const pid = parseInt(raw, 10)
    if (Number.isFinite(pid)) return pid
  } catch (_) {}
  return null
}

function _isPidAlive(pid) {
  if (!pid) return false
  try {
    // signal 0 不杀进程，仅检测是否存在
    process.kill(pid, 0)
    return true
  } catch (_) {
    return false
  }
}

function _writeLock() {
  try { fs.writeFileSync(LOCK_PATH, String(process.pid)) } catch (_) {}
}

function _clearLock() {
  try { fs.unlinkSync(LOCK_PATH) } catch (_) {}
}

// 先检查文件锁（兜底）：若已有存活的其他 PID 持有锁，则直接退出，不再抢数据库
const existingPid = _readLockPid()
if (existingPid && existingPid !== process.pid && _isPidAlive(existingPid)) {
  console.error(`[SingleInstance] 检测到已有 comic-app 进程 (PID ${existingPid}) 在运行，本实例退出以避免双进程抢数据库`)
  app.exit(0)
  // 注意：app.exit 后不应再继续初始化
  process.exit(0)
}

if (!app.requestSingleInstanceLock()) {
  console.error('[SingleInstance] 未能获取 Electron 单实例锁（已有实例持有），本实例退出')
  app.quit()
  process.exit(0)
}

// 拿到锁后写文件锁（覆盖任何残留的陈旧 PID）
_writeLock()

// 第二个实例尝试启动时：聚焦已有窗口并退出，不重复初始化
app.on('second-instance', (event, argv, workingDirectory) => {
  console.log('[SingleInstance] 收到第二个实例请求，聚焦已有窗口')
  const wins = BrowserWindow.getAllWindows()
  if (wins.length > 0) {
    const win = wins[0]
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

// 进程退出时清理文件锁
app.on('before-quit', () => { _clearLock() })
process.on('exit', () => { _clearLock() })

const sources = require('./sources/registry')
const db = require('./db')
const exporter = require('./exporter')
const cache = require('./cache')

const imageProxy = require('./modules/imageProxy')
const downloadPaths = require('./modules/downloadPaths')
const DownloadManager = require('./modules/downloadManager')
const jobHandlers = require('./modules/jobHandlers')
const { registerAllIPC } = require('./modules/ipc')
const { startup } = require('./modules/startup')

const isDev = process.env.NODE_ENV === 'development'
const downloadMgr = new DownloadManager()

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 680, minWidth: 900, minHeight: 400,
    resizable: true, frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#FFF8F0',
    icon: path.join(__dirname, '..', 'build', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true,
      sandbox: false
    }
  })
  if (process.platform === 'darwin') {
    try { win.setWindowButtonVisibility(false) } catch (_) {}
  }
  win.on('maximize', () => win.webContents.send('window:maximize-change', true))
  win.on('unmaximize', () => win.webContents.send('window:maximize-change', false))
  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 捕获渲染进程控制台日志
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['debug', 'log', 'warn', 'error']
    const levelStr = levels[level] || 'log'
    console.log(`[Renderer Console ${levelStr.toUpperCase()}]`, message)
  })
}

const ipcApi = registerAllIPC({
  app, BrowserWindow, ipcMain, dialog, shell,
  db, sources, exporter, cache,
  getJobQueue: jobHandlers.getJobQueue,
  downloadMgr,
  downloadPaths,
  imageProxy,
  jobHandlers,
  isDev,
  getExternalRoot: downloadPaths.getExternalRoot,
  setExternalRoot: downloadPaths.setExternalRoot,
  getGlobalDownloadConcurrency: downloadPaths.getGlobalDownloadConcurrency,
  setGlobalDownloadConcurrency: downloadPaths.setGlobalDownloadConcurrency,
  createWindow
})

app.commandLine.appendSwitch('ignore-certificate-errors')

app.whenReady().then(() => {
  // 确保用户数据目录存在（app.getPath 在 whenReady 后才可靠）
  _writeLock()
  startup({
    imageProxy, cache, db, downloadPaths, jobHandlers, sources,
    createWindow, ipcApi
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})