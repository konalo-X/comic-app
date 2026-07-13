'use strict'

const { execSync } = require('child_process')
const path = require('path')

function sanitizeFilename(n) {
  if (!n || typeof n !== 'string') {
    throw new Error('sanitizeFilename: 输入必须是非空字符串')
  }
  const sanitized = n
    .replace(/[<>"/\\|*\x00-\x1F]/g, '_')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .trim()
  if (!sanitized) {
    throw new Error(`sanitizeFilename: 清理后文件名为空，原始输入: "${n}"`)
  }
  return sanitized
}

function normalizeName(s) {
  if (!s) return ''
  return String(s)
    .trim()
    .replace(/[^\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AFa-zA-Z0-9]+/g, '')
    .toLowerCase()
}

function normalizeTitle(s) {
  if (!s) return ''
  let t = String(s).trim()
  t = t.replace(/^[\[\(]?\d+[\]\)\.\-\_：:\s]+/, '')
  return normalizeName(t)
}

function escapeLike(s) {
  return String(s).replace(/[%_]/g, '\\$&')
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ========== User-Agent 池 ==========
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
]

function randomChoice(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randomUA() { return randomChoice(UA_POOL) }

async function getDiskInfo(dirPath) {
  try {
    const resolved = path.resolve(dirPath)
    const stdout = execSync(`df -k "${resolved}" | tail -1`, { encoding: 'utf-8' })
    const parts = stdout.trim().split(/\s+/)
    if (parts.length >= 4) {
      const total = parseInt(parts[1], 10) * 1024
      const free = parseInt(parts[3], 10) * 1024
      return { total, free, used: total - free }
    }
  } catch (_) {}
  return { total: 0, free: 0, used: 0 }
}

module.exports = { sanitizeFilename, normalizeName, normalizeTitle, escapeLike, sleep, randomChoice, randomUA, getDiskInfo }