/*!
框选区域录屏。

# 怎么录的

用 ffmpeg 的 `gdigrab` 直接抓桌面上的一块矩形 —— 不用装任何东西，
ffmpeg 早就在包里了（格式转换那一页在用同一个）。

    -f gdigrab -offset_x X -offset_y Y -video_size WxH -i desktop

# 停止为什么不能 kill

格式转换那边取消是 `child.kill()` 然后把半截文件删掉 —— 那里本来就不要那个文件。
录屏正好相反：**那个文件就是成果**。硬杀 ffmpeg，MP4 的索引（moov）还没写进去，
出来的文件多数播放器直接打不开。

所以停止是往 ffmpeg 的标准输入写一个 `q` —— 它自己收尾、补索引、正常退出。
真正的「取消」（不要这段）才走 kill + 删文件。

# 一次只准录一段

录屏是「独占」的：屏幕就一块，同时跑两个 ffmpeg 抓同一块区域没有意义，
而且两个都在写 mp4，谁停谁不知道。所以状态是一个 `Option`，不是 map。
*/
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

// ─── 状态 ──────────────────────────────────────

/// 正在录的那一段
struct Recording {
    child: tokio::process::Child,
    output: PathBuf,
    started: Instant,
    /// 已经喊过停了。防止连点两次停止：第二次会等在一个已经退出的进程上
    stopping: bool,
}

#[derive(Default)]
pub struct RecordState {
    inner: Mutex<Option<Recording>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordStatus {
    pub recording: bool,
    /// 已经录了多少毫秒
    pub elapsed_ms: u64,
    /// 文件现在多大（字节）。ffmpeg 边写边涨，用来给个「还活着」的信号
    pub size_bytes: u64,
    pub output: Option<String>,
}

// ─── 工具 ──────────────────────────────────────

fn ffmpeg_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("取资源目录失败: {e}"))?;
    let p = dir.join("resources/ffmpeg/ffmpeg.exe");
    if p.exists() {
        Ok(p)
    } else {
        Err("没找到 ffmpeg。去「格式转换」那一页点一下下载就有了".into())
    }
}

/// 录屏存哪。传空就用「下载\Recordings」—— 录屏是随手录完就发出去的东西，
/// 堆在桌面上碍眼，下载夹本来就是这种「拿了就走」的暂存处
fn resolve_dir(custom: Option<String>) -> Result<PathBuf, String> {
    let dir = match custom.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => PathBuf::from(s),
        _ => dirs::download_dir()
            .or_else(dirs::desktop_dir)
            .ok_or("找不到下载目录")?
            .join("Recordings"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    Ok(dir)
}

/// `名字 (1).mp4` 这种避重名，和格式转换那边一致
fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let dir = path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = path.extension().unwrap_or_default().to_string_lossy().to_string();
    for i in 1..10000 {
        let c = dir.join(format!("{stem} ({i}).{ext}"));
        if !c.exists() {
            return c;
        }
    }
    path
}

// ─── 命令 ──────────────────────────────────────

/// 开始录。x/y/w/h 是**物理像素的屏幕绝对坐标**（前端已经乘过缩放）
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    fps: u32,
    dir: Option<String>,
) -> Result<String, String> {
    if state.inner.lock().unwrap().is_some() {
        return Err("已经在录了".into());
    }

    /*
        宽高必须是偶数。

        libx264 用的是 4:2:0 色度采样（yuv420p），色度平面正好是亮度的一半，
        奇数边长除不尽 —— ffmpeg 直接报 "width not divisible by 2" 退出。
        手拖的选区十有八九是奇数，所以这里往下抹平，宁可少一像素。
    */
    let w = (width / 2) * 2;
    let h = (height / 2) * 2;
    if w < 16 || h < 16 {
        return Err("这块区域太小了，录不了".into());
    }

    let ff = ffmpeg_path(&app)?;
    let stamp = chrono_stamp();
    let out = unique_path(resolve_dir(dir)?.join(format!("record_{stamp}.mp4")));
    let out_str = out.to_string_lossy().to_string();

    let fps = fps.clamp(5, 60);
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(), "error".into(),
        "-f".into(), "gdigrab".into(),
        "-framerate".into(), fps.to_string(),
        "-offset_x".into(), x.to_string(),
        "-offset_y".into(), y.to_string(),
        "-video_size".into(), format!("{w}x{h}"),
        "-draw_mouse".into(), "1".into(),
        "-i".into(), "desktop".into(),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "veryfast".into(),
        "-crf".into(), "23".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        // 索引写在文件开头,拖进度条不用先读到尾
        "-movflags".into(), "+faststart".into(),
        "-y".into(),
        out_str.clone(),
    ];

    let mut cmd = tokio::process::Command::new(&ff);
    cmd.args(&args)
        // stdin 要留着 —— 停止就是往这儿写一个 q
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let child = cmd.spawn().map_err(|e| format!("起 ffmpeg 失败: {e}"))?;

    *state.inner.lock().unwrap() = Some(Recording {
        child,
        output: out.clone(),
        started: Instant::now(),
        stopping: false,
    });

    let _ = app.emit("record-started", &out_str);
    Ok(out_str)
}

/// 停止并保存。返回文件路径
#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordState>,
) -> Result<String, String> {
    // 先把整条记录取出来，别把锁带进 await —— MutexGuard 不能跨 await
    let mut rec = {
        let mut g = state.inner.lock().unwrap();
        match g.as_mut() {
            None => return Err("现在没在录".into()),
            Some(r) if r.stopping => return Err("正在收尾，等一下".into()),
            Some(r) => r.stopping = true,
        }
        g.take().unwrap()
    };

    let out = rec.output.clone();

    // 往 stdin 写 q：ffmpeg 收到就自己收尾（补 moov 索引）再退出
    if let Some(stdin) = rec.child.stdin.as_mut() {
        let _ = stdin.write_all(b"q\n").await;
        let _ = stdin.flush().await;
    }
    drop(rec.child.stdin.take()); // 关掉管道，ffmpeg 那边 read 才会返回

    /*
        给它 5 秒收尾。超时就硬杀 —— 文件多半废了，但总比界面一直卡着强。
        正常情况下几十毫秒就退了。
    */
    let waited = tokio::time::timeout(std::time::Duration::from_secs(5), rec.child.wait()).await;
    if waited.is_err() {
        let _ = rec.child.kill().await;
        let _ = rec.child.wait().await;
    }

    let out_str = out.to_string_lossy().to_string();
    if !out.exists() || std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&out);
        return Err("录出来是空的。多半是这块区域被别的窗口全挡住了".into());
    }

    let _ = app.emit("record-stopped", &out_str);
    Ok(out_str)
}

/// 不要这段。硬杀 + 删文件
#[tauri::command]
pub async fn cancel_recording(
    app: AppHandle,
    state: tauri::State<'_, RecordState>,
) -> Result<(), String> {
    let mut rec = match state.inner.lock().unwrap().take() {
        Some(r) => r,
        None => return Ok(()),
    };
    let _ = rec.child.kill().await;
    let _ = rec.child.wait().await;
    let _ = std::fs::remove_file(&rec.output);
    let _ = app.emit("record-cancelled", ());
    Ok(())
}

#[tauri::command]
pub fn recording_status(state: tauri::State<'_, RecordState>) -> RecordStatus {
    let g = state.inner.lock().unwrap();
    match g.as_ref() {
        None => RecordStatus {
            recording: false,
            elapsed_ms: 0,
            size_bytes: 0,
            output: None,
        },
        Some(r) => RecordStatus {
            recording: true,
            elapsed_ms: r.started.elapsed().as_millis() as u64,
            size_bytes: std::fs::metadata(&r.output).map(|m| m.len()).unwrap_or(0),
            output: Some(r.output.to_string_lossy().to_string()),
        },
    }
}

/// 把录好的 mp4 转成 GIF。
///
/// 走两遍：先给这段视频算一张最合适的 256 色调色板，再拿这张板子转。
/// 一遍到底的话 GIF 只能用固定的网页安全色，渐变和肤色会花成一块一块。
#[tauri::command]
pub async fn recording_to_gif(
    app: AppHandle,
    input: String,
    fps: u32,
    width: u32,
) -> Result<String, String> {
    let ff = ffmpeg_path(&app)?;
    let src = PathBuf::from(&input);
    if !src.exists() {
        return Err("源文件不见了".into());
    }
    let out = unique_path(src.with_extension("gif"));
    let out_str = out.to_string_lossy().to_string();

    let fps = fps.clamp(5, 30);
    // width=0 表示不缩放；-1 让高按比例走，再对齐到偶数
    let scale = if width == 0 {
        "scale=trunc(iw/2)*2:-2:flags=lanczos".to_string()
    } else {
        format!("scale={}:-2:flags=lanczos", (width / 2) * 2)
    };
    let vf = format!("fps={fps},{scale},split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5");

    let mut cmd = tokio::process::Command::new(&ff);
    cmd.args([
        "-hide_banner", "-loglevel", "error",
        "-i", &input,
        "-vf", &vf,
        "-loop", "0",
        "-y", &out_str,
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let o = cmd.output().await.map_err(|e| format!("起 ffmpeg 失败: {e}"))?;
    if !o.status.success() {
        let msg = String::from_utf8_lossy(&o.stderr);
        return Err(format!("转 GIF 失败: {}", msg.lines().last().unwrap_or("").trim()));
    }
    Ok(out_str)
}

/// 在文件管理器里选中这个文件
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer");
        cmd.args(["/select,", &path]);
        // explorer 是 GUI 程序，不加 CREATE_NO_WINDOW —— 加了新窗口会继承隐藏状态开不出来
        let _ = cmd.spawn().map_err(|e| format!("打开失败: {e}"))?;
    }
    Ok(())
}

/// 进程真正退出时把还在录的那段收掉，别留一个孤儿 ffmpeg 占着文件
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<RecordState>();
    let mut g = state.inner.lock().unwrap();
    if let Some(mut rec) = g.take() {
        let _ = rec.child.start_kill();
    }
}

/// 文件名里的时间戳。直接问系统要本地时间，不自己算时区
fn chrono_stamp() -> String {
    #[cfg(windows)]
    unsafe {
        let t = windows::Win32::System::SystemInformation::GetLocalTime();
        format!(
            "{}{:02}{:02}_{:02}{:02}{:02}",
            t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
        )
    }
    #[cfg(not(windows))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "{}",
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
        )
    }
}
