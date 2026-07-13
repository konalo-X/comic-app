'use strict'

let PROXY_PORT = 48123
let PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`

function setProxyPort(port) {
  PROXY_PORT = port
  PROXY_BASE = `http://127.0.0.1:${port}`
}

function getProxyImageUrl(imageUrl, refererUrl) {
  if (!imageUrl) return ''
  const encodedUrl = Buffer.from(imageUrl).toString('base64')
  const encodedRef = Buffer.from(refererUrl || imageUrl).toString('base64')
  return `${PROXY_BASE}/img?u=${encodeURIComponent(encodedUrl)}&r=${encodeURIComponent(encodedRef)}`
}

function getLocalProxyUrl(filePath) {
  if (!filePath) return ''
  const cleanPath = String(filePath).replace(/^file:\/\//, '')
  const encoded = Buffer.from(cleanPath).toString('base64')
  return `${PROXY_BASE}/local?p=${encodeURIComponent(encoded)}`
}

function toPlain(obj) {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(toPlain)
  if (typeof obj === 'object') {
    const plain = {}
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'function') continue
      plain[k] = toPlain(v)
    }
    return plain
  }
  return obj
}

function getProxyPort() {
  return PROXY_PORT
}

function getProxyBaseUrl() {
  return PROXY_BASE
}

module.exports = {
  PROXY_PORT,
  PROXY_BASE,
  getProxyImageUrl,
  getLocalProxyUrl,
  toPlain,
  setProxyPort,
  getProxyPort,
  getProxyBaseUrl
}