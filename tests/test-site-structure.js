async function main() {
  const https = require('https')
  const cheerio = require('cheerio')

  console.log('=== 1. 获取主页 ===')
  const homeHtml = await new Promise((resolve) => {
    const req = https.request({
      hostname: 'smtt6.com', port: 443, path: '/', method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      rejectUnauthorized: false
    }, (res) => {
      let d = []
      res.on('data', c => d.push(c))
      res.on('end', () => resolve(Buffer.concat(d).toString('utf8')))
    })
    req.on('error', (e) => { console.error('主页错误:', e.message); resolve('') })
    req.end()
  })

  console.log('主页大小:', homeHtml.length)

  // 查找搜索框/搜索 URL
  const $ = cheerio.load(homeHtml)
  console.log('\n=== 2. 查找搜索相关元素 ===')
  const searchInputs = $('input[name*="search"], input[name*="keyword"], form[action*="search"]')
  console.log('搜索框数量:', searchInputs.length)
  searchInputs.each((i, el) => {
    console.log('  元素:', $(el).attr('name'), $(el).attr('placeholder'))
  })

  const forms = $('form')
  console.log('表单数量:', forms.length)
  forms.each((i, el) => {
    const $f = $(el)
    console.log('  表单 action:', $f.attr('action'), 'method:', $f.attr('method'))
    console.log('  表单内输入:')
    $f.find('input, select, textarea').each((j, inp) => {
      console.log('    ', $(inp).attr('name'), '=', $(inp).attr('value'))
    })
  })

  // 查找导航链接
  console.log('\n=== 3. 查找导航链接 ===')
  const navLinks = $('a[href]')
  console.log('导航链接数:', navLinks.length)
  const interestingLinks = []
  navLinks.each((i, el) => {
    const href = $(el).attr('href')
    const text = $(el).text().trim()
    if (href && (href.includes('search') || href.includes('list') || text.includes('搜索') || text.includes('分类') || text.includes('列表'))) {
      interestingLinks.push({ text, href })
    }
  })
  interestingLinks.slice(0, 20).forEach(l => {
    console.log('  ', l.text.substring(0, 20), '->', l.href)
  })

  // 尝试不同的搜索 URL
  console.log('\n=== 4. 测试不同的搜索 URL ===')
  const testUrls = [
    '/search.html?keyword=魔法少女',
    '/search?keyword=魔法少女',
    '/search/',
    '/index.php?s=/search&keyword=魔法少女',
    '/man-hua-lei-bie/all/',
    '/list.html',
  ]
  for (const path of testUrls) {
    const status = await new Promise((resolve) => {
      const req = https.request({
        hostname: 'smtt6.com', port: 443, path, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        rejectUnauthorized: false
      }, (res) => {
        resolve(res.statusCode)
        res.resume()
      })
      req.on('error', () => resolve(-1))
      req.end()
    })
    console.log('  ', path, '->', status)
  }
}

main()