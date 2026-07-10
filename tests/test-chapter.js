const { fetchUrl } = require('./electron/crawler')
const fs = require('fs')

async function test() {
  const chapterUrl = 'https://smtt6.com/man-hua-yue-du/12345679/raXeAVETsbPojjUwAnCn.html'
  console.log('Fetching:', chapterUrl)
  const html = await fetchUrl(null, chapterUrl, 'https://smtt6.com/man-hua-yue-du/12345679.html')
  fs.writeFileSync('chapter-page.html', html)
  console.log('Saved to chapter-page.html, size:', html.length, 'bytes')
  
  // 查找图片相关元素
  const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)]
  console.log('Found', imgMatches.length, 'img tags')
  imgMatches.forEach((m, i) => {
    console.log(i, m[1].substring(0, 120))
  })
  
  // 查找 data-original
  const origMatches = [...html.matchAll(/data-original=["']([^"']+)["']/gi)]
  console.log('Found', origMatches.length, 'data-original attributes')
  origMatches.forEach((m, i) => {
    console.log(i, m[1].substring(0, 120))
  })
  
  // 查找 hl-reader 相关内容
  const readerMatch = html.match(/class=["'][^"]*hl-reader[^"]*["'][^>]*>([\s\S]{0,500})/i)
  if (readerMatch) {
    console.log('hl-reader content:', readerMatch[1].substring(0, 500))
  }
  
  // 查找 reader 或 image 相关 div
  const divMatches = [...html.matchAll(/<div[^>]*class=["']([^"']*(?:reader|image|pic|img|content)[^"]*)["'][^>]*>/gi)]
  console.log('Found', divMatches.length, 'relevant divs')
  divMatches.forEach((m, i) => {
    console.log(i, m[1])
  })
}

test().catch(console.error)