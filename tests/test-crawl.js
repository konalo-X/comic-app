const sources = require('./electron/sources/registry')

async function main() {
  const src = sources.get('smtt6')
  console.log('=== 测试搜索 ===')
  const searchResults = await src.search('可爱的她', 1)
  console.log('搜索结果数:', searchResults?.results?.length || 0)
  if (searchResults?.results?.[0]) {
    const comic = searchResults.results[0]
    console.log('第一个漫画:', comic.title, comic.url)

    console.log('\n=== 测试详情页 ===')
    const detail = await src.getDetail(comic.url)
    console.log('标题:', detail.title)
    console.log('章节数:', detail.chapters.length)
    if (detail.chapters.length > 0) {
      console.log('第一章:', detail.chapters[0].name, detail.chapters[0].url)

      console.log('\n=== 测试图片列表 ===')
      const pageList = await src.getPageList(detail.chapters[0].url, comic.url)
      const images = Array.isArray(pageList) ? pageList : pageList.images
      const chapterName = Array.isArray(pageList) ? '' : pageList.chapterName
      console.log('图片数:', images.length)
      console.log('章节名(从内容页h2):', chapterName)
      console.log('前3张图片:')
      images.slice(0, 3).forEach((u, i) => console.log('  ', i + 1, u))

      console.log('\n=== 测试sanitize ===')
      const sanitize = n => n
        .replace(/[<>"/\\|*\x00-\x1F]/g, '_')
        .replace(/:/g, '：')
        .replace(/!/g, '！')
        .replace(/\?/g, '？')
        .trim()
      const folder = sanitize(`${1}-${chapterName || detail.chapters[0].name}`)
      console.log('章节目录名:', folder)
      console.log('漫画目录名:', sanitize(detail.title))
    }
  }
}

main().then(() => console.log('\n✅ 测试完成')).catch(e => console.error('❌ 错误:', e.message, e.stack))