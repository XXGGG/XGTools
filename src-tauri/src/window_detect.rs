use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::hash::Hash;
use std::mem;

use atree::Arena;
use atree::Token;
use rtree_rs::{RTree, Rect};

use rayon::iter::{IndexedParallelIterator, IntoParallelRefIterator, ParallelIterator};

use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::UITreeWalker;
use uiautomation::core::UICacheRequest;
use uiautomation::types::TreeScope;
use uiautomation::types::UIProperty;

use std::sync::Arc;

use thiserror::Error;

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetWindowInfo, WINDOWINFO};
#[cfg(windows)]
use windows::Win32::Graphics::Dwm::DwmGetWindowAttribute;

// ─── Error ───────────────────────────────────────────────────────

#[derive(Error, Debug)]
pub enum UIAutomationError {
    #[error("UIAutomation error")]
    UIAError(#[from] uiautomation::errors::Error),
    #[error("Windows error")]
    WinError(#[from] windows::core::Error),
}

// ─── ElementRect ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ElementRect {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

impl From<uiautomation::types::Rect> for ElementRect {
    fn from(r: uiautomation::types::Rect) -> Self {
        Self {
            min_x: r.get_left(),
            min_y: r.get_top(),
            max_x: r.get_right(),
            max_y: r.get_bottom(),
        }
    }
}

// ─── WindowElement (前端 Flatbush 用) ────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct WindowElement {
    pub element_rect: ElementRect,
    pub window_id: u32,
    pub corner_radius: f64,
}

// ─── ElementLevel ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd)]
struct ElementLevel {
    element_index: i32,
    element_level: i32,
    parent_index: i32,
    window_index: i32,
}

impl ElementLevel {
    fn root() -> Self {
        Self {
            element_index: 0,
            element_level: 0,
            parent_index: i32::MAX,
            window_index: i32::MAX,
        }
    }

    fn next_level(&mut self) {
        self.element_level += 1;
        let current = self.element_index;
        self.element_index = 0;
        self.parent_index = current;
    }

    fn next_element(&mut self) {
        self.element_index += 1;
    }
}

impl Ord for ElementLevel {
    fn cmp(&self, other: &Self) -> Ordering {
        // 窗口索引小 → 优先级高
        if self.window_index != other.window_index {
            return other.window_index.cmp(&self.window_index);
        }
        // 层级高 → 优先级高
        if self.element_level != other.element_level {
            return self.element_level.cmp(&other.element_level);
        }
        // 元素索引小 → 优先级高
        if self.element_index != other.element_index {
            return other.element_index.cmp(&self.element_index);
        }
        // 父元素索引大 → 优先级高
        other.parent_index.cmp(&self.parent_index)
    }
}

// ─── UIAutomation Send/Sync wrappers ─────────────────────────────

struct UIAutomationWrapper {
    automation: UIAutomation,
}
unsafe impl Send for UIAutomationWrapper {}
unsafe impl Sync for UIAutomationWrapper {}

struct UIElementWrapper {
    element: UIElement,
}
unsafe impl Send for UIElementWrapper {}
unsafe impl Sync for UIElementWrapper {}

// ─── Children/Sibling 缓存项 ────────────────────────────────────

enum ChildSiblingCache {
    Element(UIElement, ElementLevel),
    Leaf,
    NoNext,
}

// ─── UIElements 核心结构 ─────────────────────────────────────────

pub struct UIElements {
    automation: Option<Arc<UIAutomationWrapper>>,
    automation_walker: Option<UITreeWalker>,
    root_element: Option<UIElement>,
    cache_request: Option<UICacheRequest>,
    element_cache: RTree<2, i32, ElementLevel>,
    element_level_map: HashMap<ElementLevel, (UIElement, Token)>,
    element_rect_tree: Arena<uiautomation::types::Rect>,
    children_sibling_cache: HashMap<ElementLevel, ChildSiblingCache>,
    window_rect_map: HashMap<ElementLevel, uiautomation::types::Rect>,
    window_index_level_map: HashMap<i32, ElementLevel>,
}

unsafe impl Send for UIElements {}
unsafe impl Sync for UIElements {}

impl UIElements {
    pub fn new() -> Self {
        Self {
            automation: None,
            automation_walker: None,
            root_element: None,
            cache_request: None,
            element_rect_tree: Arena::new(),
            element_cache: RTree::new(),
            element_level_map: HashMap::new(),
            children_sibling_cache: HashMap::new(),
            window_rect_map: HashMap::new(),
            window_index_level_map: HashMap::new(),
        }
    }

    /// 初始化 UIAutomation + content_view_walker + UICacheRequest
    pub fn init(&mut self) -> Result<(), UIAutomationError> {
        if self.automation.is_some() {
            return Ok(());
        }

        let automation = UIAutomation::new()?;
        let walker = automation.get_content_view_walker()?;

        let cache_request = automation.create_cache_request()?;
        cache_request.add_property(UIProperty::BoundingRectangle)?;
        cache_request.add_property(UIProperty::ControlType)?;
        cache_request.add_property(UIProperty::IsOffscreen)?;
        cache_request.set_tree_scope(TreeScope::Element)?;

        self.automation = Some(Arc::new(UIAutomationWrapper { automation }));
        self.automation_walker = Some(walker);
        self.cache_request = Some(cache_request);

        Ok(())
    }

    // ─── 工具方法 ──────────────────────────────────

    fn to_rtree_rect(r: uiautomation::types::Rect) -> Rect<2, i32> {
        Rect::new([r.get_left(), r.get_top()], [r.get_right(), r.get_bottom()])
    }

    fn normalize_rect(r: uiautomation::types::Rect) -> uiautomation::types::Rect {
        let (mut l, mut t, mut ri, mut b) =
            (r.get_left(), r.get_top(), r.get_right(), r.get_bottom());
        if l > ri {
            mem::swap(&mut l, &mut ri);
        }
        if t > b {
            mem::swap(&mut t, &mut b);
        }
        uiautomation::types::Rect::new(l, t, ri, b)
    }

    fn beyond_rect(
        r: uiautomation::types::Rect,
        parent: uiautomation::types::Rect,
    ) -> bool {
        r.get_left() < parent.get_left()
            || r.get_right() > parent.get_right()
            || r.get_top() < parent.get_top()
            || r.get_bottom() > parent.get_bottom()
    }

    fn clip_rect(
        r: uiautomation::types::Rect,
        parent: uiautomation::types::Rect,
    ) -> uiautomation::types::Rect {
        uiautomation::types::Rect::new(
            r.get_left().max(parent.get_left()),
            r.get_top().max(parent.get_top()),
            r.get_right().min(parent.get_right()),
            r.get_bottom().min(parent.get_bottom()),
        )
    }

    fn insert_element_cache(
        &mut self,
        parent_token: &mut Token,
        element: UIElement,
        rect: uiautomation::types::Rect,
        level: ElementLevel,
    ) -> (uiautomation::types::Rect, Token) {
        let mut rect = Self::normalize_rect(rect);

        // 裁剪到所属窗口范围
        let window_rect = self
            .window_rect_map
            .get(
                self.window_index_level_map
                    .get(&level.window_index)
                    .unwrap_or(&level),
            )
            .cloned()
            .unwrap_or(rect);

        if Self::beyond_rect(rect, window_rect) {
            rect = Self::clip_rect(rect, window_rect);
        }

        self.element_cache.insert(Self::to_rtree_rect(rect), level);

        let node = self.element_rect_tree.new_node(rect);
        parent_token
            .append_node(&mut self.element_rect_tree, node)
            .unwrap();
        self.element_level_map.insert(level, (element, node));

        (rect, node)
    }

    fn get_element_from_cache(
        &self,
        mx: i32,
        my: i32,
    ) -> Option<(UIElement, ElementLevel, uiautomation::types::Rect, Token)> {
        let hits = self.element_cache.search(Rect::new_point([mx, my]));

        let mut best_level = ElementLevel::root();
        let mut best_rtree_rect = None;
        for hit in hits {
            if best_level.cmp(&hit.data) == Ordering::Less {
                best_level = *hit.data;
                best_rtree_rect = Some(hit.rect);
            }
        }

        let rr = best_rtree_rect?;
        let ua_rect =
            uiautomation::types::Rect::new(rr.min[0], rr.min[1], rr.max[0], rr.max[1]);

        let (elem, token) = self.element_level_map.get(&best_level)?;
        Some((elem.clone(), best_level, ua_rect, *token))
    }

    // ─── init_cache: rayon 并行枚举窗口 ──────────────

    pub fn init_cache(&mut self) -> Result<(), UIAutomationError> {
        let automation = self.automation.as_ref().unwrap();
        self.root_element
            .replace(automation.automation.get_root_element()?);

        let root_element = self.root_element.as_ref().unwrap();

        // 清空
        self.element_rect_tree = Arena::new();
        self.element_cache = RTree::new();
        self.element_level_map.clear();
        self.children_sibling_cache.clear();
        self.window_rect_map.clear();
        self.window_index_level_map.clear();

        // 桌面根节点（用一个非常大的矩形）
        let root_rect =
            uiautomation::types::Rect::new(-10000, -10000, 100000, 100000);

        let mut root_tree_token = self.element_rect_tree.new_node(root_rect);
        let (_, mut parent_tree_token) = self.insert_element_cache(
            &mut root_tree_token,
            root_element.clone(),
            root_rect,
            ElementLevel::root(),
        );

        // 收集窗口信息（主线程，因为 xcap::Window 不是 Send）
        let windows = xcap::Window::all().unwrap_or_default();

        struct WinInfo {
            hwnd_val: isize,
            rc_left: i32,
            rc_top: i32,
            rc_right: i32,
            rc_bottom: i32,
        }

        let win_infos: Vec<WinInfo> = windows
            .iter()
            .filter(|w| {
                if w.is_minimized() {
                    return false;
                }
                if w.width() == 0 || w.height() == 0 {
                    return false;
                }
                let title = w.title();
                // 排除截图窗口自身 + Shell Handwriting Canvas
                if title == "XGTools Screenshot Overlay"
                    || title == "Shell Handwriting Canvas"
                {
                    return false;
                }
                true
            })
            .filter_map(|w| {
                let hwnd_val = w.id() as isize;
                // 用 windows crate 的 GetWindowInfo 获取 rcClient
                let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
                let mut wi = WINDOWINFO {
                    cbSize: mem::size_of::<WINDOWINFO>() as u32,
                    ..Default::default()
                };
                let ok = unsafe { GetWindowInfo(hwnd, &mut wi) };
                if ok.is_err() {
                    // fallback: 用 xcap 的坐标
                    return Some(WinInfo {
                        hwnd_val,
                        rc_left: w.x(),
                        rc_top: w.y(),
                        rc_right: w.x() + w.width() as i32,
                        rc_bottom: w.y() + w.height() as i32,
                    });
                }
                Some(WinInfo {
                    hwnd_val,
                    rc_left: wi.rcClient.left,
                    rc_top: wi.rcClient.top,
                    rc_right: wi.rcClient.right,
                    rc_bottom: wi.rcClient.bottom,
                })
            })
            .collect();

        // rayon 并行: element_from_handle（保留原始 z-order 索引）
        let auto_clone = self.automation.clone();
        let mut children_list: Vec<(usize, UIElementWrapper, uiautomation::types::Rect)> = win_infos
            .par_iter()
            .enumerate()
            .filter_map(|(idx, info)| {
                let rect = uiautomation::types::Rect::new(
                    info.rc_left,
                    info.rc_top,
                    info.rc_right,
                    info.rc_bottom,
                );
                let handle =
                    uiautomation::types::Handle::from(info.hwnd_val);
                auto_clone
                    .as_ref()
                    .unwrap()
                    .automation
                    .element_from_handle(handle)
                    .ok()
                    .map(|elem| (idx, UIElementWrapper { element: elem }, rect))
            })
            .collect();

        // 按原始 z-order 排序（par_iter 不保证顺序）
        children_list.sort_by_key(|(idx, _, _)| *idx);

        println!("[WindowSnap] init_cache: {} win_infos, {} elements from rayon",
            win_infos.len(), children_list.len());

        // 顺序插入缓存
        let mut current_level = ElementLevel::root();
        current_level.window_index = 0;
        current_level.next_level();

        for (_idx, wrapper, rect) in children_list {
            let element = wrapper.element;
            current_level.window_index += 1;
            current_level.next_element();

            let (clipped_rect, _) = self.insert_element_cache(
                &mut parent_tree_token,
                element,
                rect,
                current_level,
            );

            self.window_rect_map.insert(current_level, clipped_rect);
            self.window_index_level_map
                .insert(current_level.window_index, current_level);
        }

        Ok(())
    }

    // ─── 增量深度遍历（核心查询） ──────────────────

    pub fn get_element_from_point_walker(
        &mut self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Result<Vec<ElementRect>, UIAutomationError> {
        let walker = self.automation_walker.clone().unwrap();

        let (parent_element, mut parent_level, parent_rect, mut parent_tree_token) =
            match self.get_element_from_cache(mouse_x, mouse_y) {
                Some(t) => t,
                None => (
                    self.root_element.clone().unwrap(),
                    ElementLevel::root(),
                    uiautomation::types::Rect::new(0, 0, i32::MAX, i32::MAX),
                    self.element_rect_tree
                        .new_node(uiautomation::types::Rect::new(0, 0, i32::MAX, i32::MAX)),
                ),
            };

        let mut current_level = ElementLevel::root();
        let mut queue: Option<UIElement> = None;

        // 先查 children/sibling 缓存
        let mut try_first_child = false;
        match self.children_sibling_cache.get(&parent_level) {
            Some(ChildSiblingCache::Element(elem, lvl)) => {
                queue = Some(elem.clone());
                current_level = *lvl;
            }
            Some(ChildSiblingCache::Leaf) | Some(ChildSiblingCache::NoNext) => {}
            None => {
                try_first_child = true;
            }
        }

        if try_first_child {
            let first = if let Some(cr) = &self.cache_request {
                walker.get_first_child_build_cache(&parent_element, cr)
            } else {
                walker.get_first_child(&parent_element)
            };

            match first {
                Ok(child) => {
                    queue = Some(child.clone());
                    current_level = parent_level;
                    current_level.next_level();
                    self.children_sibling_cache.insert(
                        parent_level,
                        ChildSiblingCache::Element(child, current_level),
                    );
                }
                Err(_) => {
                    self.children_sibling_cache
                        .insert(parent_level, ChildSiblingCache::Leaf);
                }
            }
        }

        let mut current_rect = parent_rect;
        let mut current_token = parent_tree_token;
        let mut result_token = current_token;
        let mut _result_rect = current_rect;

        while let Some(elem) = queue.take() {
            // 检查 offscreen
            let offscreen = if self.cache_request.is_some() {
                elem.is_cached_offscreen().unwrap_or(true)
            } else {
                elem.is_offscreen().unwrap_or(true)
            };

            if !offscreen {
                current_rect = if self.cache_request.is_some() {
                    match elem.get_cached_bounding_rectangle() {
                        Ok(r) => r,
                        Err(_) => {
                            // 获取下一个兄弟
                            self.try_next_sibling(&walker, &elem, &mut queue, &mut current_level, parent_level);
                            continue;
                        }
                    }
                } else {
                    match elem.get_bounding_rectangle() {
                        Ok(r) => r,
                        Err(_) => {
                            self.try_next_sibling(&walker, &elem, &mut queue, &mut current_level, parent_level);
                            continue;
                        }
                    }
                };

                let (l, r, t, b) = (
                    current_rect.get_left(),
                    current_rect.get_right(),
                    current_rect.get_top(),
                    current_rect.get_bottom(),
                );

                // 跳过零大小
                if !(l == 0 && r == 0 && t == 0 && b == 0) {
                    let (clipped, token) = self.insert_element_cache(
                        &mut parent_tree_token,
                        elem.clone(),
                        current_rect,
                        current_level,
                    );
                    current_rect = clipped;
                    current_token = token;

                    // 命中鼠标点 → 深入子元素
                    if l <= mouse_x && r >= mouse_x && t <= mouse_y && b >= mouse_y {
                        result_token = current_token;
                        _result_rect = current_rect;

                        let child = if let Some(cr) = &self.cache_request {
                            walker.get_first_child_build_cache(&elem, cr)
                        } else {
                            walker.get_first_child(&elem)
                        };

                        if let Ok(c) = child {
                            queue = Some(c.clone());
                            parent_tree_token = current_token;
                            parent_level = current_level;
                            current_level.next_level();
                            self.children_sibling_cache.insert(
                                parent_level,
                                ChildSiblingCache::Element(c, current_level),
                            );
                            continue;
                        } else {
                            self.children_sibling_cache
                                .insert(current_level, ChildSiblingCache::Leaf);
                        }
                    }
                }
            }

            // 获取下一个兄弟
            self.try_next_sibling(&walker, &elem, &mut queue, &mut current_level, parent_level);
        }

        // 收集祖先链
        let ancestors = result_token.ancestors(&self.element_rect_tree);
        let mut result: Vec<ElementRect> = Vec::with_capacity(16);
        let mut prev = ElementRect::from(_result_rect);
        result.push(prev);

        for node in ancestors {
            let cur = ElementRect::from(node.data);
            if cur == prev {
                continue;
            }
            // 跳过不相交的
            if cur.min_x == prev.max_x
                || cur.min_y == prev.max_y
                || cur.min_x > prev.max_x
                || cur.min_y > prev.max_y
            {
                continue;
            }
            result.push(cur);
            prev = cur;
        }

        Ok(result)
    }

    /// 辅助：尝试获取下一个兄弟元素
    fn try_next_sibling(
        &mut self,
        walker: &UITreeWalker,
        current: &UIElement,
        queue: &mut Option<UIElement>,
        current_level: &mut ElementLevel,
        parent_level: ElementLevel,
    ) {
        let next = if let Some(cr) = &self.cache_request {
            walker.get_next_sibling_build_cache(current, cr)
        } else {
            walker.get_next_sibling(current)
        };

        match next {
            Ok(sib) => {
                *queue = Some(sib.clone());
                current_level.next_element();
                self.children_sibling_cache.insert(
                    parent_level,
                    ChildSiblingCache::Element(sib, *current_level),
                );
            }
            Err(_) => {
                self.children_sibling_cache
                    .insert(parent_level, ChildSiblingCache::NoNext);
            }
        }
    }
}

impl Drop for UIElements {
    fn drop(&mut self) {
        self.automation = None;
        self.automation_walker = None;
        self.root_element = None;
    }
}

// ─── 专用 COM 线程 ──────────────────────────────────────────────
//
// COM UIAutomation 对象必须在同一线程上创建和使用。
// 同时 COM 操作是阻塞的，不能在 tokio 线程上运行（会堵塞快捷键/事件循环）。
// 解决方案：一个专用 OS 线程持有 UIElements，通过 channel 接收任务。

enum ComTask {
    Init(tokio::sync::oneshot::Sender<Result<(), String>>),
    InitCache(tokio::sync::oneshot::Sender<Result<(), String>>),
    GetElement {
        mouse_x: i32,
        mouse_y: i32,
        reply: tokio::sync::oneshot::Sender<Result<Vec<ElementRect>, String>>,
    },
}

pub struct ComThread {
    tx: std::sync::mpsc::Sender<ComTask>,
}

impl ComThread {
    pub fn spawn() -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<ComTask>();
        std::thread::spawn(move || {
            println!("[ComThread] started");
            let mut ui = UIElements::new();
            while let Ok(task) = rx.recv() {
                match task {
                    ComTask::Init(reply) => {
                        println!("[ComThread] Init start");
                        let r = ui.init().map_err(|e| format!("{}", e));
                        println!("[ComThread] Init result: {:?}", r);
                        let _ = reply.send(r);
                    }
                    ComTask::InitCache(reply) => {
                        println!("[ComThread] InitCache start");
                        let r = ui.init_cache().map_err(|e| format!("{}", e));
                        println!("[ComThread] InitCache result: {:?}", r);
                        let _ = reply.send(r);
                    }
                    ComTask::GetElement { mouse_x, mouse_y, reply } => {
                        let r = ui
                            .get_element_from_point_walker(mouse_x, mouse_y)
                            .map_err(|e| format!("{}", e));
                        if let Ok(ref v) = r {
                            println!("[ComThread] GetElement({},{}) => {} rects", mouse_x, mouse_y, v.len());
                        } else {
                            println!("[ComThread] GetElement({},{}) => {:?}", mouse_x, mouse_y, r);
                        }
                        let _ = reply.send(r);
                    }
                }
            }
            println!("[ComThread] exiting");
        });
        Self { tx }
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn init_ui_elements(
    com: tauri::State<'_, ComThread>,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    com.tx.send(ComTask::Init(tx)).map_err(|_| "COM thread dead".to_string())?;
    rx.await.map_err(|_| "COM reply lost".to_string())?
}

#[tauri::command]
pub async fn init_ui_elements_cache(
    com: tauri::State<'_, ComThread>,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    com.tx.send(ComTask::InitCache(tx)).map_err(|_| "COM thread dead".to_string())?;
    rx.await.map_err(|_| "COM reply lost".to_string())?
}

#[tauri::command]
pub async fn get_element_from_position(
    com: tauri::State<'_, ComThread>,
    mouse_x: i32,
    mouse_y: i32,
) -> Result<Vec<ElementRect>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    com.tx.send(ComTask::GetElement { mouse_x, mouse_y, reply: tx })
        .map_err(|_| "COM thread dead".to_string())?;
    rx.await.map_err(|_| "COM reply lost".to_string())?
}

#[tauri::command]
pub async fn get_visible_windows() -> Result<Vec<WindowElement>, String> {
    tokio::task::spawn_blocking(|| {
        let windows =
            xcap::Window::all().map_err(|e| format!("enum windows: {}", e))?;

        let result: Vec<WindowElement> = windows
            .iter()
            .filter(|w| {
                if w.is_minimized() {
                    return false;
                }
                if w.width() == 0 || w.height() == 0 {
                    return false;
                }
                let title = w.title();
                // 排除截图窗口自身 + Shell Handwriting Canvas
                if title == "XGTools Screenshot Overlay"
                    || title == "Shell Handwriting Canvas"
                {
                    return false;
                }
                true
            })
            .filter_map(|w| {
                let hwnd_val = w.id() as isize;
                let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
                let mut wi = WINDOWINFO {
                    cbSize: mem::size_of::<WINDOWINFO>() as u32,
                    ..Default::default()
                };
                let (left, top, right, bottom) =
                    if unsafe { GetWindowInfo(hwnd, &mut wi) }.is_ok() {
                        (
                            wi.rcClient.left,
                            wi.rcClient.top,
                            wi.rcClient.right,
                            wi.rcClient.bottom,
                        )
                    } else {
                        (
                            w.x(),
                            w.y(),
                            w.x() + w.width() as i32,
                            w.y() + w.height() as i32,
                        )
                    };

                // 查询 DWM 圆角偏好 (Win11+)
                // DWMWA_WINDOW_CORNER_PREFERENCE = 33
                let corner_radius = {
                    let mut corner_pref: u32 = 0;
                    let hr = unsafe {
                        DwmGetWindowAttribute(
                            hwnd,
                            windows::Win32::Graphics::Dwm::DWMWA_WINDOW_CORNER_PREFERENCE,
                            &mut corner_pref as *mut u32 as *mut _,
                            mem::size_of::<u32>() as u32,
                        )
                    };
                    if hr.is_ok() {
                        match corner_pref {
                            1 => 0.0,  // DONOTROUND
                            3 => 4.0,  // ROUNDSMALL
                            _ => 8.0,  // DEFAULT(0) 或 ROUND(2) 均为 8px
                        }
                    } else {
                        // Win10 或 API 不支持 → 默认直角
                        0.0
                    }
                };

                Some(WindowElement {
                    element_rect: ElementRect {
                        min_x: left,
                        min_y: top,
                        max_x: right,
                        max_y: bottom,
                    },
                    window_id: w.id(),
                    corner_radius,
                })
            })
            .collect();

        Ok(result)
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}
