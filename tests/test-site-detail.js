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
  console.log('=== 1. 搜索页: /cata.php?key=魔法少女 ===')
  const search = await fetchUrl('/cata.php?key=' + encodeURIComponent('魔法少女'))
  console.log('状态:', search.status)

  if (search.status === 200) {
    console.log('HTML 前1000字符:')
    console.log(search.html.substring(0, 1000))

    const $ = cheerio.load(search.html)

    console.log('\n=== 所有 li 元素 (前20个) ===')
    $('li').slice(0, 30).each((i, el) => {
      const $el = $(el)
      const className = $el.attr('class') || ''
      const text = $el.text().trim().replace(/\s+/g, ' ').substring(0, 80)
      const $a = $el.find('a').first()
      const href = $a.attr('href')
      const $img = $el.find('img').first()
      const img = $img.attr('data-original') || $img.attr('src')
      if (text.length > 3 || img) {
        console.log(`  [${i}] class="${className}" text="${text}"`)
        if (href) console.log(`      href: ${href}`)
        if (img) console.log(`      img: ${img.substring(0, 80)}`)
      }
    })

    console.log('\n=== 所有包含图片的 a 元素 ===')
    let imgCount = 0
    $('a').each((i, el) => {
      const $a = $(el)
      const $img = $a.find('img')
      if ($img.length > 0 && imgCount < 15) {
        const text = $a.text().trim().replace(/\s+/g, ' ').substring(0, 60)
        const href = $a.attr('href')
        const img = $img.attr('data-original') || $img.attr('src')
        if (img && img.length > 10) {
          console.log(`  [${imgCount}] "${text}"`)
          console.log(`      href: ${href?.substring(0, 100)}`)
          console.log(`      img: ${img.substring(0, 100)}`)
          imgCount++
        }
      }
    })
  }

  console.log('\n=== 2. 热门页: /re-men-man-hua ===')
  const popular = await fetchUrl('/re-men-man-hua')
  console.log('状态:', popular.status)
  if (popular.status === 200) {
    const $ = cheerio.load(popular.html)
    console.log('li 数量:', $('li').length)
    console.log('包含图片的 li:')
    let count = 0
    $('li').each((i, el) => {
      const $el = $(el)
      const $img = $el.find('img')
      if ($img.length > 0 && count < 10) {
        const img = $img.attr('data-original') || $img.attr('src')
        const title = $el.find('h2, h3').first().text().trim() || $el.find('a').first().text().trim()
        const href = $el.find('a').first().attr('href')
        if (title && title.length > 2) {
          console.log(`  [${count}] ${title.substring(0, 40)}`)
          console.log(`      href: ${href?.substring(0, 100)}`)
          console.log(`      img: ${img?.substring(0, 100)}`)
          count++
        }
      }
    })
  }

  console.log('\n=== 3. 最新页: /xin-man-hua ===')
  const latest = await fetchUrl('/xin-man-hua')
  console.log('状态:', latest.status)
  if (latest.status === 200) {
    const $ = cheerio.load(latest.html)
    console.log('li 数量:', $('li').length)
    let count = 0
    $('li').each((i, el) => {
      const $el = $(el)
      const $img = $el.find('img')
      if ($img.length > 0 && count < 10) {
        const img = $img.attr('data-original') || $img.attr('src')
        const title = $el.find('h2, h3').first().text().trim() || $el.find('a').first().text().trim()
        const href = $el.find('a').first().attr('href')
        if (title && title.length > 2) {
          console.log(`  [${count}] ${title.substring(0, 40)}`)
          console.log(`      href: ${href?.substring(0, 100)}`)
          console.log(`      img: ${img?.substring(0, 100)}`)
          count++
        }
      }
    })
  }

  console.log('\n=== 4. 详情页测试 ===')
  const testUrls = [
    '/man-hua-yue-du/12348454.html',
  ]
  for (const url of testUrls) {
    console.log(`\n测试: ${url}`)
    const detail = await fetchUrl(url)
    console.log('状态:', detail.status)
    if (detail.status === 200) {
      const $ = cheerio.load(detail.html)
      console.log('h1:', $('h1').first().text().trim())
      console.log('h2 数量:', $('h2').length)
      $('h2').slice(0, 5).each((i, el) => {
        console.log(`  h2[${i}]:`, $(el).text().trim().substring(0, 60))
      })
      console.log('og:title:', $('meta[property="og:title"]').attr('content'))
      console.log('图片数量:', $('img').length)
      let imgs = []
      $('img').slice(0, 15).each((i, el) => {
        const url = $(el).attr('data-original') || $(el).attr('src')
        if (url && url.length > 10) imgs.push(url)
      })
      console.log('图片URL (前5个):')
      imgs.slice(0, 5).forEach((u, i) => console.log('  ', i + 1, u.substring(0, 80)))
    }
  }
}

main()