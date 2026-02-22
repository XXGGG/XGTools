use anyhow::{Context, Result};
use image::RgbaImage;
use xcap::Monitor;

/// 截取主显示器（鼠标所在的显示器）
pub fn capture_primary_monitor() -> Result<(RgbaImage, MonitorInfo)> {
    let monitors = Monitor::all().context("Failed to enumerate monitors")?;

    // 找到主显示器（包含坐标原点 0,0 的那个）
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary())
        .or_else(|| Monitor::all().ok()?.into_iter().next())
        .context("No monitors found")?;

    let info = MonitorInfo {
        x: monitor.x(),
        y: monitor.y(),
        width: monitor.width(),
        height: monitor.height(),
        scale_factor: monitor.scale_factor(),
    };

    let img = monitor
        .capture_image()
        .context("Failed to capture monitor image")?;

    Ok((img, info))
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f32,
}
