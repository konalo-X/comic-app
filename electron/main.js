'use strict'

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') return
  throw err
})

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

// DNS 解析器(DoH) 配置已移至 app.whenReady() 回调内:
// configureHostResolver 必须在 app ready 后调用, 否则报 "cannot be called before the app is ready"。

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

// Electron 内置单实例锁(某些 macOS 环境下因 TCC 权限会创建失败,
// 但自定义 PID 文件锁已提供同等保护,此处降级为 warn 而非退出)
if (!app.requestSingleInstanceLock()) {
  // 先检查是否真的是已有实例持锁, 还是只是权限问题导致创建失败
  const existingPid2 = _readLockPid()
  if (existingPid2 && existingPid2 !== process.pid && _isPidAlive(existingPid2)) {
    console.error('[SingleInstance] 已有 comic-app 实例运行, 本实例退出')
    app.quit()
    process.exit(0)
  }
  console.warn('[SingleInstance] requestSingleInstanceLock 失败(可能是权限问题), 降级使用文件锁')
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

// ============ 崩溃兜底 ============
// 未捕获异常/未处理 rejection: 记日志 + 清锁 + 退出。
// 不"只记日志不退出"——今天的教训是那样会变成永久僵尸(事件循环假死时没人能救)。
// 退出后由用户重新启动 app(本就与 app 一体, 无外部守护), 清锁保证下次能正常起。
const _crashLog = path.join(app.getPath('userData'), 'crash.log')
function _logCrash(tag, err) {
  const msg = `[${new Date().toISOString()}] ${tag}: ${(err && err.stack) || err}\n`
  console.error(msg)
  try { require('fs').appendFileSync(_crashLog, msg) } catch (_) {}
}
process.on('uncaughtException', (err) => {
  _logCrash('uncaughtException', err)
  _clearLock()
  process.exit(1)
})
// 关键修复: unhandledRejection 不再直接杀进程.
// 历史上 JobQueue 内部 Promise.race 的孤儿 reject 会冒泡到这里, 触发 process.exit(1),
// 而队列里有大量 stale 任务 -> 重启即崩 -> 连环闪退. 真内存损坏类错误由 uncaughtException 兜底退出.
// 这里只记录 + 清锁, 让 app 保持存活, 由 JobQueue 自身的错误处理/重试机制消化.
process.on('unhandledRejection', (reason) => {
  _logCrash('unhandledRejection', reason)
  try { _clearLock() } catch (_) {}
})

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

let splashWindow = null

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    center: true,
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  const splashPath = isDev
    ? path.join(__dirname, '../public/splash.html')
    : path.join(__dirname, '../dist/splash.html')

  splashWindow.loadFile(splashPath)

  splashWindow.once('ready-to-show', () => {
    splashWindow.show()
  })

  return splashWindow
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    // 发送淡出消息
    splashWindow.webContents.send('splash-message', 'fade-out')
    // 等待淡出动画完成后关闭
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close()
        splashWindow = null
      }
    }, 600)
  }
}

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
  // Bug #12 修复: ipcMain.on('show-context-menu') 移到模块顶层只注册一次,
  // 避免 createWindow() 多次调用时重复注册导致右键菜单多次弹出
  if (!ipcMain._contextMenuRegistered) {
    ipcMain._contextMenuRegistered = true
    ipcMain.on('show-context-menu', (event, params) => {
    const menuItems = []
    const win = BrowserWindow.fromWebContents(event.sender)
    if (params.isEditable) {
      menuItems.push({ label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' })
      menuItems.push({ label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' })
      menuItems.push({ label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' })
      menuItems.push({ type: 'separator' })
      menuItems.push({ label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' })
    } else if (params.hasSelection) {
      menuItems.push({ label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' })
    }
    if (menuItems.length) {
      Menu.buildFromTemplate(menuItems).popup({ window: win })
    }
    })
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

app.whenReady().then(() => {
  // ============ 代理模式动态选择 ============
  // 策略:
  //   - VPN 已连接(默认路由是 utun)     → 'direct'  走 TUN 隧道, 流量被 VPN 劫持
  //   - VPN 未连接 + 有系统代理          → 'system'  跟随系统代理(Clash/Surge 等)
  //   - VPN 未连接 + 无系统代理          → 'direct'  直连(Chromium TLS 指纹能过 GFW)
  // 之前无脑用 'direct' 在 VPN 未连接时偶发 ERR_NAME_NOT_RESOLVED(DoH 失效 + 系统 DNS 不稳);
  // 但 'system' 在无代理时会让 Chromium 走空代理探测, 反而比 'direct' 多一次失败, 故无代理时回退 direct。
  const { session } = require('electron')
  const { execSync } = require('child_process')
  let _vpnActive = false
  let _vpnDetectHow = ''
  try {
    const routeOut = execSync('route -n get default', { encoding: 'utf8', timeout: 3000 })
    // 旧逻辑: 只看默认路由接口是不是 utun。问题: hide.me 全局 TUN 在 split/per-app 模式
    // 或部分重连状态下, 默认路由仍是 en8, 导致 VPN 已连被误判为未连, app 仍直连撞墙。
    if (/interface:\s*utun/i.test(routeOut)) {
      _vpnActive = true
      _vpnDetectHow = 'default-route'
    }
  } catch (_) {}
  // [BUG-1 修复 2026-08-08] 补充检测: 任一个非系统预留的 utun 接口(编号>=7, 真实 hide.me/全局 VPN)
  // UP 即视为 VPN 已连, 不依赖默认路由是否切到 utun。utun0-6 是 iCloud Private Relay / 系统残留死隧道。
  if (!_vpnActive) {
    try {
      const ifc = execSync('ifconfig', { encoding: 'utf8', timeout: 3000 })
      // macOS ifconfig: 每段接口顶格以 "utunN: flags=<...>" 开头, 段间空行分隔。
      const blocks = ifc.split(/\n(?=\S)/)
      for (const b of blocks) {
        const m = b.match(/^(utun(\d+)):\s*flags=\d*<([^>]*)>/)
        if (m) {
          const num = parseInt(m[2], 10)
          const isUp = /\bUP\b/.test(m[3]) && /RUNNING/.test(m[3])
          if (num >= 7 && isUp) { _vpnActive = true; _vpnDetectHow = `utun${num}-up`; break }
        }
      }
    } catch (_) {}
  }

  // 检测系统是否配置了任何代理(HTTP/HTTPS/SOCKS/PAC), 任一启用即视为有代理
  let _hasSystemProxy = false
  try {
    const services = execSync('networksetup -listallnetworkservices', { encoding: 'utf8', timeout: 3000 })
      .split('\n').slice(1).map(s => s.replace(/^\*/, '').trim()).filter(Boolean)
    for (const svc of services) {
      const cmds = [
        `networksetup -getwebproxy "${svc}"`,
        `networksetup -getsecurewebproxy "${svc}"`,
        `networksetup -getsocksfirewallproxy "${svc}"`,
        `networksetup -getautoproxyurl "${svc}"`,
      ]
      for (const cmd of cmds) {
        try {
          const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 })
          if (/Enabled:\s*Yes/i.test(out)) { _hasSystemProxy = true; break }
        } catch (_) {}
      }
      if (_hasSystemProxy) break
    }
  } catch (_) {}

  // [BUG-1 修复] 模式选择逻辑本身是对的(有系统代理→'system' 跟随; 否则'direct');
  // 真正的病灶是上面的 _vpnActive 检测漏掉了「utun7+ UP 但默认路由仍是 en8」的 hide.me 场景。
  // 现在 _vpnActive 已能正确识别该场景, 仅用于自检告警; 模式仍按系统代理决定。
  const proxyMode = _hasSystemProxy ? 'system' : 'direct'
  console.log(`[proxy] VPN=${_vpnActive ? '已连接(' + _vpnDetectHow + ')' : '未连接'}, 系统代理=${_hasSystemProxy ? '有' : '无'}, 代理模式: ${proxyMode}`)
  session.defaultSession.setProxy({ mode: proxyMode }).catch(e =>
    console.warn(`[proxy] setProxy(${proxyMode}) 失败:`, e.message)
  )

  // [BUG-1 修复] 连接自检: 设完代理后真去 fetch 一次源站首包, 验证出口是否真的通。
  // 这能把"VPN 连着却仍撞墙"这种不可见状态变成可操作的日志告警。
  setTimeout(() => {
    const { net } = require('electron')
    const req = net.request({ method: 'HEAD', url: 'https://smtt6.com/', redirect: 'manual' })
    let done = false
    const finish = (ok, info) => {
      if (done) return; done = true
      if (ok) {
        console.log('[proxy] 自检通过: smtt6.com 出口可达 ✅')
      } else {
        if (_vpnActive) {
          console.warn('[proxy][告警] VPN 已连接(' + _vpnDetectHow + ')但 smtt6.com 仍不可达 —— 默认路由可能未走隧道, 请确认 hide.me 为「全局模式/接管默认路由」')
        } else {
          console.warn('[proxy][告警] 无 VPN 且无代理, smtt6.com 直连不可达(被墙)。可连 hide.me 或使用系统代理后再试')
        }
      }
    }
    req.on('response', (res) => { res.resume(); finish(res.statusCode > 0 && res.statusCode < 500, 'status=' + res.statusCode) })
    req.on('error', (e) => finish(false, e.message))
    setTimeout(() => finish(false, 'timeout'), 12000)
    req.end()
  }, 4000)

  // ============ DNS 解析器配置（DoH）============
  // 配置 DoH (DNS over HTTPS), 用 Google/Cloudflare DoH 解析。
  // 注意: DoH 服务器本身在国内可能不可达(cloudflare-dns.com 被墙), 此配置主要给 VPN 连接后使用;
  //       VPN 未连接时 DoH 查询会失败, Chromium 自动回退到系统 DNS。
  // 'automatic' 模式: Chromium 并行查询 DoH 和系统 DNS, 谁先返回用谁。
  try {
    app.configureHostResolver({
      enableBuiltInResolver: true,
      secureDnsMode: 'automatic',
      secureDnsServers: [
        'https://dns.google/dns-query',
        'https://cloudflare-dns.com/dns-query',
      ],
    })
    console.log('[DNS] DoH 配置成功 (secureDnsMode=automatic)')
  } catch (e) {
    console.warn('[DNS] configureHostResolver 失败:', e.message)
  }

  // 确保用户数据目录存在（app.getPath 在 whenReady 后才可靠）
  _writeLock()

  // 创建启动画面
  createSplashWindow()

  // 延迟启动主应用，让启动画面显示一段时间
  setTimeout(() => {
    startup({
      imageProxy, cache, db, downloadPaths, jobHandlers, sources,
      createWindow, ipcApi, closeSplashWindow
    })
  }, 2500) // 显示 2.5 秒启动画面
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})