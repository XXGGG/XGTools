//! 盯着工作区目录，外面动了文件就通知前端刷新。
//!
//! # 为什么需要
//!
//! 用户大概率是 Obsidian 和 XGTools 一起开着的。在 Obsidian 那边删一篇、改个名，
//! 我们这边的目录缓存不知道，树上就留着一行点不动的幽灵 —— 而且每次操作
//! 都报一次「系统找不到指定的文件」，看着像功能坏了。
//!
//! # 为什么要防抖
//!
//! 一次「保存」在文件系统层面往往是好几个事件（临时文件、改名、写入、改时间戳），
//! 同步工具（Google Drive、OneDrive）更是会连着刷一片。不防抖的话前端会被
//! 几十次刷新打爆，而且刷新本身又会读盘，容易互相踩。攒 300ms 再发一次就够了 ——
//! 反正用户感知不到这点延迟。
//!
//! # 只发目录，不发文件
//!
//! 前端是按目录缓存的，收到「哪一层变了」就够它自己去重读。发具体文件名的话
//! 前端还得判断是新增还是删除还是改名，把本来在 read_dir 里一次就能拿到的
//! 事实拆成一堆猜测。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// 攒事件的窗口。见模块注释里「为什么要防抖」。
const DEBOUNCE: Duration = Duration::from_millis(300);

/// 当前挂着的监听。换工作区要先把上一个停掉，否则会同时收到两个库的事件。
pub struct VaultWatch(Mutex<Option<RecommendedWatcher>>);

impl Default for VaultWatch {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// 这条路径要不要理会。
///
/// 隐藏目录（`.git`、`.obsidian`、`.trash`）一律跳过：它们不出现在树里，
/// 但里面的动静非常频繁 —— Obsidian 光是记录一次窗口位置就会写 `.obsidian`，
/// 不挡的话监听器基本上在空转。
fn interesting(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    !rel.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
}

/// 事件路径 → 它所在的那一层（相对库根，空串就是库根）。
fn dir_of(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let dir = rel.parent()?;
    Some(dir.to_string_lossy().replace('\\', "/"))
}

/// 开始盯着 `root`。重复调用会先停掉上一个。
#[tauri::command]
pub fn watch_vault(app: AppHandle, root: String) -> Result<(), String> {
    let state = app.state::<VaultWatch>();
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    *slot = None; // 先把旧的 drop 掉，别让两个库的事件混在一起

    if root.is_empty() {
        return Ok(());
    }
    let root_real = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("工作区不可用: {e}"))?;

    /*
      顺手把这个库加进资源协议的白名单。

      笔记里的图片是相对路径(`![](attachments/a.png)`),webview 直接加载
      加载不到 —— 它得走 asset:// 协议,而那个协议默认什么都不许读。
      配置里的 scope 写死不了:库在哪要用户选完才知道。所以留空,
      在这里按实际选中的库授权,换库时上一个自然就失效了。
    */
    // 授权失败不该拦住监听本身:大不了图片显示不出来,树该刷还得刷
    if let Err(e) = app.asset_protocol_scope().allow_directory(&root_real, true) {
        eprintln!("[vault] 资源协议授权失败,笔记里的图片可能加载不出来: {e}");
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("建监听失败: {e}"))?;
    watcher
        .watch(&root_real, RecursiveMode::Recursive)
        .map_err(|e| format!("监听工作区失败: {e}"))?;

    // 收事件的线程随 rx 一起活。watcher 被 drop 时 tx 断开，recv 返回 Err，线程自己结束 ——
    // 不用额外的停止信号，也就不会有「换了库还有个线程在后台跑」的问题。
    let handle = app.clone();
    let root_for_thread = Arc::new(root_real);
    std::thread::spawn(move || {
        let root = root_for_thread;
        loop {
            // 先阻塞等第一个事件，拿到之后再开一个短窗口把后面连着来的一起收了
            let Ok(first) = rx.recv() else { return };
            let mut dirs: HashSet<String> = HashSet::new();
            let take = |ev: notify::Result<notify::Event>, dirs: &mut HashSet<String>| {
                let Ok(ev) = ev else { return };
                for p in &ev.paths {
                    if !interesting(p, &root) {
                        continue;
                    }
                    if let Some(d) = dir_of(p, &root) {
                        dirs.insert(d);
                    }
                }
            };
            take(first, &mut dirs);
            while let Ok(ev) = rx.recv_timeout(DEBOUNCE) {
                take(ev, &mut dirs);
            }
            if dirs.is_empty() {
                continue;
            }
            let list: Vec<String> = dirs.into_iter().collect();
            let _ = handle.emit("vault-changed", list);
        }
    });

    *slot = Some(watcher);
    Ok(())
}
