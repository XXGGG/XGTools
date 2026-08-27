//! 库内回收站：删掉的东西先进 `<库根>/.trash/`，能列、能还原、能彻底删。
//!
//! # 为什么不直接用系统回收站
//!
//! 系统回收站找得回来，但**我们列不出来也还原不到原位**：那是操作系统的东西，
//! 里面混着全机器的删除记录，跟「这个库删了什么」对不上。想做一个真正的
//! 回收站面板，就只能自己管。库内回收站还有个附带好处：它跟着库一起同步，
//! 换台机器打开同一个库，删掉的东西还在。
//!
//! # 原路径记在哪
//!
//! 记在我们自己的 appdata，不写进用户的库。
//!
//! `.trash` 是扁平的（Obsidian 也一样），光看文件名不知道它原来在哪一层，
//! 还原就无从谈起。但把索引写进 `.trash/` 会给用户的库塞进一个我们私有的
//! 文件 —— 那个目录是他的，我们只借地方放东西，不该留自己的记账本。
//! 所以索引按「库根路径」分组存在应用自己的数据目录里。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 回收站里的一条。
#[derive(Debug, Clone, Serialize, Deserialize)]
// 前端是 camelCase 的,不改这行传过去就是 deleted_at,取到 undefined
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// `.trash` 下的文件名，也是这条记录的唯一标识
    pub id: String,
    /// 删之前在库里的相对路径
    pub orig: String,
    /// 删除时间（Unix 毫秒）。前端用它排序和显示
    pub deleted_at: u64,
    pub is_dir: bool,
    pub size: u64,
}

/// 整个索引：库根路径 → 那个库的回收站记录。
type Index = HashMap<String, Vec<TrashItem>>;

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建数据目录失败: {e}"))?;
    Ok(dir.join("vault-trash.json"))
}

fn load_index(app: &AppHandle) -> Index {
    // 读不出来就当空的：索引坏了不该让回收站整个不能用，
    // 大不了那些记录失去原路径，文件本身还在 .trash 里
    index_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_index(app: &AppHandle, idx: &Index) -> Result<(), String> {
    let p = index_path(app)?;
    let s = serde_json::to_string_pretty(idx).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| format!("写回收站索引失败: {e}"))
}

/// 库根的规范化字符串，当索引的键用。
///
/// 必须用规范化后的路径：同一个库可能被写成 `H:\a\b` 或 `H:/a/b/`，
/// 甚至经过一个符号链接，字符串不一样但指的是同一个地方。
fn key_of(root: &str) -> String {
    PathBuf::from(root)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root.to_string())
}

/// 把 `src` 挪进 `<root>/.trash/` 并记账。`rel` 是它删之前的相对路径。
pub fn move_in(app: &AppHandle, root: &Path, src: &Path, rel: &str) -> Result<(), String> {
    let dir = root.join(".trash");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建回收站目录失败: {e}"))?;

    let name = src
        .file_name()
        .ok_or("源路径没有名字")?
        .to_string_lossy()
        .to_string();
    // 名字撞了就加序号，不覆盖 —— 回收站里的两份同名笔记很可能内容完全不同
    let (stem, ext) = match name.rsplit_once('.') {
        Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")),
        _ => (name.clone(), String::new()),
    };
    let mut id = name.clone();
    let mut i = 1;
    while dir.join(&id).exists() {
        i += 1;
        id = format!("{stem} {i}{ext}");
    }

    let is_dir = src.is_dir();
    let size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    std::fs::rename(src, dir.join(&id)).map_err(|e| format!("移入回收站失败: {e}"))?;

    let mut idx = load_index(app);
    idx.entry(key_of(&root.to_string_lossy()))
        .or_default()
        .push(TrashItem {
            id,
            orig: rel.to_string(),
            deleted_at: now_ms(),
            is_dir,
            size,
        });
    save_index(app, &idx)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 列出这个库回收站里的东西，新删的在前。
///
/// **以磁盘为准，不以索引为准。** 用户可能在文件管理器里直接清空过 `.trash`，
/// 也可能从别的设备同步来一批我们没记过账的文件。所以先读目录，
/// 再拿索引去补原路径 —— 索引里有而磁盘上没有的，顺手清掉。
#[tauri::command]
pub fn vault_trash_list(app: AppHandle, root: String) -> Result<Vec<TrashItem>, String> {
    let dir = PathBuf::from(&root).join(".trash");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut idx = load_index(&app);
    let key = key_of(&root);
    let recorded: HashMap<String, TrashItem> = idx
        .get(&key)
        .map(|v| v.iter().map(|t| (t.id.clone(), t.clone())).collect())
        .unwrap_or_default();

    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir)
        .map_err(|e| format!("读回收站失败: {e}"))?
        .flatten()
    {
        let id = e.file_name().to_string_lossy().to_string();
        let meta = e.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        match recorded.get(&id) {
            Some(t) => out.push(t.clone()),
            // 没记过账的（外部同步进来的、手动扔进去的）也列出来，
            // 只是不知道原来在哪，还原就只能回库根
            None => out.push(TrashItem {
                id: id.clone(),
                orig: id,
                deleted_at: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
                is_dir,
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            }),
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));

    // 索引里有、磁盘上没有的记录清掉，免得越攒越多
    if let Some(v) = idx.get_mut(&key) {
        let alive: Vec<String> = out.iter().map(|t| t.id.clone()).collect();
        v.retain(|t| alive.contains(&t.id));
        let _ = save_index(&app, &idx);
    }
    Ok(out)
}

/// 还原一条。返回还原到的相对路径。
#[tauri::command]
pub fn vault_trash_restore(app: AppHandle, root: String, id: String) -> Result<String, String> {
    let root_real = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("工作区不可用: {e}"))?;
    let src = root_real.join(".trash").join(&id);
    if !src.exists() {
        return Err("这一项已经不在回收站里了".into());
    }

    let mut idx = load_index(&app);
    let key = key_of(&root);
    let orig = idx
        .get(&key)
        .and_then(|v| v.iter().find(|t| t.id == id))
        .map(|t| t.orig.clone())
        // 没记过账就放回库根，用它自己的名字
        .unwrap_or_else(|| id.clone());

    let mut target = root_real.join(&orig);
    // 原位置被新文件占了就加序号，绝不覆盖 —— 还原是找回旧东西，
    // 不该以毁掉一个新东西为代价
    if target.exists() {
        let name = target
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| id.clone());
        let (stem, ext) = match name.rsplit_once('.') {
            Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")),
            _ => (name.clone(), String::new()),
        };
        let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or(root_real.clone());
        let mut i = 1;
        loop {
            i += 1;
            let cand = parent.join(format!("{stem} {i}{ext}"));
            if !cand.exists() {
                target = cand;
                break;
            }
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目标目录失败: {e}"))?;
    }
    std::fs::rename(&src, &target).map_err(|e| format!("还原失败: {e}"))?;

    if let Some(v) = idx.get_mut(&key) {
        v.retain(|t| t.id != id);
        let _ = save_index(&app, &idx);
    }
    Ok(target
        .strip_prefix(&root_real)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or(orig))
}

/// 彻底删。`id` 为空就是清空整个回收站。
///
/// 这一步**没有下一层兜底**，删完就真没了 —— 所以调用方必须先让用户确认。
#[tauri::command]
pub fn vault_trash_purge(app: AppHandle, root: String, id: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(&root).join(".trash");
    if !dir.is_dir() {
        return Ok(());
    }
    match id {
        Some(id) => {
            let p = dir.join(&id);
            // 防一手 `..`：id 是前端传来的，虽然只可能来自我们自己列出的那份，
            // 但拼路径的地方不该信任任何外来字符串
            if !p.starts_with(&dir) {
                return Err("非法的回收站项".into());
            }
            if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            }
            .map_err(|e| format!("彻底删除失败: {e}"))?;
            let mut idx = load_index(&app);
            if let Some(v) = idx.get_mut(&key_of(&root)) {
                v.retain(|t| t.id != id);
                let _ = save_index(&app, &idx);
            }
        }
        None => {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("清空回收站失败: {e}"))?;
            let mut idx = load_index(&app);
            idx.remove(&key_of(&root));
            let _ = save_index(&app, &idx);
        }
    }
    Ok(())
}
