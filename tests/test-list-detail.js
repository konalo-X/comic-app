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

async function testListPage(path, label) {
  console.log(`\n=== ${label}: ${path} ===`)
  const result = await fetchUrl(path)
  console.log('状态:', result.status)

  if (result.status !== 200) {
    console.log('❌ 页面无法访问')
    return
  }

  const $ = cheerio.load(result.html)

  // 测试当前代码的解析逻辑
  console.log('\n--- 当前代码解析: li.hl-list-item ---')
  const currentItems = []
  $('li.hl-list-item').each((i, el) => {
    const $li = $(el)
    const $a = $li.find('a').first()
    const href = $a.attr('href') || ''
    const title = $li.find('h2').first().text().trim() ||
                  $li.find('[class*="title"]').first().text().trim() ||
                  $a.attr('title') || ''
    let cover = $li.find('img[data-original]').attr('data-original') ||
                $li.find('img[src]').attr('src') || ''
    if (cover && !cover.startsWith('http')) cover = 'https://smtt6.com' + cover
    if (title && href) currentItems.push({ title, href, cover })
  })
  console.log('li.hl-list-item 数量:', $('li.hl-list-item').length)
  console.log('解析成功数量:', currentItems.length)
  currentItems.slice(0, 3).forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.title.substring(0, 40)}`)
    console.log(`     href: ${item.href.substring(0, 80)}`)
    console.log(`     cover: ${item.cover?.substring(0, 80) || '(无)'}`)
  })

  // 如果 hl-list-item 解析不成功，看看实际的 li 结构
  if (currentItems.length === 0 || $('li.hl-list-item').length === 0) {
    console.log('\n--- 调试: 所有带图片的 li ---')
    let count = 0
    $('li').each((i, el) => {
      if (count >= 5) return
      const $li = $(el)
      const $img = $li.find('img')
      if ($img.length === 0) return
      const className = $li.attr('class') || ''
      const $a = $li.find('a').first()
      const href = $a.attr('href') || ''
      const title = $li.text().trim().replace(/\s+/g, ' ').substring(0, 80)
      const imgSrc = $img.attr('data-original') || $img.attr('src') || ''
      if (imgSrc && imgSrc.length > 5 && href.includes('man-hua')) {
        console.log(`  [${count}] class="${className}"`)
        console.log(`     title-text: ${title}`)
        console.log(`     href: ${href.substring(0, 80)}`)
        console.log(`     img: ${imgSrc.substring(0, 80)}`)
        count++
      }
    })
  }

  // 测试详情页
  if (currentItems.length > 0) {
    const detailHref = currentItems[0].href.startsWith('http')
      ? new URL(currentItems[0].href).pathname
      : currentItems[0].href
    console.log(`\n--- 测试详情页: ${detailHref} ---`)
    const detail = await fetchUrl(detailHref)
    if (detail.status === 200) {
      const $d = cheerio.load(detail.html)
      const detailTitle = $d('h1.hl-dc-title').first().text().trim() ||
                          $d('meta[property="og:title"]').attr('content') ||
                          $d('h1').first().text().trim()
      console.log('标题:', detailTitle)
      console.log('封面:', $d('img.hl-item-thumb').attr('data-original') || $d('img.hl-item-thumb').attr('src'))

      // 找章节
      const $chapterList = $d('ul#hl-plays-list')
      console.log('章节列表 ul 数量:', $chapterList.length)
      const chapters = []
      $chapterList.find('a.module-play-list-link').each((i, el) => {
        chapters.push({
          name: $d(el).text().trim(),
          url: $d(el).attr('href') || ''
        })
      })
      console.log('章节数 (a.module-play-list-link):', chapters.length)
      if (chapters.length === 0) {
        // 尝试其他选择器
        const allChapterLinks = $d('a').filter((i, el) => {
          const h = $d(el).attr('href') || ''
          return h.includes('man-hua-yue-du')
        })
        console.log('章节数 (a[href*=man-hua-yue-du]):', allChapterLinks.length)
        allChapterLinks.slice(0, 3).each((i, el) => {
          console.log(`  ${i + 1}. ${$d(el).text().trim().substring(0, 40)} -> ${$d(el).attr('href')?.substring(0, 80)}`)
        })
      } else {
        chapters.slice(0, 3).forEach((ch, i) => {
          console.log(`  ${i + 1}. ${ch.name.substring(0, 40)} -> ${ch.url.substring(0, 80)}`)
        })
      }

      // 测试章节内容页
      if (chapters.length > 0) {
        const chapterHref = chapters[0].url.startsWith('http')
          ? new URL(chapters[0].url).pathname
          : chapters[0].url
        console.log(`\n--- 测试章节内容页: ${chapterHref} ---`)
        const chapter = await fetchUrl(chapterHref)
        if (chapter.status === 200) {
          const $c = cheerio.load(chapter.html)
          console.log('h2:', $c('h2').first().text().trim())
          const imgs = []
          $c('img[data-original], img[src]').each((i, el) => {
            const src = $c(el).attr('data-original') || $c(el).attr('src')
            if (src && src.match(/\.(jpg|jpeg|png|webp|gif)/i)) imgs.push(src)
          })
          console.log('图片数:', imgs.length)
          imgs.slice(0, 3).forEach((u, i) => console.log(`  ${i + 1}. ${u.substring(0, 80)}`))
        }
      }
    }
  }
}

async function main() {
  await testListPage('/man-hua-lei-bie/all/ob/time/st/all/page/1', '分类列表页')
  await testListPage('/man-hua-lei-bie/all/ob/time/st/1', '旧格式分类页')
  await testListPage('/cata.php?key=' + encodeURIComponent('魔法少女'), '搜索页')
}

main()