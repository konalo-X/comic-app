import DOMPurify from 'dompurify'

export function sanitizeHtml(html) {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'embed', 'object', 'form'],
    FORBID_ATTR: ['onclick', 'onload', 'onerror', 'onmouseover', 'onfocus', 'onblur']
  })
}

export function sanitizeText(text) {
  if (!text) return ''
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

export function sanitizeUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return ''
    }
    return url
  } catch {
    return ''
  }
}