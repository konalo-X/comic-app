// 读取用户设置。
// 优先使用本 App 的独立目录：~/Library/Application Support/com.konalo.comiv/settings.json
// 若本 App 目录无配置，自动从旧版 comic-app 做一次性迁移（用户不用重新配置）。
// 敏感字段（password/cookies/token/proxyPassword）自动加密（$XOR1$ 前缀）。
use crate::crypto;
use serde_json::{Map, Value};
use std::path::PathBuf;

const APP_ID: &str = "com.konalo.comiv";
const LEGACY_ID: &str = "comic-app";

fn data_dir() -> Option<PathBuf> {
    dirs::data_dir()
}

/// 新版（本 App）settings.json 路径
fn our_settings_path() -> Option<PathBuf> {
    let base = data_dir()?;
    let d = base.join(APP_ID);
    std::fs::create_dir_all(&d).ok()?;
    Some(d.join("settings.json"))
}

/// 旧版 comic-app settings.json 路径（只读迁移用）
fn legacy_settings_path() -> Option<PathBuf> {
    let base = data_dir()?;
    Some(base.join(LEGACY_ID).join("settings.json"))
}

/// 加载设置：优先本 App 目录；不存在则尝试迁移旧版。
pub fn load_settings() -> Value {
    let mut loaded = None::<Value>;
    // 1) 读新版路径
    if let Some(p) = our_settings_path() {
        if p.exists() {
            if let Ok(txt) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    loaded = Some(v);
                }
            }
        }
    }
    // 2) 新版不存在，尝试从旧版 comic-app 读取 + 一次性迁移落盘
    if loaded.is_none() {
        if let Some(legacy) = legacy_settings_path() {
            if legacy.exists() {
                if let Ok(txt) = std::fs::read_to_string(&legacy) {
                    if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                        eprintln!(
                            "[settings] 检测到旧版配置（{}），自动迁移到 {}",
                            legacy.display(),
                            our_settings_path()
                                .map(|p| p.display().to_string())
                                .unwrap_or_else(|| "?".into())
                        );
                        let migrated = v.clone();
                        loaded = Some(migrated);
                    }
                }
            }
        }
    }
    let mut root = loaded.unwrap_or_else(|| Value::Object(Map::new()));
    // 3) 返回前：若明文敏感字段存在 → 升级加密 & 回写保存
    if let Some(obj) = root.as_object_mut() {
        if crypto::ensure_encrypted(obj) {
            if let Some(p) = our_settings_path() {
                if let Ok(s) = serde_json::to_string_pretty(&root) {
                    let _ = std::fs::write(&p, s);
                }
            }
        }
    }
    // 4) 返回内存中的解密视图（应用层拿到纯文本用）
    crypto::decrypt_sensitive(&mut root);
    root
}

pub fn external_download_root() -> Option<String> {
    let s = load_settings();
    s.get("downloadDir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// 保存设置（浅合并到现有 settings.json，**只写入本 App 独立目录**）
pub fn save_settings(patch: &Value) -> Result<(), String> {
    let p = our_settings_path().ok_or_else(|| "无法定位 settings.json".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut current = load_settings();
    if let (Some(cur_obj), Some(patch_obj)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            cur_obj.insert(k.clone(), v.clone());
        }
    } else {
        current = patch.clone();
    }
    // 写盘前加密敏感字段
    crypto::encrypt_sensitive(&mut current);
    let txt = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    std::fs::write(&p, txt).map_err(|e| e.to_string())?;
    Ok(())
}