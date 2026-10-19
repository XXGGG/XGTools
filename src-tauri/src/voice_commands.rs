//! 语音助手（voice 分支，第一版）：把 voice/server.py 这个本机语音服务拉起来。
//!
//! 识别、对话、合成都在那个 Python 服务里（模型常驻内存才快），这里只负责：
//! 没在跑就用 uv 起一个、不弹黑窗口；应用退出时它跟着进程树一起走。
//! 先只认开发目录（仓库里的 voice/），打包进安装包是后面的事。

use std::path::PathBuf;
use std::sync::Mutex;

static CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn voice_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../voice")
}

/// 起语音服务；已经起过、还活着就什么都不做
#[tauri::command]
pub fn voice_start() -> Result<(), String> {
    let mut guard = CHILD.lock().unwrap();
    if let Some(c) = guard.as_mut() {
        if c.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            return Ok(());
        }
    }
    let dir = voice_dir();
    if !dir.join("server.py").exists() {
        return Err(format!("找不到语音服务：{}", dir.display()));
    }
    let mut cmd = std::process::Command::new("uv");
    cmd.args(["run", "--quiet", "server.py"]).current_dir(&dir);
    // 输出写进 %LOCALAPPDATA%\XGToolsoice.log：它在后台没窗口，挂了只能看这个
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let d = PathBuf::from(local).join("XGTools");
        let _ = std::fs::create_dir_all(&d);
        if let Ok(f) = std::fs::File::create(d.join("voice.log")) {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(f).stderr(f2);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("起语音服务失败（需要装 uv）：{e}"))?;
    *guard = Some(child);
    Ok(())
}

/// 关掉语音服务（连同 uv 起的 python 子进程）
#[tauri::command]
pub fn voice_stop() {
    if let Some(c) = CHILD.lock().unwrap().take() {
        let mut k = std::process::Command::new("taskkill");
        k.args(["/F", "/T", "/PID", &c.id().to_string()]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            k.creation_flags(0x0800_0000);
        }
        let _ = k.output();
    }
}
