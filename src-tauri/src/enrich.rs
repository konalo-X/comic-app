// autoEnrichAll：为缺字段的漫画拉详情补全元数据（移植 jobHandlerAutoEnrich）
// 网络部分依赖 source::get_detail（需可达源站）；DB 回写逻辑离线可测
use crate::db;
use crate::source;
use rusqlite::Connection;

const ENRICH_BATCH: i64 = 20;
const VALID_CATEGORIES: [&str; 5] = ["日漫", "韩漫", "真人", "3D漫画", "同性"];

/// 从 tags 推断分类
pub fn derive_category(tag_sources: &[&str]) -> String {
    for src in tag_sources {
        for tag in src.split(',') {
            let t = tag.trim();
            if t.is_empty() {
                continue;
            }
            for cat in VALID_CATEGORIES {
                if t.contains(cat) || cat.contains(t) {
                    return if cat.contains("3D") { "3D漫画".into() } else { cat.into() };
                }
            }
        }
    }
    String::new()
}

#[derive(serde::Serialize, Default)]
pub struct EnrichReport {
    pub enriched: usize,
    pub total: usize,
    pub failed: usize,
    pub msg: String,
    #[serde(rename = "success")]
    pub success: bool,
}

/// 跑一轮 autoEnrich（一次最多 ENRICH_BATCH 本）
///  `on_progress(i)`：处理完第 i 本后回调（1-based，0 = 准备阶段）
pub fn run_enrich(
    db_path: &str,
    limit: Option<i64>,
    on_progress: Option<&dyn Fn(usize, &str, Option<&str>)>,
) -> EnrichReport {
    let mut report = EnrichReport::default();
    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            report.msg = format!("打开 DB 失败: {}", e);
            return report;
        }
    };
    let _ = conn.execute_batch("PRAGMA busy_timeout=8000;");
    let comics = db::comics_with_missing_fields(&conn, limit.unwrap_or(ENRICH_BATCH));
    report.total = comics.len();
    if comics.is_empty() {
        report.msg = "所有漫画字段已完整".into();
        if let Some(cb) = on_progress { cb(0, "done", None); }
        return report;
    }

    for (i, comic) in comics.iter().enumerate() {
        let step = i + 1;
        let url = comic.source_url.clone().unwrap_or_default();
        let title = comic.title.clone().unwrap_or_default();
        if url.is_empty() {
            if let Some(cb) = on_progress {
                cb(step, "skip", Some(&title));
            }
            continue;
        }
        if let Some(cb) = on_progress {
            cb(step, "fetch", Some(&title));
        }
        match source::get_detail(&url) {
            Ok(detail) => {
                let existing_tags = comic.tags.join(",");
                let detail_tags = detail.tags.join(",");
                let category = derive_category(&[&detail_tags, &existing_tags]);
                if db::enrich_comic_metadata(
                    &conn,
                    &comic.id,
                    &detail.cover,
                    &detail.author,
                    &detail.status,
                    &detail.desc,
                    &detail_tags,
                    &category,
                    detail.chapters.len() as i64,
                )
                .is_ok()
                {
                    report.enriched += 1;
                    if let Some(cb) = on_progress {
                        cb(step, "ok", Some(&title));
                    }
                } else {
                    report.failed += 1;
                    if let Some(cb) = on_progress {
                        cb(step, "db-fail", Some(&title));
                    }
                }
            }
            Err(_) => {
                report.failed += 1;
                if let Some(cb) = on_progress {
                    cb(step, "net-fail", Some(&title));
                }
            }
        }
    }
    report.msg = format!(
        "补全完成: {} 本成功, {} 本失败 (共 {})",
        report.enriched, report.failed, report.total
    );
    report.success = report.enriched > 0 || report.total == 0;
    if let Some(cb) = on_progress {
        cb(report.total, "done", None);
    }
    report
}