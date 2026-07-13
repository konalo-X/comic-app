#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const SVG_PATH = path.join(__dirname, '..', '..', 'build', 'icons', 'designs', 'design-6-glass-light.svg')
const OUTPUT_DIR = __dirname

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024]

async function convertSvgToPng() {
  console.log('[Icon] 开始转换 SVG 图标...')

  const svgBuffer = fs.readFileSync(SVG_PATH)

  for (const size of sizes) {
    const outputPath = path.join(OUTPUT_DIR, `icon-${size}x${size}.png`)
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath)
    console.log(`[Icon] 生成 ${size}x${size}.png`)
  }

  // 生成主 icon.png
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(OUTPUT_DIR, 'icon.png'))
  console.log('[Icon] 生成 icon.png (512x512)')

  console.log('[Icon] PNG 转换完成')
}

convertSvgToPng().catch(err => {
  console.error('[Icon] 转换失败:', err)
  process.exit(1)
})