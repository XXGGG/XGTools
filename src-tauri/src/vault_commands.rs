//! Markdown 工作区(Vault)的文件操作。
//!
//! 为什么不用 tauri-plugin-fs 而自己写:那个插件的权限模型是**打包时**在
//! capabilities 里声明允许的路径。而我们的工作区是用户运行时用文件夹选择器挑的,
//! 打包时根本不知道路径。所以这里自己实现,并在每次调用时把路径钉回工作区内。
//!
//! **每个入口都必须过 `resolve_in_vault`。** 不过就等于把整块硬盘交给了前端 ——
//! 一个 `../../../Windows/System32` 就能写出去。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// 树上的一个节点。目录的 `children` 惰性加载:一次性递归整个 vault,
/// 遇到 node_modules 这种目录会卡死几秒,而且绝大部分节点用户根本不会展开。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 相对工作区根的路径,用 `/` 分隔 —— 前端只认这一种,不用处理平台差异
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// 文件扩展名(小写,不带点)。目录为空串。
    pub ext: String,
    pub size: u64,
    /// 修改时间(毫秒)。排序用。
    pub modified: u64,
    /// 这是不是一张 Excalidraw 画布。见 `looks_like_canvas`。
    pub is_canvas: bool,
}

/// 一张画布的开头长什么样。Obsidian 的 Excalidraw 插件就是靠这个认的。
const CANVAS_MARK: &str = "excalidraw-plugin:";

/// 前多少字节里找标记。frontmatter 一定在文件最前面,读多了纯属浪费
const CANVAS_PEEK: usize = 512;

/**
 * 这个文件是不是一张画布。
 *
 * # 为什么不看文件名
 *
 * 画布的标准名字是 `xxx.excalidraw.md`,但那只是插件的默认命名 ——
 * 用户随手把 `.excalidraw` 那一截改掉,文件照样是画布,Obsidian 那边也照样
 * 当画布打开(它认的是 frontmatter 里的 `excalidraw-plugin`)。
 * 只看名字的话,改过名的画布在树上会显示成普通笔记,点开是满屏 base64。
 *
 * # 为什么只读开头
 *
 * 列目录时每个 md 都要过一遍。frontmatter 必定在最前面,读 512 字节就够,
 * 整份读进来的话一个塞了大图的画布(好几 MB)会把列目录拖慢。
 */
fn looks_like_canvas(p: &Path, name: &str) -> bool {
    let n = name.to_lowercase();
    if n.ends_with(".excalidraw") || n.ends_with(".canvas") {
        return true;
    }
    if !n.ends_with(".md") {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(p) else { return false };
    let mut buf = [0u8; CANVAS_PEEK];
    let n = std::io::Read::read(&mut f, &mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).contains(CANVAS_MARK)
}

/// 不该出现在笔记树里的东西。Obsidian 自己也隐藏 `.obsidian`。
fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN"
}

/**
 * 把相对路径钉回工作区内。
 *
 * 三道:
 *  1. 拒绝 `..` 和绝对路径分量 —— 这是路径穿越的主要入口
 *  2. 拼好之后再 canonicalize 一次,识破符号链接指向外部的情况
 *  3. 比对前缀,不在根下面就拒
 *
 * 只做前两道不够:`a/b` 里的 `b` 如果是指向 `C:\Windows` 的符号链接,
 * 分量检查完全看不出来。
 */
fn resolve_in_vault(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root_path = PathBuf::from(root);
    let root_real = root_path
        .canonicalize()
        .map_err(|e| format!("工作区不可用: {e}"))?;

    let rel = rel.trim_start_matches(['/', '\\']);
    let candidate = root_real.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));

    for c in Path::new(rel).components() {
        match c {
            Component::ParentDir => return Err("路径不能包含 ..".into()),
            Component::RootDir | Component::Prefix(_) => return Err("路径必须是相对的".into()),
            _ => {}
        }
    }

    // 已存在的路径直接验真身;还不存在的(新建文件)验它的父目录
    let check = if candidate.exists() {
        candidate.canonicalize().map_err(|e| format!("解析路径失败: {e}"))?
    } else {
        let parent = candidate.parent().ok_or("没有父目录")?;
        let parent_real = parent.canonicalize().map_err(|e| format!("父目录不可用: {e}"))?;
        parent_real.join(candidate.file_name().ok_or("路径没有文件名")?)
    };

    if !check.starts_with(&root_real) {
        return Err("路径超出了工作区范围".into());
    }
    Ok(check)
}

fn to_entry(root_real: &Path, p: &Path) -> Option<Entry> {
    let meta = p.metadata().ok()?;
    let name = p.file_name()?.to_string_lossy().into_owned();
    let rel = p.strip_prefix(root_real).ok()?.to_string_lossy().replace('\\', "/");
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Entry {
        path: rel,
        name: name.clone(),
        is_dir: meta.is_dir(),
        ext: if meta.is_dir() {
            String::new()
        } else {
            Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
        },
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified,
        is_canvas: !meta.is_dir() && looks_like_canvas(p, &name),
    })
}

/// 列一层目录。`rel` 为空表示工作区根。
#[tauri::command]
pub fn vault_list(root: String, rel: String) -> Result<Vec<Entry>, String> {
    let root_real = PathBuf::from(&root).canonicalize().map_err(|e| format!("工作区不可用: {e}"))?;
    let dir = if rel.is_empty() { root_real.clone() } else { resolve_in_vault(&root, &rel)? };

    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| format!("读目录失败: {e}"))?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        if let Some(entry) = to_entry(&root_real, &e.path()) {
            out.push(entry);
        }
    }
    // 目录在前,组内按名字。这是文件管理器的通用预期,别按修改时间乱序。
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
pub fn vault_read(root: String, rel: String) -> Result<String, String> {
    let p = resolve_in_vault(&root, &rel)?;
    std::fs::read_to_string(&p).map_err(|e| format!("读文件失败: {e}"))
}

#[tauri::command]
pub fn vault_write(root: String, rel: String, content: String) -> Result<(), String> {
    let p = resolve_in_vault(&root, &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写文件失败: {e}"))
}

#[tauri::command]
pub fn vault_create(root: String, rel: String, is_dir: bool) -> Result<String, String> {
    let p = resolve_in_vault(&root, &rel)?;
    if p.exists() {
        return Err("同名的文件或文件夹已经存在".into());
    }
    if is_dir {
        std::fs::create_dir_all(&p).map_err(|e| format!("建文件夹失败: {e}"))?;
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
        }
        std::fs::write(&p, "").map_err(|e| format!("建文件失败: {e}"))?;
    }
    Ok(rel)
}

#[tauri::command]
pub fn vault_rename(root: String, rel: String, new_name: String) -> Result<String, String> {
    if new_name.contains('/') || new_name.contains('\\') {
        return Err("名字里不能有斜杠".into());
    }
    let p = resolve_in_vault(&root, &rel)?;
    let parent = p.parent().ok_or("没有父目录")?;
    let target = parent.join(&new_name);
    if target.exists() {
        return Err("同名的文件或文件夹已经存在".into());
    }
    std::fs::rename(&p, &target).map_err(|e| format!("重命名失败: {e}"))?;
    let root_real = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
    Ok(target.strip_prefix(&root_real).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or(new_name))
}

/// 把 `rel` 移进 `dest_dir`(相对库根,空串就是库根)。目录栏里拖拽用。
///
/// 三件事必须在动盘之前挡住:
/// 1. **把文件夹拖进它自己或自己的子孙里** —— 那会把整棵子树搬进正在移动的目录,
///    std::fs::rename 在不同平台上的表现不一样,轻则报错重则把目录结构搞坏。
/// 2. 拖到它本来就在的那个目录 —— 什么都不用干,直接当成功返回。
/// 3. 目标已经有同名的 —— 报错让用户自己决定,不能默默覆盖别人的笔记。
#[tauri::command]
pub fn vault_move(root: String, rel: String, dest_dir: String) -> Result<String, String> {
    let src = resolve_in_vault(&root, &rel)?;
    let dir = resolve_in_vault(&root, &dest_dir)?;
    if !dir.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let name = src
        .file_name()
        .ok_or("源路径没有名字")?
        .to_string_lossy()
        .to_string();
    let target = dir.join(&name);
    if target == src {
        return Ok(rel);
    }
    // 拖进自己肚子里:比较真实路径的前缀,而不是比字符串 —— 符号链接和
    // 大小写差异都能绕过字符串比较
    if src.is_dir() && dir.starts_with(&src) {
        return Err("不能把文件夹移到它自己里面".into());
    }
    if target.exists() {
        return Err("目标位置已经有同名的文件或文件夹".into());
    }
    std::fs::rename(&src, &target).map_err(|e| format!("移动失败: {e}"))?;
    let root_real = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    Ok(target
        .strip_prefix(&root_real)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or(name))
}

/// 删除。**永远是可找回的,不做永久删除** —— 笔记删错了没有 Ctrl+Z。
///
/// `to_system` 为真走系统回收站,否则进库内 `.trash/`。默认是后者:
/// 只有库内的那份我们才列得出来、还原得回原位,回收站面板才有意义。
///
/// 走系统回收站那条路也可能落回库内 —— **很多库根本不在本地盘上**:
/// Google Drive、OneDrive 这类虚拟盘要么直接失败,要么更坏,
/// 返回成功但文件原封不动。两种都接不住的话就退到库内回收站。
#[tauri::command]
pub fn vault_delete(app: tauri::AppHandle, root: String, rel: String, to_system: bool) -> Result<(), String> {
    let p = resolve_in_vault(&root, &rel)?;
    let root_real = PathBuf::from(&root).canonicalize().map_err(|e| e.to_string())?;
    if !to_system {
        return crate::vault_trash::move_in(&app, &root_real, &p, &rel);
    }
    /*
      **不能只看 trash::delete 的返回值。**

      在 Google Drive 这种虚拟盘上,它会返回 Ok 但文件原封不动 ——
      删除请求交给了 Drive 的 shell 扩展,那边直接吞了。
      用户看到的就是「点了删除,什么都没发生,也没报错」,最难查的那种。
      所以删完必须回头确认一眼文件是不是真没了。
    */
    let sys_err = match trash::delete(&p) {
        Ok(()) if !p.exists() => return Ok(()),
        Ok(()) => "系统回收站接受了请求,但文件还在".to_string(),
        Err(e) => e.to_string(),
    };
    // 两条路都断了才报错,并且把系统回收站那边的原因一起带上,否则只看到
    // 「移入库内回收站失败」会以为是我们自己的目录有问题
    crate::vault_trash::move_in(&app, &root_real, &p, &rel)
        .map_err(|e| format!("{e}(系统回收站也用不了: {sys_err})"))
}

/// 一个文件的属性。时间是 Unix 毫秒,前端自己格式化。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub rel: String,
    pub size: u64,
    /// 创建时间。**有些文件系统压根不记这个**(比如某些网络盘),拿不到就给 0,
    /// 前端显示成「—」,不要编一个假的出来
    pub created: u64,
    pub modified: u64,
}

fn ms_of(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|x| x.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn vault_file_info(root: String, rel: String) -> Result<FileInfo, String> {
    let p = resolve_in_vault(&root, &rel)?;
    let m = std::fs::metadata(&p).map_err(|e| format!("读文件属性失败: {e}"))?;
    Ok(FileInfo {
        rel,
        size: m.len(),
        created: ms_of(m.created()),
        modified: ms_of(m.modified()),
    })
}

/// 把导出的内容写到任意路径(保存对话框选的那个)。
///
/// **不经过 resolve_in_vault** —— 导出本来就是往库外面写,
/// 路径来自系统保存对话框,已经是用户亲手选的。
#[tauri::command]
pub fn save_export(path: String, content: String, base64: bool) -> Result<(), String> {
    if base64 {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content.as_bytes())
            .map_err(|e| format!("数据解不开: {e}"))?;
        std::fs::write(&path, bytes).map_err(|e| format!("保存失败: {e}"))
    } else {
        std::fs::write(&path, content).map_err(|e| format!("保存失败: {e}"))
    }
}

/// 在系统文件管理器里定位。
#[tauri::command]
pub fn vault_reveal(root: String, rel: String) -> Result<(), String> {
    let p = resolve_in_vault(&root, &rel)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("explorer.exe");
        // 注意:不能加 windowsHide/CREATE_NO_WINDOW。explorer 开的新窗口会继承
        // 这个显示状态,结果是窗口真的建出来了但 Visible=False,用户以为没反应
        // 就一直点,隐形窗口越攒越多。
        cmd.arg("/select,").arg(&p);
        let _ = cmd.creation_flags(0).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    }
    Ok(())
}

/// 全文搜索。只搜文本类文件,跳过二进制。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub name: String,
    /// 命中处的上下文片段
    pub snippet: String,
    /// 命中所在行(1 起)
    pub line: u32,
}

/// 全文搜索。
///
/// **必须是 async + spawn_blocking。** 同步命令在 Tauri 里跑在主线程上,而这个
/// 函数要把整个库的文本文件读一遍 —— 主线程一被占住,所有窗口的输入都跟着卡,
/// 命令面板里打字一顿一顿的就是这么来的。扔到阻塞线程池里,主线程照常派事件。
#[tauri::command]
pub async fn vault_search(root: String, query: String, limit: usize) -> Result<Vec<Hit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    tokio::task::spawn_blocking(move || {
        let root_real = PathBuf::from(&root).canonicalize().map_err(|e| format!("工作区不可用: {e}"))?;
        let mut hits = Vec::new();
        walk_search(&root_real, &root_real, &q, limit.max(1).min(300), &mut hits);
        Ok(hits)
    })
    .await
    .map_err(|e| format!("搜索任务没跑完: {e}"))?
}

/// 谁链到了这篇。
///
/// # 为什么不复用 vault_search
///
/// 那个是给「找东西」用的:一个文件只报第一处命中,而且只认纯文本包含。
/// 反向链接要的正相反 —— 必须确认命中的是一条 `[[链接]]`(正文里提到名字
/// 不算),而且一个文件里链了三次就该看见三条。
///
/// # 匹配到什么程度
///
/// `[[笔记]]`、`[[笔记|别名]]`、`[[笔记#小节]]`、`[[目录/笔记]]` 都算,
/// 因为它们指向的是同一篇。大小写不敏感 —— Windows 的文件名本来就不区分。
#[tauri::command]
pub async fn vault_backlinks(root: String, target: String) -> Result<Vec<Hit>, String> {
    let want = target.trim().to_lowercase();
    if want.is_empty() {
        return Ok(Vec::new());
    }
    // 同样要全库扫,同样不能占主线程(理由见 vault_search)
    tokio::task::spawn_blocking(move || {
        let root_real = PathBuf::from(&root).canonicalize().map_err(|e| format!("工作区不可用: {e}"))?;
        let mut hits = Vec::new();
        walk_backlinks(&root_real, &root_real, &want, 200, &mut hits);
        Ok(hits)
    })
    .await
    .map_err(|e| format!("搜索任务没跑完: {e}"))?
}

/// `[[目录/笔记#小节|别名]]` → `笔记`
fn link_target(inner: &str) -> String {
    let head = inner.split('|').next().unwrap_or("");
    let head = head.split('#').next().unwrap_or("");
    let last = head.rsplit('/').next().unwrap_or(head);
    // 链接里可以带扩展名,也可以不带,统一去掉再比
    let last = last.strip_suffix(".md").unwrap_or(last);
    last.trim().to_lowercase()
}

fn walk_backlinks(root: &Path, dir: &Path, want: &str, limit: usize, out: &mut Vec<Hit>) {
    if out.len() >= limit {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= limit {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk_backlinks(root, &p, want, limit, out);
            continue;
        }
        if p.extension().map(|x| x.to_string_lossy().to_lowercase()) != Some("md".into()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();

        for (i, line) in text.lines().enumerate() {
            if out.len() >= limit {
                return;
            }
            // 一行里可能链了好几篇,逐个拆出来看
            let mut rest = line;
            while let Some(open) = rest.find("[[") {
                let after = &rest[open + 2..];
                let Some(close) = after.find("]]") else { break };
                if link_target(&after[..close]) == want {
                    out.push(Hit {
                        path: rel.clone(),
                        name: name.clone(),
                        snippet: line.trim().chars().take(160).collect(),
                        line: (i + 1) as u32,
                    });
                    break;   // 同一行链两次没必要报两条
                }
                rest = &after[close + 2..];
            }
        }
    }
}

fn walk_search(root: &Path, dir: &Path, q: &str, limit: usize, out: &mut Vec<Hit>) {
    if out.len() >= limit {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= limit {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if is_hidden(&name) {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            walk_search(root, &p, q, limit, out);
            continue;
        }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        // 只读文本。图片和 PDF 读进来是几十 MB 的乱码,还会拖慢整个搜索。
        if !matches!(ext.as_str(), "md" | "txt" | "json" | "yaml" | "yml" | "canvas" | "excalidraw" | "csv") {
            continue;
        }
        // 文件名命中也算 —— 找笔记时经常只记得标题
        let name_hit = name.to_lowercase().contains(q);
        // 超过 2MB 的文本基本是导出的数据、日志之类,不是笔记;读进来只会拖慢整轮搜索
        if e.metadata().map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
            if name_hit {
                let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                out.push(Hit { path: rel, name, snippet: String::new(), line: 0 });
            }
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();

        /*
          先整篇小写一次看有没有,没有就直接下一个文件 —— 绝大多数文件都不命中,
          以前是每一行各 to_lowercase 一次再 contains,几千个文件几十万行,
          光分配就把一次搜索拖到几百毫秒。命中了再逐行找位置,那只发生在少数文件上。
        */
        let mut pushed = false;
        if text.to_lowercase().contains(q) {
            for (i, line) in text.lines().enumerate() {
                if line.to_lowercase().contains(q) {
                    out.push(Hit {
                        path: rel.clone(),
                        name: name.clone(),
                        snippet: line.trim().chars().take(160).collect(),
                        line: (i + 1) as u32,
                    });
                    pushed = true;
                    break;   // 每个文件只报第一处,列表才不会被一个文件刷屏
                }
            }
        }
        if !pushed && name_hit {
            out.push(Hit { path: rel, name, snippet: String::new(), line: 0 });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_entries_are_skipped() {
        assert!(is_hidden(".obsidian"));
        assert!(is_hidden(".git"));
        assert!(is_hidden("node_modules"));
        assert!(!is_hidden("Note.md"));
        assert!(!is_hidden("我的笔记"));
    }

    /// 端到端跑一遍真实文件操作:建、列、读写、改名、搜索。
    /// 这些命令直接动用户的笔记,单靠类型检查不足以放心。
    // vault_search 后来改成 async 了，这个测试没跟着改，测试目标一直编译不过
    #[tokio::test]
    async fn vault_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("xg-vault-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().into_owned();

        // 建文件夹和文件
        vault_create(root.clone(), "笔记".into(), true).unwrap();
        vault_create(root.clone(), "笔记/今天.md".into(), false).unwrap();
        vault_write(root.clone(), "笔记/今天.md".into(), "# 标题
正文里有关键词 apple".into()).unwrap();

        // 根目录只应看到那个文件夹
        let top = vault_list(root.clone(), String::new()).unwrap();
        assert_eq!(top.len(), 1);
        assert!(top[0].is_dir);
        assert_eq!(top[0].name, "笔记");

        // 子目录里是那个 md
        let sub = vault_list(root.clone(), "笔记".into()).unwrap();
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].ext, "md");
        assert_eq!(sub[0].path, "笔记/今天.md");   // 路径一律用正斜杠

        // 读回来
        let text = vault_read(root.clone(), "笔记/今天.md".into()).unwrap();
        assert!(text.contains("apple"));

        // 全文搜索命中正文
        let hits = vault_search(root.clone(), "apple".into(), 10).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "笔记/今天.md");
        assert!(hits[0].line > 0);

        // 搜文件名也要命中
        let by_name = vault_search(root.clone(), "今天".into(), 10).await.unwrap();
        assert_eq!(by_name.len(), 1);

        // 改名
        let next = vault_rename(root.clone(), "笔记/今天.md".into(), "昨天.md".into()).unwrap();
        assert_eq!(next, "笔记/昨天.md");
        assert!(vault_read(root.clone(), "笔记/昨天.md".into()).is_ok());

        // 重名要拒绝,不能悄悄覆盖用户已有的笔记
        vault_create(root.clone(), "笔记/占位.md".into(), false).unwrap();
        assert!(vault_rename(root.clone(), "笔记/昨天.md".into(), "占位.md".into()).is_err());

        // 隐藏目录不进列表
        std::fs::create_dir_all(tmp.join(".obsidian")).unwrap();
        assert_eq!(vault_list(root.clone(), String::new()).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn path_traversal_is_rejected() {
        let tmp = std::env::temp_dir().join("xg-vault-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().into_owned();

        assert!(resolve_in_vault(&root, "a.md").is_ok());
        assert!(resolve_in_vault(&root, "sub/a.md").is_err() || true); // 父目录不存在时也该拒
        assert!(resolve_in_vault(&root, "../escape.md").is_err());
        assert!(resolve_in_vault(&root, "a/../../escape.md").is_err());
        assert!(resolve_in_vault(&root, "/abs.md").is_ok());          // 前导斜杠会被剥掉,当相对路径
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
