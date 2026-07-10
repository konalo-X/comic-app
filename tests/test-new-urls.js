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
  console.log('=== 测试搜索: /cata.php?key=魔法少女 ===')
  const search = await fetchUrl('/cata.php?key=' + encodeURIComponent('魔法少女'))
  console.log('状态:', search.status)
  console.log('HTML 大小:', search.html.length)

  if (search.status === 200) {
    const $ = cheerio.load(search.html)

    console.log('\n=== 搜索结果页结构 ===')
    console.log('标题:', $('h1, h2').first().text().trim())

    console.log('\n=== 列表项 ===')
    const items = []
    $('li.hl-list-item, div.hl-item, li.item, div.comic-item, li[class*="item"]').each((i, el) => {
      const $el = $(el)
      const title = $el.find('h2, h3, .title, [class*="title"]').first().text().trim() ||
                    $el.find('a').first().attr('title') ||
                    $el.find('a').first().text().trim()
      const href = $el.find('a').first().attr('href')
      const cover = $el.find('img').first().attr('data-original') || $el.find('img').first().attr('src')
      if (title && href) items.push({ title, href, cover })
    })
    console.log('找到的列表项:', items.length)
    items.slice(0, 5).forEach((item, i) => {
      console.log('  ', i + 1, item.title.substring(0, 40))
      console.log('     URL:', item.href?.substring(0, 80))
      console.log('     封面:', item.cover?.substring(0, 80))
    })

    // 如果没找到，打印所有 li 看看结构
    if (items.length === 0) {
      console.log('\n=== 所有 li 元素 ===')
      const lis = []
      $('li').each((i, el) => {
        const text = $(el).text().trim().substring(0, 60)
        const hasLink = $(el).find('a').length > 0
        const hasImg = $(el).find('img').length > 0
        if (hasLink && hasImg && text.length > 5) {
          lis.push({ text, class: $(el).attr('class') })
        }
      })
      lis.slice(0, 10).forEach((l, i) => console.log('  ', i + 1, '[' + l.class + ']', l.text))
    }

    console.log('\n=== 详情页测试 ===')
    if (items.length > 0) {
      const detailPath = items[0].href.startsWith('http') ? new URL(items[0].href).pathname : items[0].href
      console.log('详情页路径:', detailPath)
      const detail = await fetchUrl(detailPath)
      console.log('状态:', detail.status)
      if (detail.status === 200) {
        const $d = cheerio.load(detail.html)
        console.log('漫画标题:', $d('meta[property="og:title"]').attr('content') || $d('h1').first().text().trim())
        console.log('章节列表数:', $d('ul#hl-plays-list a, ul.hl-plays-list a, .hl-plays-list a, a[href*="man-hua-yue-du"]').length)
        $d('a[href*="man-hua-yue-du"]').slice(0, 5).each((i, el) => {
          console.log('  章节:', $d(el).text().trim().substring(0, 40), '->', $d(el).attr('href')?.substring(0, 80))
        })

        // 测试章节内容页
        const firstChapter = $d('a[href*="man-hua-yue-du"]').first()
        if (firstChapter.length > 0) {
          const chapterPath = firstChapter.attr('href').startsWith('http') ? new URL(firstChapter.attr('href')).pathname : firstChapter.attr('href')
          console.log('\n=== 章节内容页 ===')
          console.log('路径:', chapterPath)
          const chapter = await fetchUrl(chapterPath)
          console.log('状态:', chapter.status)
          if (chapter.status === 200) {
            const $c = cheerio.load(chapter.html)
            console.log('章节标题(h2):', $c('h2').first().text().trim())
            console.log('图片数:', $c('img[data-original], img[src]').length)
            $c('img[data-original], img[src]').slice(0, 3).each((i, el) => {
              const url = $c(el).attr('data-original') || $c(el).attr('src')
              console.log('  图片', i + 1, ':', url?.substring(0, 80))
            })
          }
        }
      }
    }
  }

  // 也测试分类页
  console.log('\n=== 测试分类页: /man-hua-lei-bie ===')
  const cat = await fetchUrl('/man-hua-lei-bie')
  console.log('状态:', cat.status)
  if (cat.status === 200) {
    const $c = cheerio.load(cat.html)
    const catItems = []
    $c('li.hl-list-item').each((i, el) => {
      const title = $c(el).find('h2').first().text().trim()
      const href = $c(el).find('a').first().attr('href')
      if (title && href) catItems.push({ title, href })
    })
    console.log('分类页列表项:', catItems.length)
    catItems.slice(0, 3).forEach((item, i) => {
      console.log('  ', i + 1, item.title.substring(0, 40))
    })
  }
}

main()