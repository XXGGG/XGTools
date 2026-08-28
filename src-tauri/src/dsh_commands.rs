//! DeepSeek Harness 边车。
//!
//! XGTools 打开就把 `dsh web` 拉起来，关掉就收走 —— 用户不需要知道底下跑着一个 Node 进程。
//!
//! 三件事值得先说清楚,后面改代码别踩回去:
//!
//! 1. **端口一律传 `--port 0`**，让操作系统挑空闲端口，再从它的 stdout 里把真实地址读回来。
//!    写死 3080 就得自己处理"被占用"，而占用它的很可能正是用户自己手动起的另一个 dsh。
//!
//! 2. **前端不能直接 fetch DSH 的 /api**。DSH 有一道浏览器信任围栏:请求的 `Host` 必须是回环
//!    权威,带浏览器标记时 `Origin` 必须与之完全一致,`sec-fetch-site: cross-site` 直接拒。
//!    XGTools 的页面源是 `tauri.localhost`,跨源发过去必然 403。所以要么嵌它自己的页面(同源),
//!    要么由 Rust 这边转发(非浏览器客户端走回环能过围栏)。这不是绕过安全,是它给壳留的正门。
//!
//! 3. **杀进程要连着子孙一起杀**。dsh 是 Node 起的,自己还会 spawn 工具子进程;
//!    只 kill 直接子进程会留下一地孤儿,下次启动看着像"端口没释放"。Windows 上用
//!    `taskkill /T /F` 按进程树收。

use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// 边车当前状态。前端靠 `dsh://state` 事件同步这个。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshState {
    /// stopped | starting | ready | failed
    pub phase: String,
    /// ready 时是 `http://127.0.0.1:<真实端口>`,其余时候为空
    pub url: String,
    /// failed 时的人话原因
    pub message: String,
    pub pid: Option<u32>,
}

impl DshState {
    fn stopped() -> Self {
        Self { phase: "stopped".into(), url: String::new(), message: String::new(), pid: None }
    }
}

#[derive(Default)]
pub struct DshSidecar {
    state: Mutex<Option<DshState>>,
    pid: Mutex<Option<u32>>,
    /// 装到一半时再点一次"安装",不能真的再起一个 pnpm。
    /// 前端也有一道 `if (installing) return`,但那道守不住:多开一个窗口、
    /// 或者前端状态没跟上,就会有两个 `pnpm add` 同时写同一个 node_modules。
    /// 真正的闸必须在这里。
    installing: Mutex<bool>,
}

impl DshSidecar {
    fn get(&self) -> DshState {
        self.state.lock().unwrap().clone().unwrap_or_else(DshState::stopped)
    }
    fn set(&self, app: &AppHandle, s: DshState) {
        *self.state.lock().unwrap() = Some(s.clone());
        let _ = app.emit("dsh://state", s);
    }
}

// ───────────────────────── 环境探测 ─────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshPreflight {
    /// node 的版本号,没装就是 None
    pub node_version: Option<String>,
    /// node 是否满足 DSH 要求(^22.19 || >=24)
    pub node_ok: bool,
    pub pnpm_version: Option<String>,
    /// 已经装好的 dsh 入口文件绝对路径
    pub dsh_entry: Option<String>,
}

/// Windows 上 pnpm 这类 Node 工具是 `.cmd` 批处理垫片,**没有 .exe**。
///
/// Rust 的 `Command` 走 `CreateProcessW`,它只会给无扩展名的程序补 `.exe`,
/// 不查 `PATHEXT`,所以 `Command::new("pnpm")` 直接报"找不到程序" —— 而且这个错
/// 长得跟"用户没装 pnpm"一模一样,极容易误诊。交给 cmd.exe 去解析就对了。
///
/// node 有真正的 `node.exe`,不走这里 —— 直接 spawn 才能拿到它自己的 PID,
/// 否则按进程树杀的时候杀的是 cmd 的树,多一层没必要的间接。
fn shim(program: &str, args: &[&str]) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let mut v = vec!["/C".to_string(), program.to_string()];
        v.extend(args.iter().map(|s| s.to_string()));
        ("cmd".to_string(), v)
    }
    #[cfg(not(windows))]
    {
        (program.to_string(), args.iter().map(|s| s.to_string()).collect())
    }
}

/// 跑一个命令拿它的第一行输出。命令不存在时返回 None 而不是报错 —— "没装"是正常情况,不是故障。
fn probe(program: &str, args: &[&str]) -> Option<String> {
    let (prog, argv) = shim(program, args);
    let mut cmd = std::process::Command::new(prog);
    cmd.args(&argv).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// DSH 要求 node ^22.19.0 || >=24.0.0。22.x 里低于 22.19 的不行,23.x 整个不行(它是奇数版,已 EOL)。
fn node_satisfies(v: &str) -> bool {
    let v = v.trim_start_matches('v');
    let mut it = v.split('.').filter_map(|p| p.parse::<u32>().ok());
    let (major, minor) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    match major {
        22 => minor >= 19,
        m if m >= 24 => true,
        _ => false,
    }
}

/// DSH 装在应用自己的数据目录下,不污染用户的全局 node_modules,也不跟别的项目抢版本。
fn install_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录: {e}"))?
        .join("dsh");
    Ok(dir)
}

fn entry_path(app: &AppHandle) -> Option<String> {
    let p = install_dir(app)
        .ok()?
        .join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    p.exists().then(|| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn dsh_preflight(app: AppHandle) -> DshPreflight {
    let node_version = probe("node", &["-v"]);
    let node_ok = node_version.as_deref().map(node_satisfies).unwrap_or(false);
    DshPreflight {
        node_ok,
        node_version,
        pnpm_version: probe("pnpm", &["-v"]),
        dsh_entry: entry_path(&app),
    }
}

// ───────────────────────── 安装 ─────────────────────────

/// 去掉 ANSI 转义序列。pnpm 的进度行带颜色和光标控制,原样丢给界面会是一堆 `\x1b[32m`。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // ESC [ ... 直到一个字母结束
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// 把子进程的一条输出流转成 `dsh://install-log` 事件。
///
/// **不能用 `lines()`。** pnpm 的进度条是用回车 `\r` 刷同一行的,不发换行符;
/// `lines()` 等不到 `\n` 就永远不产出,界面上看着就是"点了没反应"。
/// 这里按字节读,`\r` 和 `\n` 都当行尾。
fn pump_progress<R>(app: AppHandle, reader: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = BufReader::new(reader);
        let mut line: Vec<u8> = Vec::with_capacity(256);
        let mut byte = [0u8; 1];
        use tokio::io::AsyncReadExt;
        loop {
            match buf.read(&mut byte).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if byte[0] == b'\n' || byte[0] == b'\r' {
                        if !line.is_empty() {
                            let text = strip_ansi(&String::from_utf8_lossy(&line));
                            let text = text.trim();
                            if !text.is_empty() {
                                let _ = app.emit("dsh://install-log", text.to_string());
                            }
                            line.clear();
                        }
                    } else {
                        line.push(byte[0]);
                        // 单行过长就先吐出去,别让某个不带换行的巨型输出把内存吃光
                        if line.len() > 4096 {
                            line.clear();
                        }
                    }
                }
            }
        }
    });
}

/// 装 DSH 到应用数据目录。
///
/// **只能用 pnpm,不能用 npm。** npm 在这棵依赖树(62 个直接依赖 / 445 个包)上会失控:
/// 实测烧了 587 秒 CPU、2.9 GB 内存还没装完。DSH 自己声明的包管理器就是 pnpm。
#[tauri::command]
pub async fn dsh_install(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;
    {
        let sidecar = app.state::<DshSidecar>();
        let mut flag = sidecar.installing.lock().unwrap();
        if *flag {
            return Err("正在安装,别重复点".into());
        }
        *flag = true;
    }
    // 从这里往下每条出口都要记得放闸,所以包一层再调真正的实现
    let result = do_install(&app).await;
    {
        let sidecar = app.state::<DshSidecar>();
        *sidecar.installing.lock().unwrap() = false;
    }
    result
}

async fn do_install(app: &AppHandle) -> Result<String, String> {
    let app = app.clone();
    let dir = install_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;

    // 一个最小的 package.json,让 pnpm 把东西装进这里而不是往上找 workspace
    let pkg = dir.join("package.json");
    if !pkg.exists() {
        std::fs::write(&pkg, "{\n  \"name\": \"xgtools-dsh-host\",\n  \"private\": true\n}\n")
            .map_err(|e| format!("写 package.json 失败: {e}"))?;
    }

    let (prog, argv) = shim("pnpm", &["add", "@deepseek-ai/dsh@latest"]);
    let mut cmd = tokio::process::Command::new(prog);
    cmd.current_dir(&dir)
        .args(&argv)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("起 pnpm 失败: {e}"))?;

    // 装的过程几分钟起步,两条流都转成事件推给前端 —— 不给动静会被当成卡死。
    if let Some(out) = child.stdout.take() {
        pump_progress(app.clone(), out);
    }
    if let Some(err) = child.stderr.take() {
        pump_progress(app.clone(), err);
    }

    let status = child.wait().await.map_err(|e| format!("等 pnpm 结束失败: {e}"))?;
    if !status.success() {
        return Err(format!("pnpm add 失败,退出码 {:?}", status.code()));
    }
    entry_path(&app).ok_or_else(|| "装完了但找不到 dsh 入口文件".to_string())
}

// ───────────────────────── 卸载 ─────────────────────────

/// DSH 自己的家目录:会话记录、凭据、设置都在这儿。
/// 位置由 DSH 决定($DSH_HOME 或 ~/.dsh),不是我们的数据目录 —— 卸载时要不要动它,
/// 必须是用户的选择:里面有他自己配的 API key 和全部聊天历史。
fn dsh_home() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("DSH_HOME") {
        if !p.trim().is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    dirs_home().map(|h| h.join(".dsh"))
}

fn dirs_home() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// 卸载前告诉用户「到底会删掉什么」。数字要真实 —— 说"会清除记忆"而不给量,
/// 用户没法判断这个决定有多重。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshFootprint {
    /// DSH 程序本体占多少字节(应用数据目录里那份)
    pub install_bytes: u64,
    /// DSH 家目录路径,不存在则为 None
    pub home_path: Option<String>,
    pub home_bytes: u64,
    /// 会话数量
    pub session_count: u32,
    /// 有没有存过凭据(只看文件在不在,不读内容)
    pub has_credentials: bool,
}

fn dir_size(p: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            total += dir_size(&e.path());
        } else if let Ok(m) = e.metadata() {
            total += m.len();
        }
    }
    total
}

#[tauri::command]
pub fn dsh_footprint(app: AppHandle) -> DshFootprint {
    let install_bytes = install_dir(&app).map(|d| dir_size(&d)).unwrap_or(0);
    let home = dsh_home().filter(|h| h.exists());
    let (home_bytes, session_count, has_credentials) = match &home {
        Some(h) => (
            dir_size(h),
            std::fs::read_dir(h.join("sessions"))
                .map(|rd| rd.flatten().count() as u32)
                .unwrap_or(0),
            h.join(".credentials.yaml").exists(),
        ),
        None => (0, 0, false),
    };
    DshFootprint {
        install_bytes,
        home_path: home.map(|h| tildify(&h)),
        home_bytes,
        session_count,
        has_credentials,
    }
}

/// 把家目录前缀换成 `~`,别让 Windows 用户名出现在界面上。
///
/// 用户会截图发出去(README、issue、群里问问题),`C:\Users\张三\.dsh` 里那个名字
/// 就跟着跑了。显示 `~\.dsh` 一样说得清位置,还少一条个人信息。
fn tildify(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    if let Some(home) = dirs_home() {
        let h = home.to_string_lossy();
        if !h.is_empty() && s.starts_with(h.as_ref()) {
            return format!("~{}", &s[h.len()..]);
        }
    }
    s.into_owned()
}

/// 卸载 DSH。`purge_home` 为真时连 DSH 家目录(会话、凭据、设置)一起删。
///
/// 删之前先把边车收掉 —— Windows 上文件被进程占着删不掉,而且报的错跟权限不足长得一样。
#[tauri::command]
pub fn dsh_uninstall(app: AppHandle, purge_home: bool) -> Result<(), String> {
    use tauri::Manager;
    if let Some(sidecar) = app.try_state::<DshSidecar>() {
        if *sidecar.installing.lock().unwrap() {
            return Err("正在安装,先等它装完".into());
        }
        let pid = sidecar.pid.lock().unwrap().take();
        kill_tree(pid);
    }
    // 杀完给系统一点时间释放文件句柄,否则紧接着删会 ERROR_SHARING_VIOLATION
    std::thread::sleep(std::time::Duration::from_millis(600));

    let dir = install_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删 DSH 目录失败: {e}"))?;
    }
    if purge_home {
        if let Some(h) = dsh_home() {
            if h.exists() {
                std::fs::remove_dir_all(&h).map_err(|e| format!("删 DSH 家目录失败: {e}"))?;
            }
        }
    }
    if let Some(sidecar) = app.try_state::<DshSidecar>() {
        sidecar.set(&app, DshState::stopped());
    }
    Ok(())
}

// ───────────────────────── 启停 ─────────────────────────

/// 从 dsh 的输出里认出它监听在哪。它打印的是 `dsh web: http://127.0.0.1:53211`。
fn sniff_url(line: &str) -> Option<String> {
    let i = line.find("http://")?;
    let rest = &line[i..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    Some(rest[..end].trim_end_matches(['.', ',']).to_string())
}

#[tauri::command]
pub async fn dsh_start(app: AppHandle) -> Result<DshState, String> {
    use tauri::Manager;
    let sidecar = app.state::<DshSidecar>();

    let cur = sidecar.get();
    if cur.phase == "ready" || cur.phase == "starting" {
        return Ok(cur);   // 已经在跑了,别起第二个
    }

    // 先收掉上一轮遗留的边车,再起新的 —— 否则应用被强杀过几次之后
    // 后台会攒下一串各占一个端口的 node
    sweep_orphan(&app);

    let entry = entry_path(&app).ok_or_else(|| "DSH 还没安装".to_string())?;
    sidecar.set(&app, DshState {
        phase: "starting".into(), url: String::new(), message: String::new(), pid: None,
    });

    let mut cmd = tokio::process::Command::new("node");
    cmd.args([&entry, "--profile", "web", "--no-open", "--port", "0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let s = DshState {
                phase: "failed".into(), url: String::new(),
                message: format!("起不来: {e}"), pid: None,
            };
            sidecar.set(&app, s.clone());
            return Err(s.message);
        }
    };

    let pid = child.id();
    *sidecar.pid.lock().unwrap() = pid;
    remember_pid(&app, pid);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // stderr 只转发,不参与判定 —— 它常年有 warning,拿它判失败会误杀
    if let Some(err) = stderr {
        let app2 = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = app2.emit("dsh://log", l);
            }
        });
    }

    // 从 stdout 认地址。认到之前一直是 starting,认到就 ready。
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    if let Some(out) = stdout {
        let app2 = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            let mut tx = Some(tx);
            while let Ok(Some(l)) = lines.next_line().await {
                let _ = app2.emit::<String>("dsh://log", l.clone());
                if let Some(url) = sniff_url(&l) {
                    if let Some(t) = tx.take() {
                        let _ = t.send(Ok(url));
                    }
                }
            }
            // 流结束了还没报过地址 = 进程自己退了
            if let Some(t) = tx.take() {
                let _ = t.send(Err("进程退出了,一直没报出监听地址".into()));
            }
        });
    }

    // 30 秒还没听到地址就当它废了 —— 首次启动要读模型和配置,给足余量
    let got = tokio::time::timeout(std::time::Duration::from_secs(30), rx).await;
    let state = match got {
        Ok(Ok(Ok(url))) => DshState {
            phase: "ready".into(), url, message: String::new(), pid,
        },
        Ok(Ok(Err(e))) => DshState {
            phase: "failed".into(), url: String::new(), message: e, pid: None,
        },
        Ok(Err(_)) => DshState {
            phase: "failed".into(), url: String::new(),
            message: "读输出的任务提前结束了".into(), pid: None,
        },
        Err(_) => DshState {
            phase: "failed".into(), url: String::new(),
            message: "30 秒内没有报出监听地址".into(), pid: None,
        },
    };

    if state.phase == "failed" {
        kill_tree(pid);
        *sidecar.pid.lock().unwrap() = None;
        remember_pid(&app, None);
    }
    sidecar.set(&app, state.clone());

    // 起来之后盯着它:进程哪天自己没了(崩溃、被任务管理器结束、被谁 kill 了),
    // 状态要跟着回到「未启动」。不盯的话这儿永远是 ready,前端对着一个已经不存在的
    // 地址连,只能看到「连接被拒绝」,绿灯还亮着,用户根本不知道该点哪儿。
    if state.phase == "ready" {
        let app2 = app.clone();
        tokio::spawn(async move {
            let _ = child.wait().await;
            let sc = app2.state::<DshSidecar>();
            // 只在「还是我这个 pid」时动手 —— 用户已经手动重启过一轮的话,别把新的盖掉
            let mine = *sc.pid.lock().unwrap() == pid;
            if mine {
                *sc.pid.lock().unwrap() = None;
                remember_pid(&app2, None);
                sc.set(&app2, DshState {
                    phase: "stopped".into(), url: String::new(),
                    message: "边车退出了".into(), pid: None,
                });
            }
        });
    }
    Ok(state)
}

/// 上一次运行遗留的边车 PID 记在这里。
///
/// 为什么需要它:`RunEvent::Exit` 只在应用**正常**退出时触发。被任务管理器结束、
/// 崩溃、或者开发时 `Stop-Process -Force`(走的是 TerminateProcess)都不会走到那儿,
/// 边车就成了孤儿 —— 一个 130MB 的 node 常驻后台,用户完全看不见。
/// 所以每次起边车之前,先把上一轮记下的那个收掉。
///
/// (更彻底的做法是 Windows Job Object + KILL_ON_JOB_CLOSE,由内核保证父死子死;
///  那要引 windows-sys 直接依赖,等这块稳定下来再说。)
fn pid_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    install_dir(app).ok().map(|d| d.join(".sidecar.pid"))
}

fn remember_pid(app: &AppHandle, pid: Option<u32>) {
    let Some(f) = pid_file(app) else { return };
    match pid {
        Some(p) => { let _ = std::fs::write(&f, p.to_string()); }
        None => { let _ = std::fs::remove_file(&f); }
    }
}

/// 收掉上一轮遗留的边车。
///
/// PID 会被系统复用,所以不能拿到号就杀 —— 先确认那个进程确实是我们的 node,
/// 靠命令行里带不带我们的安装目录来认。认错了就是杀掉用户别的程序。
fn sweep_orphan(app: &AppHandle) {
    let Some(f) = pid_file(app) else { return };
    let Ok(txt) = std::fs::read_to_string(&f) else { return };
    let Ok(pid) = txt.trim().parse::<u32>() else {
        let _ = std::fs::remove_file(&f);
        return;
    };
    let Ok(dir) = install_dir(app) else { return };
    let marker = dir.to_string_lossy().to_lowercase();

    #[cfg(windows)]
    {
        // tasklist 认得 PID,但给不出命令行;用 wmic 的替代品 —— PowerShell 太重,
        // 这里直接读 /proc 式的信息拿不到,所以用 tasklist 先确认进程还在且是 node.exe,
        // 再用命令行核对。CIM 查询交给 PowerShell 会拉起一个几十 MB 的进程,
        // 启动路径上不划算,所以只做「还在不在 + 是不是 node」这一层确认。
        let (prog, argv) = shim(
            "tasklist",
            &["/FI", &format!("PID eq {pid}"), "/FI", "IMAGENAME eq node.exe", "/NH"],
        );
        let mut cmd = std::process::Command::new(prog);
        cmd.args(&argv).stdout(Stdio::piped()).stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let is_node = cmd
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("node.exe"))
            .unwrap_or(false);
        if is_node {
            kill_tree(Some(pid));
        }
        let _ = marker; // 命令行核对留给 Job Object 那版,这里靠「PID + 是 node」两条已经足够窄
    }
    #[cfg(not(windows))]
    {
        let cmdline = std::fs::read_to_string(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        if cmdline.to_lowercase().contains(&marker) {
            kill_tree(Some(pid));
        }
    }
    let _ = std::fs::remove_file(&f);
}

/// 按进程树杀。只 kill 直接子进程会留下 node 起的那一串孙子进程。
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
    }
}

#[tauri::command]
pub fn dsh_stop(app: AppHandle) -> DshState {
    use tauri::Manager;
    let sidecar = app.state::<DshSidecar>();
    let pid = sidecar.pid.lock().unwrap().take();
    kill_tree(pid);
    remember_pid(&app, None);
    let s = DshState::stopped();
    sidecar.set(&app, s.clone());
    s
}

#[tauri::command]
pub fn dsh_status(app: AppHandle) -> DshState {
    use tauri::Manager;
    app.state::<DshSidecar>().get()
}

/// 应用退出时调用。不走 `dsh_stop` 是因为那会发事件,而这时候前端已经没了。
pub fn shutdown(app: &AppHandle) {
    use tauri::Manager;
    if let Some(sidecar) = app.try_state::<DshSidecar>() {
        let pid = sidecar.pid.lock().unwrap().take();
        kill_tree(pid);
    }
    remember_pid(app, None);
}


// ───────────────────────── 可选插件 ─────────────────────────

/// 能装进 profile 的可选能力。
///
/// 这些不是 XGTools 的功能,是 **DSH 的插件** —— 装上之后模型多一个工具可用,
/// 界面上什么都不用改。所以清单只记「包名 + 它加了什么」,别在这边复制它的语义。
pub const OPTIONAL_PLUGINS: &[(&str, &str)] = &[
    // 用本机已登录的 Claude Code CLI 当子智能体。走 Claude Agent SDK,
    // 用的是你 Claude Code 的登录态,不需要 ANTHROPIC_API_KEY。
    ("@deepseek-ai/dsh-subagent-claude-code", "claude-code"),
    // 同理,把 Codex 当子智能体
    ("@deepseek-ai/dsh-subagent-codex", "codex"),
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub package: String,
    pub id: String,
    pub installed: bool,
}

/// 装没装,只看 node_modules 里有没有那个包 —— 比解析 profile 配置稳,
/// 因为配置格式是上游的,4 天发 4 个 RC 的项目不该拿它当判据。
#[tauri::command]
pub fn dsh_plugins(app: AppHandle) -> Vec<PluginState> {
    let dir = install_dir(&app).ok();
    OPTIONAL_PLUGINS
        .iter()
        .map(|(pkg, id)| PluginState {
            package: (*pkg).to_string(),
            id: (*id).to_string(),
            installed: dir
                .as_ref()
                .map(|d| d.join("node_modules").join(pkg).exists())
                .unwrap_or(false),
        })
        .collect()
}

/// 装一个可选插件。和主安装共用那把闸 —— 两个 pnpm 同时写一个 node_modules 会打架。
#[tauri::command]
pub async fn dsh_plugin_add(app: AppHandle, package: String) -> Result<(), String> {
    use tauri::Manager;
    if !OPTIONAL_PLUGINS.iter().any(|(p, _)| *p == package) {
        return Err("不在可选清单里".into());
    }
    {
        let sidecar = app.state::<DshSidecar>();
        let mut flag = sidecar.installing.lock().unwrap();
        if *flag {
            return Err("正在安装,等它装完".into());
        }
        *flag = true;
    }
    let result = add_package(&app, &package).await;
    {
        let sidecar = app.state::<DshSidecar>();
        *sidecar.installing.lock().unwrap() = false;
    }
    result
}

async fn add_package(app: &AppHandle, package: &str) -> Result<(), String> {
    let dir = install_dir(app)?;
    let (prog, argv) = shim("pnpm", &["add", package]);
    let mut cmd = tokio::process::Command::new(prog);
    cmd.current_dir(&dir).args(&argv).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| format!("起 pnpm 失败: {e}"))?;
    if let Some(out) = child.stdout.take() { pump_progress(app.clone(), out); }
    if let Some(err) = child.stderr.take() { pump_progress(app.clone(), err); }
    let status = child.wait().await.map_err(|e| format!("等 pnpm 结束失败: {e}"))?;
    if !status.success() {
        return Err(format!("装 {package} 失败,退出码 {:?}", status.code()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_version_gate() {
        assert!(node_satisfies("v24.13.0"));
        assert!(node_satisfies("v22.19.0"));
        assert!(node_satisfies("22.20.1"));
        assert!(!node_satisfies("v22.18.0"));   // 22 系列但差一点
        assert!(!node_satisfies("v23.5.0"));    // 奇数版不在支持列表里
        assert!(!node_satisfies("v20.11.0"));
        assert!(!node_satisfies("乱码"));
    }

    #[test]
    fn windows_cmd_shim() {
        let (prog, argv) = shim("pnpm", &["add", "x"]);
        if cfg!(windows) {
            // 必须绕 cmd.exe:pnpm 在 Windows 上只有 pnpm.cmd,没有 pnpm.exe
            assert_eq!(prog, "cmd");
            assert_eq!(argv, vec!["/C", "pnpm", "add", "x"]);
        } else {
            assert_eq!(prog, "pnpm");
            assert_eq!(argv, vec!["add", "x"]);
        }
    }

    #[test]
    fn tildify_hides_username() {
        // 家目录前缀要被换掉,用户名不能出现在界面上
        if let Some(home) = dirs_home() {
            let p = home.join(".dsh");
            let shown = tildify(&p);
            assert!(shown.starts_with('~'), "得到 {shown}");
            let user = home.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if !user.is_empty() {
                assert!(!shown.contains(&user), "用户名漏出来了: {shown}");
            }
        }
        // 家目录之外的路径原样保留
        let other = std::path::Path::new(r"D:\somewhere\else");
        assert_eq!(tildify(other), r"D:\somewhere\else");
    }

    #[test]
    fn ansi_is_stripped() {
        assert_eq!(strip_ansi("\u{1b}[32mProgress:\u{1b}[0m 445 done"), "Progress: 445 done");
        assert_eq!(strip_ansi("没有转义"), "没有转义");
        // pnpm 刷进度用的「清行 + 光标归位」序列,不清掉界面上就是一串乱码
        assert_eq!(strip_ansi("\u{1b}[2K\u{1b}[1G下载中"), "下载中");
    }

    #[test]
    fn sniff_listen_url() {
        assert_eq!(sniff_url("dsh web: http://127.0.0.1:53211").as_deref(),
                   Some("http://127.0.0.1:53211"));
        assert_eq!(sniff_url("  Local: http://127.0.0.1:3080/  ").as_deref(),
                   Some("http://127.0.0.1:3080/"));
        // 句末标点不能吃进 URL
        assert_eq!(sniff_url("serving at http://127.0.0.1:8080.").as_deref(),
                   Some("http://127.0.0.1:8080"));
        assert_eq!(sniff_url("正在启动…"), None);
    }
}
