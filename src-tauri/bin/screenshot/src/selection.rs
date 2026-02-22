/// 选区状态机
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SelectionState {
    /// 等待用户操作
    Idle,
    /// 用户正在拖拽选区
    Dragging,
    /// 选区已确认
    Confirmed,
    /// 用户取消
    Cancelled,
}

/// 选区矩形（物理像素坐标）
#[derive(Debug, Clone, Copy, Default)]
pub struct SelectionRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl SelectionRect {
    /// 从两个角点创建，自动处理方向
    pub fn from_points(x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
        let x = x1.min(x2);
        let y = y1.min(y2);
        let width = (x2 - x1).abs();
        let height = (y2 - y1).abs();
        Self { x, y, width, height }
    }

    pub fn is_empty(&self) -> bool {
        self.width < 1.0 || self.height < 1.0
    }
}

/// 选区管理器
pub struct SelectionManager {
    pub state: SelectionState,
    /// 拖拽起点
    drag_start: Option<(f32, f32)>,
    /// 当前拖拽矩形
    pub drag_rect: SelectionRect,
    /// 最终确认的选区
    pub final_rect: SelectionRect,
    /// 当前鼠标位置（物理像素）
    pub cursor_pos: (f32, f32),
}

impl SelectionManager {
    pub fn new() -> Self {
        Self {
            state: SelectionState::Idle,
            drag_start: None,
            drag_rect: SelectionRect::default(),
            final_rect: SelectionRect::default(),
            cursor_pos: (0.0, 0.0),
        }
    }

    /// 鼠标移动
    pub fn on_mouse_move(&mut self, x: f32, y: f32) {
        self.cursor_pos = (x, y);

        if let (SelectionState::Dragging, Some((sx, sy))) = (self.state, self.drag_start) {
            self.drag_rect = SelectionRect::from_points(sx, sy, x, y);
        }
    }

    /// 鼠标左键按下 → 开始拖拽
    pub fn on_mouse_down(&mut self, x: f32, y: f32) {
        if self.state == SelectionState::Idle {
            self.state = SelectionState::Dragging;
            self.drag_start = Some((x, y));
            self.drag_rect = SelectionRect::default();
        }
    }

    /// 鼠标左键释放 → 确认选区
    pub fn on_mouse_up(&mut self, x: f32, y: f32) {
        if self.state == SelectionState::Dragging {
            if let Some((sx, sy)) = self.drag_start {
                let rect = SelectionRect::from_points(sx, sy, x, y);
                if rect.is_empty() {
                    self.state = SelectionState::Idle;
                    self.drag_start = None;
                } else {
                    self.final_rect = rect;
                    self.state = SelectionState::Confirmed;
                }
            }
        }
    }

    /// 右键 → 取消当前拖拽回到 Idle（不退出程序）
    pub fn on_right_click(&mut self) {
        if self.state == SelectionState::Dragging {
            self.state = SelectionState::Idle;
            self.drag_start = None;
            self.drag_rect = SelectionRect::default();
        }
    }

    /// ESC → 拖拽中回到 Idle，Idle 中退出
    pub fn on_escape(&mut self) {
        match self.state {
            SelectionState::Dragging => {
                self.state = SelectionState::Idle;
                self.drag_start = None;
                self.drag_rect = SelectionRect::default();
            }
            SelectionState::Idle => {
                self.state = SelectionState::Cancelled;
            }
            _ => {
                self.state = SelectionState::Cancelled;
            }
        }
    }

    /// 强制取消（窗口关闭等）
    pub fn on_cancel(&mut self) {
        self.state = SelectionState::Cancelled;
    }

    /// 获取当前需要渲染的选区
    pub fn current_rect(&self) -> Option<&SelectionRect> {
        match self.state {
            SelectionState::Dragging => Some(&self.drag_rect),
            SelectionState::Confirmed => Some(&self.final_rect),
            _ => None,
        }
    }
}
