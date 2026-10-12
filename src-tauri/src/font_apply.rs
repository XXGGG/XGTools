//! 字体库「套用到」：在 XGTools 里点一款字，别的软件里选中的文字就换成这款。
//!
//! 每个软件走它自己的对外接口，都只连**已经开着的**那个实例，不会帮用户把软件打开：
//!   - Photoshop：COM（`Photoshop.Application`）+ DoJavaScript，改当前选中的文字图层。
//!     字体名要用 PostScript 名，PS 的 textItem.font 只认这个。
//!   - DaVinci Resolve：自带的 fuscript.exe 跑 Lua（Python 在本机跟 fusionscript.dll 不兼容），
//!     改 Fusion 页里选中的 Text+ 节点。需要用户在 偏好设置 → 系统 → 常规 → 外部脚本使用 = 本地。
//!   - PhotoCraft：它的本机控制通道（`photocraft --control <端口> --control-token-file <文件>`），
//!     JSON 一行一条，第一条必须是 auth。这条通道只有带参数启动才有，所以另给一个「联动模式启动」。
//!   - Affinity（Canva 版）：设置里打开 MCP 服务器后，本机 6767 端口有 SSE 版 MCP，
//!     execute_script 跑它的 JavaScript SDK。
//!
//! 返回值统一是给人看的一句话（成功：改了几个；失败：差哪一步），前端直接显示。

use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyFont {
    /// 英文家族名（Resolve / PhotoCraft / Affinity 按家族名找字）
    pub family: String,
    /// 中文家族名，Affinity 有时按本地化名列字体，找不到英文名时再试它
    pub family_local: String,
    /// 选中的那个字重的 PostScript 名（PS 用）
    pub postscript: String,
    /// 字重/样式名，比如 Regular、Bold
    pub style: String,
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

// ───────────── Photoshop ─────────────

fn apply_photoshop(f: &ApplyFont) -> Result<String, String> {
    // 只改当前图层；不是文字图层就说清楚。整段 JS 返回一个状态词
    let js = format!(
        r#"(function(){{
  if (!app.documents.length) return 'nodoc';
  var l = app.activeDocument.activeLayer;
  if (l.kind != LayerKind.TEXT) return 'notext';
  l.textItem.font = {ps};
  return 'ok';
}})()"#,
        ps = js_str(&f.postscript)
    );
    // GetActiveObject：只连已经开着的 PS，不会帮用户启动一个
    let script = format!(
        "$ErrorActionPreference='Stop'\n\
         try {{ $ps = [Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application') }} catch {{ 'notrunning'; exit }}\n\
         try {{ $ps.DoJavaScript(@'\n{js}\n'@) }} catch {{ 'busy:' + $_.Exception.Message }}"
    );
    let out = run_powershell(&script)?;
    match out.as_str() {
        "ok" => Ok("Photoshop：已换成这款字".into()),
        "nodoc" => Err("Photoshop 里没有打开的文档".into()),
        "notext" => Err("Photoshop 里当前选中的不是文字图层".into()),
        "notrunning" => Err("没找到正在运行的 Photoshop".into()),
        s if s.starts_with("busy:") => Err(format!(
            "Photoshop 没接受（如果正在编辑文字，先按 Esc 或点一下别处退出编辑）：{}",
            s.trim_start_matches("busy:").trim()
        )),
        s => Err(format!("Photoshop 返回了意外的结果：{s}")),
    }
}

fn run_powershell(script: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("启动 PowerShell 失败：{e}"))?;
    {
        use std::io::Write;
        let mut stdin = child.stdin.take().ok_or("PowerShell 没有输入管道")?;
        // 前面加 BOM 不行，PowerShell 从 stdin 读按控制台代码页；这里只放 ASCII 外加 JSON 转义过的字体名
        stdin.write_all(script.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ───────────── DaVinci Resolve ─────────────

fn fuscript_path() -> Option<PathBuf> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
    let p = PathBuf::from(pf).join(r"Blackmagic Design\DaVinci Resolve\fuscript.exe");
    p.exists().then_some(p)
}

fn lua_str(s: &str) -> String {
    // 长括号字符串，不用管转义；字体名里不会有 ]==]
    format!("[==[{s}]==]")
}

fn apply_resolve(f: &ApplyFont) -> Result<String, String> {
    let exe = fuscript_path().ok_or("没找到达芬奇（fuscript.exe）")?;
    let lua = format!(
        r#"local resolve = bmd.scriptapp("Resolve")
if not resolve then print("ERR:noapi") return end
local fu = resolve:Fusion()
local comp = fu and fu:GetCurrentComp()
if not comp then print("ERR:nocomp") return end
local n = 0
local function set(t)
  t:SetInput("Font", {fam})
  t:SetInput("Style", {sty})
  n = n + 1
end
comp:Lock()
for _, t in pairs(comp:GetToolList(true, "TextPlus") or {{}}) do set(t) end
if n == 0 then
  local a = comp:GetActiveTool()
  if a and a.ID == "TextPlus" then set(a) end
end
comp:Unlock()
print("OK:" .. n)
"#,
        fam = lua_str(&f.family),
        sty = lua_str(&f.style)
    );
    let file = std::env::temp_dir().join("xgtools-font-apply.lua");
    std::fs::write(&file, lua).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(["-l", "lua"]).arg(&file);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("跑 fuscript 失败：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let line = text.lines().map(str::trim).rfind(|l| l.starts_with("OK:") || l.starts_with("ERR:")).unwrap_or("");
    match line {
        "ERR:noapi" | "" => Err("连不上达芬奇：确认它开着，并在 偏好设置 → 系统 → 常规 里把「外部脚本使用」设为「本地」".into()),
        "ERR:nocomp" => Err("达芬奇里没有打开的 Fusion 合成：切到 Fusion 页，选中 Text+ 节点".into()),
        "OK:0" => Err("达芬奇 Fusion 页里没有选中 Text+ 节点".into()),
        l => Ok(format!("达芬奇：已换 {} 个 Text+", l.trim_start_matches("OK:"))),
    }
}

// ───────────── PhotoCraft ─────────────

/// 联动用的端口和令牌文件。令牌文件 PhotoCraft 自己生成（不存在时），放在本机用户目录下
const PC_PORT: u16 = 47878;
fn pc_token_file() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    base.join("XGTools").join("photocraft-control.token")
}

/*
  常驻联动（2026-10-12）：PhotoCraft 启动时会读 PHOTOCRAFT_CONTROL_PORT / PHOTOCRAFT_CONTROL_TOKEN_FILE
  这两个环境变量（实测：只设这两个、不带任何参数启动，端口就开了）。把它们写进当前用户的环境变量，
  之后不管从开始菜单、双击文件还是别的方式打开 PhotoCraft，都能随时连上，不用再特地用联动模式重开。
  偏好设置里那个 integrations.controlPort 实测不起作用，别走那条路。
  已经开着的那个是设之前启动的，读不到新变量，要重开一次。
*/
const PC_ENV_PORT: &str = "PHOTOCRAFT_CONTROL_PORT";
const PC_ENV_TOKEN: &str = "PHOTOCRAFT_CONTROL_TOKEN_FILE";

fn user_env(name: &str) -> Option<String> {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Environment", "/v", name])
        .creation_flags_compat()
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).to_string();
    s.lines().find(|l| l.trim_start().starts_with(name)).and_then(|l| l.split("REG_").nth(1)).map(|rest| {
        rest.split_once(char::is_whitespace).map(|(_, v)| v.trim().to_string()).unwrap_or_default()
    })
}

trait NoWindow {
    fn creation_flags_compat(&mut self) -> &mut Self;
}
impl NoWindow for std::process::Command {
    fn creation_flags_compat(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

/// 常驻联动开了没有（两个用户环境变量都在、而且指向我们这份）
#[tauri::command]
pub fn font_photocraft_linked() -> bool {
    user_env(PC_ENV_PORT).as_deref() == Some(PC_PORT.to_string().as_str())
        && user_env(PC_ENV_TOKEN).is_some_and(|v| PathBuf::from(v) == pc_token_file())
}

/// 打开常驻联动：写当前用户的环境变量（setx 会顺手广播，之后新开的程序都读得到）
#[tauri::command]
pub fn font_photocraft_link() -> Result<(), String> {
    let tok = pc_token_file();
    if let Some(d) = tok.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    for (k, v) in [(PC_ENV_PORT, PC_PORT.to_string()), (PC_ENV_TOKEN, tok.to_string_lossy().to_string())] {
        let st = std::process::Command::new("setx")
            .args([k, &v])
            .creation_flags_compat()
            .status()
            .map_err(|e| format!("写环境变量失败：{e}"))?;
        if !st.success() {
            return Err(format!("写环境变量 {k} 失败"));
        }
    }
    Ok(())
}


async fn apply_photocraft(f: &ApplyFont) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let token = std::fs::read_to_string(pc_token_file()).unwrap_or_default().trim().to_string();
    let stream = tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", PC_PORT)))
        .await
        .ok()
        .and_then(|r| r.ok());
    let Some(stream) = stream else {
        return Err("PHOTOCRAFT_NOT_LINKED".into());
    };
    if token.is_empty() {
        return Err("PHOTOCRAFT_NOT_LINKED".into());
    }
    let (rd, mut wr) = stream.into_split();
    let mut lines = BufReader::new(rd).lines();
    let call = |id: &str, method: &str, params: serde_json::Value| {
        let mut s = serde_json::json!({ "id": id, "method": method, "params": params }).to_string();
        s.push('\n');
        s
    };
    async fn read_reply(
        lines: &mut tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
        id: String,
    ) -> Result<serde_json::Value, String> {
        loop {
            let l = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
                .await
                .map_err(|_| "PhotoCraft 没有回应".to_string())?
                .map_err(|e| e.to_string())?
                .ok_or("PhotoCraft 断开了连接")?;
            let v: serde_json::Value = serde_json::from_str(&l).unwrap_or_default();
            if v.get("id").and_then(|x| x.as_str()) == Some(id.as_str()) {
                return Ok(v);
            }
        }
    }
    wr.write_all(call("auth", "auth", serde_json::json!({ "token": token })).as_bytes()).await.map_err(|e| e.to_string())?;
    let a = read_reply(&mut lines, "auth".into()).await?;
    if a.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Err("PHOTOCRAFT_NOT_LINKED".into());
    }
    /*
      先问它认不认得这款字。PhotoCraft 只扫 Windows 的字体文件夹（系统的和当前用户的），
      XGTools / XGCut 装在自己目录、只在注册表里登记的字它看不到 —— 这时 type.setStyle 照样「成功」，
      图层里记下了字体名，画出来却是替补字体（2026-10-12 用户实测：说换成了，画面没变）。
    */
    let mut family = String::new();
    let mut styles: Vec<String> = vec![];
    for (i, name) in [&f.family, &f.family_local].into_iter().enumerate() {
        if name.is_empty() {
            continue;
        }
        let id = format!("fonts{i}");
        wr.write_all(
            call(&id, "engine.execute", serde_json::json!({ "command": "type.fonts", "params": { "family": name } })).as_bytes(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let r = read_reply(&mut lines, id).await?;
        let faces = r["result"]["faces"].as_array().cloned().unwrap_or_default();
        if !faces.is_empty() {
            family = faces[0]["family"].as_str().unwrap_or(name).to_string();
            styles = faces.iter().filter_map(|x| x["style"].as_str().map(str::to_string)).collect();
            break;
        }
    }
    if family.is_empty() {
        return Err(format!(
            "PhotoCraft 认不到「{}」：它只读 Windows 字体文件夹里的字，字体库/XGCut 装在自己目录里的字它看不到",
            f.family_local
        ));
    }
    let mut params = serde_json::json!({ "font": family });
    // 字重名对得上才带上；对不上让它用默认的那个
    if styles.iter().any(|s| s.eq_ignore_ascii_case(&f.style)) {
        params["fontStyle"] = serde_json::json!(f.style);
    } else if let Some(s) = styles.iter().find(|s| s.eq_ignore_ascii_case("Regular")) {
        params["fontStyle"] = serde_json::json!(s);
    }
    wr.write_all(
        call("set", "engine.execute", serde_json::json!({ "command": "type.setStyle", "params": params })).as_bytes(),
    )
    .await
    .map_err(|e| e.to_string())?;
    let r = read_reply(&mut lines, "set".into()).await?;
    if r.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        Ok("PhotoCraft：已换成这款字".into())
    } else {
        let err = r.get("error").map(|e| e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string())).unwrap_or_default();
        Err(format!("PhotoCraft 没换成：{err}（先选中一个文字图层）"))
    }
}

// ───────────── Affinity ─────────────

const AFFINITY_SSE: &str = "http://127.0.0.1:6767/sse";

/// MCP over SSE：GET /sse 拿到会话的 POST 地址（endpoint 事件），之后 JSON-RPC 往那儿 POST，
/// 回复从 SSE 流里按 id 取。只做这一次调用要用的那么多
async fn affinity_call_script(js: &str) -> Result<String, String> {
    use futures_util::StreamExt;
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let resp = tokio::time::timeout(Duration::from_secs(2), client.get(AFFINITY_SSE).header("Accept", "text/event-stream").send())
        .await
        .map_err(|_| "AFFINITY_NOT_LINKED".to_string())?
        .map_err(|_| "AFFINITY_NOT_LINKED".to_string())?;
    if !resp.status().is_success() {
        return Err("AFFINITY_NOT_LINKED".into());
    }
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // 读 SSE，一个事件一个事件吐出来：(event, data)
    macro_rules! next_event {
        () => {{
            loop {
                if let Some(pos) = buf.find("\n\n") {
                    let raw: String = buf.drain(..pos + 2).collect();
                    let mut ev = String::from("message");
                    let mut data = String::new();
                    for l in raw.lines() {
                        if let Some(v) = l.strip_prefix("event:") {
                            ev = v.trim().to_string();
                        } else if let Some(v) = l.strip_prefix("data:") {
                            if !data.is_empty() {
                                data.push('\n');
                            }
                            data.push_str(v.trim_start());
                        }
                    }
                    break (ev, data);
                }
                let chunk = tokio::time::timeout(Duration::from_secs(15), stream.next())
                    .await
                    .map_err(|_| "Affinity 没有回应".to_string())?
                    .ok_or("Affinity 断开了连接")?
                    .map_err(|e| e.to_string())?;
                // 统一成 \n，好按空行切事件
                buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
            }
        }};
    }
    let (_, endpoint) = loop {
        let (ev, data) = next_event!();
        if ev == "endpoint" {
            break (ev, data);
        }
    };
    let post_url = if endpoint.starts_with("http") { endpoint } else { format!("http://127.0.0.1:6767{endpoint}") };
    let post = |body: serde_json::Value| client.post(&post_url).json(&body).send();
    post(serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "XGTools", "version": "1" } }
    }))
    .await
    .map_err(|e| e.to_string())?;
    loop {
        let (_, data) = next_event!();
        let v: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
        if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
            break;
        }
    }
    post(serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.map_err(|e| e.to_string())?;
    post(serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": { "name": "execute_script", "arguments": { "script": js } }
    }))
    .await
    .map_err(|e| e.to_string())?;
    loop {
        let (_, data) = next_event!();
        let v: serde_json::Value = serde_json::from_str(&data).unwrap_or_default();
        if v.get("id").and_then(|x| x.as_i64()) == Some(2) {
            if let Some(e) = v.get("error") {
                return Err(format!("Affinity 报错：{e}"));
            }
            let text = v["result"]["content"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            if v["result"]["isError"].as_bool() == Some(true) {
                return Err(format!("Affinity 脚本出错：{text}"));
            }
            return Ok(text);
        }
    }
}

/// 给调试/摸接口用：在 Affinity 里跑任意一段脚本，原样返回输出
#[tauri::command]
pub async fn font_affinity_script(script: String) -> Result<String, String> {
    affinity_call_script(&script).await
}

async fn apply_affinity(f: &ApplyFont) -> Result<String, String> {
    let js = AFFINITY_SET_FONT_JS
        .replace("__FAMILY__", &js_str(&f.family))
        .replace("__FAMILY_LOCAL__", &js_str(&f.family_local))
        .replace("__STYLE__", &js_str(&f.style));
    let out = affinity_call_script(&js).await?;
    if out.contains("XG_OK") {
        Ok("Affinity：已换成这款字".into())
    } else if out.contains("XG_NOTEXT") {
        Err("Affinity 里没有选中文字".into())
    } else {
        Err(format!("Affinity 没换成：{out}"))
    }
}

/// Affinity 的脚本 SDK 还在 beta，改字体的写法等实测后填（见 font_affinity_script）
const AFFINITY_SET_FONT_JS: &str = r#"console.log('XG_UNSUPPORTED')"#;

// ───────────── 入口 ─────────────

#[tauri::command]
pub async fn font_apply(target: String, font: ApplyFont) -> Result<String, String> {
    match target.as_str() {
        "photoshop" => tokio::task::spawn_blocking(move || apply_photoshop(&font)).await.map_err(|e| e.to_string())?,
        "resolve" => tokio::task::spawn_blocking(move || apply_resolve(&font)).await.map_err(|e| e.to_string())?,
        "photocraft" => apply_photocraft(&font).await,
        "affinity" => apply_affinity(&font).await,
        _ => Err(format!("不认识的目标：{target}")),
    }
}
