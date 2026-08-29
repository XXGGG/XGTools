// 主窗口的背景特效(云母 / 亚克力)。
//
// 前提:主窗口必须 transparent:true(tauri.conf.json),否则系统合成器没法把桌面透上来 ——
// 这也是启动台窗口一直能用亚克力、主窗口不能的原因。
//
// 强度:亚克力接受一个 RGBA 着色,其中 **alpha 就是不透明度** —— 越小越通透。
// 云母(Mica)是 Win11 的系统级材质,没有强度参数,只能选深/浅,所以滑块对它无效。
//
// 不提供高斯模糊:window_vibrancy 的 apply_blur 走 ACCENT_ENABLE_BLURBEHIND,
// 这条路径在 Win11 上已被微软废弃,实测渲染成一层压死的暗色、文字都看不清,所以不接。
// clear_blur 仍保留:老版本可能给窗口挂过 blur,切换时要能清掉。

use tauri::Manager;

/// 让 DWM 把窗口本身裁成圆角(Win11)。
///
/// **上了云母/亚克力的窗口必须做这一步。** 材质是 DWM 画在**整个窗口矩形**上的,
/// 它不认 CSS 的 border-radius —— 不裁的话,圆角卡片外面会原样露出四个尖角的材质,
/// 看起来就是「面板四个角是尖的」。
///
/// 另外提醒:CSS 的 backdrop-filter **代替不了**系统材质。它只能模糊窗口内部的内容,
/// 而透明窗口背后是桌面,它够不着。真要磨砂桌面只有系统材质这一条路。
#[tauri::command]
pub fn set_window_corners(app: tauri::AppHandle, label: String, round: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
            DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
        };
        let win = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("找不到窗口: {label}"))?;
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        let pref = if round { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
        unsafe {
            DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of_val(&pref) as u32,
            )
            .map_err(|e| format!("设置窗口圆角失败: {e}"))?;

            // 裁圆角的同时 DWM 会给窗口画一道边框,在透明窗口上会显成
            // 「卡片外面还有一个框」。明确设成「无颜色」把它关掉。
            let none = DWMWA_COLOR_NONE;
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_BORDER_COLOR,
                &none as *const _ as *const _,
                std::mem::size_of_val(&none) as u32,
            );
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, label, round);
        Ok(())
    }
}

/// 告诉 DWM 这个窗口用深色变体渲染系统材质。
/// window_vibrancy 只在 apply_mica 里做了这件事,亚克力那条路径没做。
#[cfg(windows)]
fn set_immersive_dark(win: &tauri::WebviewWindow, dark: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE};

    if let Ok(hwnd) = win.hwnd() {
        let v: u32 = dark as u32;
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as _),
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &v as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[tauri::command]
pub fn set_window_effect(
    app: tauri::AppHandle,
    kind: String,
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    dark: bool,
    // 目标窗口标签。不传就是主窗口 —— 命令面板要用同一套材质,
    // 所以这里不能再写死 "main"。(函数参数上不能用 /// 文档注释,会编译报错)
    label: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_blur, clear_mica};

        let target = label.as_deref().unwrap_or("main");
        let win = app
            .get_webview_window(target)
            .ok_or_else(|| format!("找不到窗口: {target}"))?;

        // 切换前先清掉旧特效:三种材质在同一个窗口上叠加会互相干扰,
        // 表现是切过一轮之后模糊层再也不刷新。忽略清除时的错误(本来就没应用过时会报错)。
        let _ = clear_mica(&win);
        let _ = clear_acrylic(&win);
        let _ = clear_blur(&win);

        match kind.as_str() {
            "mica" => apply_mica(&win, Some(dark)).map_err(|e| format!("云母不可用: {e}"))?,
            "acrylic" => {
                // apply_mica 会顺手设 DWMWA_USE_IMMERSIVE_DARK_MODE,apply_acrylic 不设 ——
                // 结果深色模式下亚克力仍按浅色变体渲染。这里自己补上,否则暗色主题下观感不对。
                set_immersive_dark(&win, dark);
                apply_acrylic(&win, Some((r, g, b, a))).map_err(|e| format!("亚克力不可用: {e}"))?
            }
            _ => {} // "none":上面已经清干净了
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, kind, r, g, b, a, dark, label);
        return Err("当前系统不支持窗口背景特效".into());
    }
    Ok(())
}

/// 把 DWM 的背景材质"踢醒"。
///
/// 现象:云母 / 亚克力的属性明明都设对了(DWMWA_SYSTEMBACKDROP_TYPE = MICA、深色 = 1),
/// DWM 就是不画,窗口底下露出一片白,深色主题下整个界面像褪了色。启动后第一次显示时最容易中招,
/// 正式版比 dev 更常见(时序不同),偶尔跑着跑着也会掉。实测 SWP_FRAMECHANGED、重设属性、
/// 隐藏再显示、cloak 都叫不醒它,**只有最小化再还原**这一下 DWM 才重新开始画。
///
/// 所以就做这一下:先关掉 DWM 过渡动画(不然会看到窗口飞向任务栏),最小化,立刻还原
/// (最大化的窗口还原成最大化),再把动画打开。整个过程在一帧内完成,配合前端那层不透明底色,
/// 用户看不到任何闪动。
#[cfg(windows)]
pub fn kick_backdrop(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, IsWindowVisible, IsZoomed, SendMessageW, SetForegroundWindow,
        ShowWindow, SW_MINIMIZE, SW_RESTORE, SW_SHOWMAXIMIZED, WA_ACTIVE, WM_ACTIVATE,
    };
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = HWND(hwnd.0 as _);
    unsafe {
        // 藏着或本来就最小化的窗口不折腾:显示的时候自然会再走一遍
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return;
        }
        let on: i32 = 1;
        let off: i32 = 0;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &on as *const _ as *const _, 4);
        let zoomed = IsZoomed(hwnd).as_bool();
        let was_foreground = GetForegroundWindow() == hwnd;
        let _ = ShowWindow(hwnd, SW_MINIMIZE);
        let _ = ShowWindow(hwnd, if zoomed { SW_SHOWMAXIMIZED } else { SW_RESTORE });
        // 还原之后 DWM 的"激活态"是旧的:窗口明明在前台,云母却按未激活画成扁平深灰,
        // 看着像没贴材质。补一个 WM_ACTIVATE 它才重画;本来不在前台的不发,免得假装激活。
        if was_foreground {
            let _ = SetForegroundWindow(hwnd);
            SendMessageW(hwnd, WM_ACTIVATE, Some(WPARAM(WA_ACTIVE as usize)), Some(LPARAM(0)));
        }
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &off as *const _ as *const _, 4);
    }
}

#[cfg(not(windows))]
pub fn kick_backdrop(_win: &tauri::WebviewWindow) {}

/// 只刷激活态,不折腾窗口:还原之后 DWM 常常还按"未激活"画云母(扁平深灰,像没贴材质),
/// 紧跟着发 WM_ACTIVATE 它未必来得及理,隔一会儿再发一次才稳。只对真在前台的窗口发。
#[cfg(windows)]
pub fn refresh_active(win: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SendMessageW, WA_ACTIVE, WM_ACTIVATE};
    let Ok(hwnd) = win.hwnd() else { return };
    let hwnd = HWND(hwnd.0 as _);
    unsafe {
        if GetForegroundWindow() == hwnd {
            SendMessageW(hwnd, WM_ACTIVATE, Some(WPARAM(WA_ACTIVE as usize)), Some(LPARAM(0)));
        }
    }
}

#[cfg(not(windows))]
pub fn refresh_active(_win: &tauri::WebviewWindow) {}

/// 过一会儿再踢:窗口刚 show 出来那一瞬 DWM 还没开始合成,这时候踢等于白踢,
/// 它是几百毫秒后才把背景丢掉的。所以显示之后隔 350ms 踢一次、900ms 再补一次,
/// 前端那层不透明底色留够一秒,用户全程看不到。
pub fn kick_backdrop_later(app: &tauri::AppHandle, label: &str, delays_ms: &[u64]) {
    fn later(app: &tauri::AppHandle, label: &str, ms: u64, f: fn(&tauri::WebviewWindow)) {
        let app = app.clone();
        let label = label.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app2.get_webview_window(&label) {
                    f(&w);
                }
            });
        });
    }
    let mut last = 0;
    for &ms in delays_ms {
        later(app, label, ms, kick_backdrop);
        // 每次踢完隔 200ms 刷一次激活态
        later(app, label, ms + 200, refresh_active);
        last = last.max(ms);
    }
    // 最后再补一次纯激活刷新,兜住"踢醒了但还是扁平灰"的那种
    later(app, label, last + 900, refresh_active);
}

/// 设置页的手动入口:立刻踢一次,再补一次
#[tauri::command]
pub fn kick_window_backdrop(app: tauri::AppHandle, label: Option<String>) -> Result<(), String> {
    let label = label.unwrap_or_else(|| "main".to_string());
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("找不到窗口: {label}"))?;
    kick_backdrop(&win);
    kick_backdrop_later(&app, &label, &[400]);
    Ok(())
}
