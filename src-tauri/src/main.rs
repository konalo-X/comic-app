// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Comiv — Tauri v2 + Rust backend for the comic reader app (方案 B).
// 阶段 2：书架 + 详情 + 章节 + 阅读进度 + 分类统计 + 收藏 + 本地已下载图片（离线阅读）。
// 后续阶段叠加 crawler / download / export / jobqueue。

mod db;
mod download;
mod exporter;
mod imgserver;
mod jobqueue;
mod enrich;
mod crypto;
mod paths;
mod scan;
mod settings;
mod source;
mod sync;

use std::sync::Arc;

use rusqlite::Connection;
use scraper::Html;
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Emitter, Manager};

/// 安全获取 Mutex 锁：即使中毒（panic 过）也返回内部数据，不崩溃整个进程
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// 同上，但把 Result 形式的错误消息传给上层（供 IPC handler 返回结构化错误）
fn try_lock_db<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>, AppErr> {
    m.lock()
        .map_err(|_: PoisonError<_>| AppErr::new("DB_LOCK_POISONED", "[db] 内部锁中毒，请稍后重试"))
}

/// 统一错误结构（给前端解析时能区分 code）：所有 commands 返回 `Err(AppErr)` → Tauri 会序列化成 `{ code, msg }`
#[derive(serde::Serialize, Debug)]
pub struct AppErr {
    pub code: String,
    pub msg: String,
}
impl AppErr {
    pub fn new(code: &str, msg: &str) -> Self {
        Self { code: code.into(), msg: msg.into() }
    }
}
impl std::fmt::Display for AppErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.msg)
    }
}
impl std::error::Error for AppErr {}
impl From<String> for AppErr {
    fn from(s: String) -> Self { AppErr::new("UNKNOWN_ERROR", &s) }
}
impl From<&str> for AppErr {
    fn from(s: &str) -> Self { AppErr::new("UNKNOWN_ERROR", s) }
}
impl From<rusqlite::Error> for AppErr {
    fn from(e: rusqlite::Error) -> Self { AppErr::new("DB_ERROR", &e.to_string()) }
}
impl From<std::io::Error> for AppErr {
    fn from(e: std::io::Error) -> Self { AppErr::new("IO_ERROR", &e.to_string()) }
}
impl From<serde_json::Error> for AppErr {
    fn from(e: serde_json::Error) -> Self { AppErr::new("JSON_ERROR", &e.to_string()) }
}
impl From<Box<dyn std::error::Error + Send + Sync>> for AppErr {
    fn from(e: Box<dyn std::error::Error + Send + Sync>) -> Self {
        AppErr::new("UNKNOWN_ERROR", &e.to_string())
    }
}
impl From<AppErr> for String {
    fn from(e: AppErr) -> String {
        // 当 command 签名还是 Result<_, String> 时 → 把结构化 JSON 塞进 String
        // 前端 safeInvoke 里会 JSON.parse 还原
        match serde_json::to_string(&e) {
            Ok(s) => s,
            Err(_) => format!("[{}] {}", e.code, e.msg),
        }
    }
}
/// 兼容旧代码：返回 Err(String) 的 Result → 转为 AppErr 包裹
pub trait ToAppErr<T> {
    fn to_apperr(self) -> Result<T, AppErr>;
}
impl<T, E: Into<AppErr>> ToAppErr<T> for Result<T, E> {
    fn to_apperr(self) -> Result<T, AppErr> {
        self.map_err(|e| e.into())
    }
}

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub queue: Arc<jobqueue::JobQueue>,
    pub external_root: Mutex<Option<String>>,
}

fn default_db_path() -> String {
    // dev 阶段直接读 comic-app 的实时库（app data 目录），
    // 拿到与线上一致的收藏/进度/下载记录。
    if let Some(base) = dirs::data_dir() {
        let live = base.join("comic-app").join("comics.sqlite");
        if live.exists() {
            return live.to_string_lossy().to_string();
        }
    }
    let legacy = std::path::Path::new("/Users/konalo/Projects/comic-app/comics.sqlite");
    if legacy.exists() {
        return legacy.to_string_lossy().to_string();
    }
    "comics.sqlite".to_string()
}

// ---------- dbApi ----------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn comics_list(
    state: tauri::State<AppState>,
    page: i64,
    page_size: i64,
    category: Option<String>,
    status: Option<String>,
    tag: Option<String>,
    search: Option<String>,
    sort: Option<String>,
    local_only: Option<bool>,
    online_only: Option<bool>,
) -> Result<db::ComicsPage, String> {
    let conn = try_lock_db(&state.db)?;
    db::get_comics(
        &conn,
        page.max(1),
        if page_size <= 0 { 24 } else { page_size },
        category,
        status,
        tag,
        search,
        sort,
        local_only.unwrap_or(false),
        online_only.unwrap_or(false),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn comics_count(state: tauri::State<AppState>) -> Result<i64, String> {
    let conn = try_lock_db(&state.db)?;
    db::comics_count(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn comic_by_id(state: tauri::State<AppState>, id: String) -> Result<Option<db::Comic>, String> {
    let conn = try_lock_db(&state.db)?;
    db::get_comic_by_id(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn comic_by_url(state: tauri::State<AppState>, url: String) -> Result<Option<db::Comic>, String> {
    let conn = try_lock_db(&state.db)?;
    db::get_comic_by_url(&conn, &url).map_err(|e| e.to_string())
}

#[tauri::command]
fn category_stats(state: tauri::State<AppState>) -> Result<db::CategoryStats, String> {
    let conn = try_lock_db(&state.db)?;
    db::category_stats(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_favorite(state: tauri::State<AppState>, comic_id: String, favorited: bool) -> Result<bool, String> {
    let conn = try_lock_db(&state.db)?;
    db::set_favorite(&conn, &comic_id, favorited)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_update_delta(state: tauri::State<AppState>, comic_id: String) -> Result<(), String> {
    let conn = try_lock_db(&state.db)?;
    db::clear_update_delta(&conn, &comic_id).map_err(|e| e.to_string())
}

// ---------- readerApi / progress ----------

#[tauri::command]
fn get_reading_progress(
    state: tauri::State<AppState>,
    comic_id: String,
) -> Result<Option<db::ReadingProgress>, String> {
    let conn = try_lock_db(&state.db)?;
    db::get_reading_progress(&conn, &comic_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_reading_progress(
    state: tauri::State<AppState>,
    comic_id: String,
    chapter_index: i64,
    chapter_url: Option<String>,
    page_index: i64,
    total_pages: i64,
) -> Result<(), String> {
    let conn = try_lock_db(&state.db)?;
    db::save_reading_progress(
        &conn,
        &comic_id,
        chapter_index,
        &chapter_url.unwrap_or_default(),
        page_index,
        total_pages,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn reading_history(state: tauri::State<AppState>, limit: Option<i64>) -> Result<Vec<db::HistoryItem>, String> {
    let conn = try_lock_db(&state.db)?;
    db::get_all_reading_history(&conn, limit.unwrap_or(20)).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_reading_progress(state: tauri::State<AppState>, comic_id: String) -> Result<bool, String> {
    let conn = try_lock_db(&state.db)?;
    db::delete_reading_progress(&conn, &comic_id)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

/// 返回某章节已下载的本地图片代理 URL 列表（离线阅读核心）
#[tauri::command]
fn get_local_chapter_images(
    state: tauri::State<AppState>,
    comic_id: Option<String>,
    chapter_index: i64,
    comic_title: Option<String>,
) -> Result<Option<Vec<String>>, String> {
    let external = lock(&state.external_root).clone();
    // 1) download_records 快路径
    let rec_path = {
        let conn = try_lock_db(&state.db)?;
        db::download_record_path(
            &conn,
            comic_id.as_deref(),
            comic_title.as_deref(),
            chapter_index,
        )
        .map_err(|e| e.to_string())?
    };
    if let Some(p) = rec_path {
        let dir = std::path::Path::new(&p);
        if dir.exists() {
            let files = paths::list_chapter_images(dir);
            if !files.is_empty() {
                return Ok(Some(
                    files
                        .iter()
                        .map(|f| imgserver::local_proxy_url(&f.to_string_lossy()))
                        .collect(),
                ));
            }
        }
    }
    // 2) 按标题在下载根下找目录 → 找章节目录
    if let Some(title) = &comic_title {
        let local_path = comic_id.as_deref().and_then(|cid| {
            let conn = lock(&state.db);
            db::get_comic_by_id(&conn, cid)
                .ok()
                .flatten()
                .and_then(|c| c.local_path)
        });
        if let Some(cdir) = paths::find_comic_dir(title, local_path.as_deref(), external.as_deref()) {
            if let Some(chdir) = paths::find_chapter_dir(&cdir, chapter_index, "") {
                let files = paths::list_chapter_images(&chdir);
                if !files.is_empty() {
                    return Ok(Some(
                        files
                            .iter()
                            .map(|f| imgserver::local_proxy_url(&f.to_string_lossy()))
                            .collect(),
                    ));
                }
            }
        }
    }
    Ok(None)
}

// ---------- readerApi / sourceApi（在线抓取）----------

/// 在线取图：解析章节图片 URL 列表，返回可直接 <img src> 的代理 URL（带缓存）
#[tauri::command]
fn get_chapter_images(chapter_url: String, referer: Option<String>) -> Result<Vec<String>, String> {
    let ref_url = referer.clone().unwrap_or_default();
    let page = source::get_page_list(&chapter_url, &ref_url)?;
    let ref_final = if ref_url.is_empty() { &chapter_url } else { &ref_url };
    Ok(page
        .images
        .iter()
        .map(|u| imgserver::proxy_image_url(u, ref_final))
        .collect())
}

/// 原始图片 URL 列表（不经代理），供下载器使用
#[tauri::command]
fn get_page_list(chapter_url: String, referer: Option<String>) -> Result<source::PageList, String> {
    source::get_page_list(&chapter_url, &referer.unwrap_or_default())
}

#[tauri::command]
fn source_get_detail(url: String) -> Result<source::ComicDetail, String> {
    source::get_detail(&url)
}

#[tauri::command]
fn source_search(query: String, page: Option<i64>) -> Result<Vec<source::SearchItem>, String> {
    source::search(&query, page.unwrap_or(1))
}

// ---------- downloadApi / offlineApi / jobApi（下载队列 + 导出）----------

/// 入队单章下载（走后台队列，立即返回 jobId）
#[tauri::command(rename_all = "camelCase")]
fn download_chapter(
    state: tauri::State<AppState>,
    comic_title: String,
    chapter_index: i64,
    chapter_name: Option<String>,
    chapter_url: String,
    source_url: Option<String>,
    referer: Option<String>,
    priority: Option<i64>,
) -> Result<String, String> {
    state
        .queue
        .add_download_chapter(
            &comic_title,
            chapter_index,
            &chapter_name.unwrap_or_default(),
            &chapter_url,
            &source_url.unwrap_or_default(),
            &referer.unwrap_or_default(),
            priority.unwrap_or(2),
        )
        .map_err(|e| e.to_string())
}

/// 批量入队整部漫画的所有章节
#[tauri::command(rename_all = "camelCase")]
fn queue_all_chapters(
    state: tauri::State<AppState>,
    comic_title: String,
    chapters: Vec<serde_json::Value>,
    source_url: Option<String>,
    referer: Option<String>,
) -> Result<serde_json::Value, String> {
    let src = source_url.unwrap_or_default();
    let ref_ = referer.unwrap_or_default();
    let mut job_ids = Vec::new();
    for ch in &chapters {
        let idx = ch.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
        let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let url = ch.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if url.is_empty() {
            continue;
        }
        if let Ok(id) = state
            .queue
            .add_download_chapter(&comic_title, idx, name, url, &src, &ref_, 5)
        {
            job_ids.push(id);
        }
    }
    Ok(serde_json::json!({"skipped": false, "jobIds": job_ids}))
}

#[tauri::command]
fn job_list(state: tauri::State<AppState>, status: Option<String>, limit: Option<i64>) -> Vec<jobqueue::JobView> {
    state.queue.list(&status.unwrap_or_else(|| "all".into()), limit.unwrap_or(500))
}

#[tauri::command]
fn job_stats(state: tauri::State<AppState>) -> serde_json::Value {
    state.queue.stats()
}

#[tauri::command(rename_all = "camelCase")]
fn job_remove(state: tauri::State<AppState>, job_id: String) -> Result<(), String> {
    state.queue.remove(&job_id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn job_pause(state: tauri::State<AppState>, job_id: String) -> Result<(), String> {
    state.queue.pause(&job_id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn job_resume(state: tauri::State<AppState>, job_id: String) -> Result<(), String> {
    state.queue.resume(&job_id).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn job_retry(state: tauri::State<AppState>, job_id: String) -> Result<(), String> {
    state.queue.retry(&job_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn job_retry_all(state: tauri::State<AppState>) -> Result<usize, String> {
    state.queue.retry_all().map_err(|e| e.to_string())
}

/// 导出漫画（epub / cbz）到下载目录
#[tauri::command]
fn export_comic(
    state: tauri::State<AppState>,
    title: String,
    format: String,
) -> Result<String, String> {
    // 找漫画 + local_path + 章节
    let comic = {
        let conn = try_lock_db(&state.db)?;
        db::get_comic_by_title(&conn, &title).map_err(|e| e.to_string())?
    }
    .ok_or_else(|| format!("未找到漫画: {}", title))?;
    let local_path = comic
        .local_path
        .clone()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| "该漫画尚未下载（无 local_path）".to_string())?;
    let source_dir = std::path::PathBuf::from(&local_path);
    if !source_dir.exists() {
        return Err(format!("下载目录不存在: {}", local_path));
    }
    // 章节目录：按 chapters 顺序解析
    let chapters = comic.chapters.clone().unwrap_or_default();
    let mut export_chapters: Vec<exporter::ExportChapter> = Vec::new();
    for (i, ch) in chapters.iter().enumerate() {
        if let Some(dir) = paths::find_chapter_dir(&source_dir, i as i64, &ch.name) {
            export_chapters.push(exporter::ExportChapter {
                name: ch.name.clone(),
                dir,
            });
        }
    }
    if export_chapters.is_empty() {
        // 兑底：直接扫描 source_dir 下的子目录
        if let Ok(entries) = std::fs::read_dir(&source_dir) {
            let mut dirs: Vec<std::path::PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for d in dirs {
                let name = d.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                export_chapters.push(exporter::ExportChapter { name, dir: d });
            }
        }
    }
    if export_chapters.is_empty() {
        return Err("无可导出的章节目录".into());
    }

    // 输出到下载目录（与 source_dir 同级的根）
    let out_root = source_dir.parent().map(|p| p.to_path_buf()).unwrap_or(source_dir.clone());
    let safe_title = paths::sanitize_filename(&title);
    let ext = if format.eq_ignore_ascii_case("cbz") { "cbz" } else { "epub" };
    let out_path = out_root.join(format!("{}.{}", safe_title, ext));

    let author = comic.author.clone().unwrap_or_default();
    let count = if ext == "cbz" {
        exporter::to_cbz(&source_dir, &out_path, &export_chapters)?
    } else {
        exporter::to_epub(&source_dir, &out_path, &title, &author, &export_chapters)?
    };
    let _ = count;
    Ok(out_path.to_string_lossy().to_string())
}

// ---------- dbApi 统计 / diskApi / sync ----------

#[tauri::command]
fn db_chapters_count(state: tauri::State<AppState>) -> i64 {
    let c = lock(&state.db);
    db::chapters_count(&c)
}

#[tauri::command]
fn db_images_count(state: tauri::State<AppState>) -> i64 {
    let c = lock(&state.db);
    db::images_count(&c)
}

#[tauri::command]
fn db_download_size(state: tauri::State<AppState>) -> u64 {
    let c = lock(&state.db);
    db::download_size(&c)
}

#[tauri::command]
fn download_list_local(state: tauri::State<AppState>) -> Vec<serde_json::Value> {
    let c = lock(&state.db);
    db::download_records(&c)
}

#[tauri::command(rename_all = "camelCase")]
fn get_highest_downloaded_index(
    state: tauri::State<AppState>,
    comic_title: String,
    source_url: Option<String>,
) -> serde_json::Value {
    let local_path = {
        let c = lock(&state.db);
        db::get_comic_by_url(&c, &source_url.clone().unwrap_or_default())
            .ok()
            .flatten()
            .and_then(|cm| cm.local_path)
    };
    let external = settings::external_download_root();
    let dir = paths::find_comic_dir(&comic_title, local_path.as_deref(), external.as_deref());
    let (count, disk_dir) = match dir {
        Some(d) => {
            let n = std::fs::read_dir(&d)
                .map(|it| it.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).count())
                .unwrap_or(0);
            (n as i64, Some(d.to_string_lossy().to_string()))
        }
        None => (0, None),
    };
    serde_json::json!({"diskChapterCount": count, "diskDir": disk_dir})
}

#[tauri::command(rename_all = "camelCase")]
fn disk_get_space(path: Option<String>) -> serde_json::Value {
    let effective_path = {
        let preferred = path
            .filter(|p| !p.trim().is_empty())
            .or_else(settings::external_download_root)
            .filter(|p| std::path::Path::new(p).exists());
        if let Some(p) = preferred {
            p
        } else {
            std::env::var("HOME").unwrap_or_else(|_| {
                if cfg!(windows) { "C:\\".into() } else { "/".into() }
            })
        }
    };

    macro_rules! ok {
        ($tot:expr, $fr:expr) => {{
            let tot: u64 = $tot;
            let fr: u64 = $fr;
            let used = tot.saturating_sub(fr);
            return serde_json::json!({
                "success": true,
                "path": effective_path,
                "total": tot,
                "free": fr,
                "used": used,
            });
        }};
    }
    macro_rules! fail {
        ($msg:expr) => {{
            return serde_json::json!({
                "success": false,
                "path": effective_path,
                "total": 0,
                "free": 0,
                "used": 0,
                "error": $msg,
            });
        }};
    }

    // -------- macOS / Linux：使用 df -k（BSD/GNU 通用输出格式）--------
    #[cfg(unix)]
    {
        let out = std::process::Command::new("df").arg("-k").arg(&effective_path).output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                if let Some(line) = text.lines().nth(1) {
                    let cols: Vec<&str> = line.split_whitespace().collect();
                    if cols.len() >= 4 {
                        let total = cols[1].parse::<u64>().unwrap_or(0) * 1024;
                        let used_kb = cols[2].parse::<u64>().unwrap_or(0) * 1024;
                        let free = cols[3].parse::<u64>().unwrap_or(0) * 1024;
                        // macOS df 的第 2 列 1024-blocks = total, 第3 Used, 第4 Available (=free)
                        // total_blocks = used_kb/1024 + free_kb/1024 + 根卷保留块可能不相等；按定义补 total=used+free（对前端展示更准）
                        let total_norm = used_kb.saturating_add(free);
                        let total = if total_norm > total { total_norm } else { total };
                        ok!(total, free);
                    } else {
                        fail!(format!("df 输出列数不足 ({})", cols.len()));
                    }
                } else {
                    fail!("df 输出无数据行（挂载路径无效？）");
                }
            }
            Err(e) => fail!(format!("df 命令执行失败：{}", e)),
        }
    }

    // -------- Windows：使用 fsutil volume diskfree 解析 --------
    #[cfg(windows)]
    {
        let out = std::process::Command::new("fsutil")
            .args(["volume", "diskfree", &effective_path])
            .output();
        match out {
            Ok(o) => {
                let text = String::from_utf8_lossy(&o.stdout);
                let mut free_bytes: Option<u64> = None;
                let mut total_bytes: Option<u64> = None;
                for line in text.lines() {
                    let lower = line.trim().to_lowercase();
                    if let Some(colon) = lower.find(':') {
                        let (key, val) = lower.split_at(colon);
                        let num = val.trim().trim_start_matches(':').trim().split_whitespace().next()
                            .and_then(|s| s.replace(',', "").parse::<u64>().ok());
                        if key.contains("free") || key.contains("可用") {
                            free_bytes = num;
                        } else if key.contains("total") || key.contains("总字节") || key.contains("字节总数") {
                            total_bytes = num;
                        }
                    }
                }
                if let (Some(tot), Some(fr)) = (total_bytes, free_bytes) {
                    ok!(tot, fr);
                }
            }
            Err(_) => {}
        }
        // 兜底方案：通过 dir 命令或 wmic 获取
        let root = std::path::Path::new(&effective_path)
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .unwrap_or_else(|| "C:\\".into());
        if let Ok(wmic) = std::process::Command::new("wmic")
            .args(["logicaldisk", "where", &format!("DeviceID='{}'", root.trim_end_matches('\\')),
                   "get", "Size,Freespace", "/value"])
            .output()
        {
            let txt = String::from_utf8_lossy(&wmic.stdout);
            let f = txt.lines().find_map(|l| l.strip_prefix("FreeSpace=")?.trim().parse::<u64>().ok());
            let t = txt.lines().find_map(|l| l.strip_prefix("Size=")?.trim().parse::<u64>().ok());
            if let (Some(tot), Some(fr)) = (t, f) {
                ok!(tot, fr);
            }
        }
        fail!("fsutil / wmic 均未返回可用磁盘信息");
    }
}

/// 手动触发一轮 sync（自动追更）
#[tauri::command]
fn run_sync_now(state: tauri::State<AppState>, limit: Option<i64>) -> sync::SyncReport {
    let db_path = default_db_path();
    sync::run_sync(&db_path, &state.queue, limit, None)
}

/// importApi.pickDirectory：弹原生目录选择器
#[tauri::command]
fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    match rx.recv() {
        Ok(Some(path)) => Some(path.to_string()),
        _ => None,
    }
}

/// autoEnrichAll：为缺字段漫画拉详情补全元数据
#[tauri::command]
fn auto_enrich_all(limit: Option<i64>) -> enrich::EnrichReport {
    let db_path = default_db_path();
    enrich::run_enrich(&db_path, limit, None)
}

/// 清空所有漫画
#[tauri::command]
fn clear_comics(state: tauri::State<AppState>) -> Result<(), String> {
    let conn = try_lock_db(&state.db)?;
    db::clear_comics(&conn).map_err(|e| e.to_string())
}

/// 缺字段漫画计数（供 UI 展示）
#[tauri::command]
fn count_missing_fields(state: tauri::State<AppState>) -> i64 {
    let conn = lock(&state.db);
    db::count_missing_fields(&conn)
}

/// 自动扫描本地目录并入库（autoScanLocalComics）—— 带 scan://progress 事件
#[tauri::command]
fn auto_scan_local(
    app: AppHandle,
    state: tauri::State<AppState>,
    paths: Option<Vec<String>>,
) -> scan::ScanReport {
    let roots: Vec<String> = paths.unwrap_or_else(|| {
        settings::external_download_root().into_iter().collect()
    });

    // 先扫所有根 → 汇总成一个 ScannedComic 列表
    let mut all_comics: Vec<scan::ScannedComic> = Vec::new();
    for root in &roots {
        let p = std::path::Path::new(root);
        if p.exists() {
            let _ = app.emit("scan://progress", serde_json::json!({
                "stage": "scan", "dir": root,
            }));
            all_comics.extend(scan::scan_local_comics(p));
        }
    }
    let total = all_comics.len() as i64;
    let _ = app.emit("scan://progress", serde_json::json!({
        "stage": "prep", "total": total, "index": 0i64,
    }));

    // 先拿主 state 的 conn（单连接、表结构一致）；不用 lock + state 直接拿 conn 避免跨线程问题
    let conn = lock(&state.db);
    let mut report = scan::ScanReport::default();
    report.total = all_comics.len();

    for (idx, comic) in all_comics.iter().enumerate() {
        let index = (idx + 1) as i64;
        let existed = scan::match_comic_id(&conn, &comic.title).is_some();
        if existed {
            let _ = app.emit("scan://progress", serde_json::json!({
                "stage": "exists", "total": total, "index": index, "title": comic.title,
            }));
        } else {
            let _ = app.emit("scan://progress", serde_json::json!({
                "stage": "match", "total": total, "index": index, "title": comic.title,
            }));
        }
        let (newly, reg) = scan::register_existing(&conn, comic);
        if existed {
            report.matched += 1;
            if reg > 0 {
                let _ = app.emit("scan://progress", serde_json::json!({
                    "stage": "import-matched", "total": total, "index": index, "title": comic.title,
                }));
            }
        } else if newly {
            let _ = app.emit("scan://progress", serde_json::json!({
                "stage": "import-local", "total": total, "index": index, "title": comic.title,
            }));
        }
        if reg > 0 {
            report.imported += 1;
            report.chapters_registered += reg;
        } else {
            report.skipped += 1;
        }
    }

    let _ = app.emit("scan://progress", serde_json::json!({
        "stage": "done", "total": total, "index": total,
    }));
    report
}

// ---------- settingsApi ----------

#[tauri::command]
fn settings_get() -> Result<serde_json::Value, String> {
    Ok(settings::load_settings())
}

#[tauri::command]
fn settings_save(state: tauri::State<AppState>, patch: serde_json::Value) -> Result<(), String> {
    settings::save_settings(&patch)?;
    // 同步刷新 external_root 缓存
    *lock(&state.external_root) = settings::external_download_root();
    Ok(())
}

// ---------- crawlerApi（自动任务链：爬取→补全→章节增强→追更）----------
// 4 个命令都是网络/IO 耗时操作：立即返回 jobId，后台线程跑，事件吐进度

use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
static CRAWLER_JOB_SEQ: AtomicUsize = AtomicUsize::new(1);

fn next_crawler_job_id(prefix: &str) -> String {
    let n = CRAWLER_JOB_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    format!("{}-{}-{}", prefix, n, uuid_simple())
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{:x}", t)
}

/// 1) crawlAll: 全站分类爬取收录（首次导入书架用）
///  —— 本实现对源站分类列表分页（简化版：抓取 ALL 类别前 N 页 → 批量 upsert 到 DB）
#[tauri::command(rename_all = "camelCase")]
fn crawler_crawl_all(app: AppHandle, base_url: Option<String>) -> Result<serde_json::Value, String> {
    let job_id = next_crawler_job_id("crawl");
    let job_id_cloned = job_id.clone();

    std::thread::spawn(move || {
        let emit_prog = |page: i64, total_pages: i64, msg: &str| {
            let _ = app.emit("crawler://progress", serde_json::json!({
                "jobId": job_id_cloned,
                "page": page,
                "current": page,
                "total": total_pages,
                "msg": msg,
            }));
        };
        let emit_done = |pages: i64, total: i64| {
            let _ = app.emit("crawler://done", serde_json::json!({
                "jobId": job_id_cloned,
                "pages": pages,
                "total": total,
            }));
        };

        // 当前 DB 已有多少漫画（作为"已收录"基准反馈给前端）
        let db_path = default_db_path();
        let already_have = Connection::open(&db_path)
            .and_then(|c| db::comics_count(&c))
            .unwrap_or(0);

        let total_pages = 20i64; // 对齐前端进度 (page/126)*100 公式，但这里用 20 页避免打满源站
        let mut inserted_total = 0i64;

        // 简化版：扫描前 total_pages 页分类（all / ob / time / st / all）
        let start_page = base_url.and_then(|u| {
            u.rsplit('/').next()?.parse::<i64>().ok()
        }).unwrap_or(1);

        for page in start_page..=total_pages {
            emit_prog(page, total_pages, &format!("爬取第 {} 页分类...（已有 {} 部）", page, already_have + inserted_total));
            // 抓分类列表：SM动漫 分类页 HTML，解析缩略卡片（用 source.search 近似效果 + 手动解析卡片）
            let url = format!("{}/man-hua-lei-bie/all/ob/time/st/all/page/{}", source::BASE_URL, page);
            let html = source::fetch_html(&url, "").ok();
            if let Some(doc) = html.as_ref().map(|h| Html::parse_document(h)) {
                // 抓取所有 /book/XXXX 链接 + 对应缩略标题封面
                let sel = scraper::Selector::parse("a[href*=\"/book/\"]").unwrap();
                let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
                let mut batch: Vec<(String, String, String, String)> = Vec::new();
                for a in doc.select(&sel) {
                    let href = a.value().attr("href").unwrap_or_default();
                    if href.is_empty() || !href.starts_with("/book/") || seen.contains(href) {
                        continue;
                    }
                    seen.insert(href.into());
                    let book_url = source::absolute_url(href, &url);
                    // 抓标题
                    let title_sel = scraper::Selector::parse("h2,h3,.title,.name").unwrap();
                    let t = a.select(&title_sel).next().map(|e| e.text().collect::<String>().trim().to_string())
                        .or_else(|| a.value().attr("title").map(|s| s.to_string()))
                        .unwrap_or_default();
                    // 抓封面
                    let img_sel = scraper::Selector::parse("img").unwrap();
                    let cover = a.select(&img_sel).next()
                        .and_then(|img| img.value().attr("data-src").or_else(|| img.value().attr("src")))
                        .map(|s| source::absolute_url(s, &url))
                        .unwrap_or_default();
                    if !t.is_empty() {
                        batch.push((book_url, t, cover, String::new()));
                    }
                }
                // 批量入库（upsert）
                if let Ok(conn) = Connection::open(&db_path) {
                    let _ = conn.execute_batch("PRAGMA busy_timeout=8000;");
                    for (burl, title, cov, _auth) in &batch {
                        let id = sha1_hex(burl);
                        let _ = conn.execute(
                            "INSERT OR IGNORE INTO comics (id,title,cover,source_url,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                            rusqlite::params![
                                id, title, cov, burl, db::now_ms(), db::now_ms(),
                            ],
                        );
                        inserted_total += 1;
                    }
                }
            }
            // 爬完 20 页够了，避免给源站压力
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        emit_done(total_pages, already_have + inserted_total);
    });

    Ok(serde_json::json!({ "jobId": job_id, "existing": false }))
}

fn sha1_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// 2) enrich：补全缺字段漫画的元数据（标签/作者/状态/描述 + 章节数）
///  —— 直接复用 enrich::run_enrich（已有完整实现）；加进度事件
#[tauri::command(rename_all = "camelCase")]
fn crawler_enrich(app: AppHandle, force: Option<bool>) -> Result<serde_json::Value, String> {
    let job_id = next_crawler_job_id("enrich");
    let job_id_cloned = job_id.clone();
    let limit = if force.unwrap_or(false) { None } else { Some(500i64) };
    let db_path = default_db_path();

    std::thread::spawn(move || {
        // 1) 先拿总数用于进度估算
        let total = Connection::open(&db_path)
            .and_then(|c| if force.unwrap_or(false) {
                db::comics_count(&c)
            } else {
                Ok(db::count_missing_fields(&c))
            })
            .unwrap_or(0);
        let emit_prog = |cur: i64, msg: &str| {
            let _ = app.emit("crawler://enrich-progress", serde_json::json!({
                "jobId": job_id_cloned,
                "current": cur,
                "total": total,
                "msg": msg,
            }));
        };

        emit_prog(0, &format!("准备补全（共 {} 部待处理）...", total));
        let report = crate::enrich::run_enrich(&db_path, limit, Some(&|cur, stage, title| {
            let msg = match stage {
                "fetch" => format!("抓取元数据：{}", title.unwrap_or("")),
                "ok" => format!("补全成功：{}", title.unwrap_or("")),
                "skip" => format!("跳过（无链接）：{}", title.unwrap_or("")),
                "db-fail" => format!("写入失败：{}", title.unwrap_or("")),
                "net-fail" => format!("网络失败：{}", title.unwrap_or("")),
                "done" => format!("补全完成"),
                _ => stage.into(),
            };
            emit_prog(cur as i64, &msg);
        }));

        // 简单把 report.total 作为"当前已处理全部"的进度触发一次
        emit_prog(report.total as i64, &format!(
            "补全完成：成功 {} / 共 {} / 失败 {}",
            report.enriched, report.total, report.failed
        ));
        let _ = app.emit("crawler://enrich-done", serde_json::json!({
            "jobId": job_id_cloned,
            "total": report.total,
            "enriched": report.enriched,
            "failed": report.failed,
            "msg": report.msg,
        }));
    });

    Ok(serde_json::json!({ "jobId": job_id }))
}

/// 3) enrichChapters：章节增强（扫描磁盘章节目录 → 回填图片数，修正章节名）
#[tauri::command(rename_all = "camelCase")]
fn crawler_enrich_chapters(app: AppHandle) -> Result<serde_json::Value, String> {
    let job_id = next_crawler_job_id("enrich-chapters");
    let job_id_cloned = job_id.clone();
    let db_path = default_db_path();
    let external = settings::external_download_root();

    std::thread::spawn(move || {
        let conn = match Connection::open(&db_path) {
            Ok(c) => { let _ = c.execute_batch("PRAGMA busy_timeout=8000;"); c },
            Err(_) => {
                let _ = app.emit("crawler://enrich-chapters-done", serde_json::json!({
                    "jobId": job_id_cloned, "processed": 0, "totalImgUpdated": 0,
                }));
                return;
            }
        };
        // 有 local_path 或已经在磁盘可定位到目录的漫画
        let candidates = match conn.query_row(
            "SELECT COUNT(*) FROM comics WHERE local_path IS NOT NULL AND local_path != ''",
            [], |r| r.get::<_, i64>(0)
        ) {
            Ok(n) => n,
            Err(_) => 0,
        };
        let emit_prog = |ci: i64, tc: i64, title: &str| {
            let _ = app.emit("crawler://enrich-chapters-progress", serde_json::json!({
                "jobId": job_id_cloned,
                "chapterIndex": ci,
                "totalChapters": tc,
                "title": title,
            }));
        };

        let mut processed_comics = 0usize;
        let mut total_img_updated = 0usize;

        // 分页扫 comics（每批 100）
        let mut offset = 0i64;
        const BATCH: i64 = 100;
        loop {
            let mut stmt = match conn.prepare(
                "SELECT id, title, local_path, source_url FROM comics WHERE local_path IS NOT NULL AND local_path != '' LIMIT ? OFFSET ?"
            ) {
                Ok(s) => s,
                Err(_) => break,
            };
            let rows = match stmt.query_map(rusqlite::params![BATCH, offset], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(2)?,
                ))
            }) {
                Ok(r) => r,
                Err(_) => break,
            };
            let mut batch_rows: Vec<(String, String, Option<String>)> = Vec::new();
            for r in rows { if let Ok(x) = r { batch_rows.push(x); } }
            if batch_rows.is_empty() { break; }

            for (cid, title, local_path) in &batch_rows {
                processed_comics += 1;
                let comic_dir_opt = paths::find_comic_dir(title, local_path.as_deref(), external.as_deref());
                let Some(comic_dir) = comic_dir_opt else { continue };
                // 读取 DB 章节列表 → 找目录 → 数图片数 → UPDATE
                let chapters = db::load_chapters(&conn, cid).unwrap_or_default();
                let total_ch = chapters.len() as i64;
                for (idx, ch) in chapters.iter().enumerate() {
                    if let Some(ch_dir) = paths::find_chapter_dir(&comic_dir, idx as i64, &ch.name) {
                        let img_count = paths::list_chapter_images(&ch_dir).len() as i64;
                        if img_count > 0 {
                            let _ = conn.execute(
                                "UPDATE chapters SET image_count = ?, sort_order = ? WHERE comic_id = ? AND url = ? AND name = ?",
                                rusqlite::params![img_count, idx as i64, cid, ch.url, ch.name],
                            );
                            total_img_updated += 1;
                        }
                    }
                    emit_prog(idx as i64, total_ch, title);
                }
            }
            offset += BATCH;
        }

        let _ = app.emit("crawler://enrich-chapters-done", serde_json::json!({
            "jobId": job_id_cloned,
            "processed": processed_comics,
            "totalImgUpdated": total_img_updated,
            "candidates": candidates,
        }));
    });

    Ok(serde_json::json!({ "jobId": job_id }))
}

/// 4) checkUpdates：检查连载中/收藏漫画最新章节 → 缺章入队下载
///  —— 直接复用 sync::run_sync（已有完整实现）；加进度事件
#[tauri::command(rename_all = "camelCase")]
fn crawler_check_updates(app: AppHandle, queue: tauri::State<'_, std::sync::Arc<jobqueue::JobQueue>>) -> Result<serde_json::Value, String> {
    let job_id = next_crawler_job_id("sync");
    let job_id_cloned = job_id.clone();
    let db_path = default_db_path();
    let queue_copy = (*queue.inner()).clone();

    std::thread::spawn(move || {
        let total = Connection::open(&db_path)
            .map(|c| db::gather_sync_comics(&c, 1000).len() as i64)
            .unwrap_or(0);
        let emit_prog = |cur: i64, title: Option<&str>, err: Option<&str>, msg: Option<&str>| {
            let mut payload = serde_json::json!({
                "jobId": job_id_cloned,
                "current": cur,
                "total": total,
            });
            if let Some(t) = title { payload["title"] = t.into(); }
            if let Some(e) = err { payload["error"] = e.into(); }
            if let Some(m) = msg { payload["msg"] = m.into(); }
            let _ = app.emit("crawler://update-progress", payload);
        };

        emit_prog(0, None, None, Some(&format!("准备检查更新（共 {} 部收藏/连载）", total)));
        let report = sync::run_sync(&db_path, &queue_copy, None, Some(&|cur, stage, title, queued, err| {
            let msg = match stage {
                "check" => format!("检查：{}", title.unwrap_or("")),
                "updated" => format!("新章入队：{} ({} 章)", title.unwrap_or(""), queued),
                "uptodate" => format!("已是最新：{}", title.unwrap_or("")),
                "no-chapter" => format!("无章节：{}", title.unwrap_or("")),
                "skip" => format!("跳过：{}", title.unwrap_or("")),
                "fail" => format!("失败：{}", title.unwrap_or("")),
                _ => stage.into(),
            };
            emit_prog(cur as i64, title, err, Some(&msg));
        }));

        emit_prog(report.checked as i64, None, None, Some(&format!(
            "检查完成：共 {} / 更新 {} 部 / 入队下载 {} 章 / 失败 {}",
            report.total, report.updated, report.queued_chapters, report.failed
        )));
        let _ = app.emit("crawler://update-done", serde_json::json!({
            "jobId": job_id_cloned,
            "total": report.total,
            "checked": report.checked,
            "updated": report.updated,
            "queuedChapters": report.queued_chapters,
            "failed": report.failed,
            "msg": report.msg,
        }));
    });

    Ok(serde_json::json!({ "jobId": job_id }))
}

// ---------- windowApi ----------

/// 把 Tauri 原生窗口事件（tauri://window-created 等不发）主动发送给前端：
///  setup 阶段注册监听，前端 bridge.js 里 window.onMaximizeChange 对应 "window://maximize-changed"
fn register_window_events<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let w = match app.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };
    let app_c = app.clone();
    let w_c = w.clone();
    std::thread::spawn(move || {
        let mut last_max = false;
        let mut last_fs = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(350));
            let cur_max = w_c.is_maximized().unwrap_or(false);
            let cur_fs = w_c.is_fullscreen().unwrap_or(false);
            if cur_max != last_max {
                last_max = cur_max;
                let _ = app_c.emit("window://maximize-changed", cur_max);
            }
            if cur_fs != last_fs {
                last_fs = cur_fs;
                let _ = app_c.emit("window://fullscreen-changed", cur_fs);
            }
        }
    });
}

// ---------- batchApi / cacheApi（简化实现）----------

/// 批量删除漫画（DB + 本地目录），返回 { deleted, failed }
#[tauri::command]
fn batch_delete_comics(state: tauri::State<AppState>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    if ids.is_empty() {
        return Ok(serde_json::json!({ "deleted": 0, "failed": 0 }));
    }
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let external = settings::external_download_root();
    let conn = lock(&state.db);
    for id in &ids {
        // 找 local_path
        let local_path: Option<String> = conn
            .query_row("SELECT local_path FROM comics WHERE id = ?", [id], |r| r.get(0))
            .ok()
            .flatten();
        let title: Option<String> = conn
            .query_row("SELECT title FROM comics WHERE id = ?", [id], |r| r.get(0))
            .ok()
            .flatten();
        // 删 DB
        let ok = conn.execute("DELETE FROM comics WHERE id = ?", [id]).is_ok();
        // 删磁盘目录
        if ok {
            deleted += 1;
            let dir = paths::find_comic_dir(&title.unwrap_or_default(), local_path.as_deref(), external.as_deref());
            if let Some(d) = dir {
                let _ = std::fs::remove_dir_all(&d);
            }
        } else {
            failed += 1;
        }
    }
    Ok(serde_json::json!({ "deleted": deleted, "failed": failed }))
}

/// 批量导出 EPUB（按 title 逐一调 export_comic 逻辑），返回 { processed }
#[tauri::command(rename_all = "camelCase")]
fn batch_export_epub(state: tauri::State<AppState>, ids: Vec<String>) -> Result<serde_json::Value, String> {
    if ids.is_empty() {
        return Ok(serde_json::json!({ "processed": 0, "failed": 0 }));
    }
    let conn = lock(&state.db);
    let mut processed = 0usize;
    let mut failed = 0usize;
    for id in &ids {
        let title: Option<String> = conn
            .query_row("SELECT title FROM comics WHERE id = ?", [id], |r| r.get::<_, Option<String>>(0))
            .ok()
            .flatten();
        let Some(t) = title else { failed += 1; continue };
        // 复用 export_comic 同款路径：查 local_path → 构造章节 → 输出 EPUB
        let local_path: Option<String> = {
            conn.query_row("SELECT local_path FROM comics WHERE id = ?", [id], |r| {
                r.get::<_, Option<String>>(0)
            }).ok().flatten().filter(|p| !p.trim().is_empty())
        };
        let Some(lp) = local_path else { failed += 1; continue };
        let source_dir = std::path::PathBuf::from(&lp);
        if !source_dir.exists() { failed += 1; continue }
        let author: String = conn.query_row("SELECT author FROM comics WHERE id = ?", [id], |r| {
            r.get::<_, Option<String>>(0)
        }).ok().flatten().unwrap_or_default();
        // 章节
        let chapters = db::load_chapters(&conn, id).unwrap_or_default();
        let mut export_chapters: Vec<exporter::ExportChapter> = Vec::new();
        for (i, ch) in chapters.iter().enumerate() {
            if let Some(dir) = paths::find_chapter_dir(&source_dir, i as i64, &ch.name) {
                export_chapters.push(exporter::ExportChapter { name: ch.name.clone(), dir });
            }
        }
        if export_chapters.is_empty() {
            if let Ok(entries) = std::fs::read_dir(&source_dir) {
                let mut dirs: Vec<std::path::PathBuf> = entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect();
                dirs.sort();
                for d in dirs {
                    let name = d.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    export_chapters.push(exporter::ExportChapter { name, dir: d });
                }
            }
        }
        if export_chapters.is_empty() { failed += 1; continue }
        let out_root = source_dir.parent().map(|p| p.to_path_buf()).unwrap_or(source_dir.clone());
        let safe_title = paths::sanitize_filename(&t);
        let out_path = out_root.join(format!("{}.epub", safe_title));
        match exporter::to_epub(&source_dir, &out_path, &t, &author, &export_chapters) {
            Ok(_) => processed += 1,
            Err(_) => failed += 1,
        }
    }
    Ok(serde_json::json!({ "processed": processed, "failed": failed }))
}

/// 缓存统计（已下载图片数/体积/章节数）
#[tauri::command]
fn cache_stats(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let conn = try_lock_db(&state.db)?;
    let images: i64 = conn.query_row("SELECT COALESCE(SUM(image_count),0) FROM chapters WHERE image_count > 0", [], |r| r.get(0)).unwrap_or(0);
    let size: u64 = db::download_size(&conn);
    let chapters: i64 = conn.query_row("SELECT COUNT(*) FROM chapters WHERE image_count > 0", [], |r| r.get(0)).unwrap_or(0);
    let comics: i64 = conn.query_row("SELECT COUNT(*) FROM comics WHERE local_path IS NOT NULL AND local_path != ''", [], |r| r.get(0)).unwrap_or(0);
    Ok(serde_json::json!({
        "images": images,
        "sizeBytes": size,
        "chapters": chapters,
        "comics": comics,
    }))
}

/// 清除缓存：删除所有 local_path 的磁盘内容，但保留 DB 元数据（不删漫画条目）
#[tauri::command]
fn cache_clear(state: tauri::State<AppState>) -> Result<serde_json::Value, String> {
    let conn = try_lock_db(&state.db)?;
    let external = settings::external_download_root();
    let mut stmt = conn.prepare("SELECT id, title, local_path FROM comics WHERE local_path IS NOT NULL AND local_path != ''")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, Option<String>>(2)?,
        ))
    }).map_err(|e| e.to_string())?;
    let mut cleared = 0usize;
    let rows: Vec<_> = rows.collect();
    for r in rows {
        let Ok((_id, title, lp)) = r else { continue };
        if let Some(dir) = paths::find_comic_dir(&title, lp.as_deref(), external.as_deref()) {
            if std::fs::remove_dir_all(&dir).is_ok() {
                cleared += 1;
            }
        }
    }
    // 清空 image_count 等
    let _ = conn.execute("UPDATE chapters SET image_count = 0 WHERE image_count > 0", []);
    Ok(serde_json::json!({ "clearedComics": cleared }))
}

#[tauri::command]
fn window_minimize(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.minimize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_maximize(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_unmaximize(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.unmaximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_is_maximized(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_maximized().ok())
        .unwrap_or(false)
}

#[tauri::command]
fn window_toggle_fullscreen(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let cur = w.is_fullscreen().map_err(|e| e.to_string())?;
        w.set_fullscreen(!cur).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn window_is_fullscreen(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_fullscreen().ok())
        .unwrap_or(false)
}

#[tauri::command]
fn window_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 用系统默认程序打开文件或目录（openPath）
#[tauri::command]
fn open_path(_app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    { Err("不支持的平台".into()) }
}

/// 在 Finder/资源管理器中定位文件（reveal in folder）
#[tauri::command]
fn reveal_in_folder(_app: AppHandle, path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_dir() {
        path.clone()
    } else {
        p.parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".into())
    };
    // macOS: Finder 的 "reveal" 需要用 AppleScript 选中文件
    #[cfg(target_os = "macos")]
    {
        if !p.is_dir() && p.exists() {
            let _ = std::process::Command::new("osascript")
                .args([
                    "-e",
                    &format!(
                        "tell application \"Finder\" to reveal POSIX file \"{}\"",
                        path.replace('"', "\\\"")
                    ),
                ])
                .status();
            let _ = std::process::Command::new("osascript")
                .args(["-e", "tell application \"Finder\" to activate"])
                .status();
            return Ok(());
        }
        // 目录：直接 Finder 打开
        std::process::Command::new("open").arg(&dir).status().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        if !p.is_dir() && p.exists() {
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .status()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        std::process::Command::new("explorer").arg(&dir).status().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .status()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    { Err("不支持的平台".into()) }
}

fn main() {
    imgserver::start();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = default_db_path();
            let conn = rusqlite::Connection::open(&path)
                .map_err(|e| format!("打开数据库失败 {}: {}", path, e))?;
            conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
                .ok();
            // download_records 去重保障 (2026-07-27, 同步 comic-app migration v6, 幂等):
            // 旧索引非 UNIQUE 导致 INSERT OR REPLACE 从未真正去重。
            // 先清存量重复(每组留最新), 再重建为 UNIQUE 索引。
            conn.execute_batch(
                "DELETE FROM download_records WHERE id NOT IN (\
                    SELECT MAX(id) FROM download_records GROUP BY comic_id, chapter_index);\
                 DROP INDEX IF EXISTS idx_downloads_comic_chapter;\
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_comic_chapter \
                    ON download_records(comic_id, chapter_index);",
            )
            .ok();
            let external = settings::external_download_root();
            eprintln!("[comiv] DB={} external_root={:?}", path, external);

            // 后台任务队列
            let queue = jobqueue::JobQueue::new(path.clone());
            queue.ensure_schema().ok();
            queue.recover().ok();
            queue.set_app(app.handle().clone());
            queue.start();
            eprintln!("[comiv] jobqueue 已启动（并发5）");

            app.manage(AppState {
                db: Mutex::new(conn),
                queue,
                external_root: Mutex::new(external),
            });
            register_window_events(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            comics_list,
            comics_count,
            comic_by_id,
            comic_by_url,
            category_stats,
            set_favorite,
            clear_update_delta,
            get_reading_progress,
            save_reading_progress,
            reading_history,
            delete_reading_progress,
            get_local_chapter_images,
            get_chapter_images,
            get_page_list,
            source_get_detail,
            source_search,
            download_chapter,
            queue_all_chapters,
            job_list,
            job_stats,
            job_remove,
            job_pause,
            job_resume,
            job_retry,
            job_retry_all,
            db_chapters_count,
            db_images_count,
            db_download_size,
            download_list_local,
            get_highest_downloaded_index,
            disk_get_space,
            run_sync_now,
            auto_scan_local,
            auto_enrich_all,
            clear_comics,
            count_missing_fields,
            pick_directory,
            settings_save,
            export_comic,
            settings_get,
            window_minimize,
            window_maximize,
            window_unmaximize,
            window_is_maximized,
            window_toggle_fullscreen,
            window_is_fullscreen,
            window_close,
            open_path,
            reveal_in_folder,
            crawler_crawl_all,
            crawler_enrich,
            crawler_enrich_chapters,
            crawler_check_updates,
            batch_delete_comics,
            batch_export_epub,
            cache_stats,
            cache_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}