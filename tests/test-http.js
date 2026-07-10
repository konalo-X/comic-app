async function testNodeFetch() {
  console.log('=== 测试 Node.js fetch API ===')
  try {
    const res = await fetch('https://smtt6.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    })
    console.log('状态码:', res.status)
    const text = await res.text()
    console.log('响应大小:', text.length, 'bytes')
    console.log('前200字符:', text.substring(0, 200))
  } catch (e) {
    console.error('fetch 失败:', e.message)
  }
}

async function testNodeHttps() {
  console.log('\n=== 测试 Node.js https API ===')
  const https = require('https')
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'smtt6.com',
      port: 443,
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      rejectUnauthorized: false
    }, (res) => {
      console.log('状态码:', res.statusCode)
      let data = []
      res.on('data', c => data.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(data)
        console.log('响应大小:', buf.length, 'bytes')
        console.log('前200字符:', buf.toString('utf8', 0, 200))
        resolve()
      })
    })
    req.on('error', (e) => {
      console.error('https 失败:', e.message)
      resolve()
    })
    req.end()
  })
}

async function testNodeHttpsWithHttp2() {
  console.log('\n=== 测试 Node.js http2 API ===')
  const http2 = require('http2')
  return new Promise((resolve) => {
    try {
      const client = http2.connect('https://smtt6.com', {
        rejectUnauthorized: false
      })
      client.on('error', (e) => {
        console.error('http2 连接失败:', e.message)
        resolve()
      })
      const req = client.request({
        ':method': 'GET',
        ':path': '/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      })
      let data = []
      req.on('response', (headers) => {
        console.log('状态码:', headers[':status'])
      })
      req.on('data', c => data.push(c))
      req.on('end', () => {
        const buf = Buffer.concat(data)
        console.log('响应大小:', buf.length, 'bytes')
        console.log('前200字符:', buf.toString('utf8', 0, 200))
        client.close()
        resolve()
      })
      req.end()
    } catch (e) {
      console.error('http2 异常:', e.message)
      resolve()
    }
  })
}

async function main() {
  console.log('Node.js 版本:', process.version)
  await testNodeFetch()
  await testNodeHttps()
  await testNodeHttpsWithHttp2()
}

main()