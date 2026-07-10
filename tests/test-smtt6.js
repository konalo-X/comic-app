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
      console.log('Status:', res.statusCode)
      let chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        const ce = res.headers['content-encoding']
        if (ce === 'gzip') buf = zlib.gunzipSync(buf)
        else if (ce === 'deflate') buf = zlib.inflateSync(buf)
        else if (ce === 'br') buf = zlib.brotliDecompressSync(buf)
        const html = buf.toString('utf-8')
        const $ = cheerio.load(html)
        console.log('Title:', $('title').text())
        console.log('H1:', $('h1').text())
        console.log('H2:', $('h2').text())
        console.log('HTML length:', html.length)
        resolve(html)
      })
    })
    req.on('error', e => { console.log('Error:', e.message); resolve(null) })
    req.setTimeout(15000, () => { req.destroy(); console.log('Timeout'); resolve(null) })
  })
}

async function main() {
  console.log('=== 测试详情页 ===')
  const html = await fetch('https://smtt6.com/man-hua-yue-du/12348454.html')
}
main()