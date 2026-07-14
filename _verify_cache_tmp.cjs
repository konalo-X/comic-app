const Module = require('module')
const origRequire = Module.prototype.require
Module.prototype.require = function(p) {
  if (p === 'electron') return { app: { getPath: () => '/tmp' } }
  if (p === '../db') return { prepare: () => ({ all: () => [] }) }
  return origRequire.apply(this, arguments)
}
const path = require('path'), fs = require('fs')
const { getValidChapterImagesCached } = require('./electron/modules/downloadPaths.js')
async function main() {
  const comicDir = '/Volumes/可移动磁盘/ComicDownloads/逢九'
  let ch1 = null
  for (const d of fs.readdirSync(comicDir)) {
    const fp = path.join(comicDir, d)
    if (fs.statSync(fp).isDirectory()) {
      const m = d.match(/^(\d+)-/)
      if (m && parseInt(m[1],10) === 1) { ch1 = fp; break }
    }
  }
  const diskFiles = fs.readdirSync(ch1).filter(f=>/\.(webp|jpg|jpeg|png|gif|avif|bmp)$/i.test(f)).length
  console.log('第1话目录:', ch1, '| 磁盘文件数:', diskFiles, '(已知源站应有 114, 删了2张→应112)')
  console.log('\n--- 第一轮: 无缓存, 真 sharp 每张(含缺图) ---')
  let t0 = Date.now()
  let r1 = await getValidChapterImagesCached(ch1)
  console.log(`valid=${r1.validFiles.length} allVerified=${r1.allVerified} 耗时${Date.now()-t0}ms`)
  console.log('缓存文件生成:', fs.existsSync(path.join(ch1,'.sharp_cache.json')))
  console.log('\n--- 第二轮: 文件未变, 应全部命中缓存跳过 sharp ---')
  t0 = Date.now()
  let r2 = await getValidChapterImagesCached(ch1)
  console.log(`valid=${r2.validFiles.length} allVerified=${r2.allVerified} 耗时${Date.now()-t0}ms`)
  const expected = 114
  console.log(`\n逢九第1话: valid=${r1.validFiles.length} expected=${expected} isComplete=${expected>0 && r1.validFiles.length===expected && r1.allVerified}`)
  console.log(`(预期 isComplete=false: 112<114 缺图, 应进下载补齐)`)
  // 清理测试缓存文件, 避免污染真实磁盘
  try { fs.unlinkSync(path.join(ch1,'.sharp_cache.json')) } catch {}
}
main().catch(e => { console.error(e); process.exit(1) })
