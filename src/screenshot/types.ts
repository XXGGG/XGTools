// 截图相关类型定义

/** 选区状态 */
export enum SelectState {
  /** 空闲：等待用户拖拽创建选区 */
  Idle = 0,
  /** 正在创建选区（鼠标拖拽中） */
  Creating = 1,
  /** 已选中：选区已创建，可移动/缩放/使用工具栏 */
  Selected = 2,
  /** 拖动选区中 */
  Moving = 3,
  /** 缩放选区中 */
  Resizing = 4,
}

/** 缩放方向（位掩码） */
export enum ResizeEdge {
  None = 0,
  Top = 1,
  Right = 2,
  Bottom = 4,
  Left = 8,
  TopLeft = Top | Left,       // 9
  TopRight = Top | Right,     // 3
  BottomLeft = Bottom | Left, // 12
  BottomRight = Bottom | Right, // 6
}

/** 选区矩形（CSS 像素坐标） */
export interface SelectRect {
  x: number
  y: number
  w: number
  h: number
}

/** 标注工具类型 */
export enum DrawTool {
  None = 0,
  Rect = 1,
  Diamond = 2,
  Ellipse = 3,
  Arrow = 4,
  Line = 5,
  Pen = 6,
  Text = 7,
  SerialNumber = 8,
  Blur = 9,
  BlurFreeDraw = 10,
  Highlight = 11,
  Watermark = 12,
  Eraser = 13,
}

/** 边框样式 */
export type BorderStyle = 'solid' | 'dashed' | 'dotted'

/** 线条风格 */
export type LineStyle = 'sharp' | 'curve' | 'thick'

/** 箭头类型 */
export type ArrowType = 'thin' | 'normal' | 'block'

/** 端点样式 */
export type EndpointStyle = 'none' | 'arrow'

/** 画笔样式 */
export type PenStyle = 'round' | 'chisel'

/** 边角样式 */
export type CornerStyle = 'sharp' | 'round'

/** 标注元素基类 */
export interface AnnotationBase {
  id: string
  tool: DrawTool
  strokeColor: string
  strokeWidth: number
  fillColor: string
  /** 透明度 0-1 */
  opacity?: number
  /** 边框样式 */
  borderStyle?: BorderStyle
  /** 线条风格 */
  lineStyle?: LineStyle
}

/** 矩形标注 */
export interface RectAnnotation extends AnnotationBase {
  tool: DrawTool.Rect
  x: number
  y: number
  w: number
  h: number
  /** 边角样式 */
  cornerStyle?: CornerStyle
  /** 圆角半径 */
  borderRadius?: number
}

/** 椭圆标注 */
export interface EllipseAnnotation extends AnnotationBase {
  tool: DrawTool.Ellipse
  cx: number
  cy: number
  rx: number
  ry: number
}

/** 箭头标注 */
export interface ArrowAnnotation extends AnnotationBase {
  tool: DrawTool.Arrow
  x1: number
  y1: number
  x2: number
  y2: number
  /** 箭头类型 */
  arrowType?: ArrowType
  /** 起点端点样式 */
  startEndpoint?: EndpointStyle
  /** 终点端点样式 */
  endEndpoint?: EndpointStyle
}

/** 直线标注 */
export interface LineAnnotation extends AnnotationBase {
  tool: DrawTool.Line
  x1: number
  y1: number
  x2: number
  y2: number
  /** 起点端点样式 */
  startEndpoint?: EndpointStyle
  /** 终点端点样式 */
  endEndpoint?: EndpointStyle
}

/** 画笔标注 */
export interface PenAnnotation extends AnnotationBase {
  tool: DrawTool.Pen
  points: [number, number][]
  /** 画笔样式 */
  penStyle?: PenStyle
}

/** 文字标注 */
export interface TextAnnotation extends AnnotationBase {
  tool: DrawTool.Text
  x: number
  y: number
  text: string
  fontSize: number
  /** 文本背景色 */
  bgColor: string
  /** 文本描边颜色 */
  textStrokeColor: string
  /** 文本描边宽度 */
  textStrokeWidth: number
  /** 字体 */
  fontFamily: string
  /** 对齐方式 */
  textAlign: 'left' | 'center' | 'right'
  /** 透明度 0-1 */
  opacity: number
}

/** 序号标记 */
export interface SerialNumberAnnotation extends AnnotationBase {
  tool: DrawTool.SerialNumber
  cx: number
  cy: number
  number: number
  fontSize: number
}

/** 菱形标注 */
export interface DiamondAnnotation extends AnnotationBase {
  tool: DrawTool.Diamond
  x: number
  y: number
  w: number
  h: number
}

/** 模糊标注 */
export interface BlurAnnotation extends AnnotationBase {
  tool: DrawTool.Blur
  x: number
  y: number
  w: number
  h: number
  blurRadius: number
}

/** 自由模糊标注 */
export interface BlurFreeDrawAnnotation extends AnnotationBase {
  tool: DrawTool.BlurFreeDraw
  points: [number, number][]
  blurRadius: number
  lineWidth: number
}

/** 高亮标注 */
export interface HighlightAnnotation extends AnnotationBase {
  tool: DrawTool.Highlight
  points: [number, number][]
  lineWidth: number
}

/** 水印标注（平铺 45° 旋转水印覆盖整个选区） */
export interface WatermarkAnnotation extends AnnotationBase {
  tool: DrawTool.Watermark
  /** 选区范围（本地坐标） */
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize: number
  opacity: number
  fontFamily: string
}

/** 橡皮擦（记录擦除的标注 ID） */
export interface EraserAction {
  tool: DrawTool.Eraser
  erasedIds: string[]
}

export type Annotation =
  | RectAnnotation
  | EllipseAnnotation
  | ArrowAnnotation
  | LineAnnotation
  | PenAnnotation
  | TextAnnotation
  | SerialNumberAnnotation
  | DiamondAnnotation
  | BlurAnnotation
  | BlurFreeDrawAnnotation
  | HighlightAnnotation
  | WatermarkAnnotation

/** 选区样式常量（参考 Snow-Shot） */
export const SELECTION_STYLE = {
  /** 选区边框颜色 */
  borderColor: '#4096ff',
  /** 选区边框宽度 */
  borderWidth: 2,
  /** 遮罩透明度 */
  maskAlpha: 0.5,
  /** 控制点半径 */
  controlPointRadius: 4,
  /** 控制点填充色 */
  controlPointFill: '#ffffff',
  /** 控制点描边色 */
  controlPointStroke: '#4096ff',
  /** 控制点描边宽度 */
  controlPointStrokeWidth: 1.5,
  /** 角点显示阈值 */
  cornerShowThreshold: 32,
  /** 边中点显示阈值 */
  midPointShowThreshold: 64,
  /** 边缘检测容差 */
  edgeDetectTolerance: 8,
  /** 十字辅助线颜色 */
  crosshairColor: 'rgba(64, 150, 255, 0.6)',
  /** 十字辅助线虚线 */
  crosshairDash: [10, 3],
  /** 十字辅助线宽度 */
  crosshairWidth: 1,
  /** 尺寸标签背景色 */
  sizeLabelBg: 'rgba(0, 0, 0, 0.7)',
  /** 尺寸标签文字色 */
  sizeLabelColor: '#ffffff',
  /** 尺寸标签字号 */
  sizeLabelFontSize: 12,
} as const

/** 默认描边颜色 */
export const STROKE_COLORS = ['#1e1e1e', '#f5222d', '#52c41a', '#1677ff', '#faad14']

/** 默认填充颜色 */
export const FILL_COLORS = ['transparent', '#ffccc7', '#d9f7be', '#bae0ff', '#fff1b8']

/** 默认线宽预设 */
export const STROKE_WIDTH_PRESETS = [1, 2, 4]

/** 默认字号预设 */
export const FONT_SIZE_PRESETS = [16, 20, 28, 36]

/** 文本背景色预设 */
export const TEXT_BG_COLORS = ['transparent', '#ffccc7', '#d9f7be', '#bae0ff', '#fff1b8']

/** 文本描边色预设 */
export const TEXT_STROKE_COLORS = ['transparent', '#1e1e1e', '#f5222d', '#1677ff', '#ffffff']

/** 字体预设（手写、正常、代码，参考 Snow-Shot/Excalidraw） */
export const FONT_FAMILIES = [
  { label: 'A', value: "'Segoe Script', 'Comic Sans MS', cursive", icon: 'handwriting' },
  { label: 'A', value: "'Segoe UI', 'Microsoft YaHei', sans-serif", icon: 'normal' },
  { label: 'A', value: "'Cascadia Code', 'Consolas', monospace", icon: 'code' },
] as const

/** 字号标签预设（S/M/L/XL） */
export const FONT_SIZE_LABELS = [
  { label: 'S', value: 16 },
  { label: 'M', value: 20 },
  { label: 'L', value: 28 },
  { label: 'XL', value: 36 },
] as const

/** 文本对齐预设 */
export const TEXT_ALIGNS = ['left', 'center', 'right'] as const

/** 边框样式预设 */
export const BORDER_STYLES: BorderStyle[] = ['solid', 'dashed', 'dotted']

/** 线条风格预设 */
export const LINE_STYLES: LineStyle[] = ['sharp', 'curve', 'thick']

/** 箭头类型预设 */
export const ARROW_TYPES: ArrowType[] = ['thin', 'normal', 'block']

/** 端点样式预设 */
export const ENDPOINT_STYLES: EndpointStyle[] = ['none', 'arrow']

/** 画笔样式预设 */
export const PEN_STYLES: PenStyle[] = ['round', 'chisel']

/** 边角样式预设 */
export const CORNER_STYLES: CornerStyle[] = ['sharp', 'round']

/** 颜色格式 */
export enum ColorFormat {
  HEX = 'hex',
  RGB = 'rgb',
  HSL = 'hsl',
}

/** 取色器样式常量（参考 Snow-Shot） */
export const COLOR_PICKER_STYLE = {
  /** 像素网格大小（奇数，中心像素在正中间） */
  gridSize: 11,
  /** 放大倍数 */
  zoom: 12,
  /** 显示尺寸 = gridSize × zoom = 132 */
  canvasSize: 132,
  /** 圆角 */
  borderRadius: 8,
  /** 背景色 */
  bgColor: 'rgba(30, 30, 30, 0.9)',
  /** 中心像素边框宽度 */
  centerBorderWidth: 1,
  /** 十字辅助线颜色 */
  crosshairColor: 'rgba(255,255,255,0.4)',
  /** 颜色值标签字号 */
  labelFontSize: 12,
  /** 颜色值标签高度 */
  labelHeight: 24,
  /** 坐标标签高度 */
  posLabelHeight: 18,
  /** 放大镜与鼠标的偏移 */
  offsetX: 20,
  offsetY: 20,
} as const
