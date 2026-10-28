//! Skills 页：看本机装了哪些 AI skill、装在哪个 AI 里、用过几次。
//!
//! 只读不写。数据全来自本机：
//! - 各家 AI 的 skill 文件夹（Claude Code `~/.claude/skills`、Codex `~/.codex/skills`、
//!   通用的 `~/.agents/skills`），里面每个带 SKILL.md 的文件夹就是一个 skill；
//! - 用户自己加的文件夹（比如放 skill 源码的仓库），往下找 SKILL.md；
//! - 使用次数从对话记录里数：Claude Code 每调一次 skill 会记一条 `"name":"Skill","input":{"skill":"…"}`，
//!   Codex 没有专门的 skill 调用，读 SKILL.md 的那次工具调用就算用了一次（同一段对话只算一次）。
//!
//! 「启用」= 某个 AI 的 skill 文件夹里有它。按真实路径比对，所以链接（junction / 软链接）
//! 指过去的也认得出来；同名但不是同一份的标成「副本」。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    id: String,
    name: String,
    dir: String,
    exists: bool,
}

#[derive(Serialize, Clone)]
pub struct SkillInfo {
    name: String,
    description: String,
    /// 真实所在的文件夹（链接已解开）
    path: String,
    /// 在哪些 AI 的 skill 文件夹里（同一份）
    enabled_in: Vec<String>,
    /// 在哪些 AI 里装的是同名的另一份
    copy_in: Vec<String>,
    /// 是通过链接装进去的那些 AI
    linked_in: Vec<String>,
    /// 来自用户加的哪个文件夹（不是来自自选文件夹就是空）
    folder: String,
    /// SKILL.md 以外的文件（相对路径，最多 200 个）
    files: Vec<String>,
}

#[derive(Serialize)]
pub struct FolderInfo {
    path: String,
    exists: bool,
    count: usize,
}

#[derive(Serialize)]
pub struct ScanResult {
    agents: Vec<AgentInfo>,
    folders: Vec<FolderInfo>,
    skills: Vec<SkillInfo>,
}

#[derive(Serialize, Clone, Default)]
pub struct UsageStat {
    count: u32,
    /// 最近一次的时间（ISO 字符串，取自记录本身）
    last: String,
}

fn agents() -> Vec<(String, String, PathBuf)> {
    let home = dirs::home_dir().unwrap_or_default();
    vec![
        ("claude".into(), "Claude Code".into(), home.join(".claude").join("skills")),
        ("codex".into(), "Codex".into(), home.join(".codex").join("skills")),
        ("agents".into(), ".agents".into(), home.join(".agents").join("skills")),
    ]
}

/// 解开链接拿真实路径，并去掉 Windows 的 `\\?\` 前缀，方便显示和比对
fn real(p: &Path) -> PathBuf {
    let c = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let s = c.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

fn key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// 往下找带 SKILL.md 的文件夹。找到一个就不再往它里面钻
fn find_skills(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join("SKILL.md").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        let n = name.to_string_lossy();
        if n == ".git" || n == "node_modules" || n == "target" || n == "dist" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            find_skills(&p, depth - 1, out);
        }
    }
}

/// 读 SKILL.md 开头 --- 之间的 name / description（description 支持 `>`、`|` 折行写法）
fn frontmatter(md: &str) -> (Option<String>, String) {
    let mut lines = md.lines();
    if lines.next().map(|l| l.trim()) != Some("---") {
        return (None, String::new());
    }
    let mut name = None;
    let mut desc = String::new();
    let mut in_desc = false;
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        let indented = l.starts_with(' ') || l.starts_with('\t');
        if in_desc && indented {
            if !desc.is_empty() {
                desc.push(' ');
            }
            desc.push_str(l.trim());
            continue;
        }
        in_desc = false;
        let unq = |v: &str| v.trim().trim_matches('"').trim_matches('\'').to_string();
        if let Some(v) = l.strip_prefix("name:") {
            name = Some(unq(v));
        } else if let Some(v) = l.strip_prefix("description:") {
            let v = v.trim();
            if v.is_empty() || v.starts_with('>') || v.starts_with('|') {
                in_desc = true;
            } else {
                desc = unq(v);
            }
        }
    }
    (name, desc)
}

fn list_files(dir: &Path) -> Vec<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut items: Vec<_> = rd.flatten().collect();
        items.sort_by_key(|e| e.file_name());
        for e in items {
            if out.len() >= 200 {
                return;
            }
            let p = e.path();
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with('.') || n == "node_modules" || n == "__pycache__" {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, out);
            } else if !(dir == base && n == "SKILL.md") {
                out.push(p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out
}

fn read_skill(dir: &Path) -> (String, String) {
    let md = fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
    let (name, desc) = frontmatter(&md);
    let fallback = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    (name.filter(|n| !n.is_empty()).unwrap_or(fallback), desc)
}

#[tauri::command]
pub async fn skills_scan(folders: Vec<String>) -> Result<ScanResult, String> {
    tokio::task::spawn_blocking(move || {
        let mut skills: Vec<SkillInfo> = Vec::new();
        let mut by_key: HashMap<String, usize> = HashMap::new();
        let mut agent_infos = Vec::new();

        let mut add = |dir: &Path, skills: &mut Vec<SkillInfo>| -> usize {
            let r = real(dir);
            let k = key(&r);
            if let Some(&i) = by_key.get(&k) {
                return i;
            }
            let (name, description) = read_skill(&r);
            skills.push(SkillInfo {
                name,
                description,
                path: r.to_string_lossy().to_string(),
                enabled_in: vec![],
                copy_in: vec![],
                linked_in: vec![],
                folder: String::new(),
                files: list_files(&r),
            });
            by_key.insert(k, skills.len() - 1);
            skills.len() - 1
        };

        // 各家 AI 的 skill 文件夹
        let mut installed: Vec<(String, String, usize)> = Vec::new(); // (agent, 名字, 下标)
        for (id, name, dir) in agents() {
            let exists = dir.is_dir();
            agent_infos.push(AgentInfo { id: id.clone(), name, dir: dir.to_string_lossy().to_string(), exists });
            if !exists {
                continue;
            }
            let mut found = Vec::new();
            find_skills(&dir, 3, &mut found);
            for p in found {
                // 链接：这一级或它的上级（比如整个分类文件夹链过去）是链接都算
                let linked = p
                    .ancestors()
                    .take_while(|a| a.starts_with(&dir) && *a != dir.as_path())
                    .any(|a| fs::symlink_metadata(a).map(|m| m.file_type().is_symlink()).unwrap_or(false));
                let i = add(&p, &mut skills);
                if !skills[i].enabled_in.contains(&id) {
                    skills[i].enabled_in.push(id.clone());
                }
                if linked && !skills[i].linked_in.contains(&id) {
                    skills[i].linked_in.push(id.clone());
                }
                installed.push((id.clone(), skills[i].name.clone(), i));
            }
        }

        // 用户自己加的文件夹
        let mut folder_infos = Vec::new();
        for f in &folders {
            let root = PathBuf::from(f);
            let exists = root.is_dir();
            let mut found = Vec::new();
            if exists {
                find_skills(&root, 6, &mut found);
            }
            folder_infos.push(FolderInfo { path: f.clone(), exists, count: found.len() });
            for p in found {
                let i = add(&p, &mut skills);
                if skills[i].folder.is_empty() {
                    skills[i].folder = f.clone();
                }
            }
        }

        // 同名不同份：AI 里装的是另一份拷贝
        for (agent, name, idx) in &installed {
            for (j, s) in skills.iter_mut().enumerate() {
                if j != *idx && s.name == *name && !s.enabled_in.contains(agent) && !s.copy_in.contains(agent) {
                    s.copy_in.push(agent.clone());
                }
            }
        }

        skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(ScanResult { agents: agent_infos, folders: folder_infos, skills })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------- 使用次数 ----------------

/// 每个记录文件按「修改时间 + 大小」缓存解析结果，刷新时只重读变过的文件
type FileStats = HashMap<String, UsageStat>;
static CACHE: Mutex<Option<HashMap<PathBuf, (SystemTime, u64, FileStats)>>> = Mutex::new(None);

fn jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            jsonl_files(&p, out);
        } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            out.push(p);
        }
    }
}

/// 这一行里的 "timestamp":"…"
fn line_ts(line: &[u8]) -> String {
    const T: &[u8] = b"\"timestamp\":\"";
    if let Some(i) = memchr::memmem::find(line, T) {
        let rest = &line[i + T.len()..];
        if let Some(j) = memchr::memchr(b'"', rest) {
            return String::from_utf8_lossy(&rest[..j]).to_string();
        }
    }
    String::new()
}

fn bump(m: &mut FileStats, name: &str, ts: String) {
    let e = m.entry(name.to_string()).or_default();
    e.count += 1;
    if ts > e.last {
        e.last = ts;
    }
}

/// Claude Code：每调一次 Skill 工具算一次
fn parse_claude(buf: &[u8]) -> FileStats {
    const P: &[u8] = b"\"name\":\"Skill\",\"input\":{\"skill\":\"";
    let mut m = FileStats::new();
    for i in memchr::memmem::find_iter(buf, P) {
        let rest = &buf[i + P.len()..];
        let Some(j) = memchr::memchr(b'"', rest) else { continue };
        let name = String::from_utf8_lossy(&rest[..j]).to_string();
        let start = memchr::memrchr(b'\n', &buf[..i]).map(|x| x + 1).unwrap_or(0);
        let end = memchr::memchr(b'\n', &buf[i..]).map(|x| i + x).unwrap_or(buf.len());
        bump(&mut m, &name, line_ts(&buf[start..end]));
    }
    m
}

/// Codex：工具调用里读了哪个 SKILL.md，同一段对话里一个 skill 只算一次
fn parse_codex(buf: &[u8]) -> FileStats {
    let mut m = FileStats::new();
    let mut seen: HashSet<String> = HashSet::new();
    for line in buf.split(|&b| b == b'\n') {
        if memchr::memmem::find(line, b"SKILL.md").is_none() {
            continue;
        }
        let is_call = memchr::memmem::find(line, b"\"type\":\"function_call\"").is_some()
            || memchr::memmem::find(line, b"\"type\":\"custom_tool_call\"").is_some();
        if !is_call {
            continue;
        }
        for i in memchr::memmem::find_iter(line, b"SKILL.md") {
            // SKILL.md 前面那一节文件夹名就是 skill 名；分隔符可能是 / \ 或 JSON 转义过的 \\
            let mut end = i;
            while end > 0 && (line[end - 1] == b'/' || line[end - 1] == b'\\') {
                end -= 1;
            }
            let mut start = end;
            while start > 0 && !matches!(line[start - 1], b'/' | b'\\' | b'"' | b'\'' | b' ') {
                start -= 1;
            }
            if start == end {
                continue;
            }
            let name = String::from_utf8_lossy(&line[start..end]).to_string();
            if seen.insert(name.clone()) {
                bump(&mut m, &name, line_ts(line));
            }
        }
    }
    m
}

#[tauri::command]
pub async fn skills_usage() -> Result<HashMap<String, HashMap<String, UsageStat>>, String> {
    tokio::task::spawn_blocking(|| {
        let home = dirs::home_dir().unwrap_or_default();
        let sources: [(&str, PathBuf, fn(&[u8]) -> FileStats); 2] = [
            ("claude", home.join(".claude").join("projects"), parse_claude),
            ("codex", home.join(".codex").join("sessions"), parse_codex),
        ];
        let mut guard = CACHE.lock().map_err(|e| e.to_string())?;
        let cache = guard.get_or_insert_with(HashMap::new);
        let mut result: HashMap<String, HashMap<String, UsageStat>> = HashMap::new();
        for (agent, dir, parse) in sources {
            let mut files = Vec::new();
            jsonl_files(&dir, &mut files);
            let total = result.entry(agent.to_string()).or_default();
            for f in files {
                let Ok(meta) = fs::metadata(&f) else { continue };
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let len = meta.len();
                let fresh = matches!(cache.get(&f), Some((t, l, _)) if *t == mtime && *l == len);
                if !fresh {
                    let Ok(buf) = fs::read(&f) else { continue };
                    cache.insert(f.clone(), (mtime, len, parse(&buf)));
                }
                for (name, s) in &cache[&f].2 {
                    let e = total.entry(name.clone()).or_default();
                    e.count += s.count;
                    if s.last > e.last {
                        e.last = s.last.clone();
                    }
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读某个 skill 的 SKILL.md 全文（页面中间用笔记的编辑器只读显示）
#[tauri::command]
pub fn skills_read(dir: String) -> Result<String, String> {
    fs::read_to_string(Path::new(&dir).join("SKILL.md")).map_err(|e| e.to_string())
}
