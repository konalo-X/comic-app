const https = require('https')
const zlib = require('zlib')
const cheerio = require('cheerio')

function fetch(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://smtt6.com/',
      }
    }, (res) => {
      let chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const ce = res.headers['content-encoding']
        if (ce === 'gzip') buf = zlib.gunzipSync(buf)
        else if (ce === 'deflate') buf = zlib.inflateSync(buf)
        else if (ce === 'br') buf = zlib.brotliDecompressSync(buf)
        resolve(buf.toString('utf-8'))
      })
    })
    req.on('error', e => { console.log('Error:', e.message); resolve(null) })
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
  })
}

async function main() {
  // 用 BeautifulDays 的第1话内容页来测试
  // 先获取详情页找到章节URL
  const detailHtml = await fetch('https://smtt6.com/man-hua-yue-du/12348454.html')
  if (!detailHtml) return

  const $ = cheerio.load(detailHtml)

  // 找到第一个章节链接
  const firstChapterUrl = $('ul#hl-plays-list a').first().attr('href')
  if (!firstChapterUrl) {
    console.log('没找到章节链接')
    return
  }

  const fullUrl = firstChapterUrl.startsWith('http') ? firstChapterUrl : 'https://smtt6.com' + firstChapterUrl
  console.log('章节URL:', fullUrl)

  // 获取章节内容页
  const chapterHtml = await fetch(fullUrl)
  if (!chapterHtml) return

  const $ch = cheerio.load(chapterHtml)

  // 查找各种 h 元素
  console.log('\n=== 页面标题 ===')
  console.log('title:', $ch('title').text())

  console.log('\n=== h1 元素 ===')
  $ch('h1').each((i, el) => {
    console.log(`  h1[${i}]:`, $ch(el).text().trim())
  })

  console.log('\n=== h2 元素 ===')
  $ch('h2').each((i, el) => {
    console.log(`  h2[${i}]:`, $ch(el).text().trim())
  })

  console.log('\n=== h3 元素 ===')
  $ch('h3').each((i, el) => {
    console.log(`  h3[${i}]:`, $ch(el).text().trim())
  })

  console.log('\n=== 其他可能包含章节名的元素 ===')
  $ch('[class*="title"]').each((i, el) => {
    console.log(`  .title[${i}]:`, $ch(el).text().trim())
  })

  // 保存 HTML 用于分析
  fs.writeFileSync('chapter-page.html', chapterHtml)
  console.log('\nHTML 已保存到 chapter-page.html')
}

const fs = require('fs')
main()