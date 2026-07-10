#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')

// 使用 sharp 生成图标
async function generateIcon() {
  try {
    const sharp = require('sharp')
    
    const size = 1024
    const padding = size * 0.15
    const innerSize = size - padding * 2
    
    // 创建渐变背景
    const gradientSvg = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#8B5CF6;stop-opacity:1" />
            <stop offset="50%" style="stop-color:#7C3AED;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#6D28D9;stop-opacity:1" />
          </linearGradient>
          <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000" flood-opacity="0.3"/>
          </filter>
        </defs>
        
        <!-- 背景圆角矩形 -->
        <rect x="0" y="0" width="${size}" height="${size}" rx="${size * 0.22}" ry="${size * 0.22}" fill="url(#grad)"/>
        
        <!-- 内发光效果 -->
        <rect x="4" y="4" width="${size-8}" height="${size-8}" rx="${size * 0.22 - 4}" ry="${size * 0.22 - 4}" 
              fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2"/>
        
        <!-- 书本/漫画图标 -->
        <g transform="translate(${padding}, ${padding})" filter="url(#shadow)">
          <!-- 书本主体 -->
          <rect x="${innerSize * 0.1}" y="${innerSize * 0.05}" 
                width="${innerSize * 0.8}" height="${innerSize * 0.9}" 
                rx="${innerSize * 0.05}" ry="${innerSize * 0.05}" 
                fill="rgba(255,255,255,0.95)"/>
          
          <!-- 书脊 -->
          <rect x="${innerSize * 0.1}" y="${innerSize * 0.05}" 
                width="${innerSize * 0.15}" height="${innerSize * 0.9}" 
                rx="${innerSize * 0.03}" ry="${innerSize * 0.03}" 
                fill="rgba(139,92,246,0.15)"/>
          
          <!-- 漫画格子 1 -->
          <rect x="${innerSize * 0.3}" y="${innerSize * 0.15}" 
                width="${innerSize * 0.25}" height="${innerSize * 0.2}" 
                rx="${innerSize * 0.02}" fill="#F3E8FF"/>
          
          <!-- 漫画格子 2 -->
          <rect x="${innerSize * 0.6}" y="${innerSize * 0.15}" 
                width="${innerSize * 0.22}" height="${innerSize * 0.2}" 
                rx="${innerSize * 0.02}" fill="#F3E8FF"/>
          
          <!-- 漫画格子 3 (大格子) -->
          <rect x="${innerSize * 0.3}" y="${innerSize * 0.42}" 
                width="${innerSize * 0.52}" height="${innerSize * 0.35}" 
                rx="${innerSize * 0.02}" fill="#F3E8FF"/>
          
          <!-- 对话框 -->
          <ellipse cx="${innerSize * 0.45}" cy="${innerSize * 0.55}" 
                   rx="${innerSize * 0.12}" ry="${innerSize * 0.08}" 
                   fill="white" stroke="#8B5CF6" stroke-width="2"/>
          <polygon points="${innerSize * 0.4},${innerSize * 0.62} ${innerSize * 0.45},${innerSize * 0.6} ${innerSize * 0.42},${innerSize * 0.65}" 
                   fill="white" stroke="#8B5CF6" stroke-width="2"/>
          <line x1="${innerSize * 0.38}" y1="${innerSize * 0.53}" 
                x2="${innerSize * 0.52}" y2="${innerSize * 0.53}" 
                stroke="#8B5CF6" stroke-width="2" stroke-linecap="round"/>
          <line x1="${innerSize * 0.38}" y1="${innerSize * 0.58}" 
                x2="${innerSize * 0.48}" y2="${innerSize * 0.58}" 
                stroke="#8B5CF6" stroke-width="2" stroke-linecap="round"/>
          
          <!-- 小星星装饰 -->
          <text x="${innerSize * 0.7}" y="${innerSize * 0.75}" 
                font-size="${innerSize * 0.08}" fill="#8B5CF6">✦</text>
        </g>
        
        <!-- 底部装饰线 -->
        <rect x="${size * 0.25}" y="${size * 0.88}" 
              width="${size * 0.5}" height="${size * 0.015}" 
              rx="${size * 0.0075}" fill="rgba(255,255,255,0.3)"/>
      </svg>
    `
    
    // 生成各种尺寸的图标
    const sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    const iconDir = path.join(__dirname, '..', 'build', 'icons')
    
    if (!fs.existsSync(iconDir)) {
      fs.mkdirSync(iconDir, { recursive: true })
    }
    
    // 生成 PNG 图标
    for (const s of sizes) {
      await sharp(Buffer.from(gradientSvg))
        .resize(s, s)
        .png()
        .toFile(path.join(iconDir, `icon-${s}x${s}.png`))
      console.log(`✓ Generated ${s}x${s}.png`)
    }
    
    // 生成 ICO (Windows)
    await sharp(Buffer.from(gradientSvg))
      .resize(256, 256)
      .toFile(path.join(iconDir, 'icon.ico'))
    console.log('✓ Generated icon.ico')
    
    // 生成 ICNS (macOS) - 使用 1024 版本
    await sharp(Buffer.from(gradientSvg))
      .resize(1024, 1024)
      .toFile(path.join(iconDir, 'icon.icns'))
    console.log('✓ Generated icon.icns')
    
    // 生成主图标文件
    await sharp(Buffer.from(gradientSvg))
      .resize(512, 512)
      .toFile(path.join(__dirname, '..', 'icon.png'))
    console.log('✓ Generated icon.png (512x512)')
    
    console.log('\n🎉 All icons generated successfully!')
    console.log(`📁 Output directory: ${iconDir}`)
    
  } catch (e) {
    console.error('Error generating icon:', e.message)
    console.log('\nFalling back to SVG-only generation...')
    generateSVGOnly()
  }
}

// 纯 SVG 生成（无需 sharp）
function generateSVGOnly() {
  const size = 1024
  const padding = size * 0.15
  const innerSize = size - padding * 2
  
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#8B5CF6;stop-opacity:1" />
      <stop offset="50%" style="stop-color:#7C3AED;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#6D28D9;stop-opacity:1" />
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>
  
  <rect x="0" y="0" width="${size}" height="${size}" rx="${size * 0.22}" ry="${size * 0.22}" fill="url(#grad)"/>
  
  <rect x="4" y="4" width="${size-8}" height="${size-8}" rx="${size * 0.22 - 4}" ry="${size * 0.22 - 4}" 
        fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2"/>
  
  <g transform="translate(${padding}, ${padding})" filter="url(#shadow)">
    <rect x="${innerSize * 0.1}" y="${innerSize * 0.05}" 
          width="${innerSize * 0.8}" height="${innerSize * 0.9}" 
          rx="${innerSize * 0.05}" ry="${innerSize * 0.05}" 
          fill="rgba(255,255,255,0.95)"/>
    
    <rect x="${innerSize * 0.1}" y="${innerSize * 0.05}" 
          width="${innerSize * 0.15}" height="${innerSize * 0.9}" 
          rx="${innerSize * 0.03}" ry="${innerSize * 0.03}" 
          fill="rgba(139,92,246,0.15)"/>
    
    <rect x="${innerSize * 0.3}" y="${innerSize * 0.15}" 
          width="${innerSize * 0.25}" height="${innerSize * 0.2}" 
          rx="${innerSize * 0.02}" fill="#F3E8FF"/>
    
    <rect x="${innerSize * 0.6}" y="${innerSize * 0.15}" 
          width="${innerSize * 0.22}" height="${innerSize * 0.2}" 
          rx="${innerSize * 0.02}" fill="#F3E8FF"/>
    
    <rect x="${innerSize * 0.3}" y="${innerSize * 0.42}" 
          width="${innerSize * 0.52}" height="${innerSize * 0.35}" 
          rx="${innerSize * 0.02}" fill="#F3E8FF"/>
    
    <ellipse cx="${innerSize * 0.45}" cy="${innerSize * 0.55}" 
             rx="${innerSize * 0.12}" ry="${innerSize * 0.08}" 
             fill="white" stroke="#8B5CF6" stroke-width="2"/>
    <polygon points="${innerSize * 0.4},${innerSize * 0.62} ${innerSize * 0.45},${innerSize * 0.6} ${innerSize * 0.42},${innerSize * 0.65}" 
             fill="white" stroke="#8B5CF6" stroke-width="2"/>
    <line x1="${innerSize * 0.38}" y1="${innerSize * 0.53}" 
          x2="${innerSize * 0.52}" y2="${innerSize * 0.53}" 
          stroke="#8B5CF6" stroke-width="2" stroke-linecap="round"/>
    <line x1="${innerSize * 0.38}" y1="${innerSize * 0.58}" 
          x2="${innerSize * 0.48}" y2="${innerSize * 0.58}" 
          stroke="#8B5CF6" stroke-width="2" stroke-linecap="round"/>
    
    <text x="${innerSize * 0.7}" y="${innerSize * 0.75}" 
          font-size="${innerSize * 0.08}" fill="#8B5CF6">✦</text>
  </g>
  
  <rect x="${size * 0.25}" y="${size * 0.88}" 
        width="${size * 0.5}" height="${size * 0.015}" 
        rx="${size * 0.0075}" fill="rgba(255,255,255,0.3)"/>
</svg>`

  const iconDir = path.join(__dirname, '..', 'build', 'icons')
  if (!fs.existsSync(iconDir)) {
    fs.mkdirSync(iconDir, { recursive: true })
  }
  
  fs.writeFileSync(path.join(iconDir, 'icon.svg'), svg)
  fs.writeFileSync(path.join(__dirname, '..', 'icon.svg'), svg)
  
  console.log('✓ Generated icon.svg')
  console.log('\n📁 SVG icon saved. Install sharp for PNG/ICO generation:')
  console.log('   npm install sharp')
}

// 运行生成
generateIcon().catch(() => generateSVGOnly())