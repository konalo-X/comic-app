'use strict'

const cookieJar = new Map()

function getCookies(hostname) {
  const cookies = cookieJar.get(hostname) || []
  return cookies.map(c => c.split(';')[0]).join('; ')
}

function updateCookies(hostname, setCookieStr) {
  if (!setCookieStr) return
  const headers = Array.isArray(setCookieStr) ? setCookieStr : [setCookieStr]
  const existing = cookieJar.get(hostname) || []
  for (const h of headers) {
    const cookie = h.split(';')[0].trim()
    if (!cookie) continue
    const [name] = cookie.split('=')
    const idx = existing.findIndex(c => c.startsWith(name + '='))
    if (idx >= 0) existing[idx] = cookie
    else existing.push(cookie)
  }
  cookieJar.set(hostname, existing)
}

module.exports = { getCookies, updateCookies }