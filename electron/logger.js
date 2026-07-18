'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// 日志级别
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR']

let _logFile = null
let _logLevel = 'info'
let _initialized = false

function _init() {
  if (_initialized) return
  _initialized = true
  try {
    const userData = app.getPath('userData')
    const logDir = path.join(userData, 'logs')
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    _logFile = path.join(logDir, 'app.log')
    _logLevel = process.env.COMIC_LOG_LEVEL || 'info'
  } catch {
    _logLevel = process.env.COMIC_LOG_LEVEL || 'info'
  }
}

function _format(level, args) {
  const ts = new Date().toISOString()
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message
    if (typeof a === 'object') {
      try { return JSON.stringify(a) } catch { return String(a) }
    }
    return String(a)
  }).join(' ')
  return `[${ts}] [${LEVEL_LABELS[level]}] ${msg}`
}

function _write(level, args) {
  if (LEVELS[level] < LEVELS[_logLevel]) return
  _init()

  const formatted = _format(level, args)
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(formatted)

  if (_logFile) {
    try {
      fs.appendFileSync(_logFile, formatted + '\n')
    } catch {}
  }
}

const logger = {
  debug: (...args) => _write('debug', args),
  info: (...args) => _write('info', args),
  warn: (...args) => _write('warn', args),
  error: (...args) => _write('error', args),

  get logFile() {
    _init()
    return _logFile
  }
}

module.exports = logger