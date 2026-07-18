'use strict'

const { autoUpdater } = require('electron-updater')
const { BrowserWindow } = require('electron')
const logger = require('../logger')

let _updateCheckTimer = null
const CHECK_INTERVAL = 4 * 60 * 60 * 1000 // 4 小时

function initAutoUpdater() {
  autoUpdater.logger = {
    info: (...args) => logger.info('[Updater]', ...args),
    warn: (...args) => logger.warn('[Updater]', ...args),
    error: (...args) => logger.error('[Updater]', ...args),
    debug: (...args) => logger.debug('[Updater]', ...args)
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    logger.info('正在检查更新...')
  })

  autoUpdater.on('update-available', (info) => {
    logger.info('发现新版本:', info.version)
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    }
  })

  autoUpdater.on('update-not-available', () => {
    logger.info('当前已是最新版本')
  })

  autoUpdater.on('download-progress', (progress) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:downloadProgress', {
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond
      })
    }
  })

  autoUpdater.on('update-downloaded', () => {
    logger.info('更新已下载，下次启动时安装')
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send('update:downloaded')
    }
  })

  autoUpdater.on('error', (err) => {
    logger.error('更新检查失败:', err.message)
  })

  checkForUpdates()
  _updateCheckTimer = setInterval(checkForUpdates, CHECK_INTERVAL)
}

function checkForUpdates() {
  if (process.env.NODE_ENV === 'development') {
    logger.info('开发模式，跳过更新检查')
    return
  }
  autoUpdater.checkForUpdates().catch((err) => {
    logger.warn('更新检查失败:', err.message)
  })
}

function downloadUpdate() {
  autoUpdater.downloadUpdate().catch((err) => {
    logger.error('下载更新失败:', err.message)
  })
}

function quitAndInstall() {
  autoUpdater.quitAndInstall()
}

function destroy() {
  if (_updateCheckTimer) {
    clearInterval(_updateCheckTimer)
    _updateCheckTimer = null
  }
}

module.exports = {
  initAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  destroy
}