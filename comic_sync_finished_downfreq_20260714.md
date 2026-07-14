# comic-app sync 完结漫画降频 + enrichChapters 动态超时（2026-07-14）

## 目标
1. 放宽 enrichChapters 超时（原固定 240s 覆盖不了多章慢源）
2. sync 每轮不再全扫 3007 本收藏；完结漫画降频，追更只盯连载

## 改动一：enrichChapters 动态超时（commit c86c9b8）
- 文件：`electron/modules/jobHandlers/sync.js`
- 根因：enrichChapters 串行逐章 getPageList，每章最多 90s；一次最多 10 章（MAX_CHAPTERS_PER_UPDATE=10）→ 最坏 900s+，固定 240s 覆盖不了。
- 修复：`enrichTimeoutMs = Math.max(240, chaptersToCheck.length * 100) * 1000`
  - 3章→300s，10章→1000s。sync 任务总超时 60min 够用。

## 改动二：完结漫画降频（commit 196cc7b）
- 文件：`electron/db/comics.js` 的 `getFavoritedForSyncBatch`
- 原逻辑：`WHERE favorited = 1`（不分连载/完结全扫）
- 新逻辑：
  ```sql
  WHERE favorited = 1 AND (
    status IS NULL OR status = '' OR status NOT LIKE '%完结%'
    OR COALESCE(last_sync_at, 0) < (now - 30天)
  )
  ```
- status 字段格式：「已完结 06/25/2024」/「连载中 06/25/2024」，用 `%完结%` 匹配。
- 实测：收藏 3007 → 连载/未知 793（每轮都扫）；完结 2214（30天内已同步→跳过，超30天补校验一次）。

## sync 配置速查（本次确认）
- 每轮取数（常规非 fullSync）：收藏 100 + 无标签 50 + 缺图数 10 + 缺字段 30，去重后约 100~190 本
- 触发频率：主定时每 4h（syncIntervalHours = max(4, 用户设2h)）；空闲≥5min 触发 fullSync（最小间隔 1h）；失败 30min 重试（最多3次）
- 单轮内部：并发 3 本，批间隔 2s + 随机抖动

## 磁盘检查结论（2026-07-14）
- `/Volumes/可移动磁盘/ComicDownloads` 根目录：无章节图错放、无错放章节目录
- 章节图全部规整在 `漫画标题/序号-章节名/` 下
- 清理了根目录一个孤立残留 `cover.webp`（trash 移废纸篓，可恢复）；37 个 epub 成品未动

## 状态
- 两处改动均语法通过、已重启（Electron PID 66825）、5173 返回 200
- GitHub push 待网络恢复重推
