// 下载目录解析 + 本地章节图片枚举
// 移植自 comic-app/electron/modules/downloadPaths.js 的只读部分
use std::fs;
use std::path::{Path, PathBuf};

/// sanitizeFilename 的 Rust 版（与 utils.js 对齐）
pub fn sanitize_filename(n: &str) -> String {
    let mut s = String::with_capacity(n.len());
    for ch in n.chars() {
        match ch {
            '<' | '>' | '"' | '/' | '\\' | '|' | '*' => s.push('_'),
            c if (c as u32) < 0x20 => s.push('_'),
            ':' => s.push('：'),
            '!' => s.push('！'),
            '?' => s.push('？'),
            c => s.push(c),
        }
    }
    s.trim().to_string()
}

/// normalizeName：只保留中/日/韩/字母/数字并小写（与 utils.js 对齐）
pub fn normalize_name(s: &str) -> String {
    let mut out = String::new();
    for ch in s.trim().chars() {
        let keep = matches!(ch as u32,
            0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x3040..=0x30FF | 0xAC00..=0xD7AF)
            || ch.is_ascii_alphanumeric();
        if keep {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

/// 下载根目录候选：内置 documents/comic-downloads + 外部盘 + 系统 Downloads
pub fn download_roots(external_root: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(docs) = dirs::document_dir() {
        roots.push(docs.join("comic-downloads"));
    }
    if let Some(ext) = external_root {
        if !ext.is_empty() {
            let p = PathBuf::from(ext);
            if p.exists() && !roots.contains(&p) {
                roots.push(p);
            }
        }
    }
    if let Some(dl) = dirs::download_dir() {
        if !roots.contains(&dl) {
            roots.push(dl);
        }
    }
    roots
}

/// 优先用 comics.local_path；否则在各下载根下按标题（sanitize / 原名 / normalize 相等）查找
pub fn find_comic_dir(
    title: &str,
    local_path: Option<&str>,
    external_root: Option<&str>,
) -> Option<PathBuf> {
    let roots = download_roots(external_root);
    let root_set: Vec<PathBuf> = roots.iter().filter_map(|r| r.canonicalize().ok()).collect();

    if let Some(lp) = local_path {
        if !lp.is_empty() {
            let p = PathBuf::from(lp);
            if p.exists() {
                let canon = p.canonicalize().ok();
                let is_root = canon.map(|c| root_set.contains(&c)).unwrap_or(false);
                if !is_root {
                    return Some(p);
                }
            }
        }
    }

    let norm_title = normalize_name(title);
    let candidates = [sanitize_filename(title), title.to_string()];
    for root in &roots {
        for c in &candidates {
            let p = root.join(c);
            if p.exists() {
                return Some(p);
            }
        }
        if let Ok(entries) = fs::read_dir(root) {
            for e in entries.flatten() {
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let name = e.file_name().to_string_lossy().to_string();
                    let nd = normalize_name(&name);
                    if !nd.is_empty() && !norm_title.is_empty() && nd == norm_title {
                        return Some(root.join(name));
                    }
                }
            }
        }
    }
    None
}

/// 列出一个章节目录下的图片（按文件名内数字排序）
pub fn list_chapter_images(chapter_dir: &Path) -> Vec<PathBuf> {
    if !chapter_dir.exists() {
        return Vec::new();
    }
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(chapter_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".webp")
                || name.ends_with(".jpg")
                || name.ends_with(".jpeg")
                || name.ends_with(".png")
                || name.ends_with(".gif")
                || name.ends_with(".avif")
                || name.ends_with(".bmp")
            {
                files.push(e.path());
            }
        }
    }
    files.sort_by(|a, b| {
        let na = first_num(a);
        let nb = first_num(b);
        na.cmp(&nb)
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });
    files
}

fn first_num(p: &Path) -> u64 {
    let name = p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    let mut digits = String::new();
    for c in name.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().unwrap_or(99999)
}

/// 在漫画目录下按章节序号（+可选章名）匹配章节子目录
/// 目录格式：`序号-章节名`（序号 1 基）
pub fn find_chapter_dir(comic_dir: &Path, chapter_index: i64, chapter_name: &str) -> Option<PathBuf> {
    if !comic_dir.exists() {
        return None;
    }
    let entries: Vec<(String, PathBuf)> = fs::read_dir(comic_dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect();

    let norm_name = normalize_name(chapter_name);

    // 1) 序号+章名精确匹配
    for (name, path) in &entries {
        if let Some((idx, dir_ch)) = parse_seq_name(name) {
            if idx == chapter_index {
                let nd = normalize_name(&dir_ch);
                let matched = chapter_name == dir_ch
                    || sanitize_filename(chapter_name) == dir_ch
                    || (!nd.is_empty() && !norm_name.is_empty() && nd == norm_name);
                if matched {
                    let files = list_chapter_images(path);
                    if files.len() > 3 || (!files.is_empty() && chapter_name.is_empty()) {
                        return Some(path.clone());
                    }
                }
            }
        }
    }

    // 2) 仅按序号匹配（数量 > 3）
    for (name, path) in &entries {
        if let Some((idx, _)) = parse_seq_name_loose(name) {
            if idx == chapter_index {
                let files = list_chapter_images(path);
                if files.len() > 3 {
                    return Some(path.clone());
                }
            }
        }
    }

    // 3) 数字目录按顺序取第 index 个（容差 2）
    let mut numbered: Vec<(u64, PathBuf)> = entries
        .iter()
        .filter_map(|(name, path)| leading_num(name).map(|n| (n, path.clone())))
        .collect();
    numbered.sort_by_key(|(n, _)| *n);
    if let Some((num, path)) = numbered.get(chapter_index as usize) {
        if (*num as i64 - (chapter_index + 1)).abs() <= 2 {
            let files = list_chapter_images(path);
            if files.len() > 3 {
                return Some(path.clone());
            }
        }
    }
    None
}

fn parse_seq_name(name: &str) -> Option<(i64, String)> {
    // `123-章节名`
    let dash = name.find('-')?;
    let (num, rest) = name.split_at(dash);
    let idx: i64 = num.parse().ok()?;
    Some((idx - 1, rest[1..].to_string()))
}

fn parse_seq_name_loose(name: &str) -> Option<(i64, String)> {
    let n = leading_num(name)?;
    Some((n as i64 - 1, name.to_string()))
}

fn leading_num(name: &str) -> Option<u64> {
    let digits: String = name.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}
