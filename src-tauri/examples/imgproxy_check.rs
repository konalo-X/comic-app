// 验证 /img 远程代理 + 磁盘缓存
#[path = "../src/source.rs"]
mod source;
#[path = "../src/imgserver.rs"]
mod imgserver;

use std::io::Read;

fn http_get(url: &str) -> (u16, String, usize) {
    // 用 reqwest blocking 直接打本机代理
    let cli = reqwest::blocking::Client::new();
    match cli.get(url).send() {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let ct = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let mut buf = Vec::new();
            let mut r = resp;
            let _ = r.read_to_end(&mut buf);
            (code, ct, buf.len())
        }
        Err(e) => {
            println!("  req err: {}", e);
            (0, String::new(), 0)
        }
    }
}

fn main() {
    imgserver::start();
    std::thread::sleep(std::time::Duration::from_millis(500));

    let remote = "http://127.0.0.1:8899/remote001.webp";
    let purl = imgserver::proxy_image_url(remote, "http://127.0.0.1:8899/");
    println!("proxy url = {}", purl);

    println!("\n== 第一次请求（MISS，走网络抓取+缓存）==");
    let (c1, t1, s1) = http_get(&purl);
    println!("  code={} type={} size={}", c1, t1, s1);

    println!("\n== 第二次请求（HIT，走磁盘缓存）==");
    let (c2, t2, s2) = http_get(&purl);
    println!("  code={} type={} size={}", c2, t2, s2);

    assert_eq!(c1, 200, "首次代理失败");
    assert_eq!(c2, 200, "缓存代理失败");
    assert_eq!(s1, s2, "两次大小不一致");
    assert!(t1.contains("webp"), "MIME 识别失败: {}", t1);
    println!("\n✅ /img 远程代理 + 磁盘缓存验证通过 ({} 字节, {})", s1, t1);
}
