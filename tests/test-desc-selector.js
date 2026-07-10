const cheerio = require('cheerio')
const axios = require('axios')

async function testDescSelector() {
  const url = 'https://smtt6.com/man-hua-yue-du/12345713.html'
  
  console.log('[Test] 测试简介选择器...')
  console.log('[Test] URL:', url)
  
  try {
    const html = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    }).then(r => r.data)
    
    const $ = cheerio.load(html)
    
    console.log('\n[Test] 尝试不同的选择器:')
    
    // 方法1: meta description
    const metaDesc = $('meta[property="og:description"]').attr('content')
    console.log('[Test] meta[property="og:description"]:', metaDesc ? metaDesc.substring(0, 100) : '(空)')
    
    // 方法2: div.hl-dc-desc
    const divDesc = $('div.hl-dc-desc').first().text().trim()
    console.log('[Test] div.hl-dc-desc:', divDesc ? divDesc.substring(0, 100) : '(空)')
    
    // 方法3: 查找所有包含"简介"或"介绍"的元素
    $('*').each((i, el) => {
      const text = $(el).text().trim()
      if (text.includes('简介') || text.includes('介绍') || text.includes('描述')) {
        console.log(`[Test] 找到关键词在 <${el.name}>:`, text.substring(0, 150))
        return false  // 只找第一个
      }
    })
    
    // 方法4: 直接打印 hl-dc-content 的内容
    const contentText = $('div.hl-dc-content').first().text()
    console.log('\n[Test] div.hl-dc-content 内容:', contentText ? contentText.substring(0, 200) : '(空)')
    
  } catch (err) {
    console.error('[Test] 错误:', err.message)
  }
}

testDescSelector()
