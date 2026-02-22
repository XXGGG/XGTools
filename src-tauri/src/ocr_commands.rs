use paddle_ocr_rs::ocr_lite::OcrLite;
use paddle_ocr_rs::ocr_result::TextBlock;
use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct OcrResult {
    pub text_blocks: Vec<TextBlock>,
    pub scale_factor: f32,
}

pub struct OcrState {
    pub ocr: Mutex<Option<OcrLite>>,
    pub initializing: AtomicBool,
}

/// 初始化 OCR 模型（首次调用时加载，之后跳过）
#[tauri::command]
pub async fn ocr_init(
    app: AppHandle,
    state: State<'_, OcrState>,
) -> Result<(), String> {
    // 已初始化？
    {
        let guard = state.ocr.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            eprintln!("[OCR] Already initialized, skipping");
            return Ok(());
        }
    }

    // 正在初始化？（防止并发重入）
    if state.initializing.swap(true, Ordering::SeqCst) {
        eprintln!("[OCR] Already initializing, waiting...");
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let guard = state.ocr.lock().map_err(|e| e.to_string())?;
            if guard.is_some() {
                return Ok(());
            }
        }
    }

    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let ocr_dir = resource_dir.join("resources").join("ocr");

    let ocr_dir = if ocr_dir.exists() {
        ocr_dir
    } else {
        let dev_dir = std::env::current_dir()
            .unwrap_or_default()
            .join("resources")
            .join("ocr");
        if dev_dir.exists() {
            dev_dir
        } else {
            state.initializing.store(false, Ordering::SeqCst);
            return Err(format!("OCR model directory not found. Tried:\n  {}\n  {}",
                ocr_dir.display(), dev_dir.display()));
        }
    };

    eprintln!("[OCR] Loading models from: {}", ocr_dir.display());

    let det_path = ocr_dir.join("ch_PP-OCRv4_det_infer.onnx");
    let cls_path = ocr_dir.join("ch_ppocr_mobile_v2.0_cls_infer.onnx");
    let rec_path = ocr_dir.join("ch_PP-OCRv4_rec_infer.onnx");

    let det_data = std::fs::read(&det_path)
        .map_err(|e| { state.initializing.store(false, Ordering::SeqCst); format!("Failed to read det: {}", e) })?;
    let cls_data = std::fs::read(&cls_path)
        .map_err(|e| { state.initializing.store(false, Ordering::SeqCst); format!("Failed to read cls: {}", e) })?;
    let rec_data = std::fs::read(&rec_path)
        .map_err(|e| { state.initializing.store(false, Ordering::SeqCst); format!("Failed to read rec: {}", e) })?;

    eprintln!("[OCR] Model files read OK");

    let ocr_result = tokio::task::spawn_blocking(move || {
        eprintln!("[OCR] Initializing ONNX sessions (single thread)...");
        let mut ocr = OcrLite::new();
        ocr.init_models_from_memory(
            &det_data,
            &cls_data,
            &rec_data,
            1,
        )
        .map_err(|e| format!("Failed to init OCR models: {}", e))?;
        eprintln!("[OCR] ONNX sessions ready");
        Ok::<OcrLite, String>(ocr)
    })
    .await
    .map_err(|e| { state.initializing.store(false, Ordering::SeqCst); format!("Task join error: {}", e) })?;

    match ocr_result {
        Ok(ocr) => {
            let mut guard = state.ocr.lock().map_err(|e| e.to_string())?;
            *guard = Some(ocr);
            eprintln!("[OCR] Init complete!");
            Ok(())
        }
        Err(e) => {
            state.initializing.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}

/// OCR 检测：接收 PNG 图片的 raw binary body
/// 参数通过 headers 传递：x-scale-factor
#[tauri::command]
pub async fn ocr_detect(
    state: State<'_, OcrState>,
    request: tauri::ipc::Request<'_>,
) -> Result<OcrResult, String> {
    // 从 raw body 获取 PNG 数据
    let png_data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data.clone(),
        _ => return Err("Expected raw binary data (PNG)".to_string()),
    };

    // 从 header 获取 scale_factor
    let scale_factor: f32 = request.headers()
        .get("x-scale-factor")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);

    eprintln!("[OCR] ocr_detect: png_data={} bytes, sf={}", png_data.len(), scale_factor);

    // 从 state 取出 OcrLite
    let mut ocr = {
        let mut guard = state.ocr.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("OCR not initialized")?
    };

    let (ocr_back, detect_result) = tokio::task::spawn_blocking(move || {
        // 解码 PNG → DynamicImage
        let image = match image::load(
            std::io::Cursor::new(&png_data),
            image::ImageFormat::Png,
        ) {
            Ok(img) => img,
            Err(e) => return (ocr, Err(format!("Failed to decode PNG: {}", e))),
        };

        let rgb_image = image.to_rgb8();
        let (width, height) = rgb_image.dimensions();
        let max_size = width.max(height);

        eprintln!("[OCR] Running detection on {}x{} ...", width, height);

        let ocr_result = ocr.detect_angle_rollback(
            &rgb_image,
            50,
            max_size,
            0.5,
            0.3,
            1.6,
            false,
            false,
            0.9,
        );

        match ocr_result {
            Ok(result) => {
                eprintln!("[OCR] Found {} text blocks", result.text_blocks.len());
                (ocr, Ok(OcrResult {
                    text_blocks: result.text_blocks,
                    scale_factor,
                }))
            },
            Err(e) => {
                eprintln!("[OCR] Detection failed: {}", e);
                (ocr, Err(format!("OCR detection failed: {}", e)))
            },
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    // 放回 OcrLite
    {
        let mut guard = state.ocr.lock().map_err(|e| e.to_string())?;
        *guard = Some(ocr_back);
    }

    detect_result
}

/// 释放 OCR 资源
#[tauri::command]
pub fn ocr_release(state: State<'_, OcrState>) -> Result<(), String> {
    let mut guard = state.ocr.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}
