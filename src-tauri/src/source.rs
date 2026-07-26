// smtt6 源站解析（移植自 comic-app/electron/sources/smtt6.js 的只读抓取部分）
// 用 reqwest(blocking) + scraper 复刻 _fetch / getPageList / getDetail / search。
use scraper::{Html, Selector};
use serde::Serialize;
use std::time::Duration;

pub const BASE_URL: &str = "https://smtt6.com";
const TIMEOUT_SECS: u64 = 30;

const UA_LIST: &[&str] = &[
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];

static HTTP_CLIENT: std::sync::OnceLock<reqwest::blocking::Client> = std::sync::OnceLock::new();

#[derive(Serialize, Clone)]
pub struct PageList {
    pub images: Vec<String>,
    pub chapter_name: String,
}

#[derive(Serialize, Clone)]
pub struct DetailChapter {
    pub name: String,
    pub url: String,
}

#[derive(Serialize, Clone)]
pub struct ComicDetail {
    pub title: String,
    pub cover: String,
    pub author: String,
    pub desc: String,
    pub status: String,
    pub tags: Vec<String>,
    pub chapters: Vec<DetailChapter>,
}

#[derive(Serialize, Clone)]
pub struct SearchItem {
    pub title: String,
    pub cover: String,
    pub source_url: String,
    pub author: String,
}

fn pick_ua() -> &'static str {
    let n = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)) as usize;
    UA_LIST[n % UA_LIST.len()]
}

/// 全局单例 HTTP 客户端（复用 TCP/TLS 连接池，避免每次新建）
fn client() -> &'static reqwest::blocking::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .cookie_store(true)
            .pool_max_idle_per_host(8)
            .build()
            .unwrap_or_else(|_| {
                // 构建失败时兜底：最简配置
                reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(TIMEOUT_SECS))
                    .build()
                    .expect("http client fallback must build")
            })
    })
}

pub fn absolute_url(href: &str, base: &str) -> String {
    if href.is_empty() {
        return String::new();
    }
    match reqwest::Url::parse(base).and_then(|b| b.join(href)) {
        Ok(u) => u.to_string(),
        Err(_) => href.to_string(),
    }
}

/// 抓取页面 HTML（带 UA / Referer / gbk 兜底解码）
pub fn fetch_html(url: &str, referer: &str) -> Result<String, String> {
    let cli = client();
    let ref_final = if referer.is_empty() {
        format!("{}/", BASE_URL)
    } else {
        referer.to_string()
    };
    let resp = cli
        .get(url)
        .header("User-Agent", pick_ua())
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Referer", ref_final)
        .header("Upgrade-Insecure-Requests", "1")
        .send()
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let bytes = resp.bytes().map_err(|e| format!("读取 body 失败: {}", e))?;
    let html = if ct.contains("charset=gbk") || ct.contains("gb2312") {
        let (cow, _, _) = encoding_rs::GBK.decode(&bytes);
        cow.into_owned()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(html)
}

fn looks_like_image(u: &str) -> bool {
    let low = u.to_lowercase();
    low.ends_with(".jpg")
        || low.ends_with(".jpeg")
        || low.ends_with(".png")
        || low.ends_with(".webp")
        || low.ends_with(".gif")
        || low.ends_with(".bmp")
        || low.contains(".jpg?")
        || low.contains(".jpeg?")
        || low.contains(".png?")
        || low.contains(".webp?")
        || low.contains(".gif?")
        || low.contains("image")
        || low.contains("img")
        || low.contains("/pic/")
        || low.contains("/photo/")
}

/// 解析章节图片列表（移植 getPageList）
pub fn get_page_list(chapter_url: &str, referer: &str) -> Result<PageList, String> {
    let html = fetch_html(chapter_url, referer)?;
    let doc = Html::parse_document(&html);
    let mut images: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let add = |u: &str, images: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        if u.is_empty() {
            return;
        }
        let abs = absolute_url(u, chapter_url);
        if abs.is_empty() || seen.contains(&abs) {
            return;
        }
        if !looks_like_image(&abs) && !abs.starts_with("http") {
            return;
        }
        seen.insert(abs.clone());
        images.push(abs);
    };

    // 1) <img> 的 data-original/data-src/... /src
    if let Ok(img_sel) = Selector::parse("img") {
        let attrs = [
            "data-original",
            "data-src",
            "data-lazy-src",
            "data-url",
            "data-img",
            "src",
        ];
        for el in doc.select(&img_sel) {
            for a in attrs {
                if let Some(v) = el.value().attr(a) {
                    add(v, &mut images, &mut seen);
                }
            }
        }
    }

    // 2) <script> 内的图片数组/URL（正则）
    if images.len() < 3 {
        if let Ok(script_sel) = Selector::parse("script") {
            let url_re = regex_lite_urls();
            for el in doc.select(&script_sel) {
                let text = el.text().collect::<String>();
                for u in url_re(&text) {
                    add(&u, &mut images, &mut seen);
                }
            }
        }
    }

    let chapter_name = {
        Selector::parse("h2")
            .ok()
            .and_then(|sel| doc.select(&sel).next().map(|e| e.text().collect::<String>().trim().to_string()))
            .unwrap_or_default()
    };

    Ok(PageList {
        images,
        chapter_name,
    })
}

/// 极简 URL 抽取（避免引入 regex crate；扫描 http(s) 图片链接）
fn regex_lite_urls() -> impl Fn(&str) -> Vec<String> {
    |text: &str| {
        let mut out = Vec::new();
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if text[i..].starts_with("http://") || text[i..].starts_with("https://") {
                let mut j = i;
                while j < bytes.len() {
                    let c = bytes[j] as char;
                    if c.is_whitespace()
                        || c == '"'
                        || c == '\''
                        || c == '\\'
                        || c == '<'
                        || c == '>'
                        || c == ')'
                        || c == ']'
                    {
                        break;
                    }
                    j += 1;
                }
                let url = &text[i..j];
                if looks_like_image(url) {
                    out.push(url.to_string());
                }
                i = j;
            } else {
                i += 1;
            }
        }
        out
    }
}

/// 解析漫画详情 + 章节列表（移植 getDetail 的关键选择器）
pub fn get_detail(url: &str) -> Result<ComicDetail, String> {
    let html = fetch_html(url, "")?;
    let doc = Html::parse_document(&html);

    let text_of = |selector: &str| -> String {
        Selector::parse(selector)
            .ok()
            .and_then(|s| doc.select(&s).next().map(|e| e.text().collect::<String>().trim().to_string()))
            .unwrap_or_default()
    };
    let attr_of = |selector: &str, attr: &str| -> String {
        Selector::parse(selector)
            .ok()
            .and_then(|s| doc.select(&s).next().and_then(|e| e.value().attr(attr).map(|v| v.to_string())))
            .unwrap_or_default()
    };

    let title = {
        let t = text_of("h1");
        if t.is_empty() {
            text_of(".comic-title")
        } else {
            t
        }
    };
    let cover = {
        let c = attr_of(".comic-cover img", "src");
        if c.is_empty() {
            attr_of(".cover img", "src")
        } else {
            c
        }
    };
    let cover = absolute_url(&cover, url);

    // 章节：常见 .chapter-list a / .chapter a / ul li a
    let mut chapters: Vec<DetailChapter> = Vec::new();
    for sel_str in [".chapter-list a", ".chapter a", ".chapters a", "#chapter-list a", ".list a"] {
        if let Ok(sel) = Selector::parse(sel_str) {
            for el in doc.select(&sel) {
                let href = el.value().attr("href").unwrap_or("");
                if href.is_empty() {
                    continue;
                }
                let name = el.text().collect::<String>().trim().to_string();
                let abs = absolute_url(href, url);
                chapters.push(DetailChapter { name, url: abs });
            }
        }
        if !chapters.is_empty() {
            break;
        }
    }

    Ok(ComicDetail {
        title,
        cover,
        author: String::new(),
        desc: text_of(".comic-desc"),
        status: String::new(),
        tags: Vec::new(),
        chapters,
    })
}

/// 搜索（移植 search 的关键选择器）
pub fn search(query: &str, page: i64) -> Result<Vec<SearchItem>, String> {
    let url = format!(
        "{}/search?keyword={}&page={}",
        BASE_URL,
        urlencoding::encode(query),
        page.max(1)
    );
    let html = fetch_html(&url, "")?;
    let doc = Html::parse_document(&html);
    let mut items = Vec::new();
    for sel_str in [".comic-item", ".book-item", ".list-item", ".comic-list li"] {
        if let Ok(sel) = Selector::parse(sel_str) {
            for el in doc.select(&sel) {
                let a = Selector::parse("a").ok().and_then(|s| el.select(&s).next());
                let img = Selector::parse("img").ok().and_then(|s| el.select(&s).next());
                let href = a.as_ref().and_then(|e| e.value().attr("href")).unwrap_or("");
                if href.is_empty() {
                    continue;
                }
                let title = a
                    .as_ref()
                    .map(|e| e.text().collect::<String>().trim().to_string())
                    .unwrap_or_default();
                let cover = img
                    .as_ref()
                    .and_then(|e| e.value().attr("src").or_else(|| e.value().attr("data-src")))
                    .unwrap_or("");
                items.push(SearchItem {
                    title,
                    cover: absolute_url(cover, BASE_URL),
                    source_url: absolute_url(href, BASE_URL),
                    author: String::new(),
                });
            }
        }
        if !items.is_empty() {
            break;
        }
    }
    Ok(items)
}

/// 抓取远程图片（用于 /img 代理与下载）
pub fn fetch_image(image_url: &str, referer: &str) -> Result<Vec<u8>, String> {
    let cli = client();
    let ref_final = if referer.is_empty() {
        image_url
    } else {
        referer
    };
    let resp = cli
        .get(image_url)
        .header("User-Agent", pick_ua())
        .header("Referer", ref_final)
        .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .send()
        .map_err(|e| format!("图片请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("图片 HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().map_err(|e| format!("图片 body 失败: {}", e))?;
    Ok(bytes.to_vec())
}