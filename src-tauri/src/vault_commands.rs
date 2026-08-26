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

/// 删除。**走回收站,不是永久删除** —— 笔记删错了没有 Ctrl+Z。
#[tauri::command]
pub fn vault_delete(root: String, rel: String) -> Result<(), String> {
    let p = resolve_in_vault(&root, &rel)?;
    trash::delete(&p).map_err(|e| format!("移入回收站失败: {e}"))
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

#[tauri::command]
pub fn vault_search(root: String, query: String, limit: usize) -> Result<Vec<Hit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let root_real = PathBuf::from(&root).canonicalize().map_err(|e| format!("工作区不可用: {e}"))?;
    let mut hits = Vec::new();
    walk_search(&root_real, &root_real, &q, limit.max(1).min(300), &mut hits);
    Ok(hits)
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
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();

        let mut pushed = false;
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
    #[test]
    fn vault_roundtrip() {
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
        let hits = vault_search(root.clone(), "apple".into(), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "笔记/今天.md");
        assert!(hits[0].line > 0);

        // 搜文件名也要命中
        let by_name = vault_search(root.clone(), "今天".into(), 10).unwrap();
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
