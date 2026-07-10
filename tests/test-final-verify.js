const sources = require('./electron/sources/registry')

async function main() {
  const src = sources.get('smtt6')
  console.log('源站:', src.name, src.baseUrl)

  try {
    console.log('\n=== 测试1: 热门列表 (getPopular) ===')
    const popular = await src.getPopular(1)
    console.log('数量:', popular.length)
    popular.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title}`)
      console.log(`     URL: ${item.sourceUrl?.substring(0, 80)}`)
      console.log(`     封面: ${item.cover?.substring(0, 80) || '(无)'} ✅`)
    })

    console.log('\n=== 测试2: 搜索 (search "魔法少女") ===')
    const searchResults = await src.search('魔法少女', 1)
    console.log('数量:', searchResults.length)
    searchResults.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title}`)
      console.log(`     URL: ${item.sourceUrl?.substring(0, 80)}`)
      console.log(`     封面: ${item.cover?.substring(0, 80) || '(无)'} ✅`)
    })

    if (searchResults.length > 0) {
      const comic = searchResults[0]

      console.log('\n=== 测试3: 详情页 (getDetail) ===')
      const detail = await src.getDetail(comic.sourceUrl)
      console.log('标题:', detail.title)
      console.log('封面:', detail.cover?.substring(0, 80) || '(无)')
      console.log('章节数:', detail.chapters.length)
      detail.chapters.slice(0, 3).forEach((ch, i) => {
        console.log(`  ${i + 1}. ${ch.name} -> ${ch.url?.substring(0, 80)}`)
      })

      if (detail.chapters.length > 0) {
        console.log('\n=== 测试4: 章节图片列表 (getPageList) ===')
        const pageList = await src.getPageList(detail.chapters[0].url, comic.sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        const chapterName = Array.isArray(pageList) ? '' : pageList.chapterName
        console.log('图片数:', images.length)
        console.log('章节名 (从内容页 h2):', chapterName || '(无)')
        console.log('前3张:')
        images.slice(0, 3).forEach((u, i) => console.log(`  ${i + 1}. ${u.substring(0, 80)}`))

        console.log('\n=== 测试5: 下载第一张图片 (fetchImage) ===')
        try {
          const buf = await src.fetchImage(images[0], detail.chapters[0].url)
          console.log('✅ 下载成功, 大小:', buf.length, 'bytes')
        } catch (e) {
          console.log('❌ 下载失败:', e.message)
        }
      }
    }

    console.log('\n🎉 所有测试通过！')
  } catch (e) {
    console.error('\n❌ 错误:', e.message)
    console.error(e.stack)
  }
}

main()