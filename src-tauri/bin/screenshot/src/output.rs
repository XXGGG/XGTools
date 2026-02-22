use anyhow::{Context, Result};
use image::RgbaImage;
use serde::Serialize;
use std::path::PathBuf;
use uuid::Uuid;

use crate::selection::SelectionRect;

#[derive(Serialize)]
pub struct CaptureOutput {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub cancelled: bool,
}

#[derive(Serialize)]
pub struct SelectionOutput {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// 保存截图到临时文件，返回文件路径
pub fn save_temp_image(img: &RgbaImage) -> Result<PathBuf> {
    let temp_dir = std::env::temp_dir();
    let filename = format!("xgtools_capture_{}.png", Uuid::new_v4());
    let path = temp_dir.join(filename);
    img.save(&path)
        .with_context(|| format!("Failed to save temp image to {}", path.display()))?;
    Ok(path)
}

/// 输出成功结果到 stdout
pub fn output_success(image_path: &str, selection: &SelectionRect) {
    let output = CaptureOutput {
        success: true,
        image_path: Some(image_path.to_string()),
        selection: Some(SelectionOutput {
            x: selection.x as u32,
            y: selection.y as u32,
            width: selection.width as u32,
            height: selection.height as u32,
        }),
        error: None,
        cancelled: false,
    };
    let json = serde_json::to_string(&output).unwrap_or_default();
    println!("{}", json);
}

/// 输出取消结果
pub fn output_cancelled() {
    let output = CaptureOutput {
        success: false,
        image_path: None,
        selection: None,
        error: None,
        cancelled: true,
    };
    let json = serde_json::to_string(&output).unwrap_or_default();
    println!("{}", json);
}

/// 输出错误
pub fn output_error(err: &str) {
    let output = CaptureOutput {
        success: false,
        image_path: None,
        selection: None,
        error: Some(err.to_string()),
        cancelled: false,
    };
    let json = serde_json::to_string(&output).unwrap_or_default();
    println!("{}", json);
}
