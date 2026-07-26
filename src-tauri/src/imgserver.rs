// 本地图片代理 HTTP 服务，端口 48123
// 复刻 comic-app 的 getLocalProxyUrl 契约：GET /local?p=<base64(绝对路径)>
// 使 Reader.vue 无需改动即可直接 <img src="http://127.0.0.1:48123/local?p=..."> 显示已下载图片。
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::thread;
use tiny_http::{Header, Response, Server};

use crate::{settings, source};

pub const PROXY_PORT: u16 = 48123;

/// 远程图片磁盘缓存目录
fn cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let d = base.join("comiv").join("img-cache");
    let _ = fs::create_dir_all(&d);
    d
}

/// 允许 /local 端点读取的目录白名单（防止路径穿越）
fn allowed_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    // 1) 外部下载根（用户配置的移动硬盘/主目录下的下载目录）
    if let Some(ext) = settings::external_download_root() {
        let p = PathBuf::from(&ext);
        if p.exists() {
            roots.push(p);
        }
    }
    // 2) 老应用的 data 目录（兼容旧 local_path）
    if let Some(base) = dirs::data_dir() {
        let legacy = base.join("comic-app");
        if legacy.exists() {
            roots.push(legacy);
        }
        // 本应用的 data 目录
        let ours = base.join("com.konalo.comiv");
        roots.push(ours);
    }
    // 3) 远程图片缓存目录（一般不会直接读，但防万一）
    roots.push(cache_dir());
    // 4) /Volumes 下的所有挂载卷（用户可能把漫画放别的盘）
    let volumes = PathBuf::from("/Volumes");
    if volumes.exists() {
        if let Ok(rd) = fs::read_dir(&volumes) {
            for entry in rd.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    roots.push(p);
                }
            }
        }
    }
    // 5) HOME（兜底：用户主目录下的任何图片，但拒绝系统目录）
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(home));
    }
    roots
}

/// 检查路径是否在允许的白名单目录内（canonicalize 后前缀匹配）
fn is_path_allowed(path: &Path) -> bool {
    let canonical = match fs::canonicalize(path) {
        Ok(p) => p,
        Err(_) => return false,
    };
    for root in allowed_roots() {
        let root_c = fs::canonicalize(&root).unwrap_or(root);
        if canonical.starts_with(&root_c) {
            return true;
        }
    }
    eprintln!(
        "[imgserver] 拒绝访问非白名单路径: {}（allowed={:?}）",
        canonical.display(),
        allowed_roots().iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    );
    false
}

fn cache_path_for(url: &str) -> PathBuf {
    let mut h = Sha256::new();
    h.update(url.as_bytes());
    let digest = h.finalize();
    let name = format!("{:x}", digest);
    cache_dir().join(name)
}

pub fn start() {
    thread::spawn(|| {
        let addr = format!("127.0.0.1:{}", PROXY_PORT);
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[imgserver] 启动失败 {}: {}", addr, e);
                return;
            }
        };
        eprintln!("[imgserver] 本地图片代理已就绪 http://{}", addr);
        for request in server.incoming_requests() {
            let url = request.url().to_string();
            if let Some(qs) = url.strip_prefix("/local?") {
                match serve_local(qs) {
                    Some((bytes, mime)) => {
                        let _ = request.respond(bytes_response(bytes, &mime));
                    }
                    None => {
                        let _ = request.respond(Response::from_string("not found").with_status_code(404));
                    }
                }
            } else if let Some(qs) = url.strip_prefix("/img?") {
                match serve_remote(qs) {
                    Some((bytes, mime)) => {
                        let _ = request.respond(bytes_response(bytes, &mime));
                    }
                    None => {
                        let _ = request.respond(Response::from_string("not found").with_status_code(404));
                    }
                }
            } else if url == "/health" {
                let _ = request.respond(Response::from_string("ok"));
            } else {
                let _ = request.respond(Response::from_string("bad request").with_status_code(400));
            }
        }
    });
}

fn bytes_response(bytes: Vec<u8>, mime: &str) -> Response<Cursor<Vec<u8>>> {
    let header = Header::from_bytes(&b"Content-Type"[..], mime.as_bytes())
        .unwrap_or_else(|_| Header::from_bytes(&b"Content-Type"[..], &b"image/jpeg"[..]).unwrap());
    let cache = Header::from_bytes(&b"Cache-Control"[..], &b"public, max-age=31536000"[..])
        .unwrap_or_else(|_| Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap());
    let len = bytes.len();
    Response::new(
        tiny_http::StatusCode(200),
        vec![header, cache],
        Cursor::new(bytes),
        Some(len),
        None,
    )
}

fn parse_query<'a>(qs: &'a str, key: &str) -> Option<String> {
    for pair in qs.split('&') {
        if let Some(v) = pair.strip_prefix(&format!("{}=", key)) {
            let dec = urlencoding::decode(v).ok()?.into_owned();
            let bytes = base64::engine::general_purpose::STANDARD.decode(dec.as_bytes()).ok()?;
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

/// /img?u=<b64(url)>&r=<b64(referer)> —— 远程图片抓取 + 磁盘缓存
fn serve_remote(qs: &str) -> Option<(Vec<u8>, String)> {
    let image_url = parse_query(qs, "u")?;
    let referer = parse_query(qs, "r").unwrap_or_default();
    if image_url.is_empty() {
        return None;
    }
    let cpath = cache_path_for(&image_url);
    if let Ok(bytes) = fs::read(&cpath) {
        if !bytes.is_empty() {
            return Some((bytes.clone(), sniff_mime(&bytes)));
        }
    }
    let bytes = source::fetch_image(&image_url, &referer).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let _ = fs::write(&cpath, &bytes);
    let mime = sniff_mime(&bytes);
    Some((bytes, mime))
}

fn sniff_mime(buf: &[u8]) -> String {
    if buf.len() >= 12 {
        if buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4E {
            return "image/png".into();
        }
        if buf[0] == 0xFF && buf[1] == 0xD8 {
            return "image/jpeg".into();
        }
        if buf[0] == 0x47 && buf[1] == 0x49 && buf[2] == 0x46 {
            return "image/gif".into();
        }
        if &buf[8..12] == b"WEBP" {
            return "image/webp".into();
        }
    }
    "image/jpeg".into()
}

fn serve_local(qs: &str) -> Option<(Vec<u8>, String)> {
    // qs 形如 p=<urlencoded(base64)>
    let mut p_val: Option<String> = None;
    for pair in qs.split('&') {
        if let Some(v) = pair.strip_prefix("p=") {
            p_val = Some(urlencoding::decode(v).ok()?.into_owned());
        }
    }
    let b64 = p_val?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .ok()?;
    let path_str = String::from_utf8(decoded).ok()?;
    let path = Path::new(&path_str);
    if !path.exists() || !path.is_file() {
        return None;
    }
    // 🔒 路径白名单校验：防止路径穿越读取系统敏感文件
    if !is_path_allowed(path) {
        return None;
    }
    // 额外保险：只允许图片扩展名
    let lower = path_str.to_lowercase();
    let is_image = lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
        || lower.ends_with(".avif");
    if !is_image {
        eprintln!("[imgserver] 拒绝读取非图片文件: {}", path_str);
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let mime = guess_mime(&path_str);
    Some((bytes, mime))
}

fn guess_mime(path: &str) -> String {
    let lower = path.to_lowercase();
    let m = if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/jpeg"
    };
    m.to_string()
}

/// 生成与前端一致的本地代理 URL
pub fn local_proxy_url(file_path: &str) -> String {
    let clean = file_path.strip_prefix("file://").unwrap_or(file_path);
    let encoded = base64::engine::general_purpose::STANDARD.encode(clean.as_bytes());
    format!(
        "http://127.0.0.1:{}/local?p={}",
        PROXY_PORT,
        urlencoding::encode(&encoded)
    )
}

/// 生成远程图片代理 URL（对齐 getProxyImageUrl）
pub fn proxy_image_url(image_url: &str, referer: &str) -> String {
    if image_url.is_empty() {
        return String::new();
    }
    let eu = base64::engine::general_purpose::STANDARD.encode(image_url.as_bytes());
    let er = base64::engine::general_purpose::STANDARD.encode(
        if referer.is_empty() { image_url } else { referer }.as_bytes(),
    );
    format!(
        "http://127.0.0.1:{}/img?u={}&r={}",
        PROXY_PORT,
        urlencoding::encode(&eu),
        urlencoding::encode(&er)
    )
}