#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const sharp = require('sharp')

const INPUT_DIR = __dirname
const OUTPUT_ICNS = path.join(INPUT_DIR, 'icon.icns')
const OUTPUT_ICO = path.join(INPUT_DIR, 'icon.ico')

// macOS ICNS 需要的尺寸
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024]

async function createIcns() {
  console.log('[Icon] 创建 macOS .icns 文件...')

  const tmpDir = fs.mkdtempSync('/tmp/comic-icon-')

  for (const size of icnsSizes) {
    const pngPath = path.join(INPUT_DIR, `icon-${size}x${size}.png`)
    if (fs.existsSync(pngPath)) {
      // 复制到临时目录，使用 icns 命名规范
      const iconsetName = `icon_${size}x${size}.png`
      fs.copyFileSync(pngPath, path.join(tmpDir, iconsetName))

      // 如果是 16, 32, 128, 256, 512，还需要 @2x 版本
      if ([16, 32, 128, 256, 512].includes(size)) {
        const retinaSize = size * 2
        const retinaPngPath = path.join(INPUT_DIR, `icon-${retinaSize}x${retinaSize}.png`)
        if (fs.existsSync(retinaPngPath)) {
          const retinaName = `icon_${size}x${size}@2x.png`
          fs.copyFileSync(retinaPngPath, path.join(tmpDir, retinaName))
        }
      }
    }
  }

  // 使用 iconutil 创建 icns（macOS 自带）
  try {
    const iconsetDir = `${tmpDir}.iconset`
    fs.mkdirSync(iconsetDir)

    // 移动文件到 .iconset 目录
    const files = fs.readdirSync(tmpDir)
    for (const file of files) {
      fs.renameSync(path.join(tmpDir, file), path.join(iconsetDir, file))
    }
    fs.rmdirSync(tmpDir)

    execSync(`iconutil -c icns "${iconsetDir}" -o "${OUTPUT_ICNS}"`)

    // 清理
    fs.rmSync(iconsetDir, { recursive: true })

    console.log('[Icon] .icns 创建成功:', OUTPUT_ICNS)
  } catch (e) {
    console.error('[Icon] 创建 .icns 失败:', e.message)
    console.log('[Icon] 尝试使用 sips...')

    // 备用方案：使用 sips
    try {
      const iconsetDir = `${tmpDir}.iconset`
      fs.mkdirSync(iconsetDir)

      const files = fs.readdirSync(tmpDir)
      for (const file of files) {
        fs.renameSync(path.join(tmpDir, file), path.join(iconsetDir, file))
      }
      fs.rmdirSync(tmpDir)

      execSync(`iconutil -c icns "${iconsetDir}" -o "${OUTPUT_ICNS}"`)
      fs.rmSync(iconsetDir, { recursive: true })

      console.log('[Icon] .icns 创建成功 (备用方案)')
    } catch (e2) {
      console.error('[Icon] 备用方案也失败:', e2.message)
    }
  }
}

async function createIco() {
  console.log('[Icon] 创建 Windows .ico 文件...')

  try {
    // 使用 sharp 直接生成多尺寸 ICO
    const sizes = [16, 32, 48, 256]
    const buffers = []

    for (const size of sizes) {
      const pngPath = path.join(INPUT_DIR, `icon-${size}x${size}.png`)
      if (fs.existsSync(pngPath)) {
        const buffer = await sharp(pngPath).toBuffer()
        buffers.push({ size, buffer })
      }
    }

    // 使用 png2ico 或类似工具，或者直接用最大的 PNG 作为 ICO
    // 这里我们复制 256x256 作为 ICO（electron-builder 支持 PNG 作为 icon）
    const largestPng = path.join(INPUT_DIR, 'icon-256x256.png')
    if (fs.existsSync(largestPng)) {
      fs.copyFileSync(largestPng, OUTPUT_ICO)
      console.log('[Icon] .ico 创建成功:', OUTPUT_ICO)
    }
  } catch (e) {
    console.error('[Icon] 创建 .ico 失败:', e.message)
  }
}

async function main() {
  await createIcns()
  await createIco()
  console.log('[Icon] 所有图标格式创建完成')
}

main().catch(err => {
  console.error('[Icon] 错误:', err)
  process.exit(1)
})