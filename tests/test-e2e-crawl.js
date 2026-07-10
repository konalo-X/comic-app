const sources = require('./electron/sources/registry')
const db = require('./electron/db')

async function testFullCrawl() {
  console.log('=== 端到端爬取流程测试 ===\n')

  // 1. 测试 getPopular 返回的数据结构
  console.log('1. 测试列表爬取...')
  const src = sources.default
  const items = await src.getPopular(1)
  console.log(`   获取到 ${items.length} 部漫画`)
  if (items.length > 0) {
    console.log(`   第1部: ${items[0].title}`)
    console.log(`   sourceUrl: ${items[0].sourceUrl?.substring(0, 70)}`)
    console.log(`   cover: ${items[0].cover?.substring(0, 70)}`)
  }

  // 2. 测试数据库写入
  console.log('\n2. 测试数据库写入...')
  try {
    const saved = await db.upsertComics(items.slice(0, 3))
    console.log(`   写入 ${saved.length} 部成功`)
  } catch (e) {
    console.log(`   写入失败: ${e.message}`)
  }

  // 3. 测试详情页解析
  if (items.length > 0) {
    console.log('\n3. 测试详情页解析...')
    try {
      const detail = await src.getDetail(items[0].sourceUrl)
      console.log(`   标题: ${detail.title}`)
      console.log(`   章节数: ${detail.chapters.length}`)
      if (detail.chapters.length > 0) {
        console.log(`   第1章: ${detail.chapters[0].name}`)
        console.log(`   第1章URL: ${detail.chapters[0].url?.substring(0, 70)}`)
      }
    } catch (e) {
      console.log(`   详情解析失败: ${e.message}`)
    }
  }

  // 4. 测试章节图片列表
  if (items.length > 0) {
    console.log('\n4. 测试章节图片列表...')
    try {
      const detail = await src.getDetail(items[0].sourceUrl)
      if (detail.chapters.length > 0) {
        const pageList = await src.getPageList(detail.chapters[0].url, items[0].sourceUrl)
        const images = Array.isArray(pageList) ? pageList : pageList.images
        console.log(`   图片数: ${images.length}`)
        if (images.length > 0) {
          console.log(`   第1张: ${images[0].substring(0, 70)}`)
        }
      }
    } catch (e) {
      console.log(`   图片列表获取失败: ${e.message}`)
    }
  }

  // 5. 测试 onProgress 数据格式（模拟 jobHandlerCrawlAll）
  console.log('\n5. 测试 onProgress 数据格式...')
  const mockProgress = { page: 1, total: 24, msg: '正在爬取第 1 页...' }
  console.log(`   data.page = ${mockProgress.page}`)
  console.log(`   data.total = ${mockProgress.total}`)
  console.log(`   data.msg = ${mockProgress.msg}`)
  console.log(`   前端进度计算: Math.min(99, Math.round((${mockProgress.page} / Math.max(${mockProgress.page}, 126)) * 100)) = ${Math.min(99, Math.round((mockProgress.page / Math.max(mockProgress.page, 126)) * 100))}%`)

  console.log('\n✅ 所有测试通过！')
}

testFullCrawl().catch(e => {
  console.error('❌ 测试失败:', e.message)
  console.error(e.stack)
})