// 自动追更（sync）：移植 jobHandlerSync 的核心
// 仅追 favorited=1 的漫画，按 last_sync_at ASC 断点续追；每轮 N 本
// 对每本：get_detail → 对比磁盘缺章 → 入队 downloadChapter（priority 高数=低优）
use crate::db;
use crate::jobqueue::JobQueue;
use crate::paths;
use crate::settings;
use crate::source;
use rusqlite::Connection;
use std::sync::Arc;

const SYNC_BATCH: i64 = 100;

#[derive(serde::Serialize, Default)]
pub struct SyncReport {
    pub total: usize,
    pub checked: usize,
    pub updated: usize,
    pub queued_chapters: usize,
    pub failed: usize,
    pub msg: String,
}

/// 跑一轮 sync。db_path 用于独立连接；queue 用于入队下载。
/// `on_progress(i, stage, title, queued_chapters, err)`：处理完第 i 本后回调（1-based）
pub fn run_sync(
    db_path: &str,
    queue: &Arc<JobQueue>,
    limit: Option<i64>,
    on_progress: Option<&dyn Fn(usize, &str, Option<&str>, usize, Option<&str>)>,
) -> SyncReport {
    let mut report = SyncReport::default();
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            report.msg = format!("打开 DB 失败: {}", e);
            return report;
        }
    };
    let _ = conn.execute_batch("PRAGMA busy_timeout=8000;");
    let comics = db::gather_sync_comics(&conn, limit.unwrap_or(SYNC_BATCH));
    report.total = comics.len();
    if comics.is_empty() {
        report.msg = "没有需要同步的收藏漫画".into();
        return report;
    }

    let external = settings::external_download_root();

    for (i, comic) in comics.iter().enumerate() {
        let step = i + 1;
        let source_url = comic.source_url.clone().unwrap_or_default();
        let title = comic.title.clone().unwrap_or_default();
        if source_url.is_empty() {
            if let Some(cb) = on_progress {
                cb(step, "skip", Some(&title), 0, None);
            }
            continue;
        }
        report.checked += 1;
        if let Some(cb) = on_progress {
            cb(step, "check", Some(&title), 0, None);
        }

        // 拉详情（网络）
        let detail = match source::get_detail(&source_url) {
            Ok(d) => d,
            Err(e) => {
                report.failed += 1;
                let _ = db::mark_synced(&conn, std::slice::from_ref(&comic.id));
                if let Some(cb) = on_progress {
                    cb(step, "fail", Some(&title), 0, Some(&e.to_string()));
                }
                continue;
            }
        };
        if detail.chapters.is_empty() {
            let _ = db::mark_synced(&conn, std::slice::from_ref(&comic.id));
            if let Some(cb) = on_progress {
                cb(step, "no-chapter", Some(&title), 0, None);
            }
            continue;
        }

        // 磁盘缺章检测
        // 同名多本防串 (2026-07-27): 标题不唯一且无 local_path 时,
        // 按标题找目录会命中另一本的目录导致误判"已下载"而跳章。
        // 此时视为无本地目录, 缺章全部入队, 由下载处理器分配独立目录。
        let title_dup: i64 = conn
            .query_row("SELECT COUNT(*) FROM comics WHERE title = ?", [&title], |r| r.get(0))
            .unwrap_or(0);
        let comic_dir = if title_dup > 1 && comic.local_path.as_deref().map_or(true, |s| s.is_empty()) {
            None
        } else {
            paths::find_comic_dir(&title, comic.local_path.as_deref(), external.as_deref())
        };
        let mut queued_this = 0usize;
        let mut seen = std::collections::HashSet::new();
        for (idx, ch) in detail.chapters.iter().enumerate() {
            let url = ch.url.trim();
            if url.is_empty() {
                continue;
            }
            if !seen.insert(url.to_string()) {
                continue;
            }
            // 已存在有效图片则跳过
            if let Some(ref dir) = comic_dir {
                if let Some(ch_dir) = paths::find_chapter_dir(dir, idx as i64, &ch.name) {
                    let n = paths::list_chapter_images(&ch_dir).len();
                    if n > 0 {
                        continue;
                    }
                }
            }
            // 入队（自动任务 priority=5，低于手动 p=2）
            if queue
                .add_download_chapter(
                    &title,
                    idx as i64,
                    &ch.name,
                    url,
                    &source_url,
                    &source_url,
                    5,
                )
                .is_ok()
            {
                queued_this += 1;
            }
        }
        if queued_this > 0 {
            report.updated += 1;
            report.queued_chapters += queued_this;
        }
        let _ = db::mark_synced(&conn, std::slice::from_ref(&comic.id));
        if let Some(cb) = on_progress {
            cb(
                step,
                if queued_this > 0 { "updated" } else { "uptodate" },
                Some(&title),
                queued_this,
                None,
            );
        }
    }

    report.msg = format!(
        "同步完成: 检查 {} 本, {} 本有新章, 入队 {} 章, 失败 {}",
        report.checked, report.updated, report.queued_chapters, report.failed
    );
    report
}