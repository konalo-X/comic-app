/**
 * 自动扫描本地漫画目录并加入书架
 * 
 * 功能：
 * 1. 扫描配置的下载目录
 * 2. 将所有本地漫画注册到数据库
 * 3. 自动标记为收藏（favorited=1）
 * 4. 确保显示在书架页面
 * 
 * 使用方法：
 * node auto_scan_and_add_to_bookshelf_v2.js
 */

const path = require('path')
const fs = require('fs')

// 引入数据库模块
const db = require('./electron/db')

// 配置：本地漫画目录（根据实际配置修改）
const LOCAL_COMIC_DIRS = [
  '/Volumes/可移动磁盘/ComicDownloads',
  path.join(process.env.HOME, 'Projects', 'comic-app', 'downloads'),
  // 添加更多目录...
]

// 初始化数据库
async function init() {
  db.initDB()
  console.log('✅ 数据库初始化完成')
}

// 扫描单个目录
async function scanDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    console.log(`⚠️  目录不存在: ${dirPath}`)
    return []
  }

  console.log(`📂 扫描目录: ${dirPath}`)
  
  const comics = await db.scanLocalComics(dirPath)
  console.log(`   找到 ${comics.length} 本漫画`)
  
  return comics
}

// 导入漫画到书架
async function importComicsToBookshelf(comics, targetDir) {
  let successCount = 0
  let skipCount = 0
  let errorCount = 0

  console.log(`\n📥 开始导入 ${comics.length} 本漫画到书架...`)
  
  for (const comic of comics) {
    try {
      // 检查是否已经在数据库中
      const existing = await db.getComicByUrl(null, comic.title)
      
      if (existing) {
        console.log(`   ⏭️  已存在: ${comic.title}`)
        skipCount++
        
        // 更新为收藏状态
        if (!existing.favorited) {
          await db.setFavorite(existing._id || existing.id, true)
          console.log(`   ✅ 已标记为收藏: ${comic.title}`)
        }
      } else {
        // 导入新漫画
        const result = await db.importLocalComic(comic, targetDir, null)
        
        if (result.success) {
          successCount++
          console.log(`   ✅ 导入成功: ${comic.title}`)
        } else {
          errorCount++
          console.log(`   ❌ 导入失败: ${comic.title} - ${result.error}`)
        }
      }
    } catch (err) {
      errorCount++
      console.error(`   ❌ 处理失败: ${comic.title}`, err.message)
    }
  }
  
  console.log(`\n📊 导入完成:`)
  console.log(`   成功: ${successCount}`)
  console.log(`   跳过: ${skipCount}`)
  console.log(`   失败: ${errorCount}`)
}

// 主函数
async function main() {
  try {
    await init()
    
    // 扫描所有配置的目录
    let allComics = []
    
    for (const dir of LOCAL_COMIC_DIRS) {
      const comics = await scanDirectory(dir)
      allComics = allComics.concat(comics)
    }
    
    if (allComics.length === 0) {
      console.log('\n⚠️  没有找到本地漫画')
      console.log('请检查 LOCAL_COMIC_DIRS 配置是否正确')
      return
    }
    
    // 去重（根据标题）
    const uniqueComics = []
    const seenTitles = new Set()
    
    for (const comic of allComics) {
      if (!seenTitles.has(comic.title)) {
        seenTitles.add(comic.title)
        uniqueComics.push(comic)
      }
    }
    
    console.log(`\n📊 去重后: ${uniqueComics.length} 本漫画`)
    
    // 选择目标目录（用于导入）
    const targetDir = LOCAL_COMIC_DIRS[0]  // 使用第一个目录作为目标
    
    // 导入到书架
    await importComicsToBookshelf(uniqueComics, targetDir)
    
    console.log('\n🎉 所有漫画已自动加入书架！')
    console.log('现在打开 app，切换到"书架"页面，应该能看到所有本地漫画')
    
  } catch (err) {
    console.error('❌ 发生错误:', err)
  }
}

// 执行
main()