//! 文件恢复：定时给笔记存快照，随时能翻回去。
//!
//! # 为什么需要
//!
//! Ctrl+Z 只在这个标签开着的时候有效，关掉就没了；回收站管的是「整篇被删」，
//! 管不了「写着写着删掉了一大段、第二天才发现」。这是笔记软件里最实际的
//! 一层保险，Obsidian 把它做成核心插件也是这个道理。
//!
//! # 存在哪
//!
//! 应用自己的数据目录，不写进用户的库。快照是我们的实现细节，不该让用户的
//! 库里多出一堆看不懂的文件，也不该跟着他的同步盘上传几百份历史。
//!
//! # 为什么按内容哈希去重
//!
//! 定时器每隔几分钟跑一次，但笔记大部分时候没动。存之前先比一下和上一份
//! 是不是同一个哈希，一样就跳过 —— 不然一天下来能攒出几百份一模一样的副本。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 一份快照的元信息。正文单独放文件里，列表不需要把内容全读出来。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// 文件名（时间戳 + 哈希），同时也是这条记录的 id
    pub id: String,
    /// Unix 毫秒
    pub at: u64,
    pub size: u64,
}

/// 每个文件最多留多少份。
///
/// 超过就丢最旧的。不设上限的话，一篇天天改的笔记几个月能攒出上千份，
/// 而人真正会回头翻的基本都在最近几十份里。
const KEEP: usize = 60;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 内容的短哈希。只用来判断「和上一份是不是一样」，不需要抗碰撞强度。
fn hash_of(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// 一个库 + 一个相对路径 → 存快照的目录。
///
/// 把库根和相对路径一起哈希：不同库里的同名笔记不能混在一块，
/// 而路径里的斜杠和中文又不能直接拿来当目录名。
fn dir_for(app: &AppHandle, root: &str, rel: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到数据目录: {e}"))?
        .join("history")
        .join(hash_of(&format!("{root}\u{0}{rel}")));
    std::fs::create_dir_all(&base).map_err(|e| format!("建历史目录失败: {e}"))?;
    Ok(base)
}

/// 存一份快照。内容和上一份一样就跳过，返回是否真的存了。
#[tauri::command]
pub fn vault_snapshot(
    app: AppHandle,
    root: String,
    rel: String,
    content: String,
) -> Result<bool, String> {
    let dir = dir_for(&app, &root, &rel)?;
    let h = hash_of(&content);

    let mut names = list_names(&dir);
    // 文件名末尾就是哈希，比一下就知道内容变没变，不用把上一份读出来
    if names.last().map(|n| n.ends_with(&format!("-{h}.txt"))).unwrap_or(false) {
        return Ok(false);
    }

    let name = format!("{}-{h}.txt", now_ms());
    std::fs::write(dir.join(&name), &content).map_err(|e| format!("写快照失败: {e}"))?;
    names.push(name);

    // 超出上限就从最旧的开始丢
    while names.len() > KEEP {
        let old = names.remove(0);
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(true)
}

/// 目录里的快照文件名，按时间从旧到新。
fn list_names(dir: &PathBuf) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".txt"))
                .collect()
        })
        .unwrap_or_default();
    // 名字前缀是毫秒时间戳，位数一样，按字符串排就是按时间排
    v.sort();
    v
}

/// 列出一篇笔记的所有快照，新的在前。
#[tauri::command]
pub fn vault_history_list(
    app: AppHandle,
    root: String,
    rel: String,
) -> Result<Vec<Snapshot>, String> {
    let dir = dir_for(&app, &root, &rel)?;
    let mut out: Vec<Snapshot> = list_names(&dir)
        .into_iter()
        .filter_map(|name| {
            let at = name.split('-').next()?.parse::<u64>().ok()?;
            let size = std::fs::metadata(dir.join(&name)).map(|m| m.len()).unwrap_or(0);
            Some(Snapshot { id: name, at, size })
        })
        .collect();
    out.reverse();
    Ok(out)
}

/// 读一份快照的正文。
#[tauri::command]
pub fn vault_history_read(
    app: AppHandle,
    root: String,
    rel: String,
    id: String,
) -> Result<String, String> {
    // id 来自我们自己列出来的那份,但拼路径的地方不该信任任何外来字符串
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("非法的快照 id".into());
    }
    let dir = dir_for(&app, &root, &rel)?;
    std::fs::read_to_string(dir.join(&id)).map_err(|e| format!("读快照失败: {e}"))
}

/// 清掉一篇笔记的全部快照。
#[tauri::command]
pub fn vault_history_clear(app: AppHandle, root: String, rel: String) -> Result<(), String> {
    let dir = dir_for(&app, &root, &rel)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("清历史失败: {e}"))
}
