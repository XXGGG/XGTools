use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

// ─── Types ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Image,
    Video,
    Audio,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub media_type: MediaType,
    pub size: u64,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertOptions {
    pub quality: Option<u32>,
    pub video_codec: Option<String>,
    #[allow(dead_code)]
    pub audio_codec: Option<String>,
    pub audio_bitrate: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvertProgress {
    pub file_index: usize,
    pub total_files: usize,
    pub file_name: String,
    pub file_progress: f64,
    pub status: String,
    pub error: Option<String>,
}

pub struct ConvertState {
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

// ─── Helpers ────────────────────────────────────

fn classify_extension(ext: &str) -> MediaType {
    match ext.to_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tiff" | "tif" | "gif" | "ico" | "avif" => {
            MediaType::Image
        }
        "mp4" | "avi" | "mkv" | "mov" | "webm" | "flv" | "wmv" => MediaType::Video,
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "wma" | "m4a" => MediaType::Audio,
        _ => MediaType::Unknown,
    }
}

fn get_ffmpeg_path_internal(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let ffmpeg_path = resource_dir.join("resources/ffmpeg/ffmpeg.exe");
    if ffmpeg_path.exists() {
        Ok(ffmpeg_path)
    } else {
        // Fallback: try system PATH
        Err("ffmpeg not found. Please ensure ffmpeg.exe is in resources/ffmpeg/".into())
    }
}

fn get_ffprobe_path_internal(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let ffprobe_path = resource_dir.join("resources/ffmpeg/ffprobe.exe");
    if ffprobe_path.exists() {
        Ok(ffprobe_path)
    } else {
        Err("ffprobe not found".into())
    }
}

/// Generate a unique output path to avoid overwriting (Windows style: name (1).ext)
fn unique_output_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = path.extension().unwrap_or_default().to_string_lossy();
    for i in 1..10000 {
        let candidate = dir.join(format!("{} ({}).{}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Fallback with timestamp
    dir.join(format!("{} ({}).{}", stem, chrono_fallback(), ext))
}

fn chrono_fallback() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}", ts)
}

// ─── Commands ───────────────────────────────────

#[tauri::command]
pub fn detect_file_type(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let media_type = classify_extension(&extension);

    let meta = std::fs::metadata(&path).map_err(|e| format!("Cannot read file: {}", e))?;
    let size = meta.len();

    // For images, try to get dimensions
    let (width, height) = if media_type == MediaType::Image {
        image::image_dimensions(&path)
            .map(|(w, h)| (Some(w), Some(h)))
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    Ok(FileInfo {
        path,
        name,
        extension,
        media_type,
        size,
        duration: None,
        width,
        height,
    })
}

#[tauri::command]
pub async fn probe_file(app: AppHandle, path: String) -> Result<FileInfo, String> {
    let mut info = detect_file_type(path.clone())?;

    // For video/audio, use ffprobe to get duration
    if info.media_type == MediaType::Video || info.media_type == MediaType::Audio {
        if let Ok(ffprobe_path) = get_ffprobe_path_internal(&app) {
            let mut cmd = tokio::process::Command::new(ffprobe_path);
            cmd.args([
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(&path);
            #[cfg(windows)]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let output = cmd
                .output()
                .await
                .map_err(|e| format!("ffprobe failed: {}", e))?;

            if let Ok(json) =
                serde_json::from_slice::<serde_json::Value>(&output.stdout)
            {
                // Duration from format
                if let Some(dur_str) = json
                    .get("format")
                    .and_then(|f| f.get("duration"))
                    .and_then(|d| d.as_str())
                {
                    info.duration = dur_str.parse::<f64>().ok();
                }
                // Width/height from first video stream
                if let Some(streams) = json.get("streams").and_then(|s| s.as_array()) {
                    for stream in streams {
                        if stream.get("codec_type").and_then(|c| c.as_str()) == Some("video") {
                            info.width = stream
                                .get("width")
                                .and_then(|w| w.as_u64())
                                .map(|w| w as u32);
                            info.height = stream
                                .get("height")
                                .and_then(|h| h.as_u64())
                                .map(|h| h as u32);
                            break;
                        }
                    }
                }
            }
        }
    }

    Ok(info)
}

#[tauri::command]
pub async fn convert_image(
    input_path: String,
    output_path: String,
    format: String,
    quality: Option<u32>,
) -> Result<String, String> {
    let img = image::open(&input_path).map_err(|e| format!("Failed to open image: {}", e))?;

    let out = unique_output_path(Path::new(&output_path));
    let quality = quality.unwrap_or(85).min(100);

    match format.to_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let mut writer = std::io::BufWriter::new(
                std::fs::File::create(&out)
                    .map_err(|e| format!("Failed to create file: {}", e))?,
            );
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality as u8);
            img.write_with_encoder(encoder)
                .map_err(|e| format!("JPEG encode failed: {}", e))?;
        }
        "png" => {
            img.save_with_format(&out, image::ImageFormat::Png)
                .map_err(|e| format!("PNG save failed: {}", e))?;
        }
        "webp" => {
            img.save_with_format(&out, image::ImageFormat::WebP)
                .map_err(|e| format!("WebP save failed: {}", e))?;
        }
        "bmp" => {
            img.save_with_format(&out, image::ImageFormat::Bmp)
                .map_err(|e| format!("BMP save failed: {}", e))?;
        }
        "tiff" | "tif" => {
            img.save_with_format(&out, image::ImageFormat::Tiff)
                .map_err(|e| format!("TIFF save failed: {}", e))?;
        }
        "gif" => {
            img.save_with_format(&out, image::ImageFormat::Gif)
                .map_err(|e| format!("GIF save failed: {}", e))?;
        }
        "ico" => {
            img.save_with_format(&out, image::ImageFormat::Ico)
                .map_err(|e| format!("ICO save failed: {}", e))?;
        }
        "avif" => {
            img.save_with_format(&out, image::ImageFormat::Avif)
                .map_err(|e| format!("AVIF save failed: {}", e))?;
        }
        _ => return Err(format!("Unsupported image format: {}", format)),
    }

    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn convert_media(
    app: AppHandle,
    task_id: String,
    file_index: usize,
    total_files: usize,
    input_path: String,
    output_path: String,
    format: String,
    options: ConvertOptions,
    state: tauri::State<'_, ConvertState>,
) -> Result<String, String> {
    let ffmpeg_path = get_ffmpeg_path_internal(&app)?;

    // Resolve unique output path (Windows style: name (1).ext)
    let actual_output = unique_output_path(Path::new(&output_path));
    let actual_output_str = actual_output.to_string_lossy().to_string();

    // Register cancel flag
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.cancel_flags.lock().unwrap();
        flags.insert(task_id.clone(), cancel_flag.clone());
    }

    // Get duration for progress calculation
    let duration = {
        if let Ok(info) = probe_file(app.clone(), input_path.clone()).await {
            info.duration.unwrap_or(0.0)
        } else {
            0.0
        }
    };

    let file_name = Path::new(&input_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Build ffmpeg args (-n = never overwrite, we handle uniqueness ourselves)
    let mut args = vec!["-y".to_string(), "-i".to_string(), input_path.clone()];

    let fmt = format.to_lowercase();
    match fmt.as_str() {
        "mp4" => {
            let crf = options.quality.unwrap_or(23).to_string();
            args.extend([
                "-c:v".into(), options.video_codec.clone().unwrap_or("libx264".into()),
                "-crf".into(), crf,
                "-c:a".into(), "aac".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "webm" => {
            let crf = options.quality.unwrap_or(30).to_string();
            args.extend([
                "-c:v".into(), "libvpx-vp9".into(),
                "-crf".into(), crf,
                "-b:v".into(), "0".into(),
                "-c:a".into(), "libopus".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("128k".into()),
            ]);
        }
        "avi" => {
            args.extend([
                "-c:v".into(), "mpeg4".into(),
                "-q:v".into(), options.quality.unwrap_or(5).to_string(),
                "-c:a".into(), "mp3".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "mkv" => {
            let crf = options.quality.unwrap_or(23).to_string();
            args.extend([
                "-c:v".into(), options.video_codec.clone().unwrap_or("libx264".into()),
                "-crf".into(), crf,
                "-c:a".into(), "aac".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "mov" => {
            let crf = options.quality.unwrap_or(23).to_string();
            args.extend([
                "-c:v".into(), "libx264".into(),
                "-crf".into(), crf,
                "-c:a".into(), "aac".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "flv" => {
            args.extend([
                "-c:v".into(), "flv1".into(),
                "-q:v".into(), options.quality.unwrap_or(5).to_string(),
                "-c:a".into(), "mp3".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("128k".into()),
            ]);
        }
        "gif" => {
            // Video to GIF with palette
            args.extend([
                "-vf".into(),
                "fps=15,scale=480:-1:flags=lanczos".into(),
                "-loop".into(), "0".into(),
            ]);
        }
        // Audio formats
        "mp3" => {
            args.extend([
                "-vn".into(),
                "-c:a".into(), "libmp3lame".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "wav" => {
            args.extend(["-vn".into(), "-c:a".into(), "pcm_s16le".into()]);
        }
        "flac" => {
            args.extend(["-vn".into(), "-c:a".into(), "flac".into()]);
        }
        "aac" => {
            args.extend([
                "-vn".into(),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "ogg" => {
            args.extend([
                "-vn".into(),
                "-c:a".into(), "libvorbis".into(),
                "-q:a".into(), "5".into(),
            ]);
        }
        "m4a" => {
            args.extend([
                "-vn".into(),
                "-c:a".into(), "aac".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        "wma" => {
            args.extend([
                "-vn".into(),
                "-c:a".into(), "wmav2".into(),
                "-b:a".into(), options.audio_bitrate.clone().unwrap_or("192k".into()),
            ]);
        }
        _ => {
            // Generic: let ffmpeg auto-detect
        }
    }

    args.extend(["-progress".into(), "pipe:1".into()]);
    args.push(actual_output_str.clone());

    // Spawn ffmpeg
    let mut cmd = tokio::process::Command::new(&ffmpeg_path);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    // Parse progress from stdout
    let stdout = child.stdout.take();
    if let Some(stdout) = stdout {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            if cancel_flag.load(Ordering::Relaxed) {
                let _ = child.kill().await;
                // Cleanup partial file
                let _ = std::fs::remove_file(&actual_output_str);
                // Remove cancel flag
                let mut flags = state.cancel_flags.lock().unwrap();
                flags.remove(&task_id);
                return Err("Cancelled".into());
            }

            // Parse out_time_us=XXXX
            if line.starts_with("out_time_us=") {
                if let Ok(us) = line[12..].trim().parse::<i64>() {
                    if duration > 0.0 && us > 0 {
                        let progress = (us as f64 / 1_000_000.0) / duration;
                        let progress = progress.min(1.0).max(0.0);
                        let _ = app.emit(
                            "convert-progress",
                            ConvertProgress {
                                file_index,
                                total_files,
                                file_name: file_name.clone(),
                                file_progress: progress,
                                status: "converting".into(),
                                error: None,
                            },
                        );
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("ffmpeg wait failed: {}", e))?;

    // Cleanup cancel flag
    {
        let mut flags = state.cancel_flags.lock().unwrap();
        flags.remove(&task_id);
    }

    if !status.success() {
        let _ = std::fs::remove_file(&actual_output_str);
        return Err(format!("ffmpeg exited with code: {:?}", status.code()));
    }

    // Emit done
    let _ = app.emit(
        "convert-progress",
        ConvertProgress {
            file_index,
            total_files,
            file_name,
            file_progress: 1.0,
            status: "done".into(),
            error: None,
        },
    );

    Ok(actual_output_str)
}

#[tauri::command]
pub async fn scan_folder(path: String, extensions: Vec<String>) -> Result<Vec<FileInfo>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err("Not a directory".into());
    }

    let exts: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();
    let mut results = Vec::new();

    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_file() {
            continue;
        }
        let ext = entry_path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !exts.contains(&ext) {
            continue;
        }
        if let Ok(info) = detect_file_type(entry_path.to_string_lossy().to_string()) {
            results.push(info);
        }
    }

    // Sort by name
    results.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(results)
}

#[tauri::command]
pub fn get_ffmpeg_path(app: AppHandle) -> Result<String, String> {
    get_ffmpeg_path_internal(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cancel_convert(task_id: String, state: tauri::State<'_, ConvertState>) -> Result<(), String> {
    let flags = state.cancel_flags.lock().unwrap();
    if let Some(flag) = flags.get(&task_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ─── FFmpeg download ────────────────────────────────

const FFMPEG_ZIP_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";

/// Get the directory where ffmpeg should live (works in both dev and production)
fn get_ffmpeg_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    Ok(resource_dir.join("resources/ffmpeg"))
}

#[tauri::command]
pub fn check_ffmpeg(app: AppHandle) -> bool {
    if let Ok(dir) = get_ffmpeg_dir(&app) {
        dir.join("ffmpeg.exe").exists() && dir.join("ffprobe.exe").exists()
    } else {
        false
    }
}

#[derive(Clone, Serialize)]
pub struct FfmpegDownloadProgress {
    pub stage: String,        // "downloading" | "extracting" | "done" | "error"
    pub progress: f64,        // 0.0 - 1.0
    pub message: String,
}

#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle) -> Result<(), String> {
    use futures_util::StreamExt;

    let ffmpeg_dir = get_ffmpeg_dir(&app)?;
    std::fs::create_dir_all(&ffmpeg_dir)
        .map_err(|e| format!("Failed to create ffmpeg dir: {}", e))?;

    let emit = |stage: &str, progress: f64, message: &str| {
        let _ = app.emit(
            "ffmpeg-download-progress",
            FfmpegDownloadProgress {
                stage: stage.into(),
                progress,
                message: message.into(),
            },
        );
    };

    emit("downloading", 0.0, "正在连接...");

    // Download the zip
    let client = reqwest::Client::new();
    let resp = client
        .get(FFMPEG_ZIP_URL)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !resp.status().is_success() {
        let msg = format!("Download failed: HTTP {}", resp.status());
        emit("error", 0.0, &msg);
        return Err(msg);
    }

    let total_size = resp.content_length().unwrap_or(0);
    let tmp_zip = ffmpeg_dir.join("_ffmpeg_download.zip");

    let mut file = tokio::fs::File::create(&tmp_zip)
        .await
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;
        downloaded += chunk.len() as u64;

        if total_size > 0 {
            let pct = downloaded as f64 / total_size as f64;
            let mb_done = downloaded as f64 / 1_048_576.0;
            let mb_total = total_size as f64 / 1_048_576.0;
            emit(
                "downloading",
                pct,
                &format!("{:.1} / {:.1} MB", mb_done, mb_total),
            );
        }
    }
    file.flush().await.map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    // Extract ffmpeg.exe and ffprobe.exe from the zip
    emit("extracting", 0.0, "正在解压...");

    // Blocking zip extraction in spawn_blocking
    let zip_path = tmp_zip.clone();
    let out_dir = ffmpeg_dir.clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&zip_path)
            .map_err(|e| format!("Failed to open zip: {}", e))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Invalid zip: {}", e))?;

        let targets = ["ffmpeg.exe", "ffprobe.exe"];
        let mut found = 0;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Zip entry error: {}", e))?;
            let name = entry.name().to_string();

            // Files are inside a subdirectory like ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe
            for target in &targets {
                if name.ends_with(&format!("bin/{}", target)) {
                    let out_path = out_dir.join(target);
                    let mut out_file = std::fs::File::create(&out_path)
                        .map_err(|e| format!("Failed to create {}: {}", target, e))?;
                    std::io::copy(&mut entry, &mut out_file)
                        .map_err(|e| format!("Failed to extract {}: {}", target, e))?;
                    found += 1;

                    let _ = app_clone.emit(
                        "ffmpeg-download-progress",
                        FfmpegDownloadProgress {
                            stage: "extracting".into(),
                            progress: found as f64 / targets.len() as f64,
                            message: format!("已解压 {}", target),
                        },
                    );
                }
            }
        }

        if found < targets.len() {
            return Err("ffmpeg.exe or ffprobe.exe not found in zip".into());
        }

        // Cleanup zip
        let _ = std::fs::remove_file(&zip_path);

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
    .map_err(|e| {
        let _ = app.emit(
            "ffmpeg-download-progress",
            FfmpegDownloadProgress {
                stage: "error".into(),
                progress: 0.0,
                message: e.clone(),
            },
        );
        e
    })?;

    emit("done", 1.0, "FFmpeg 已就绪");
    Ok(())
}

/// Resolve the output directory based on location preference
#[tauri::command]
pub fn resolve_output_dir(location: String, source_path: String) -> Result<String, String> {
    match location.as_str() {
        "original" => {
            let p = Path::new(&source_path);
            Ok(p.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".into()))
        }
        "desktop" => {
            let desktop = dirs::desktop_dir().ok_or("Cannot find desktop directory")?;
            Ok(desktop.to_string_lossy().to_string())
        }
        custom => Ok(custom.to_string()),
    }
}
