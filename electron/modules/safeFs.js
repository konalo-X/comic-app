// safeFs.js — 防 uv_cancel abort 的 fs.promises 包装
//
// 背景: fs.promises.* (readdir/stat/readFile/access/writeFile/unlink/mkdir/rename)
// 走 libuv 线程池。当请求还在线程池里跑、但 JS 端已不再持有该 Promise 引用
// (任务被取消/抢占、handler 提前 return、并发 fan-out 后丢弃), V8 垃圾回收会
// 对其调用 uv_cancel 撤消在途请求。libuv 在请求已提交线程池后 uv_cancel 返回
// 非 0 时会直接 abort() 整个进程 -> 表现为 SIGABRT + "uv_cancel" 栈。
//
// 修复: 把所有在途 fs.promises 注册进模块级 Set, 直到 settle 才移除。
// 这样 GC 永远碰不到在途请求, uv_cancel 永不触发, 进程不崩。
// (与 sharpPool 用 worker_threads 规避 libuv 线程池是同一思路)

const fs = require('fs')

const _pending = new Set()

function _guard(promise) {
  _pending.add(promise)
  // 无论成功失败, settle 后移除引用, 让 GC 正常回收(此时已无在途请求)
  promise.then(() => _pending.delete(promise), () => _pending.delete(promise))
  return promise
}

// 暴露与原生 fs.promises 同名的方法, 调用方只需把 fs.promises.xxx 改成 safeFs.xxx
const safeFs = {
  access: (...a) => _guard(fs.promises.access(...a)),
  readdir: (...a) => _guard(fs.promises.readdir(...a)),
  stat: (...a) => _guard(fs.promises.stat(...a)),
  lstat: (...a) => _guard(fs.promises.lstat(...a)),
  readFile: (...a) => _guard(fs.promises.readFile(...a)),
  writeFile: (...a) => _guard(fs.promises.writeFile(...a)),
  unlink: (...a) => _guard(fs.promises.unlink(...a)),
  mkdir: (...a) => _guard(fs.promises.mkdir(...a)),
  rename: (...a) => _guard(fs.promises.rename(...a)),
  // 调试用: 当前在途请求数(应长期接近 0, 仅在大量并发扫描时短暂升高)
  pendingCount: () => _pending.size,
}

module.exports = safeFs
