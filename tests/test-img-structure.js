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
  console.log('=== 测试列表页的图片结构 ===')
  const result = await fetchUrl('/man-hua-lei-bie/all/ob/time/st/all/page/1')
  if (result.status !== 200) { console.error('访问失败'); return }

  const $ = cheerio.load(result.html)

  console.log('\n--- 前3个 li.hl-list-item 的完整 outerHTML ---')
  $('li.hl-list-item').slice(0, 2).each((i, el) => {
    console.log(`\n=== li[${i}] ===`)
    console.log($.html(el).substring(0, 500))
  })

  console.log('\n--- 查找 li.hl-list-item 中的所有 img ---')
  $('li.hl-list-item').slice(0, 3).each((i, el) => {
    const $li = $(el)
    console.log(`\nli[${i}] 中的图片:`)
    $li.find('img').each((j, img) => {
      console.log(`  img[${j}]:`)
      console.log(`    data-original="${$(img).attr('data-original')}"`)
      console.log(`    data-src="${$(img).attr('data-src')}"`)
      console.log(`    src="${$(img).attr('src')}"`)
      console.log(`    class="${$(img).attr('class')}"`)
    })
    console.log(`  标题:`, $li.find('h2, h3, [class*="title"]').first().text().trim())
  })

  console.log('\n=== 测试详情页的封面 ===')
  const detail = await fetchUrl('/man-hua-yue-du/12348648.html')
  if (detail.status === 200) {
    const $d = cheerio.load(detail.html)
    console.log('\n--- 查找封面图片 ---')
    $d('img').slice(0, 5).each((i, img) => {
      console.log(`img[${i}]:`)
      console.log(`  data-original="${$d(img).attr('data-original')}"`)
      console.log(`  data-src="${$d(img).attr('data-src')}"`)
      console.log(`  src="${$d(img).attr('src')?.substring(0, 80)}"`)
      console.log(`  class="${$d(img).attr('class')}"`)
    })
    console.log('\n--- og:image meta ---')
    console.log('og:image:', $d('meta[property="og:image"]').attr('content'))
  }
}

main()