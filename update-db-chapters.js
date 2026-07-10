'use strict'
const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const https = require('https')
const http = require('http')
const { URL } = require('url')
const zlib = require('zlib')

const DB_PATH = path.join(__dirname, 'comics.sqlite')
const BATCH_SIZE = 5  // 每批处理多少部漫画
const DELAY_MS = 800  // 请求间隔

let SQL = null
let db = null

async function initDB() {
  SQL = await initSqlJs()
  const buf = fs.readFileSync(DB_PATH)
  db = new SQL.Database(buf)
}

function saveDB() {
  const data = db.export()
  fs.writeFileSync(DB_PATH, Buffer.from(data))
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
  const match = html.match(/<h2[^>]*>([^<]*)<\/h2>/i)
  if (match) return match[1].trim()
  return ''
}

async function getAllComicsWithChapters() {
  const rows = db.exec('SELECT id, title, sourceUrl FROM comics')
  if (rows.length === 0) return []
  const comics = rows[0].values.map(r => ({ id: r[0], title: r[1], sourceUrl: r[2] }))
  
  for (const comic of comics) {
    const chRows = db.exec('SELECT id, name, url, sort_order FROM chapters WHERE comic_id = ? ORDER BY sort_order', [comic.id])
    comic.chapters = chRows.length > 0 ? chRows[0].values.map(r => ({ id: r[0], name: r[1], url: r[2], sortOrder: r[3] })) : []
  }
  return comics
}

async function updateChapterName(chapterId, newName) {
  db.run('UPDATE chapters SET name = ? WHERE id = ?', [newName, chapterId])
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

  const comics = await getAllComicsWithChapters()
  console.log(`数据库漫画总数: ${comics.length}`)
  
  // 只处理有章节的漫画
  const comicsWithChapters = comics.filter(c => c.chapters.length > 0)
  console.log(`有章节的漫画: ${comicsWithChapters.length}`)
  console.log()

  let totalUpdated = 0
  let totalSkipped = 0
  let totalErrors = 0

  // 分批处理
  for (let batchStart = 0; batchStart < comicsWithChapters.length; batchStart += BATCH_SIZE) {
    const batch = comicsWithChapters.slice(batchStart, batchStart + BATCH_SIZE)
    console.log(`\n--- 批次 ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(comicsWithChapters.length / BATCH_SIZE)} ---`)

    for (const comic of batch) {
      console.log(`\n[${comic.title}] 章节数: ${comic.chapters.length}`)
      
      for (const chapter of comic.chapters) {
        if (!chapter.url) {
          console.log(`  跳过: 无URL`)
          totalSkipped++
          continue
        }

        try {
          const html = await fetchUrl(chapter.url, comic.sourceUrl)
          const newName = extractChapterNameFromHtml(html)
          
          if (!newName) {
            console.log(`  第${chapter.sortOrder + 1}章: 无法从h2提取章节名`)
            totalSkipped++
            continue
          }

          const oldName = chapter.name
          if (newName === oldName) {
            console.log(`  第${chapter.sortOrder + 1}章: "${oldName}" → 无需更新`)
            totalSkipped++
            continue
          }

          console.log(`  第${chapter.sortOrder + 1}章: "${oldName}" → "${newName}"`)
          await updateChapterName(chapter.id, newName)
          totalUpdated++

        } catch (e) {
          console.log(`  第${chapter.sortOrder + 1}章: 错误 - ${e.message}`)
          totalErrors++
        }

        // 请求间隔
        await new Promise(r => setTimeout(r, DELAY_MS))
      }
    }

    // 每批保存一次
    saveDB()
    console.log(`\n  💾 已保存批次`)
  }

  // 最终保存
  saveDB()

  console.log('\n' + '='.repeat(70))
  console.log('更新完成')
  console.log('='.repeat(70))
  console.log(`  总章节数: ${comicsWithChapters.reduce((sum, c) => sum + c.chapters.length, 0)}`)
  console.log(`  已更新: ${totalUpdated}`)
  console.log(`  跳过: ${totalSkipped}`)
  console.log(`  错误: ${totalErrors}`)
}

main().catch(console.error)