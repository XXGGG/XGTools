/*!
长截图：框一块区域，一边滚一边抓，接成一张长图。

# 一轮是什么样的

抓一帧 → 交给拼接器接上去（[`crate::long_shot_stitch`]）→ 发一格滚轮 → 等一下 → 再抓。
到底了就停：连着几帧画面都不动，说明滚不下去了。

# 为什么要有「手动兜底」

自动滚是靠给目标窗口发滚轮事件。**不是所有窗口都吃这一套** —— 自绘滚动容器、
某些 Electron 应用、带惯性动画的页面，发过去要么没反应，要么滚得乱七八糟。
所以开头几次滚轮如果一点效果都没有，就地转成手动：不再发滚轮，让用户自己滚，
我们照样一帧一帧接。**能自动的省事，不能自动的也不至于白框一场。**

# 抓的是整块屏幕再裁

`xcap` 只能整屏抓，没有区域抓。整屏 1920×1080 一帧 8MB，每秒抓五六次，
裁一下的开销和抓的开销比起来可以忽略，不值得为此换一套抓屏实现。

# 内存

长图是一直往下接的，没有上限就等着爆。这里按**字节数**封顶而不是按行数 ——
同样一万行，宽 400 的和宽 1920 的差着五倍。
*/
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::long_shot_stitch::{Push, Stitcher};

/// 长图最多占这么多内存（RGBA）。约 250MB，1920 宽能接三万多行
const MAX_BYTES: usize = 250 * 1024 * 1024;
/// 连着这么多帧没变化 = 滚到底了
const STILL_LIMIT: u32 = 3;
/// 连着这么多帧认不出位移 = 画面被别的东西盖住了，收工别硬接
const LOST_LIMIT: u32 = 5;
/// 自动模式下，前这么多次滚轮一点效果都没有就转手动
const AUTO_GIVEUP: u32 = 3;
/// 滚一次等多久再抓（留给平滑滚动动画）
const STEP_MS: u64 = 180;
/// 手动模式下的抓帧间隔
const MANUAL_MS: u64 = 100;

/// 0 = 自动滚，1 = 手动（用户自己滚）
const MODE_AUTO: u8 = 0;
const MODE_MANUAL: u8 = 1;

#[derive(Clone, Serialize)]
pub struct LongShotProgress {
    /// 已经接了多少行
    pub height: u32,
    pub width: u32,
    /// "auto" | "manual"
    pub mode: &'static str,
    /// 到底了（自动模式下滚不动了）
    pub done: bool,
}

struct Session {
    stop: Arc<AtomicBool>,
    mode: Arc<AtomicU8>,
    /// 抓完的长图放这儿等前端来取
    result: Arc<Mutex<Option<(Vec<u8>, usize, usize)>>>,
}

#[derive(Default)]
pub struct LongShotState {
    inner: Mutex<Option<Session>>,
}

// ─── 平台相关：抓屏 / 发滚轮 ──────────────────────

/// 抓这块屏幕上的一块矩形。x/y 是**虚拟桌面绝对物理坐标**
fn grab(x: i32, y: i32, w: usize, h: usize) -> Result<Vec<u8>, String> {
    use xcap::Monitor;
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    // 选区左上角落在哪块屏上就抓哪块
    let mon = monitors
        .into_iter()
        .find(|m| {
            x >= m.x() && y >= m.y() && x < m.x() + m.width() as i32 && y < m.y() + m.height() as i32
        })
        .ok_or("这块区域不在任何一块显示器上")?;

    let (mx, my, mw, mh) = (mon.x(), mon.y(), mon.width() as usize, mon.height() as usize);
    let img = mon.capture_image().map_err(|e| format!("抓屏失败: {e}"))?;
    let src = img.into_raw();

    let ox = (x - mx).max(0) as usize;
    let oy = (y - my).max(0) as usize;
    if ox + w > mw || oy + h > mh {
        return Err("选区超出了显示器范围".into());
    }

    let mut out = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let from = ((oy + row) * mw + ox) * 4;
        out.extend_from_slice(&src[from..from + w * 4]);
    }
    Ok(out)
}

/// 把鼠标挪到区域中间，发 `notches` 格向下滚轮。
///
/// 滚轮事件是发给**光标底下那个窗口**的，所以非挪不可。挪之前先记下原位置，
/// 收工时放回去 —— 不然用户的鼠标会莫名其妙停在别处。
#[cfg(windows)]
fn wheel_down(cx: i32, cy: i32, notches: i32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
    unsafe {
        let _ = SetCursorPos(cx, cy);
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    // 负数 = 向下滚。一格是 WHEEL_DELTA(120)
                    mouseData: (-120 * notches) as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(windows))]
fn wheel_down(_cx: i32, _cy: i32, _notches: i32) {}

#[cfg(windows)]
fn cursor_pos() -> (i32, i32) {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

#[cfg(not(windows))]
fn cursor_pos() -> (i32, i32) {
    (0, 0)
}

#[cfg(windows)]
fn set_cursor(x: i32, y: i32) {
    use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
    unsafe {
        let _ = SetCursorPos(x, y);
    }
}

#[cfg(not(windows))]
fn set_cursor(_x: i32, _y: i32) {}

// ─── 命令 ──────────────────────────────────────

/// 开始长截图。x/y/w/h 是屏幕绝对物理坐标
#[tauri::command]
pub async fn start_long_shot(
    app: AppHandle,
    state: tauri::State<'_, LongShotState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if state.inner.lock().unwrap().is_some() {
        return Err("已经在抓了".into());
    }
    let (w, h) = (width as usize, height as usize);
    if w < 40 || h < 80 {
        return Err("这块区域太小了，拼不出长图".into());
    }

    let stop = Arc::new(AtomicBool::new(false));
    let mode = Arc::new(AtomicU8::new(MODE_AUTO));
    let result = Arc::new(Mutex::new(None));

    *state.inner.lock().unwrap() = Some(Session {
        stop: stop.clone(),
        mode: mode.clone(),
        result: result.clone(),
    });

    std::thread::Builder::new()
        .name("xg-longshot".into())
        .spawn(move || {
            let saved_cursor = cursor_pos();
            let (cx, cy) = (x + width as i32 / 2, y + height as i32 / 2);
            let mut st = Stitcher::new(w, h);
            let mut still = 0u32;
            let mut lost = 0u32;
            let mut scrolls = 0u32;
            let mut done = false;
            // 出问题时唯一能回答"它到底在干嘛"的东西。收工时打一行
            let (mut n_grew, mut n_same, mut n_lost) = (0u32, 0u32, 0u32);
            /*
                一格滚轮到底滚多少像素 —— **只能量，不能猜**。

                每个应用都不一样：Chromium 系一格 100px，记事本按行算，
                有的应用还带惯性。猜错的后果不对称：
                滚少了顶多多抓两帧；滚多了**直接跳过一段内容，而且事后看不出来**
                （拼接器只会说"认不出"）。

                所以第一次只滚一格，量出来之后再按「一次滚小半屏」去换算。
                量不出来之前一律一格。
            */
            let mut px_per_notch: Option<f32> = None;
            let mut last_notches = 1i32;

            while !stop.load(Ordering::Relaxed) {
                let auto = mode.load(Ordering::Relaxed) == MODE_AUTO;

                match grab(x, y, w, h) {
                    Err(e) => {
                        eprintln!("[longshot] {e}");
                        break;
                    }
                    Ok(frame) => match st.push(&frame) {
                        Push::Grew(d) => {
                            n_grew += 1;
                            still = 0;
                            lost = 0;
                            /*
                                标定。**只许快涨、不许快跌。**

                                第一帧不是滚出来的，不算；快到底时滚一下只动几像素，
                                那也不算 —— 拿它当样本会把估计值压到很小，
                                下一次就换算出一大堆格数，一口气滚过一整屏，
                                中间的内容直接丢了还看不出来。
                                低估的代价远大于高估，所以往下最多降三成。
                            */
                            if scrolls > 0 && last_notches > 0 && d >= 8 {
                                let sample = d as f32 / last_notches as f32;
                                px_per_notch = Some(match px_per_notch {
                                    None => sample,
                                    Some(p) if sample > p => sample,
                                    Some(p) => sample.max(p * 0.7),
                                });
                            }
                        }
                        Push::Same => {
                            n_same += 1;
                            still += 1;
                            /*
                                画面不动有两种可能，**先分清是哪一种再决定收不收工**：

                                 · 滚了半天一行都没长出来 —— 这个窗口根本不吃合成的
                                   滚轮事件（自绘滚动容器、部分 Electron 应用）。
                                   转手动让用户自己滚，不能当成"到底了"。
                                 · 已经接出内容了，现在不动了 —— 那才是真到底。

                                顺序反了的话，不吃滚轮的窗口会在第三帧被判成"抓完了"，
                                交出去的长图只有第一屏。
                            */
                            if auto && scrolls >= AUTO_GIVEUP && st.height() == h {
                                mode.store(MODE_MANUAL, Ordering::Relaxed);
                                still = 0;
                            } else if auto && scrolls > 0 && still >= STILL_LIMIT {
                                // 手动模式不这么判 —— 用户中途停下来想一想是常事，
                                // 停一秒就给他收了才是莫名其妙
                                done = true;
                                break;
                            }
                        }
                        Push::Lost => {
                            n_lost += 1;
                            lost += 1;
                            /*
                                认不出，最常见的原因就是**上一次滚过头了** ——
                                滚过一整屏的话，新旧两帧没有任何重叠，拿什么都对不上。
                                把估计值往大了改，下一次自然就少滚几格。
                            */
                            if let Some(p) = px_per_notch {
                                px_per_notch = Some(p * 2.0);
                            } else if last_notches > 1 {
                                px_per_notch = Some(h as f32);
                            }
                            if lost >= LOST_LIMIT {
                                break;
                            }
                        }
                    },
                }

                if st.height() * w * 4 >= MAX_BYTES {
                    done = true;
                    break;
                }

                let _ = app.emit(
                    "long-shot-progress",
                    LongShotProgress {
                        height: st.height() as u32,
                        width: w as u32,
                        mode: if auto { "auto" } else { "manual" },
                        done: false,
                    },
                );

                if mode.load(Ordering::Relaxed) == MODE_AUTO {
                    /*
                        一次滚小半屏。**上限卡在 0.45 屏是有讲究的**：
                        拼接器拿底部 1/3 当比对带子，能认出来的最大位移是 2/3 屏，
                        再多就完全没有重叠了。留一截余量给平滑滚动的过冲。
                    */
                    let target = h as f32 * 0.45;
                    let notches = match px_per_notch {
                        None => 1, // 还没量出来，先滚一格把它量出来
                        Some(p) if p > 0.5 => ((target / p).floor() as i32).clamp(1, 8),
                        _ => 1,
                    };
                    last_notches = notches;
                    wheel_down(cx, cy, notches);
                    scrolls += 1;
                    std::thread::sleep(std::time::Duration::from_millis(STEP_MS));
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(MANUAL_MS));
                }
            }

            eprintln!(
                "[longshot] 收工: 高 {} (一屏 {}), 接上 {} 次 / 没动 {} 次 / 认不出 {} 次, 滚了 {} 次, 一格约 {:?}px, mode={}, done={}",
                st.height(), h, n_grew, n_same, n_lost, scrolls, px_per_notch.map(|p| p.round()),
                if mode.load(Ordering::Relaxed) == MODE_AUTO { "auto" } else { "manual" }, done,
            );
            set_cursor(saved_cursor.0, saved_cursor.1);
            let (px, pw, ph) = st.into_image();
            *result.lock().unwrap() = Some((px, pw, ph));
            let _ = app.emit(
                "long-shot-progress",
                LongShotProgress { height: ph as u32, width: pw as u32, mode: "auto", done },
            );
            let _ = app.emit("long-shot-ended", done);
        })
        .map_err(|e| format!("起线程失败: {e}"))?;

    Ok(())
}

/// 用户按了「完成」：停下来
#[tauri::command]
pub fn stop_long_shot(state: tauri::State<'_, LongShotState>) -> Result<(), String> {
    if let Some(s) = state.inner.lock().unwrap().as_ref() {
        s.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 用户自己要求转手动（自动滚得不对劲时的出口）
#[tauri::command]
pub fn long_shot_manual(state: tauri::State<'_, LongShotState>) -> Result<(), String> {
    if let Some(s) = state.inner.lock().unwrap().as_ref() {
        s.mode.store(MODE_MANUAL, Ordering::Relaxed);
    }
    Ok(())
}

/// 抓完之后的结果
#[derive(Serialize)]
pub struct LongShotResult {
    pub path: String,
    /// 有没有进剪贴板。**进不去不算失败** —— 文件才是成果
    pub copied: bool,
}

/// 把接好的长图存成 PNG 并放进剪贴板，返回路径。取完这一次会话就结束了
#[tauri::command]
pub async fn take_long_shot(
    state: tauri::State<'_, LongShotState>,
    dir: Option<String>,
) -> Result<LongShotResult, String> {
    let taken = {
        let mut guard = state.inner.lock().unwrap();
        let s = guard.as_ref().ok_or("没有正在进行的长截图")?;
        let px = s.result.lock().unwrap().take();
        // 取过就清掉会话，允许开下一次
        if px.is_some() {
            *guard = None;
        }
        px
    };
    let (px, w, h) = taken.ok_or("还没抓完")?;
    if h == 0 {
        return Err("一行都没抓到".into());
    }

    tokio::task::spawn_blocking(move || {
        /*
            默认存「下载\Screenshots」，和录屏那边一个道理：长截图是随手抓完
            就发出去的东西，堆在桌面上碍眼，下载夹本来就是这种「拿了就走」的暂存处。
        */
        let dir = match dir.as_deref().map(str::trim) {
            Some(s) if !s.is_empty() => std::path::PathBuf::from(s),
            _ => dirs::download_dir()
                .or_else(dirs::desktop_dir)
                .ok_or("找不到下载目录")?
                .join("Screenshots"),
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
        let path = dir.join(format!("long_{}.png", crate::record_commands::chrono_stamp()));

        /*
            **先存盘再进剪贴板。**

            剪贴板是可能失败的（被别的程序占着、图太大），而文件是成果本身。
            顺序反过来的话，剪贴板一出错就白抓一场。
        */
        let img = image::RgbaImage::from_raw(w as u32, h as u32, px)
            .ok_or("像素数对不上，拼接结果坏了")?;
        img.save(&path).map_err(|e| format!("存 PNG 失败: {e}"))?;

        let copied = arboard::Clipboard::new()
            .and_then(|mut c| {
                c.set_image(arboard::ImageData {
                    width: w,
                    height: h,
                    bytes: img.into_raw().into(),
                })
            })
            .map_err(|e| eprintln!("[longshot] 没能进剪贴板（文件已经存好了）: {e}"))
            .is_ok();

        Ok(LongShotResult { path: path.to_string_lossy().to_string(), copied })
    })
    .await
    .map_err(|e| format!("任务出错: {e}"))?
}

/// 不要了：停掉并丢弃
#[tauri::command]
pub fn cancel_long_shot(state: tauri::State<'_, LongShotState>) -> Result<(), String> {
    if let Some(s) = state.inner.lock().unwrap().take() {
        s.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}
