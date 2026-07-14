# comic-app 下载 skip 判定 / success 标记 三处修复（2026-07-14）

## 目标（主人要求）
- 章节图片**数量缺**（磁盘图数 < 源站应有数）时**不能算已下载、不能 skip**，必须真下载补齐。
- `download_records.success` 只应在「图片数量不缺 + 每张图都真 sharp 解析过图头且正常」时写。
- sharp OK 的图以后不重复 sharp（per-image 校验缓存，已在早前实现 `.sharp_cache.json`）。

## 根因（三个独立 bug 叠加）
1. **skip 判定不看源站图数**：`checkChapterAlreadyDownloaded`（download.js）原逻辑只看 `validFiles.length > 0 && corruptCount === 0`，磁盘有图且无损坏就 skip。逢九第1话磁盘 111 张、每张不损坏 → 被判 skip，永远补不到源站的 114 张。
2. **success 无条件写**：`saveDownloadRecord` 从不写 `status` 列 → 全部记录默认 `status='success'`（表默认值），无论是否完整。
3. **image_count 被落盘数污染**：`saveChapterResult` 用 `result.downloaded`（本次实际落盘数）写回 `chapters.image_count`。部分失败（111/114）会把权威图数覆盖成 111，永久掩盖缺图。

## 修复
### electron/db/chapters.js
- 新增 `getChapterImageCountBySourceUrl(sourceUrl, chapterIndex)`：按 sourceUrl+sort_order 取源站应有图数（image_count）。返回 0 表示未知。

### electron/modules/jobHandlers/download.js
- `checkChapterAlreadyDownloaded`：先查 `expected = getChapterImageCountBySourceUrl(...)`。skip 条件加 `countOk`：`expected>0 ? validCount>=expected : validCount>0`。数量不足 → 不 skip，回去真下载补齐（增量只下缺的图）。
- `saveChapterResult` 重写完整性判定：
  - `expected = result.total`（getPageList 源站页数，权威）。
  - **`diskValid = getValidChapterImagesCached(chDir).validFiles.length`**（磁盘真 sharp 校验的有效图数，含旧有+本次补的）——不能只看 `result.downloaded`（增量补齐只是本次新下的几张）。
  - `isComplete = expected>0 && diskValid>=expected && !hasFailed`。
  - 记录写 `status: isComplete ? 'success' : 'incomplete'`，`imagesCount: diskValid`。
  - `image_count` 写回用 `expected`（源站 total），不用落盘数，杜绝污染。

### electron/db/downloads.js
- `saveDownloadRecord` 持久化 `status`/`completed`/`error`：`status||'success'`，`completed = status==='success'?1:0`。之前完全不写这三列。

## 验证（逢九第1话，磁盘故意缺 3 张 → 111/114）
1. 第一次跑：`开始下载 逢九›第1话 (3/114 张)` —— 只下缺的 3 张（增量补齐生效），磁盘 111→**114**。
2. （修 diskValid bug 前记录错标 incomplete/3，因只看本次 downloaded=3）修正后：
3. 第二次跑（磁盘已 114 满）：task=completed | 磁盘=114 | **record=success/114** | image_count=114 | `.sharp_cache.json` 已生成 ✅

## 提交
- 本地 commit：`c33ea41`
- GitHub push：网络仍失败（443 连不上），待网络恢复重试 `git push`。

## 备注
- 手动测试任务已从 job_queue 清理。
- 当前队列：downloadChapter active 1 / waiting 505（旧 sync 残留补齐任务，新逻辑会正确判定）；sync waiting 1。
