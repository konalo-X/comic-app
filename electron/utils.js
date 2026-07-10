'use strict'

const { execSync } = require('child_process')
const path = require('path')

function sanitizeFilename(n) {
  return n
    .replace(/[<>"/\\|*\x00-\x1F]/g, '_')
    .replace(/:/g, '：')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .trim()
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

module.exports = { sanitizeFilename, normalizeName, normalizeTitle, escapeLike, getDiskInfo }