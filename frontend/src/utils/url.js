export function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    })
  }
  return url.toString()
}

export function parseUrlParams(url) {
  const params = {}
  const urlObj = new URL(url, window.location.origin)
  urlObj.searchParams.forEach((value, key) => {
    params[key] = decodeURIComponent(value)
  })
  return params
}

export function encodeParam(value) {
  if (value === undefined || value === null) return ''
  return encodeURIComponent(String(value))
}

export function decodeParam(value) {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function isValidUrl(url) {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

export function getHostname(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}