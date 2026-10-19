//! 任务栏透明：交给 TranslucentTB 干活，XGTools 只当它的设置面板。
//!
//! Windows 11 的任务栏是 XAML 画的，老办法（对 Shell_TrayWnd 调 SetWindowCompositionAttribute）
//! 已经改不动它的背景了；TranslucentTB 是往 Explorer 里注入 XAML 诊断钩子才做到的，
//! 那一套自己重写成本太高。它本身会盯着自己的 settings.json，文件一改马上生效，
//! 所以这里只做：看它装没装、开没开，读写它的设置，把它启动起来。

use serde::Serialize;
use std::path::PathBuf;

const FAMILY: &str = "28017CharlesMilette.TranslucentTB_v826wp6bftszj";

fn settings_path() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("Packages").join(FAMILY).join("RoamingState").join("settings.json"))
}

#[derive(Serialize)]
pub struct TtbStatus {
    /// 装了（它的数据目录在）
    pub installed: bool,
    /// 正在跑
    pub running: bool,
}

fn no_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

#[tauri::command]
pub fn ttb_status() -> TtbStatus {
    let installed = settings_path().map(|p| p.parent().map(|d| d.exists()).unwrap_or(false)).unwrap_or(false);
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/FI", "IMAGENAME eq TranslucentTB.exe", "/NH"]);
    no_window(&mut cmd);
    let running = cmd
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("translucenttb.exe"))
        .unwrap_or(false);
    TtbStatus { installed, running }
}

/// 读它的设置（带注释的 JSON，原样返回给前端去解析）
#[tauri::command]
pub fn ttb_read() -> Result<String, String> {
    let p = settings_path().ok_or("找不到 LOCALAPPDATA")?;
    std::fs::read_to_string(&p).map_err(|e| format!("读不到 TranslucentTB 的设置：{e}"))
}

/// 写回它的设置：先写临时文件再替换，写到一半出错也不会把原文件弄成空的
#[tauri::command]
pub fn ttb_write(content: String) -> Result<(), String> {
    let p = settings_path().ok_or("找不到 LOCALAPPDATA")?;
    let tmp = p.with_extension("json.xgtools-tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// 启动它（商店应用，按应用 ID 启动）
#[tauri::command]
pub fn ttb_start() -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(format!("shell:AppsFolder\\{FAMILY}!TranslucentTB"));
    no_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 没装：打开微软商店里它的页面
#[tauri::command]
pub fn ttb_install() -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg("ms-windows-store://pdp/?productid=9PF4KZ2VN4W9");
    no_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
