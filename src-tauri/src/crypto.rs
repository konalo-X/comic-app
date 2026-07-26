// settings 敏感字段轻量加密（防"人眼扫到明文"级别的保护）
//  - 不是安全加密：key 直接硬编码在二进制里；但比明文安全一个量级（防止 cat/搜索泄漏）
//  - 加密格式：$XOR1$<base64(ciphertext)>
//  - 目标字段：proxyPassword, cookies, userToken, authorization

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{Map, Value};

const PREFIX: &str = "$XOR1$";
const KEY: [u8; 32] = [
    0x5c, 0x12, 0x7a, 0x9f, 0x63, 0x8b, 0x41, 0xe0,
    0xd5, 0x08, 0x2c, 0x7e, 0x93, 0xba, 0xef, 0x11,
    0x66, 0x48, 0x30, 0x8a, 0xcd, 0x27, 0x55, 0xfe,
    0x1a, 0xc1, 0x03, 0xdb, 0x79, 0xa5, 0xb6, 0x4c,
];
const SENSITIVE_KEYS: &[&str] = &[
    "proxyPassword",
    "proxy_password",
    "cookies",
    "userToken",
    "user_token",
    "authorization",
    "access_token",
    "cookie",
    "password",
];

fn xor_bytes(plain: &[u8]) -> Vec<u8> {
    plain.iter().enumerate().map(|(i, b)| b ^ KEY[i % KEY.len()]).collect()
}

fn encrypt_str(s: &str) -> String {
    if s.is_empty() { return s.into(); }
    if s.starts_with(PREFIX) { return s.into(); }
    let c = xor_bytes(s.as_bytes());
    format!("{}{}", PREFIX, B64.encode(c))
}

fn decrypt_str(s: &str) -> Option<String> {
    if !s.starts_with(PREFIX) { return None; }
    let b = B64.decode(&s[PREFIX.len()..]).ok()?;
    let p = xor_bytes(&b);
    String::from_utf8(p).ok()
}

pub fn encrypt_sensitive(v: &mut Value) {
    match v {
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if let Some(mut child) = map.get_mut(&k) {
                    if is_sensitive_key(&k) {
                        if let Some(s) = child.as_str().map(|s| s.to_string()) {
                            *child = Value::String(encrypt_str(&s));
                        } else if let Value::Object(_) | Value::Array(_) = child {
                            encrypt_sensitive(&mut child);
                        }
                    } else {
                        encrypt_sensitive(&mut child);
                    }
                }
            }
        }
        Value::Array(arr) => {
            for child in arr.iter_mut() {
                encrypt_sensitive(child);
            }
        }
        _ => {}
    }
}

pub fn decrypt_sensitive(v: &mut Value) {
    match v {
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if let Some(mut child) = map.get_mut(&k) {
                    if let Some(s) = child.as_str().map(|s| s.to_string()) {
                        if let Some(de) = decrypt_str(&s) {
                            *child = Value::String(de);
                        }
                    } else {
                        decrypt_sensitive(&mut child);
                    }
                }
            }
        }
        Value::Array(arr) => {
            for child in arr.iter_mut() {
                if let Some(s) = child.as_str().map(|s| s.to_string()) {
                    if let Some(de) = decrypt_str(&s) {
                        *child = Value::String(de);
                    }
                } else {
                    decrypt_sensitive(child);
                }
            }
        }
        _ => {}
    }
}

fn is_sensitive_key(k: &str) -> bool {
    let lower = k.to_lowercase();
    SENSITIVE_KEYS.iter().any(|s| lower == s.to_lowercase() || lower.contains(*s))
}

/// 仅用于测试：允许外部用（未使用时避免 dead_code）
#[allow(dead_code)]
pub fn test_roundtrip(s: &str) -> bool {
    let enc = encrypt_str(s);
    let dec = decrypt_str(&enc);
    dec.as_deref() == Some(s)
}

/// 迁移旧 settings JSON（Map），把已经是明文的敏感字段升级为加密格式
///  —— 调用者：load_settings 最后一步返回前
pub fn ensure_encrypted(map: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    for (k, v) in map.iter_mut() {
        if is_sensitive_key(k) {
            if let Some(s) = v.as_str() {
                if !s.starts_with(PREFIX) && !s.is_empty() {
                    *v = Value::String(encrypt_str(s));
                    changed = true;
                }
            } else if let Value::Object(m) = v {
                changed |= ensure_encrypted(m);
            }
        } else if let Value::Object(m) = v {
            changed |= ensure_encrypted(m);
        } else if let Value::Array(_) = v {
            // array 里的对象也要处理
            encrypt_sensitive(v);
            changed = true;
        }
    }
    changed
}