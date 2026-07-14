# comic-app 状态栏网速为0 + 运行中/等待假199/199 修复（2026-07-14 晚）

## 背景
主人反馈两个 UI 问题：
1. 状态栏网速一直显示 0
2. 状态栏"运行中 199 / 等待 199"相等可疑，下载页所有任务显示"等待中"

## 问题一：状态栏网速恒为0（commit e5ea9aa）
- 根因：`download:jobProgress` 进度转发只在用户**手动**点下载时注册（`ipc/download.js` 的 `download:queueChapter`/`queueAllChapters` 里 `jq.on('progress')` 且过滤 `data.jobId === id`）。sync 自动追更批量入队的下载任务进度无人转发到前端 footer。
- 后端其实一直算了 speed（`downloadPaths.js:551-552` bytesDownloaded/elapsed）。
- 修复：`ipc/download.js` register() 里加**全局进度转发器**，惰性获取 jobQueue（`deps.getJobQueue()`，因 register 同步执行时 deps.jq 可能未就绪，`jq.on` 报 not a function），对所有 downloadChapter/downloadComic 的 progress 广播 `download:jobProgress`。
- 验证：抓到 active 下载任务 speed=58.4 KB/s、72 KB/s，转发生效。

## 问题二：footer 运行中/等待假相等 199/199（commit c5e877b）
- 真实状态：downloadChapter active 1~2 / waiting 1313~1315（完全正常，并发小所以大量排队）。
- 根因：`getBackgroundTasks`（`electron/modules/ipc.js`）用 `jq.listJobs('active', 200)` 当"运行中"。但 `jobqueue.js listJobs` 的 'active' 分支内部查的是 `status IN (waiting,running,active,paused)`——把 waiting 也算进"运行中"，且被 limit 200 截断。于是 运行中≈等待≈199。
- 注：`getStats()` 是对的（按 status GROUP BY 精确），所以底部"作业队列 X 活跃"准确；只有顶部 footerTasks 错。
- 修复：改为按 type 用 SQL 精确聚合——运行中只算 running/active，等待只算 waiting，不受 limit 截断。
- 验证：修复后 footer 显示"下载章节 运行中 1 / 等待 1313"，与 DB 真实值一致。

## 相关：下载页按漫画分组折叠（commit a8659b7，本轮早些完成）
- DownloadPage.vue 队列从扁平章节列表改为按漫画分组折叠，解决自动追更章节任务刷屏。

## 状态
- 三处改动均语法/build 通过、已重启（Electron PID 86867）、5173 返回 200、无 uncaughtException
- GitHub push 待网络恢复重推
