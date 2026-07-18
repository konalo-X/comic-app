# comic-app 打包成 DMG（2026-07-14 21:44）

## 目标
把 comic-app 打包成可安装的 macOS app。

## 关键前置修复
electron-builder 的 `build` 配置里 `asarUnpack` 原来只解包了 sharp/@img，**漏了 better-sqlite3**。better-sqlite3 是原生模块（.node），打进 asar 后无法 dlopen → app 启动即崩（数据库加载失败）。

修复：`package.json` build.asarUnpack 补充：
- `node_modules/better-sqlite3/**/*`
- `node_modules/bindings/**/*`（better-sqlite3 依赖）
- `node_modules/file-uri-to-path/**/*`

## 打包过程
- 命令：`npm run build`（= `vite build && electron-builder`）
- vite build ✅ 73 模块
- electron-builder：
  - better-sqlite3 prebuild-install 404（无 v12.11.1-electron-v119 预编译包），回退到 electron-rebuild 本地重编译，成功
  - 未签名（无 Developer ID，正常；本地自用 app）
  - DMG 用 APFS（arm64 无 HFS+）

## 产物
- `release/ComicApp-1.0.0-arm64.dmg`（117 MB）
- `release/mac-arm64/ComicApp.app`
- app 内 sqlite 二进制：`app.asar.unpacked/.../better_sqlite3.node`（Mach-O arm64 ✅）
- sharp 也正确解包

## 验证（实际启动打包的 app）
```
[DB Migration] 数据库已是最新版本
[DB] SQLite 数据库就绪
[Cache] 图片缓存就绪
[autoScan] 数据库中有 3007 本漫画
[SmartCrawl] 成功: ...
```
app 存活、数据库就绪、加载 3007 本漫画、自动扫描/爬取正常。原生模块 ABI 完全匹配。
（日志里的 SSL CERTIFICATE_VERIFY_FAILED 是 smtt6 源站证书问题，与 app 无关。）

## 安装方式
双击 `release/ComicApp-1.0.0-arm64.dmg` → 拖 ComicApp 到 Applications。
首次打开若被 Gatekeeper 拦（未签名）：右键→打开，或 `xattr -dr com.apple.quarantine /Applications/ComicApp.app`。

## commit
（asarUnpack 修复）已提交。DMG 在 release/（.gitignore 排除，不入库）。
