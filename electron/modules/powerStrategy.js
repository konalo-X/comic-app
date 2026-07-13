'use strict'

const powerMonitor = require('electron').powerMonitor

function isBatteryMode() {
  try {
    const status = powerMonitor.getSystemBatteryState()
    return status ? !status.powerSource || status.charging === false : false
  } catch { return false }
}
function isQuietHours() {
  const h = new Date().getHours()
  return h >= 23 || h < 8
}

function shouldSkipAutoTask(taskName) {
  // Mac mini 等桌面设备不需要省电策略
  if (process.platform === 'darwin' && !powerMonitor?.onBatteryPower) {
    return false
  }
  if (isQuietHours()) { console.log(`[Auto] [省电] 深夜时段，跳过 ${taskName}`); return true }
  if (isBatteryMode()) { console.log(`[Auto] [省电] 电池供电，跳过 ${taskName}`); return true }
  return false
}

module.exports = {
  isBatteryMode,
  isQuietHours,
  shouldSkipAutoTask
}
