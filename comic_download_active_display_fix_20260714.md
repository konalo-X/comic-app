# comic-app 下载页"进行中0/分组全等待中" 修复（2026-07-14 21:32）

## 现象
下载队列页顶部显示"进行中 0 · 等待 499"，下方漫画任务分组全部显示"等待中"。但后端实际有 3 个 downloadChapter 在 active 下载（进度正常推进）。

## 根因
前端 `DownloadPage.vue` 调 `jobApi.list('active', 500)` 取队列。
后端 `jobqueue.js listJobs('active')` 的 SQL：
```
WHERE status IN(waiting,running,active,paused)
ORDER BY priority ASC, created_at DESC   ← 问题
LIMIT 500
```
- 真正 active 的 3 个任务是**最早创建**的（一直在跑），`created_at DESC` 把它们排到 1300+ 条的**最末尾**
- 被 `LIMIT 500` 截断 → 前端拿到的 500 条全是 waiting
- 前端映射 `active/running → downloading`，但一个 active 都没拿到 → "进行中 0"
- 分组按 items 状态判断，全 waiting → 全"等待中"

（注：前一轮修的 footer 199/199 是 `getBackgroundTasks` 里另一处 listJobs 误用，这次是下载页 DownloadPage 直接调 list('active') 的另一处，同源不同调用点。）

## 修复
`listJobs('active')` 排序改为按状态优先级：
```
ORDER BY CASE status
  WHEN 'running' THEN 0 WHEN 'active' THEN 0
  WHEN 'paused' THEN 1 ELSE 2 END ASC,
  priority ASC, created_at ASC
```
让 running/active/paused 永远排最前，不会被 LIMIT 截掉。

## 验证
重启后模拟查询：前 3 条=3 个 active downloadChapter，之后才是 waiting。前端将正确显示"进行中 3"，分组出现"下载中"。

## commit
cdac1c3

## 关联本轮其他修复
- e5ea9aa 状态栏网速恒0（全局转发下载进度）
- c5e877b footer 运行中/等待假199/199
- 78d5fbd 下载并发永远只有1个（_tick await 阻塞）+ 分组折叠空白（嵌套backdrop-filter）
