'use strict'

// cookieJar 存储格式：Map<hostname, Array<{ name, value, expires?, path?, domain? }>>
const cookieJar = new Map()

// 过滤已过期的 cookie
function _filterValid(cookies) {
  const now = Date.now()
  return cookies.filter(c => !c.expires || c.expires > now)
}

function getCookies(hostname) {
  const cookies = cookieJar.get(hostname) || []
  return _filterValid(cookies).map(c => `${c.name}=${c.value}`).join('; ')
}

function updateCookies(hostname, setCookieStr) {
  if (!setCookieStr) return
  const headers = Array.isArray(setCookieStr) ? setCookieStr : [setCookieStr]
  const existing = cookieJar.get(hostname) || []
  for (const h of headers) {
    const parts = h.split(';').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) continue
    // 第一段是 name=value
    const nameValue = parts[0]
    const eqIdx = nameValue.indexOf('=')
    if (eqIdx < 0) continue
    const name = nameValue.substring(0, eqIdx)
    const value = nameValue.substring(eqIdx + 1)
    if (!name) continue

    // 解析 expires/path/domain/max-age 等属性
    const cookie = { name, value }
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i]
      const idx = attr.indexOf('=')
      const k = (idx >= 0 ? attr.substring(0, idx) : attr).toLowerCase()
      const v = idx >= 0 ? attr.substring(idx + 1) : ''
      if (k === 'expires') {
        const t = new Date(v).getTime()
        if (!isNaN(t)) cookie.expires = t
      } else if (k === 'max-age') {
        const sec = parseInt(v, 10)
        if (!isNaN(sec)) cookie.expires = Date.now() + sec * 1000
      } else if (k === 'path') {
        cookie.path = v
      } else if (k === 'domain') {
        cookie.domain = v
      }
    }

    // 同名 cookie 覆盖，否则追加
    const idx = existing.findIndex(c => c.name === name)
    if (idx >= 0) existing[idx] = cookie
    else existing.push(cookie)
  }
  cookieJar.set(hostname, existing)
}

module.exports = { getCookies, updateCookies }
