'use strict'
// sharp worker 线程入口 — 在 worker_threads 中执行图片处理，避免阻塞主线程
const { parentPort } = require('worker_threads')
const sharp = require('sharp')

/**
 * 消息处理
 * @param {{id: string, type: string, buffer?: ArrayBuffer, filePath?: string, outPath?: string, options?: Object}} msg
 */
parentPort.on('message', async (msg) => {
  const { id, type } = msg
  try {
    let result
    switch (type) {
      case 'webpConvert': {
        // buffer → webp 文件
        const buf = Buffer.from(msg.buffer)
        await sharp(buf).webp(msg.options || { quality: 85 }).toFile(msg.outPath)
        result = { success: true }
        break
      }
      case 'webpConvertToBuffer': {
        // buffer → webp buffer（用于 exporter）
        const buf = Buffer.from(msg.buffer)
        const output = await sharp(buf).webp(msg.options || { quality: 85 }).toBuffer()
        // 转回 ArrayBuffer 以便可转移传递
        result = { success: true, buffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) }
        break
      }
      case 'metadata': {
        // 文件路径 → metadata（用于验证图片是否损坏）
        const meta = await sharp(msg.filePath).metadata()
        result = { success: true, metadata: { width: meta.width, height: meta.height, format: meta.format } }
        break
      }
      case 'resizeWebpToBuffer': {
        // buffer → resize → webp buffer（用于 exporter）
        const buf = Buffer.from(msg.buffer)
        const { maxWidth, quality } = msg.options || {}
        const output = await sharp(buf)
          .resize(maxWidth || 1200, null, { withoutEnlargement: true })
          .webp({ quality: quality || 80 })
          .toBuffer()
        result = { success: true, buffer: output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) }
        break
      }
      default:
        result = { success: false, error: `未知任务类型: ${type}` }
    }
    parentPort.postMessage({ id, ...result })
  } catch (e) {
    parentPort.postMessage({ id, success: false, error: e.message })
  }
})
