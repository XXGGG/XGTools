use serde::{Deserialize, Serialize};
use tauri::ipc::Response;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 截取主显示器，返回 RGBA 原始像素 + 头部24字节(含显示器信息)
/// 格式: [img_w:u32][img_h:u32][mon_x:i32][mon_y:i32][mon_w:u32][mon_h:u32][rgba_pixels...]
/// 一次 IPC 同时返回截图数据和显示器信息，省掉额外的 get_monitor_info 调用
#[tauri::command]
pub async fn capture_screen() -> Result<Response, String> {
    tokio::task::spawn_blocking(|| {
        use xcap::Monitor;

        let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.is_primary())
            .or_else(|| Monitor::all().ok()?.into_iter().next())
            .ok_or_else(|| "No monitors found".to_string())?;

        // 先获取显示器信息
        let mon_x = monitor.x();
        let mon_y = monitor.y();
        let mon_w = monitor.width();
        let mon_h = monitor.height();

        let img = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture: {}", e))?;

        let img_w = img.width();
        let img_h = img.height();
        let rgba = img.into_raw();

        // 头部 24 字节，后面紧跟 RGBA 像素
        let mut buf = Vec::with_capacity(24 + rgba.len());
        buf.extend_from_slice(&img_w.to_le_bytes());
        buf.extend_from_slice(&img_h.to_le_bytes());
        buf.extend_from_slice(&mon_x.to_le_bytes());
        buf.extend_from_slice(&mon_y.to_le_bytes());
        buf.extend_from_slice(&mon_w.to_le_bytes());
        buf.extend_from_slice(&mon_h.to_le_bytes());
        buf.extend_from_slice(&rgba);

        Ok(Response::new(buf))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取主显示器信息
#[tauri::command]
pub async fn get_monitor_info() -> Result<MonitorInfo, String> {
    tokio::task::spawn_blocking(|| {
        use xcap::Monitor;

        let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.is_primary())
            .or_else(|| Monitor::all().ok()?.into_iter().next())
            .ok_or_else(|| "No monitors found".to_string())?;

        Ok(MonitorInfo {
            x: monitor.x(),
            y: monitor.y(),
            width: monitor.width(),
            height: monitor.height(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 复制截图区域到剪贴板（接收完整 PNG + 选区坐标）
#[tauri::command]
pub async fn copy_screenshot_to_clipboard(
    image_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let img = image::open(&image_path)
            .map_err(|e| format!("Failed to open image: {}", e))?;
        let cropped = img.crop_imm(x, y, width, height);
        let rgba = cropped.to_rgba8();

        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let img_data = arboard::ImageData {
            width: rgba.width() as usize,
            height: rgba.height() as usize,
            bytes: rgba.as_raw().into(),
        };

        clipboard
            .set_image(img_data)
            .map_err(|e| format!("Failed to set clipboard image: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 直接从原始像素数据复制到剪贴板
#[tauri::command]
pub async fn copy_rgba_to_clipboard(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| format!("Failed to open clipboard: {}", e))?;

        let img_data = arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: rgba_data.into(),
        };

        clipboard
            .set_image(img_data)
            .map_err(|e| format!("Failed to set clipboard image: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 保存截图到文件
#[tauri::command]
pub async fn save_screenshot(
    image_path: String,
    save_path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let img = image::open(&image_path)
            .map_err(|e| format!("Failed to open image: {}", e))?;
        let cropped = img.crop_imm(x, y, width, height);
        cropped
            .save(&save_path)
            .map_err(|e| format!("Failed to save image: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 直接从 PNG 二进制数据保存到指定路径
#[tauri::command]
pub async fn save_screenshot_to_path(data: Vec<u8>, path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, &data).map_err(|e| format!("Failed to save: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 快速保存截图到桌面/Screenshots/目录
#[tauri::command]
pub async fn save_screenshot_file(data: Vec<u8>, filename: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let desktop = dirs::desktop_dir().ok_or("Cannot find desktop dir")?;
        let dir = desktop.join("Screenshots");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
        let path = dir.join(&filename);
        std::fs::write(&path, &data).map_err(|e| format!("Failed to save: {}", e))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 清理临时截图文件
#[tauri::command]
pub async fn cleanup_temp_screenshot(image_path: String) -> Result<(), String> {
    if image_path.contains("xgtools_capture_") {
        let _ = std::fs::remove_file(&image_path);
    }
    Ok(())
}

/// 通知截图流程结束，释放快捷键重入锁
#[tauri::command]
pub fn screenshot_done() {
    crate::SCREENSHOT_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
}
