/*!
把别家 AI 的**会话**读出来 —— 一个会话就是一个项目。

# 为什么会话才是项目

同一个文件夹里可以同时进行好几摊完全不相干的活：`c:\XGCode` 底下既在改 XGTools，
又在弄 ComfyUI 的视频生成，还在管服务器安全。它们共用一个工作区，
但**不是同一个项目** —— 各有各的上下文、各有各的进度。

Claude Code 就是这么组织的：会话可以起名字（`【ComfyUI】视频生成`），
一个文件夹下挂十几个。所以同步过来的时候也得按会话来，
只按文件夹的话这十几摊活会塌成一条。

# 为什么要在 Rust 这边读

会话日志加起来将近一个 G，单份能有几十兆。前端那个 `readTextFile` 只能整份读进来，
光是把它们读一遍就够卡半天了。而要的东西都在两头：

 · `cwd` 在**开头** —— 每条记录都带，读头 64 KB 足够
 · 标题在**结尾** —— `custom-title` / `ai-title` 这两种记录是改一次追加一条，
   最后一条才是当前的名字，读尾 512 KB 足够

所以这里按字节 seek，只读两头。二十来份日志加起来读不到 20 MB。
*/
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// 头尾各读多少。头部只要够碰到第一条带 cwd 的记录；
/// 尾部要够装下最后几条标题记录 —— 中间隔着的都是正常对话
const HEAD: usize = 64 * 1024;
const TAIL: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ForeignSession {
    /// 会话 id（文件名去掉扩展名）。用来认「这个会话已经接过来了」
    pub id: String,
    /// 会话名。自己改过的名字优先，其次是自动起的，都没有就用第一句话
    pub title: String,
    /// 工作目录
    pub cwd: String,
    /// 最后动过的时间（毫秒）
    pub mtime: u64,
    /// 自己改过名字 —— 这种是他真的在意的活，排前面
    pub named: bool,
}

/// 从一段文本里找最后一个 `"键":"值"` 的值。
///
/// 不上正则：这里只有两个固定的键，手写扫一遍比引一个正则引擎划算，
/// 而且能顺手处理 `\"` 这种转义 —— 会话名里带引号是很正常的事。
fn last_json_str(hay: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let mut found = None;
    let mut from = 0usize;
    while let Some(i) = hay[from..].find(&pat) {
        let start = from + i + pat.len();
        let bytes = hay.as_bytes();
        let mut j = start;
        let mut esc = false;
        while j < bytes.len() {
            match bytes[j] {
                b'\\' if !esc => esc = true,
                b'"' if !esc => break,
                _ => esc = false,
            }
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }
        // 走 serde 反转义,别自己拼 —— \u4e2d 这种得靠它
        if let Ok(s) = serde_json::from_str::<String>(&format!("\"{}\"", &hay[start..j])) {
            if !s.trim().is_empty() {
                found = Some(s);
            }
        }
        from = j;
    }
    found
}

/// 第一句人说的话。没起过名字的会话拿它当标题 —— 和 Claude Code 自己的做法一致
fn first_user_line(head: &str) -> Option<String> {
    for line in head.lines() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        let c = v.get("message").and_then(|m| m.get("content"))?;
        let text = match c {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Array(a) => a
                .iter()
                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" "),
            _ => continue,
        };
        let t = text.trim();
        // `<command-name>` 这种是工具塞进去的,不是人说的
        if t.is_empty() || t.starts_with('<') {
            continue;
        }
        return Some(t.chars().take(40).collect::<String>().replace('\n', " "));
    }
    None
}

fn read_at(path: &Path, from: SeekFrom, len: usize) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(from).ok()?;
    let mut buf = vec![0u8; len];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    // 两头切下来必然会切断多字节字符,lossy 就好 —— 我们只是在里面找固定的键
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn scan_one(path: &Path) -> Option<ForeignSession> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let head = read_at(path, SeekFrom::Start(0), HEAD.min(size as usize))?;
    let cwd = last_json_str(&head[..head.len().min(20_000)], "cwd")?;

    // 尾部。文件本来就短的话头部已经全读了,别再读一遍
    let tail = if size as usize > HEAD {
        read_at(path, SeekFrom::End(-(TAIL.min(size as usize) as i64)), TAIL)
            .unwrap_or_default()
    } else {
        String::new()
    };

    let pick = |k: &str| last_json_str(&tail, k).or_else(|| last_json_str(&head, k));
    let custom = pick("customTitle");
    let named = custom.is_some();
    let title = custom
        .or_else(|| pick("aiTitle"))
        .or_else(|| first_user_line(&head))
        .unwrap_or_else(|| "未命名会话".into());

    Some(ForeignSession {
        id: path.file_stem()?.to_string_lossy().to_string(),
        title,
        cwd,
        mtime,
        named,
    })
}

/// 扫出 Claude Code 的全部会话。
///
/// `~/.claude/projects/<把路径里的符号换成横杠>/…jsonl`。目录名反解不回来
/// （`:`、`\`、空格**和中文**统统变成 `-`），所以真实路径只能从日志里的 `cwd` 拿。
#[tauri::command]
pub async fn scan_claude_sessions() -> Result<Vec<ForeignSession>, String> {
    let home = dirs::home_dir().ok_or("找不到用户目录")?;
    let root: PathBuf = home.join(".claude").join("projects");
    if !root.is_dir() {
        return Ok(vec![]);
    }

    tokio::task::spawn_blocking(move || {
        let mut out: Vec<ForeignSession> = Vec::new();
        let dirs = match std::fs::read_dir(&root) {
            Ok(d) => d,
            Err(e) => return Err(format!("读不了 {}: {e}", root.display())),
        };
        for d in dirs.flatten() {
            if !d.path().is_dir() {
                continue;
            }
            let files = match std::fs::read_dir(d.path()) {
                Ok(f) => f,
                Err(_) => continue,
            };
            for f in files.flatten() {
                let p = f.path();
                // 子目录里是 subagents 的日志,那不是会话
                if !p.is_file() || p.extension().map(|e| e != "jsonl").unwrap_or(true) {
                    continue;
                }
                if let Some(s) = scan_one(&p) {
                    out.push(s);
                }
            }
        }
        // 新的在前
        out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        Ok(out)
    })
    .await
    .map_err(|e| format!("扫描线程挂了: {e}"))?
}
