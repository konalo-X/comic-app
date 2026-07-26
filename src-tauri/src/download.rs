// 下载引擎（移植 comic-app 的 downloadChapter 核心逻辑）
// 逐章：resolveComicDir → getPageList → 并发下载图片 → 转 webp 落盘 → 写 download_records + local_path + favorite
use crate::paths;
use crate::source;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const IMAGE_CONCURRENCY: usize = 5;
const MAX_RETRY: usize = 3;

#[derive(Clone)]
pub struct ChapterJob {
    pub comic_title: String,
    pub chapter_index: i64,
    pub chapter_name: String,
    pub chapter_url: String,
    pub referer: String,
    pub source_url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DownloadResult {
    pub success: bool,
    pub skipped: bool,
    pub downloaded: usize,
    pub total: usize,
    pub failed: usize,
    pub chapter: String,
    pub chapter_dir: String,
}

/// 解析漫画目录：优先 local_path/已存在目录，否则在主下载根下新建 sanitize(title)
fn resolve_comic_dir(
    comic_title: &str,
    local_path: Option<&str>,
    external_root: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(lp) = local_path {
        if !lp.trim().is_empty() {
            let p = PathBuf::from(lp);
            return Ok(p);
        }
    }
    if let Some(dir) = paths::find_comic_dir(comic_title, local_path, external_root) {
        return Ok(dir);
    }
    // 主下载根（外部盘优先，其存在时）
    let roots = paths::download_roots(external_root);
    let primary = roots
        .iter()
        .find(|r| r.starts_with("/Volumes/") && r.exists())
        .or_else(|| roots.first())
        .ok_or_else(|| "无可用下载根目录".to_string())?
        .clone();
    if primary.to_string_lossy().starts_with("/Volumes/") && !primary.exists() {
        return Err(format!("下载磁盘未挂载: {}", primary.display()));
    }
    let dir = primary.join(paths::sanitize_filename(comic_title));
    Ok(dir)
}

fn webp_out_path(ch_dir: &Path, idx: usize) -> PathBuf {
    ch_dir.join(format!("{:03}.webp", idx + 1))
}

/// 把任意图片 buffer 转 webp 落盘（quality 85）
fn convert_and_write_webp(buf: &[u8], out: &Path) -> Result<(), String> {
    // 已是 webp 直接写
    if buf.len() >= 12 && &buf[8..12] == b"WEBP" {
        std::fs::write(out, buf).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let img = image::load_from_memory(buf).map_err(|e| format!("解码失败: {}", e))?;
    let encoder = webp::Encoder::from_image(&img).map_err(|e| format!("webp 编码器: {}", e))?;
    let encoded = encoder.encode(85.0);
    std::fs::write(out, &*encoded).map_err(|e| e.to_string())?;
    Ok(())
}

/// 校验 webp 文件有效（存在且 >0 且魔数正确）
fn valid_webp(p: &Path) -> bool {
    match std::fs::read(p) {
        Ok(b) => b.len() > 12 && &b[8..12] == b"WEBP",
        Err(_) => false,
    }
}

/// 下载单个章节（同步阻塞；上层可放线程）
pub fn download_chapter(
    job: &ChapterJob,
    comic_dir: &Path,
    on_progress: Arc<dyn Fn(usize, usize) -> bool + Send + Sync>,
) -> Result<DownloadResult, String> {
    // 1) 取图片列表 —— 取之前先判断取消
    if !on_progress(0, 0) {
        return Err("cancelled".into());
    }
    let page = source::get_page_list(&job.chapter_url, &job.referer)?;
    let images = page.images;
    if images.is_empty() {
        return Err("章节无图片数据".into());
    }
    let ch_name = if job.chapter_name.is_empty() {
        page.chapter_name.clone()
    } else {
        job.chapter_name.clone()
    };

    // 2) 章节目录 folder = sanitize("{index+1}-{name}")
    let folder = paths::sanitize_filename(&format!("{}-{}", job.chapter_index + 1, ch_name));
    let ch_dir = comic_dir.join(&folder);
    std::fs::create_dir_all(&ch_dir).map_err(|e| format!("创建章节目录失败: {}", e))?;

    // 3) 找出需要下载的 index（已存在且有效则跳过）
    let mut to_download: Vec<usize> = Vec::new();
    for i in 0..images.len() {
        let out = webp_out_path(&ch_dir, i);
        if out.exists() && valid_webp(&out) {
            continue;
        }
        to_download.push(i);
    }

    let total = images.len();

    if to_download.is_empty() {
        // 全部存在已跳过：回调 100% 再返回
        let _ = on_progress(total, total);
        return Ok(DownloadResult {
            success: true,
            skipped: true,
            downloaded: 0,
            total,
            failed: 0,
            chapter: ch_name,
            chapter_dir: ch_dir.to_string_lossy().to_string(),
        });
    }

    // 回调跳过进度（当前已完成的 = total - to_download）
    let already_done = total - to_download.len();
    if !on_progress(already_done, total) {
        return Err("cancelled".into());
    }

    // 4) 并发下载（取消信号 + 每图进度回调）
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completed = Arc::new(AtomicUsize::new(already_done));
    let failed = Arc::new(AtomicUsize::new(0));
    let downloaded = Arc::new(AtomicUsize::new(0));
    let images = Arc::new(images);
    let ch_dir_a = Arc::new(ch_dir.clone());
    let referer = if job.referer.is_empty() {
        job.chapter_url.clone()
    } else {
        job.referer.clone()
    };

    // 把 on_progress 拆到各线程共享（已由调用方包在 Arc 里，直接 clone）
    let cb = Arc::clone(&on_progress);

    let chunks: Vec<Vec<usize>> = {
        let mut buckets: Vec<Vec<usize>> = (0..IMAGE_CONCURRENCY).map(|_| Vec::new()).collect();
        for (n, &idx) in to_download.iter().enumerate() {
            buckets[n % IMAGE_CONCURRENCY].push(idx);
        }
        buckets
    };

    let mut handles = Vec::new();
    for bucket in chunks {
        if bucket.is_empty() {
            continue;
        }
        let images = Arc::clone(&images);
        let ch_dir_a = Arc::clone(&ch_dir_a);
        let completed = Arc::clone(&completed);
        let failed = Arc::clone(&failed);
        let downloaded = Arc::clone(&downloaded);
        let cancelled = Arc::clone(&cancelled);
        let cb = Arc::clone(&cb);
        let referer = referer.clone();
        let total_c = total;
        let handle = std::thread::spawn(move || {
            for idx in bucket {
                // 每图开始前先判断取消
                if cancelled.load(Ordering::SeqCst) {
                    break;
                }
                let url = &images[idx];
                let mut ok = false;
                for attempt in 0..MAX_RETRY {
                    if cancelled.load(Ordering::SeqCst) {
                        break;
                    }
                    match source::fetch_image(url, &referer) {
                        Ok(buf) if !buf.is_empty() => {
                            let out = ch_dir_a.join(format!("{:03}.webp", idx + 1));
                            match convert_and_write_webp(&buf, &out) {
                                Ok(_) => {
                                    downloaded.fetch_add(1, Ordering::SeqCst);
                                    ok = true;
                                    break;
                                }
                                Err(_) => {}
                            }
                        }
                        _ => {}
                    }
                    if attempt + 1 < MAX_RETRY {
                        std::thread::sleep(std::time::Duration::from_millis(
                            800 * (attempt as u64 + 1),
                        ));
                        if cancelled.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                }
                if !ok {
                    failed.fetch_add(1, Ordering::SeqCst);
                }
                let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                // 每完成一张图：回调一次进度，若返回 false 则全局设置取消
                if !cb(done, total_c) {
                    cancelled.store(true, Ordering::SeqCst);
                }
                let _ = done;
                let _ = total_c;
            }
        });
        handles.push(handle);
    }

    // 主线程等待所有 worker，期间检查是否已被取消（cb 返回 false 时 cancelled=true）
    for h in handles {
        let _ = h.join();
    }
    let dl = downloaded.load(Ordering::SeqCst);
    let fl = failed.load(Ordering::SeqCst);
    // 回调最终进度
    let _ = on_progress(total, total);
    if cancelled.load(Ordering::SeqCst) && fl + dl < to_download.len() {
        return Err("cancelled".into());
    }

    Ok(DownloadResult {
        success: fl == 0,
        skipped: false,
        downloaded: dl,
        total,
        failed: fl,
        chapter: ch_name,
        chapter_dir: ch_dir.to_string_lossy().to_string(),
    })
}

/// 下载后写 DB：download_records + local_path + favorite（仅全部有效才标 success）
pub fn persist_chapter_result(
    conn: &Connection,
    job: &ChapterJob,
    result: &DownloadResult,
) -> rusqlite::Result<()> {
    let ch_dir = Path::new(&result.chapter_dir);
    let valid = paths::list_chapter_images(ch_dir)
        .iter()
        .filter(|p| valid_webp(p))
        .count() as i64;
    let status = if result.failed == 0 && valid as usize >= result.total && result.total > 0 {
        "success"
    } else {
        "partial"
    };
    let comic_id = if job.source_url.is_empty() {
        job.comic_title.clone()
    } else {
        job.source_url.clone()
    };
    conn.execute(
        "INSERT OR REPLACE INTO download_records \
         (comic_id, comic_title, chapter_index, chapter_name, images_count, path, url, status, downloaded_at) \
         VALUES (?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            comic_id,
            job.comic_title,
            job.chapter_index,
            result.chapter,
            valid,
            result.chapter_dir,
            job.chapter_url,
            status,
            crate::db::now_ms(),
        ],
    )?;
    // local_path = 章节目录的父目录（漫画目录）
    if let Some(comic_dir) = ch_dir.parent() {
        let _ = conn.execute(
            "UPDATE comics SET local_path = ? WHERE sourceUrl = ? OR id = ?",
            rusqlite::params![comic_dir.to_string_lossy(), job.source_url, comic_id],
        );
    }
    // 下载即收藏
    let _ = conn.execute(
        "UPDATE comics SET favorited = 1 WHERE sourceUrl = ? OR id = ?",
        rusqlite::params![job.source_url, comic_id],
    );
    Ok(())
}

pub fn resolve_dir_for(
    comic_title: &str,
    local_path: Option<&str>,
    external_root: Option<&str>,
) -> Result<PathBuf, String> {
    let dir = resolve_comic_dir(comic_title, local_path, external_root)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建漫画目录失败: {}", e))?;
    Ok(dir)
}