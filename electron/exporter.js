'use strict'
const path = require('path')
const fs = require('fs')
const AdmZip = require('adm-zip')
const sharpPool = require('./modules/sharpPool')
const { sanitizeFilename: sanitize } = require('./utils')

/**
 * CBZ / EPUB 导出器
 *
 * CBZ 格式：zip 打包图片，保持命名顺序
 * CBZ 是基于 Zip 的漫画书格式（Comic Book Archive），
 * 可用任何支持 CBZ 的阅读器打开（YACReader, Kavita, ComicRack, Kindle 等）
 */
function detectImageFormat(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg'
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif'
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp'
  return 'webp'
}

class ArchiveExporter {
  /**
   * 从下载好的漫画目录导出 CBZ
   * @param {object} opts
   * @param {string} opts.sourceDir     - 下载好的漫画目录（含章节子目录）
   * @param {string} opts.outputPath    - 输出 .cbz 文件路径
   * @param {string} opts.title         - 漫画标题
   * @param {Array<{name:string, dir:string}>} opts.chapters - 章节信息（按下载顺序）
   * @param {function} opts.onProgress  - 进度回调
   * @returns {string} 输出路径
   */
  async toCBZ(opts) {
    const { sourceDir, outputPath, title, chapters, onProgress } = opts
    const zip = new AdmZip()
    let fileCount = 0

    // 如果有封面
    const coverPath = path.join(sourceDir, 'cover.webp')
    if (fs.existsSync(coverPath)) {
      zip.addFile('cover.webp', fs.readFileSync(coverPath))
      fileCount++
    }

    // 遍历章节目录
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      const chDir = (ch.dir && path.isAbsolute(ch.dir))
        ? ch.dir
        : path.join(sourceDir, ch.dir || `${i + 1}-${sanitize(ch.name)}`)
      if (!fs.existsSync(chDir)) {
        console.warn(`[CBZ] 章节目录不存在，跳过: ${chDir}`)
        continue
      }

      const files = fs.readdirSync(chDir)
        .filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f))
        .sort()

      for (let j = 0; j < files.length; j++) {
        const filePath = path.join(chDir, files[j])
        // 用 3 位数字前缀 + 章节序号保证全局排序正确
        // 格式: ch${章节序号三维}_${图片序号三维}.webp
        const zipName = `ch${String(i + 1).padStart(3, '0')}_${String(j + 1).padStart(4, '0')}.webp`
        zip.addFile(zipName, fs.readFileSync(filePath))
        fileCount++
      }

      if (onProgress) {
        onProgress({ current: i + 1, total: chapters.length, fileCount })
      }
    }

    // 写文件
    zip.writeZip(outputPath)
    console.log(`[CBZ] 导出完成: ${outputPath} (${fileCount} 张图片, ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB)`)

    // 写元数据
    this._writeComicInfo(outputPath, { title, chapters: chapters.length })

    return outputPath
  }

  /**
   * 从下载好的漫画目录导出 EPUB
   * 支持分卷：每卷包含指定数量的章节
   * 支持图片质量压缩
   * 生成与参考文件完全一致的结构：
   * - mimetype
   * - META-INF/container.xml
   * - EPUB/css/style.css
   * - EPUB/nav.xhtml
   * - EPUB/toc.ncx
   * - EPUB/content.opf
   * - EPUB/images/{章节文件夹名}_{序号}.webp
   * - EPUB/chapters/{章节文件夹名}.xhtml
   * @param {object} opts
   * @param {string} opts.sourceDir     - 下载好的漫画目录
   * @param {string} opts.outputPath    - 输出 .epub 文件路径（分卷时会自动添加 _1, _2 后缀）
   * @param {string} opts.title         - 漫画标题
   * @param {object} [opts.meta]        - 元数据
   * @param {Array}  opts.chapters      - 章节信息
   * @param {function} opts.onProgress  - 进度回调
   * @param {number} [opts.chaptersPerVolume] - 每卷章节数，undefined/null 表示不分卷
   * @param {string} [opts.imageQuality] - 图片质量：'original' | 'high' | 'medium'
   * @returns {string|string[]} 不分卷返回路径，分卷返回路径数组
   */
  async toEPUB(opts) {
    const { sourceDir, outputPath, title, chapters, onProgress, meta, chaptersPerVolume, imageQuality } = opts

    // 不分卷：直接生成单个 EPUB
    if (!chaptersPerVolume || chaptersPerVolume <= 0 || chapters.length <= chaptersPerVolume) {
      return await this._generateSingleEPUB({ sourceDir, outputPath, title, chapters, onProgress, meta })
    }

    // 分卷：按 chaptersPerVolume 拆分章节
    const volumeCount = Math.ceil(chapters.length / chaptersPerVolume)
    const outputPaths = []
    const outputDir = path.dirname(outputPath)
    const outputBaseName = path.basename(outputPath, '.epub')

    for (let vol = 0; vol < volumeCount; vol++) {
      const startIdx = vol * chaptersPerVolume
      const endIdx = Math.min(startIdx + chaptersPerVolume, chapters.length)
      const volumeChapters = chapters.slice(startIdx, endIdx)
      const volumeTitle = volumeCount === 1 ? title : `${title}_${vol + 1}`
      const volumePath = path.join(outputDir, `${outputBaseName}_${vol + 1}.epub`)

      console.log(`[EPUB] 生成第 ${vol + 1}/${volumeCount} 卷，章节 ${startIdx + 1}-${endIdx}`)

      const result = await this._generateSingleEPUB({
        sourceDir,
        outputPath: volumePath,
        title: volumeTitle,
        chapters: volumeChapters,
        onProgress: (p) => {
          if (onProgress) {
            const totalProgress = (vol * chaptersPerVolume + p.current) / chapters.length * 100
            onProgress({ current: p.current, total: p.total, volume: vol + 1, volumeCount, progress: totalProgress })
          }
        },
        meta,
        imageQuality
      })
      outputPaths.push(result)
    }

    console.log(`[EPUB] 分卷完成，共 ${volumeCount} 卷: ${outputPaths.join(', ')}`)
    return outputPaths
  }

  /**
   * 生成单个 EPUB 文件（内部方法）
   */
  async _generateSingleEPUB(opts) {
    const { sourceDir, outputPath, title, chapters, onProgress, meta, imageQuality } = opts
    const zip = new AdmZip()

    // EPUB 必须的文件结构
    zip.addFile('mimetype', Buffer.from('application/epub+zip'))
    zip.addFile('META-INF/container.xml', Buffer.from(this._containerXML()))

    // 收集 manifest 条目
    const manifestItems = []
    // 收集 NCX navPoints
    const navPoints = []

    // ---------- 1. CSS ----------
    zip.addFile('EPUB/css/style.css', Buffer.from(this._cssContent()))
    manifestItems.push({ id: 'css', href: 'css/style.css', mediaType: 'text/css' })

    // ---------- 2. 封面 ----------
    const coverPath = path.join(sourceDir, 'cover.webp')
    let coverAdded = false
    if (fs.existsSync(coverPath)) {
      let coverBuf = fs.readFileSync(coverPath)
      let coverFormat = detectImageFormat(coverBuf)
      if (coverFormat !== 'webp') {
        try {
          coverBuf = await sharpPool.webpConvertToBuffer(coverBuf, { quality: 85 })
          coverFormat = 'webp'
        } catch (e) {
          console.warn('[EPUB] 封面WebP转换失败，保留原格式', e.message)
        }
      }
      const coverMediaType = { 'webp': 'image/webp', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif' }[coverFormat] || 'image/webp'
      zip.addFile('EPUB/images/cover.webp', coverBuf)
      manifestItems.push({ id: 'cover', href: 'images/cover.webp', mediaType: coverMediaType })
      coverAdded = true
    }

    // ---------- 3. 收集所有章节图片 ----------
    const allChapters = []
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i]
      const chDir = ch.dir && path.isAbsolute(ch.dir)
        ? ch.dir
        : path.join(sourceDir, ch.dir || `${ch.index + 1 || i + 1}-${sanitize(ch.name)}`)
      if (!fs.existsSync(chDir)) continue

      const files = fs.readdirSync(chDir)
        .filter(f => /\.(webp|jpg|jpeg|png|gif)$/i.test(f))
        .sort((a, b) => {
          const na = parseInt(a.match(/^(\d+)/)?.[1] || '0', 10)
          const nb = parseInt(b.match(/^(\d+)/)?.[1] || '0', 10)
          return na - nb
        })

      if (files.length === 0) continue

      const chFolderName = ch.dir ? path.basename(ch.dir) : `${ch.index + 1 || i + 1}-${sanitize(ch.name)}`

      const imgNames = []
      for (let j = 0; j < files.length; j++) {
        const srcPath = path.join(chDir, files[j])
        const imgFileName = `${chFolderName}_${String(j + 1).padStart(3, '0')}.webp`

        let imgBuffer = fs.readFileSync(srcPath)
        let actualFormat = detectImageFormat(imgBuffer)

        if (actualFormat !== 'webp') {
          try {
            imgBuffer = await sharpPool.webpConvertToBuffer(imgBuffer, { quality: 85 })
            actualFormat = 'webp'
          } catch (e) {
            console.warn(`[EPUB] 图片WebP转换失败，保留原格式: ${files[j]}`, e.message)
          }
        }

        if (imageQuality && imageQuality !== 'original') {
          try {
            const quality = imageQuality === 'high' ? 80 : 50
            const maxWidth = imageQuality === 'high' ? 1200 : 800
            imgBuffer = await sharpPool.resizeWebpToBuffer(imgBuffer, { maxWidth, quality })
            actualFormat = 'webp'
          } catch (e) {
            console.warn(`[EPUB] 图片压缩失败，使用原图: ${files[j]}`, e.message)
          }
        }

        const mediaType = { 'webp': 'image/webp', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif' }[actualFormat] || 'image/webp'

        zip.addFile(`EPUB/images/${imgFileName}`, imgBuffer)
        manifestItems.push({ id: `img-${i}-${j}`, href: `images/${imgFileName}`, mediaType })
        imgNames.push(imgFileName)
      }

      allChapters.push({ chFolderName, chName: ch.name || chFolderName, imgNames })

      if (onProgress) onProgress({ current: i + 1, total: chapters.length })
    }

    // ---------- 4. 单个 XHTML（所有章节合并，锚点分隔） ----------
    const xhtmlId = 'all-pages'
    zip.addFile('EPUB/chapters/all-pages.xhtml', Buffer.from(this._allPagesXHTML(allChapters)))
    manifestItems.push({ id: xhtmlId, href: 'chapters/all-pages.xhtml', mediaType: 'application/xhtml+xml' })

    for (const ch of allChapters) {
      navPoints.push({
        id: ch.chFolderName,
        label: ch.chFolderName,
        src: `chapters/all-pages.xhtml#${ch.chFolderName}`
      })
    }

    // ---------- 4. nav.xhtml ----------
    manifestItems.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' })
    zip.addFile('EPUB/nav.xhtml', Buffer.from(this._navXHTML(title, navPoints)))

    // ---------- 5. toc.ncx ----------
    manifestItems.push({ id: 'ncx', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' })
    const isbn = `comic_${sanitize(title)}`
    zip.addFile('EPUB/toc.ncx', Buffer.from(this._ncxXML({ title, isbn, navPoints })))

    // ---------- 6. content.opf ----------
    const opfXml = this._opfXML({
      title: meta?.title || title || 'Untitled',
      author: meta?.author || 'Unknown',
      language: meta?.language || 'zh-CN',
      isbn,
      manifestItems,
      navPoints,
      coverAdded
    })
    zip.addFile('EPUB/content.opf', Buffer.from(opfXml))

    // 写入文件
    zip.writeZip(outputPath)
    console.log(`[EPUB] 导出完成: ${outputPath} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB)`)
    return outputPath
  }

  /**
   * 写 CBZ 的 ComicInfo.xml 元数据
   */
  _writeComicInfo(cbzPath, meta) {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Title>${escHtml(meta.title || '')}</Title>
  <PageCount>${meta.fileCount || 0}</PageCount>
</ComicInfo>`
    try {
      const zip = new AdmZip(cbzPath)
      zip.addFile('ComicInfo.xml', Buffer.from(xml))
      zip.writeZip(cbzPath)
    } catch (e) {
      console.warn('[CBZ] 写入 ComicInfo.xml 失败:', e.message)
    }
  }

  _containerXML() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  }

  _cssContent() {
    return `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}
html, body {
    width: 100%;
    line-height: 0;
}
.comic-container {
    width: 100%;
}
.no-images {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    font-size: 18px;
    color: #666;
    text-align: center;
    background-color: #f5f5f5;
}
.comic-img {
    display: block !important;
    width: 100% !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
}
.chapter-nav {
    position: fixed;
    bottom: 20px;
    width: 100%;
    display: flex;
    justify-content: space-between;
    padding: 0 20px;
    z-index: 999;
}
.nav-btn {
    padding: 10px 20px;
    background: #333;
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
}
.nav-btn:disabled {
    background: #999;
    cursor: not-allowed;
}
@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
    .comic-img {
        image-rendering: crisp-edges;
    }
}`
  }

  /**
   * EPUB3 导航文档（nav.xhtml）
   */
  _navXHTML(title, navPoints) {
    const items = navPoints.map(p =>
      `        <li>\n          <a href="${escHtml(p.src)}">${escHtml(p.label)}</a>\n        </li>`
    ).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
  <head>
    <title>${escHtml(title)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="id" role="doc-toc">
      <h2>${escHtml(title)}</h2>
      <ol>
${items}
      </ol>
    </nav>
  </body>
</html>`
  }

  _chapterXHTML(title, imgNames) {
    const imgs = imgNames.map(n =>
      `        <img src="../images/${n}" alt="${escHtml(title)}" class="comic-img"/>`
    ).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN" xml:lang="zh-CN">
  <head>
    <title>${escHtml(title)}</title>
    <link rel="stylesheet" type="text/css" href="../css/style.css"/>
  </head>
  <body>
    <div class="comic-container">
${imgs}
    </div>
  </body>
</html>`
  }

  _allPagesXHTML(allChapters) {
    const sections = allChapters.map(ch => {
      const anchor = `<a id="${escHtml(ch.chFolderName)}"></a>`
      const imgs = ch.imgNames.map(n =>
        `        <img src="../images/${n}" alt="${escHtml(ch.chName)}" class="comic-img"/>`
      ).join('\n')
      return `      ${anchor}\n${imgs}`
    }).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN" xml:lang="zh-CN">
  <head>
    <title>Comic</title>
    <link rel="stylesheet" type="text/css" href="../css/style.css"/>
  </head>
  <body>
    <div class="comic-container">
${sections}
    </div>
  </body>
</html>`
  }

  /**
   * 生成 content.opf
   */
  _opfXML(opts) {
    const { title, author, language, isbn, manifestItems, navPoints, coverAdded } = opts

    const manifestXml = manifestItems.map(item => {
      const props = item.properties ? ` properties="${escHtml(item.properties)}"` : ''
      return `        <item id="${escHtml(item.id)}" href="${escHtml(item.href)}" media-type="${escHtml(item.mediaType)}"${props}/>`
    }).join('\n')

    const xhtmlItems = manifestItems.filter(item => item.mediaType === 'application/xhtml+xml' && item.id !== 'nav')
    const spineXml = xhtmlItems.map(item =>
      `        <itemref idref="${escHtml(item.id)}"/>`
    ).join('\n')

    // metadata
    let metadataXml = `        <dc:identifier id="bookid">${escHtml(isbn)}</dc:identifier>\n`
    metadataXml += `        <dc:title>${escHtml(title)}</dc:title>\n`
    if (author && author !== 'Unknown') {
      metadataXml += `        <dc:creator>${escHtml(author)}</dc:creator>\n`
    }
    metadataXml += `        <dc:language>${escHtml(language || 'zh-CN')}</dc:language>`

    return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadataXml}
    </metadata>
    <manifest>
${manifestXml}
    </manifest>
    <spine toc="ncx">
${spineXml}
    </spine>
</package>`
  }

  /**
   * 生成 toc.ncx
   */
  _ncxXML(opts) {
    const { title, isbn, navPoints } = opts
    const navPointsXml = navPoints.map(p =>
      `        <navPoint id="${escHtml(p.id)}">\n            <navLabel>\n                <text>${escHtml(p.label)}</text>\n            </navLabel>\n            <content src="${escHtml(p.src)}"/>\n        </navPoint>`
    ).join('\n')

    return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
        <meta content="${escHtml(isbn)}" name="dtb:uid"/>
        <meta content="0" name="dtb:depth"/>
        <meta content="0" name="dtb:totalPageCount"/>
        <meta content="0" name="dtb:maxPageNumber"/>
    </head>
    <docTitle>
        <text>${escHtml(title)}</text>
    </docTitle>
    <navMap>
${navPointsXml}
    </navMap>
</ncx>`
  }
}

function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

module.exports = new ArchiveExporter()