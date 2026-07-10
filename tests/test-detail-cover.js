const https = require('https')
const cheerio = require('cheerio')

function fetchUrl(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'smtt6.com', port: 443, path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://smtt6.com/',
      },
      rejectUnauthorized: false
    }, (res) => {
      let d = []
      res.on('data', c => d.push(c))
      res.on('end', () => resolve({ status: res.statusCode, html: Buffer.concat(d).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ status: -1, html: '', error: e.message }))
    req.end()
  })
}

async function main() {
  console.log('=== 详情页完整结构（前3000字符） ===')
  const result = await fetchUrl('/man-hua-yue-du/12348648.html')
  console.log('状态:', result.status)
  console.log(result.html.substring(0, 3000))

  const $ = cheerio.load(result.html)
  console.log('\n\n=== 查找所有带 data-original 的元素 ===')
  $('[data-original]').slice(0, 5).each((i, el) => {
    console.log(`[${i}] <${$(el).prop('tagName').toLowerCase()}> class="${$(el).attr('class')}"`)
    console.log(`    data-original="${$(el).attr('data-original')?.substring(0, 80)}"`)
  })

  console.log('\n=== 查找所有 <a> 和 <img> 中包含 URL 的元素 ===')
  $('a, img').slice(0, 10).each((i, el) => {
    const tag = $(el).prop('tagName').toLowerCase()
    const do_ = $(el).attr('data-original')
    const ds_ = $(el).attr('data-src')
    const src = $(el).attr('src')
    const href = $(el).attr('href')
    if (do_ || ds_ || (src && src.includes('manga')) || (href && href.includes('man-hua'))) {
      console.log(`<${tag}>: class="${$(el).attr('class')}"`)
      if (do_) console.log(`  data-original: ${do_.substring(0, 80)}`)
      if (ds_) console.log(`  data-src: ${ds_.substring(0, 80)}`)
      if (src) console.log(`  src: ${src.substring(0, 80)}`)
      if (href) console.log(`  href: ${href.substring(0, 80)}`)
    }
  })

  console.log('\n=== 查找详情页 hl-dc-content 区域 ===')
  const $content = $('div.hl-dc-content')
  if ($content.length > 0) {
    console.log('内容文本:', $content.first().text().trim().substring(0, 200))
  }

  console.log('\n=== 查找详情页的标题元素 ===')
  console.log('h1.hl-dc-title:', $('h1.hl-dc-title').first().text().trim())
  console.log('h1:', $('h1').first().text().trim())

  // 测试章节内容页 - 看完整 h2
  const chapter = await fetchUrl('/man-hua-yue-du/12348648/SGOsNvjRlZUHXHiFAHqG.html')
  const $c = cheerio.load(chapter.html)
  console.log('\n=== 章节内容页 h2 ===')
  $c('h2').slice(0, 3).each((i, el) => {
    console.log(`h2[${i}]: "${$c(el).text().trim()}"`)
  })
  console.log('=== 章节内容页第一张图片附近的上下文 ===')
  $c('img').slice(0, 3).each((i, el) => {
    const src = $c(el).attr('data-original') || $c(el).attr('src')
    console.log(`img[${i}]: ${src?.substring(0, 100)}`)
  })
}

main()