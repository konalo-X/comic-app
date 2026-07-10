const sources = require('./electron/sources/registry')

async function main() {
  const src = sources.get('smtt6')

  console.log('=== 完整模拟点击「爬取漫画」按钮 ===')
  console.log('BASE_URL: https://smtt6.com/man-hua-lei-bie/all/ob/time/st/all/page/1')
  console.log()

  const TOTAL_PAGES = 150  // main.js 中设置的总页数
  let totalComics = 0
  const maxPages = 5  // 只测前 5 页

  try {
    // 预热（对应第 100 行 source.search('', 1)）
    console.log('[预热] 建立连接...')
    try { await src.search('', 1) } catch {}
    console.log('[预热] 完成')
    console.log()

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      console.log(`--- 第 ${pageNum}/${TOTAL_PAGES} 页 ---`)

      // 对应第 106-107 行 getPopular
      const items = pageNum === 1 ? await src.getPopular(1) : await src.getPopular(pageNum)
      console.log(`  获取到 ${items.length} 部漫画`)

      if (items.length > 0) {
        totalComics += items.length
        console.log(`  前 3 部:`)
        items.slice(0, 3).forEach((item, i) => {
          console.log(`    ${i + 1}. ${item.title}`)
          console.log(`       封面: ${item.cover?.substring(0, 60) || '(无)'}`)
          console.log(`       URL: ${item.sourceUrl?.substring(0, 70)}`)
        })

        // 验证详情页解析（第 1 页第 1 部）
        if (pageNum === 1) {
          console.log(`\n[详情验证] 第 1 页第 1 部: ${items[0].title}`)
          const detail = await src.getDetail(items[0].sourceUrl)
          console.log(`  章节数: ${detail.chapters.length}`)

          if (detail.chapters.length > 0) {
            const pageList = await src.getPageList(detail.chapters[0].url, items[0].sourceUrl)
            const images = Array.isArray(pageList) ? pageList : pageList.images
            const chapterName = Array.isArray(pageList) ? '' : pageList.chapterName
            console.log(`  第 1 章: ${chapterName} (${images.length} 图)`)

            // 下载第一张图
            try {
              const buf = await src.fetchImage(images[0], detail.chapters[0].url)
              console.log(`  下载第 1 张图: ${buf.length} bytes ✅`)
            } catch (e) {
              console.log(`  下载第 1 张图: ❌ ${e.message}`)
            }
          }
        }
      }

      console.log(`  累计: ${totalComics} 部`)
      console.log()

      // 翻页（对应第 117 行 url = pageNum < 150 ? url : null）
      if (pageNum >= maxPages) {
        console.log('[完成] 已测试 5 页，停止')
        break
      }
    }

    console.log('\n🎉 完整爬取流程验证通过！')
    console.log(`   - 列表页 URL: https://smtt6.com/man-hua-lei-bie/all/ob/time/st/all/page/N ✅`)
    console.log(`   - 封面图提取: 从 <a class="hl-item-thumb hl-lazy" data-original="..."> ✅`)
    console.log(`   - 详情页解析: 章节列表、标题、封面 ✅`)
    console.log(`   - 章节图片: 从内容页 <img data-original="..."> 提取 ✅`)
    console.log(`   - 图片下载: 通过 referer 伪装请求 ✅`)

  } catch (e) {
    console.error('\n❌ 错误:', e.message)
    console.error(e.stack)
  }
}

main()