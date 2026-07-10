'use strict'
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const https = require('https')
const http = require('http')
const { URL } = require('url')
const zlib = require('zlib')

const DB_PATH = path.join(__dirname, 'comics.sqlite')
const DELAY_MS = 600

let SQL = null
let db = null

async function initDB() {
  SQL = await initSqlJs()
  const buf = fs.readFileSync(DB_PATH)
  db = new SQL.Database(buf)
}

function saveDB() {
  if (!db) return
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
  console.log('  💾 数据库已保存')
}

function fetchUrl(urlStr, referer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr)
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': referer || 'https://smtt6.com/',
      },
      timeout: 15000
    }, (res) => {
      if ([301, 302].includes(res.statusCode)) {
        res.resume()
        const location = res.headers['location']
        if (!location) return reject(new Error('Redirect without Location'))
        return resolve(fetchUrl(new URL(location, urlStr).href, referer))
      }
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
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function extractChapterNameFromHtml(html) {
  // 匹配 h2 元素内容
  const match = html.match(/<h2[^>]*>([^<]*)<\/h2>/i)
  if (match) return match[1].trim()
  return ''
}

async function main() {
  console.log('='.repeat(70))
  console.log('更新数据库章节名 - 从内容页 h2 获取完整章节名')
  console.log('='.repeat(70))
  console.log()

  if (!fs.existsSync(DB_PATH)) {
    console.error('数据库文件不存在!')
    return
  }

  await initDB()

  // 获取所有漫画和章节
  const comicRows = db.exec('SELECT id, title, sourceUrl FROM comics')
  if (comicRows.length === 0) {
    console.log('数据库为空')
    return
  }

  const comics = comicRows[0].values.map(r => ({ id: r[0], title: r[1], sourceUrl: r[2] }))
  console.log(`数据库漫画总数: ${comics.length}`)

  let totalUpdated = 0
  let totalSkipped = 0
  let totalErrors = 0
  let processedComics = 0

  for (const comic of comics) {
    // 获取该漫画的章节
    const chRows = db.exec('SELECT id, name, url, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order', [comic.id])
    if (chRows.length === 0 || chRows[0].values.length === 0) continue

    const chapters = chRows[0].values.map(r => ({ id: r[0], name: r[1], url: r[2], sortOrder: r[3] }))
    processedComics++
    console.log(`\n[${processedComics}] ${comic.title} - ${chapters.length}章`)

    let comicUpdated = false

    for (const chapter of chapters) {
      if (!chapter.url) {
        totalSkipped++
        continue
      }

      try {
        const html = await fetchUrl(chapter.url, comic.sourceUrl)
        const newName = extractChapterNameFromHtml(html)

        if (!newName) {
          totalSkipped++
          continue
        }

        const oldName = chapter.name
        if (newName === oldName) {
          totalSkipped++
          continue
        }

        // 更新数据库
        db.run('UPDATE chapters SET name = ? WHERE id = ?', [newName, chapter.id])
        console.log(`  第${chapter.sortOrder + 1}章: "${oldName}" → "${newName}"`)
        totalUpdated++
        comicUpdated = true

      } catch (e) {
        console.log(`  第${chapter.sortOrder + 1}章: 错误 - ${e.message}`)
        totalErrors++
      }

      // 请求间隔
      await new Promise(r => setTimeout(r, DELAY_MS))
    }

    // 每部漫画处理完后保存
    if (comicUpdated) {
      saveDB()
    }
  }

  // 最终保存
  saveDB()

  console.log('\n' + '='.repeat(70))
  console.log('更新完成')
  console.log('='.repeat(70))
  console.log(`  处理漫画数: ${processedComics}`)
  console.log(`  已更新章节: ${totalUpdated}`)
  console.log(`  跳过: ${totalSkipped}`)
  console.log(`  错误: ${totalErrors}`)
}

main().catch(console.error)