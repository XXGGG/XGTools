// XGTools Screenshot Sidecar
// 独立原生截图进程: xcap截屏 → winit全屏窗口 → wgpu GPU渲染 → 鼠标选区 → JSON stdout

#![windows_subsystem = "windows"]

mod capture;
mod output;
mod overlay;
mod selection;

use anyhow::Result;
use overlay::OverlayRenderer;
use selection::{SelectionManager, SelectionState};
use std::sync::Arc;
use std::time::Instant;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::dpi::{PhysicalPosition, PhysicalSize};
use winit::window::{CursorIcon, Window, WindowAttributes, WindowId, WindowLevel};

fn main() {
    match run() {
        Ok(_) => {}
        Err(e) => {
            output::output_error(&format!("{:#}", e));
            std::process::exit(1);
        }
    }
}

fn run() -> Result<()> {
    let event_loop = EventLoop::new()?;
    event_loop.set_control_flow(ControlFlow::Poll);

    let mut app = ScreenshotApp::new()?;
    event_loop.run_app(&mut app)?;

    Ok(())
}

struct ScreenshotApp {
    /// 截图图像数据
    screenshot: image::RgbaImage,
    /// 临时文件路径
    temp_image_path: String,
    /// GPU 渲染器
    renderer: Option<OverlayRenderer>,
    /// 选区管理器
    selection: SelectionManager,
    /// 窗口引用
    window: Option<Arc<Window>>,
    /// 主显示器位置和大小（用于延迟全屏）
    monitor_pos: (i32, i32),
    monitor_size: (u32, u32),
    /// 起始时间（动画用）
    start_time: Instant,
    /// 是否已输出结果
    output_sent: bool,
    /// 输入是否就绪（渲染 3 帧后才接受鼠标/键盘输入）
    input_armed: bool,
    /// 已完成的渲染帧数
    frames_rendered: u32,
}

impl ScreenshotApp {
    fn new() -> Result<Self> {
        // 1. 截取屏幕
        let (screenshot, _monitor_info) = capture::capture_primary_monitor()?;

        // 2. 保存临时文件
        let temp_path = output::save_temp_image(&screenshot)?;
        let temp_image_path = temp_path.to_string_lossy().to_string();

        Ok(Self {
            screenshot,
            temp_image_path,
            renderer: None,
            selection: SelectionManager::new(),
            window: None,
            monitor_pos: (0, 0),
            monitor_size: (1920, 1080),
            start_time: Instant::now(),
            output_sent: false,
            input_armed: false,
            frames_rendered: 0,
        })
    }

    fn send_result(&mut self) {
        if self.output_sent {
            return;
        }
        self.output_sent = true;

        match self.selection.state {
            SelectionState::Confirmed => {
                output::output_success(&self.temp_image_path, &self.selection.final_rect);
            }
            _ => {
                let _ = std::fs::remove_file(&self.temp_image_path);
                output::output_cancelled();
            }
        }
    }
}

impl ApplicationHandler for ScreenshotApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        // 获取主显示器尺寸
        let monitor = event_loop
            .primary_monitor()
            .or_else(|| event_loop.available_monitors().next());
        let (mon_pos, mon_size) = monitor
            .map(|m| (m.position(), m.size()))
            .unwrap_or((
                PhysicalPosition::new(0, 0),
                PhysicalSize::new(1920, 1080),
            ));
        self.monitor_pos = (mon_pos.x, mon_pos.y);
        self.monitor_size = (mon_size.width, mon_size.height);

        // 直接创建全屏无边框窗口（可见状态，但通过 WS_EX_LAYERED 设为完全透明）
        let attrs = WindowAttributes::default()
            .with_title("")
            .with_decorations(false)
            .with_position(mon_pos)
            .with_inner_size(mon_size)
            .with_visible(true); // 窗口可见但完全透明

        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                output::output_error(&format!("Failed to create window: {}", e));
                event_loop.exit();
                return;
            }
        };

        window.set_cursor(CursorIcon::Crosshair);

        // Win32: 设置分层窗口（完全透明）+ 禁用 DWM 动画 + 工具窗口 + 置顶
        #[cfg(windows)]
        let hwnd = {
            use raw_window_handle::HasWindowHandle;
            use windows::Win32::Foundation::HWND;
            let h = window.window_handle().ok().and_then(|handle| {
                if let raw_window_handle::RawWindowHandle::Win32(win32) = handle.as_ref() {
                    Some(HWND(win32.hwnd.get() as *mut _))
                } else {
                    None
                }
            });
            if let Some(hwnd) = h {
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
                };
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
                    WS_EX_TOOLWINDOW, WS_EX_LAYERED,
                    SetLayeredWindowAttributes, LWA_ALPHA,
                    SetWindowPos, SetForegroundWindow,
                    HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE,
                };
                unsafe {
                    // 1. 禁用 DWM 过渡动画
                    let disable: u32 = 1;
                    let _ = DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_TRANSITIONS_FORCEDISABLED,
                        &disable as *const u32 as *const _,
                        std::mem::size_of::<u32>() as u32,
                    );
                    // 2. 添加 LAYERED + TOOLWINDOW 扩展样式
                    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                    SetWindowLongW(
                        hwnd,
                        GWL_EXSTYLE,
                        (ex_style | WS_EX_LAYERED.0 | WS_EX_TOOLWINDOW.0) as i32,
                    );
                    // 3. 设为完全透明（alpha=0）— 窗口可见但用户看不到
                    use windows::Win32::Foundation::COLORREF;
                    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
                    // 4. 置顶
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                    let _ = SetForegroundWindow(hwnd);
                }
            }
            h
        };

        // 初始化 GPU 渲染器
        match OverlayRenderer::new(window.clone(), &self.screenshot) {
            Ok(mut renderer) => {
                // 渲染首帧（窗口存在且全屏，但alpha=0完全透明）
                let _ = renderer.render();

                // 移除 LAYERED 样式，让 wgpu surface 内容直接显示
                // 这是瞬间操作：从透明到有内容，没有闪烁
                #[cfg(windows)]
                if let Some(hwnd) = hwnd {
                    use windows::Win32::UI::WindowsAndMessaging::{
                        GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_LAYERED,
                    };
                    unsafe {
                        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                        SetWindowLongW(
                            hwnd,
                            GWL_EXSTYLE,
                            (ex_style & !WS_EX_LAYERED.0) as i32,
                        );
                    }
                }

                self.frames_rendered = 1;
                self.renderer = Some(renderer);
                self.window = Some(window.clone());
                self.start_time = Instant::now();
                window.request_redraw();
            }
            Err(e) => {
                output::output_error(&format!("GPU init failed: {}", e));
                event_loop.exit();
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        // 输入保护：渲染 3 帧后才接受鼠标/键盘输入
        // 防止窗口启动时残留的输入状态误触发操作
        if !self.input_armed {
            if self.frames_rendered >= 3 {
                self.input_armed = true;
            } else {
                match &event {
                    WindowEvent::MouseInput { .. } | WindowEvent::KeyboardInput { .. } => {
                        return;
                    }
                    _ => {}
                }
            }
        }

        match event {
            WindowEvent::CloseRequested => {
                self.selection.on_cancel();
                self.send_result();
                event_loop.exit();
            }

            WindowEvent::Resized(new_size) => {
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(new_size);
                }
            }

            WindowEvent::CursorMoved { position, .. } => {
                self.selection
                    .on_mouse_move(position.x as f32, position.y as f32);

                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }

            WindowEvent::MouseInput { state, button, .. } => {
                match (button, state) {
                    (MouseButton::Left, ElementState::Pressed) => {
                        let (x, y) = self.selection.cursor_pos;
                        self.selection.on_mouse_down(x, y);
                    }
                    (MouseButton::Left, ElementState::Released) => {
                        let (x, y) = self.selection.cursor_pos;
                        self.selection.on_mouse_up(x, y);

                        if self.selection.state == SelectionState::Confirmed {
                            self.send_result();
                            event_loop.exit();
                        }
                    }
                    (MouseButton::Right, ElementState::Pressed) => {
                        self.selection.on_right_click();
                    }
                    _ => {}
                }

                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }

            WindowEvent::KeyboardInput { event, .. } => {
                if event.state == ElementState::Pressed {
                    match event.logical_key {
                        Key::Named(NamedKey::Escape) => {
                            self.selection.on_escape();
                            if self.selection.state == SelectionState::Cancelled {
                                self.send_result();
                                event_loop.exit();
                            }
                            if let Some(window) = &self.window {
                                window.request_redraw();
                            }
                        }
                        _ => {}
                    }
                }
            }

            WindowEvent::RedrawRequested => {
                if let Some(renderer) = &mut self.renderer {
                    let elapsed = self.start_time.elapsed().as_secs_f32();
                    renderer.uniforms.time = elapsed;
                    renderer.uniforms.mouse_pos =
                        [self.selection.cursor_pos.0, self.selection.cursor_pos.1];

                    renderer.uniforms.state = match self.selection.state {
                        SelectionState::Idle => 0,
                        SelectionState::Dragging => 1,
                        SelectionState::Confirmed => 2,
                        SelectionState::Cancelled => 0,
                    };

                    if let Some(rect) = self.selection.current_rect() {
                        renderer.uniforms.sel_start = [rect.x, rect.y];
                        renderer.uniforms.sel_end =
                            [rect.x + rect.width, rect.y + rect.height];
                    }

                    if renderer.render().is_ok() {
                        self.frames_rendered = self.frames_rendered.saturating_add(1);
                    }
                }

                if let Some(window) = &self.window {
                    window.request_redraw();
                }
            }

            _ => {}
        }
    }

    fn about_to_wait(&mut self, _event_loop: &ActiveEventLoop) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        self.send_result();
    }
}
