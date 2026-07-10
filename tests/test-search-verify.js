const sources = require('./electron/sources/registry')

async function main() {
  const src = sources.get('smtt6')

  console.log('=== 测试搜索空字符串 ===')
  try {
    const items = await src.search('', 1)
    console.log(`结果数: ${items.length}`)
    items.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title}`)
    })
  } catch (e) {
    console.log('❌ 搜索空字符串失败:', e.message)
  }

  console.log('\n=== 测试搜索有效关键词 ===')
  try {
    const items = await src.search('魔法少女', 1)
    console.log(`结果数: ${items.length}`)
    items.slice(0, 3).forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.title}`)
    })
  } catch (e) {
    console.log('❌ 搜索失败:', e.message)
  }
}

main()