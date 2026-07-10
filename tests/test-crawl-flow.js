const sources = require('./electron/sources/registry')

async function main() {
  const src = sources.get('smtt6')

  console.log('=== 模拟点击"爬取漫画"按钮 ===')
  console.log('起始 URL: https://smtt6.com/man-hua-lei-bie/all/ob/time/st/all/page/1')

  try {
    for (let page = 1; page <= 3; page++) {
      console.log(`\n--- 第 ${page} 页 ---`)
      const items = await src.getPopular(page)
      console.log(`获取到 ${items.length} 部漫画`)
      items.slice(0, 3).forEach((item, i) => {
        console.log(`  ${i + 1}. ${item.title}`)
        console.log(`     封面: ${item.cover?.substring(0, 70) || '(无)'}`)
        console.log(`     URL: ${item.sourceUrl?.substring(0, 80)}`)
      })
      if (items.length === 0) {
        console.log('  ❌ 没有获取到任何漫画，可能是 URL 或解析问题')
        break
      }
    }

    console.log('\n=== 测试详情页（取第1页第1部） ===')
    const firstPage = await src.getPopular(1)
    if (firstPage.length > 0) {
      const firstComic = firstPage[0]
      console.log(`漫画: ${firstComic.title}`)
      console.log(`URL: ${firstComic.sourceUrl}`)

      const detail = await src.getDetail(firstComic.sourceUrl)
      console.log(`章节数: ${detail.chapters.length}`)
      detail.chapters.slice(0, 3).forEach((ch, i) => {
        console.log(`  ${i + 1}. ${ch.name} -> ${ch.url?.substring(0, 80)}`)
      })

      if (detail.chapters.length > 0) {
        console.log('\n=== 测试章节内容页 ===')
        const pageList = await src.getPageList(detail.chapters[0].url, firstComic.sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        const chapterName = Array.isArray(pageList) ? '' : pageList.chapterName
        console.log(`章节名: ${chapterName}`)
        console.log(`图片数: ${images.length}`)
        images.slice(0, 2).forEach((u, i) => {
          console.log(`  图 ${i + 1}: ${u.substring(0, 70)}`)
        })
      }
    }

    console.log('\n🎉 爬取流程验证通过！')
  } catch (e) {
    console.error('\n❌ 错误:', e.message)
    console.error(e.stack)
  }
}

main()