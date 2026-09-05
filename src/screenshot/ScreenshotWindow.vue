<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, nextTick, computed } from 'vue'
import { PixelSnap } from './pixelSnap'
import { translateBlocks } from '@/lib/translateChain'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { save } from '@tauri-apps/plugin-dialog'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit as tauriEmit, listen } from '@tauri-apps/api/event'
import { LazyStore } from '@tauri-apps/plugin-store'
import { SelectionManager } from './selection'
import { AnnotationManager } from './annotations'
import { WindowSnapManager } from './windowSnap'
import { SelectState, DrawTool, STROKE_COLORS, FILL_COLORS, STROKE_WIDTH_PRESETS, FONT_SIZE_PRESETS, TEXT_BG_COLORS, TEXT_STROKE_COLORS, FONT_FAMILIES, FONT_SIZE_LABELS, TEXT_ALIGNS, BORDER_STYLES, LINE_STYLES, ARROW_TYPES, PEN_STYLES, CORNER_STYLES, setSelectionLook } from './types'
import type { Annotation, BorderStyle, LineStyle, ArrowType, EndpointStyle, PenStyle, CornerStyle } from './types'
import { useI18n, applySavedLocale } from '@/i18n'

const { t } = useI18n()

const canvasRef = ref<HTMLCanvasElement>()
const overlayRef = ref<HTMLCanvasElement>()
const annCanvasRef = ref<HTMLCanvasElement>()
const containerRef = ref<HTMLDivElement>()

// 工具栏
const showToolbar = ref(false)
const toolbarX = ref(0)
const toolbarY = ref(0)

// 工具选项面板
const showOptions = ref(false)

// 状态
const capturing = ref(false)
let imgWidth = 0
let imgHeight = 0
let scaleFactor = window.devicePixelRatio
/* 这块显示器在虚拟桌面里的原点。录屏要把选区换算回屏幕绝对坐标，靠它 */
let monitorX = 0
let monitorY = 0

const appWindow = getCurrentWindow()

// 管理器
let selMgr: SelectionManager | null = null
const annMgr = reactive(new AnnotationManager())
const windowSnapMgr = new WindowSnapManager()
const pixelSnap = new PixelSnap()

// 设置 store（截图开关 + 背景投影设置）
const settingsStore = new LazyStore('settings.json')

// 当前工具
const currentTool = ref(DrawTool.None)
const currentStrokeColor = ref(STROKE_COLORS[1])
const currentStrokeWidth = ref(STROKE_WIDTH_PRESETS[1])
const currentFillColor = ref('transparent')
const currentFontSize = ref(FONT_SIZE_PRESETS[1])

// 文字工具专用状态
const textBgColor = ref('transparent')
const textStrokeColor = ref('transparent')
const textStrokeWidth = ref(2)
const textFontFamily = ref("'Segoe UI', 'Microsoft YaHei', sans-serif")
const textAlignVal = ref<'left' | 'center' | 'right'>('left')
const textOpacity = ref(1)

// 通用样式状态
const opacity = ref(1)
const borderStyle = ref<BorderStyle>('solid')
const lineStyle = ref<LineStyle>('sharp')
const cornerStyle = ref<CornerStyle>('sharp')
const borderRadius = ref(8)
const arrowType = ref<ArrowType>('normal')
const startEndpoint = ref<EndpointStyle>('none')
const endEndpoint = ref<EndpointStyle>('arrow')
const penStyle = ref<PenStyle>('round')
const blurRadius = ref(10)
const blurLineWidth = ref(20)

// 水印工具专用状态
const watermarkText = ref('WATERMARK')
const watermarkFontSize = ref(24)
const watermarkOpacity = ref(0.15)
const watermarkFontFamily = ref('sans-serif')

// 文字面板定位（紧挨选区右侧）
const textPanelRef = ref<HTMLDivElement>()
const panelTransX = ref(0)
const panelTransY = ref(0)
const panelBaseX = ref(0)
const panelBaseY = ref(0)
let _panelDragging = false
let _panelMouseStartX = 0
let _panelMouseStartY = 0
let _panelTransStartX = 0
let _panelTransStartY = 0

/** 更新面板基准位置：紧挨选区右侧，垂直居中 */
function updatePanelBasePosition() {
  if (!selMgr) return
  const r = selMgr.rect
  const panelW = 210
  const panelH = 380 // 面板大约高度
  const gap = 12
  const screenW = imgWidth / scaleFactor
  const screenH = imgHeight / scaleFactor

  // 优先放在选区右侧
  let px = r.x + r.w + gap
  // 如果右侧空间不够，放左侧
  if (px + panelW > screenW - 8) {
    px = r.x - panelW - gap
  }
  // 如果左侧也不够，放右边贴边
  if (px < 8) {
    px = screenW - panelW - 8
  }

  // 垂直：跟选区中心对齐
  let py = r.y + (r.h - panelH) / 2
  // 限制在屏幕内
  py = Math.max(8, Math.min(py, screenH - panelH - 8))

  panelBaseX.value = px
  panelBaseY.value = py
}

function onPanelDragStart(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  _panelDragging = true
  _panelMouseStartX = e.clientX
  _panelMouseStartY = e.clientY
  _panelTransStartX = panelTransX.value
  _panelTransStartY = panelTransY.value
  document.addEventListener('mousemove', onPanelDragMove)
  document.addEventListener('mouseup', onPanelDragEnd)
}

function onPanelDragMove(e: MouseEvent) {
  if (!_panelDragging) return
  panelTransX.value = _panelTransStartX + (e.clientX - _panelMouseStartX)
  panelTransY.value = _panelTransStartY + (e.clientY - _panelMouseStartY)
}

function onPanelDragEnd() {
  _panelDragging = false
  document.removeEventListener('mousemove', onPanelDragMove)
  document.removeEventListener('mouseup', onPanelDragEnd)
}

/*
  工具栏也能拖。它默认贴在选区右下角,选区一大就可能压在你要标注的地方,
  或者跑到屏幕边上把按钮挤没了 —— 抓着左端那个六点图标挪开就行。
  拖过之后位置就归用户;再次改选区时自动定位会重新接管。
*/
let _tbDragging = false
let _tbMouseStartX = 0, _tbMouseStartY = 0, _tbStartX = 0, _tbStartY = 0

function onToolbarDragStart(e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  _tbDragging = true
  _tbMouseStartX = e.clientX
  _tbMouseStartY = e.clientY
  _tbStartX = toolbarX.value
  _tbStartY = toolbarY.value
  document.addEventListener('mousemove', onToolbarDragMove)
  document.addEventListener('mouseup', onToolbarDragEnd)
}

function onToolbarDragMove(e: MouseEvent) {
  if (!_tbDragging) return
  // 别拖出屏幕:留 4px 边,和自动定位用的一样
  const w = document.querySelector<HTMLElement>('.toolbar')?.offsetWidth ?? 0
  toolbarX.value = Math.max(4, Math.min(_tbStartX + (e.clientX - _tbMouseStartX), window.innerWidth - w - 4))
  toolbarY.value = Math.max(4, Math.min(_tbStartY + (e.clientY - _tbMouseStartY), window.innerHeight - 44))
}

function onToolbarDragEnd() {
  _tbDragging = false
  document.removeEventListener('mousemove', onToolbarDragMove)
  document.removeEventListener('mouseup', onToolbarDragEnd)
}

// 内联文字编辑器
const showTextEditor = ref(false)
const textEditorX = ref(0)
const textEditorY = ref(0)
const textEditorValue = ref('')
const textEditorRef = ref<HTMLTextAreaElement>()

function openTextEditor(absX: number, absY: number) {
  if (!selMgr) return
  // absX/absY 已经是绝对 CSS 坐标（仿 Snow-Shot 绝对坐标系）
  textEditorX.value = absX
  textEditorY.value = absY
  textEditorValue.value = ''
  showTextEditor.value = true
  nextTick(() => {
    textEditorRef.value?.focus()
    autoResizeTextEditor()
  })
}

function commitTextEditor() {
  annMgr.textPreview = null
  if (textEditorValue.value.trim() && selMgr) {
    // 绝对坐标系：直接用编辑器位置作为标注坐标
    annMgr.commitText(textEditorX.value, textEditorY.value, textEditorValue.value)
  }
  showTextEditor.value = false
  textEditorValue.value = ''
  redraw()
}

function cancelTextEditor() {
  showTextEditor.value = false
  textEditorValue.value = ''
  annMgr.textPreview = null
  redraw()
}

/** 更新文字实时预览（在 Canvas 上绘制编辑中的文本） */
function updateTextPreview() {
  if (!showTextEditor.value || !selMgr) {
    annMgr.textPreview = null
    return
  }
  const text = textEditorValue.value
  if (!text) {
    annMgr.textPreview = null
    redraw()
    return
  }
  // 绝对坐标系：直接使用编辑器位置
  annMgr.textPreview = {
    id: '_preview',
    tool: DrawTool.Text,
    strokeColor: currentStrokeColor.value,
    strokeWidth: currentStrokeWidth.value,
    fillColor: currentFillColor.value,
    x: textEditorX.value,
    y: textEditorY.value,
    text,
    fontSize: currentFontSize.value,
    bgColor: textBgColor.value,
    textStrokeColor: textStrokeColor.value,
    textStrokeWidth: textStrokeWidth.value,
    fontFamily: textFontFamily.value,
    textAlign: textAlignVal.value,
    opacity: textOpacity.value,
  }
  redraw()
}

/** 自动调整 textarea 尺寸（根据内容） */
function autoResizeTextEditor() {
  const el = textEditorRef.value
  if (!el) return
  // 用一个临时 span 测量文字宽度
  const text = el.value || el.placeholder || ''
  const lines = text.split('\n')
  const style = getComputedStyle(el)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = style.font
  let maxW = 0
  for (const line of lines) {
    const w = ctx.measureText(line || ' ').width
    if (w > maxW) maxW = w
  }
  // 加 padding + 光标宽度
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
  const lineH = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3
  el.style.width = Math.max(20, maxW + 8) + padX + 'px'
  el.style.height = Math.max(lineH, lineH * lines.length) + padY + 'px'
}

function onTextEditorKeyDown(e: KeyboardEvent) {
  e.stopPropagation() // 阻止截图快捷键
  if (e.key === 'Escape') {
    cancelTextEditor()
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    commitTextEditor()
  }
  // Shift+Enter 允许换行
}

// 面板 mousedown：编辑器打开时阻止默认行为（防止 textarea 失焦）
function onPanelMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  // slider 需要默认行为才能拖动，不阻止
  if (target.tagName === 'INPUT') return
  // 拖拽手柄有自己的 handler，也不阻止（它自己会 preventDefault）
  if (target.closest('.panel-drag-handle')) return
  // 编辑器打开时阻止默认行为，防止 textarea 失焦
  if (showTextEditor.value) {
    e.preventDefault()
  }
}

// 智能 blur 处理：点击文字面板/工具栏时不提交，而是重新聚焦
function onTextEditorBlur(e: FocusEvent) {
  const related = e.relatedTarget as HTMLElement | null
  // 如果焦点移到了文字面板或工具栏内，不提交
  if (related) {
    if (textPanelRef.value?.contains(related)) {
      nextTick(() => textEditorRef.value?.focus())
      return
    }
    // 检查是否点了工具栏（toolbar 区域）
    const toolbar = related.closest?.('.toolbar')
    if (toolbar) {
      nextTick(() => textEditorRef.value?.focus())
      return
    }
  }
  // 用 setTimeout 处理 relatedTarget 为 null 的情况（某些按钮不获取焦点）
  setTimeout(() => {
    if (!showTextEditor.value) return
    // 检查当前焦点是否在面板或工具栏内
    const active = document.activeElement as HTMLElement | null
    if (active && textPanelRef.value?.contains(active)) {
      textEditorRef.value?.focus()
      return
    }
    if (active?.closest?.('.toolbar')) {
      textEditorRef.value?.focus()
      return
    }
    commitTextEditor()
  }, 50)
}

function setTextStrokeColor(c: string) {
  textStrokeColor.value = c
  syncToolState()
}

// 同步工具状态到标注管理器（同时更新选中标注）
function syncToolState() {
  annMgr.currentTool = currentTool.value
  annMgr.strokeColor = currentStrokeColor.value
  annMgr.strokeWidth = currentStrokeWidth.value
  annMgr.fillColor = currentFillColor.value
  annMgr.fontSize = currentFontSize.value
  annMgr.textBgColor = textBgColor.value
  annMgr.textStrokeColor = textStrokeColor.value
  annMgr.textStrokeWidth = textStrokeWidth.value
  annMgr.fontFamily = textFontFamily.value
  annMgr.textAlign = textAlignVal.value
  annMgr.textOpacity = textOpacity.value
  // 通用样式
  annMgr.opacity = opacity.value
  annMgr.borderStyle = borderStyle.value
  annMgr.lineStyle = lineStyle.value
  annMgr.cornerStyle = cornerStyle.value
  annMgr.borderRadius = borderRadius.value
  annMgr.arrowType = arrowType.value
  annMgr.startEndpoint = startEndpoint.value
  annMgr.endEndpoint = endEndpoint.value
  annMgr.penStyle = penStyle.value
  annMgr.blurRadius = blurRadius.value
  annMgr.blurLineWidth = blurLineWidth.value
  annMgr.watermarkText = watermarkText.value
  annMgr.watermarkFontSize = watermarkFontSize.value
  annMgr.watermarkOpacity = watermarkOpacity.value
  annMgr.watermarkFontFamily = watermarkFontFamily.value
  // 编辑器打开时同步调整尺寸和预览
  if (showTextEditor.value) {
    nextTick(() => {
      autoResizeTextEditor()
      updateTextPreview()
    })
  }
  // 如果有选中的标注，把面板值同步到标注上
  applyPanelToSelected()
}

/** 将选中标注的属性回填到面板 */
function loadAnnotationToPanel(ann: Annotation) {
  // 通用属性
  currentStrokeColor.value = ann.strokeColor
  currentStrokeWidth.value = ann.strokeWidth
  currentFillColor.value = ann.fillColor
  opacity.value = ann.opacity ?? 1
  borderStyle.value = ann.borderStyle ?? 'solid'
  lineStyle.value = ann.lineStyle ?? 'sharp'

  // 按类型回填专属属性
  switch (ann.tool) {
    case DrawTool.Rect:
      cornerStyle.value = ann.cornerStyle ?? 'sharp'
      borderRadius.value = ann.borderRadius ?? 8
      break
    case DrawTool.Arrow:
      arrowType.value = ann.arrowType ?? 'normal'
      startEndpoint.value = ann.startEndpoint ?? 'none'
      endEndpoint.value = ann.endEndpoint ?? 'arrow'
      break
    case DrawTool.Line:
      startEndpoint.value = ann.startEndpoint ?? 'none'
      endEndpoint.value = ann.endEndpoint ?? 'arrow'
      break
    case DrawTool.Pen:
      penStyle.value = ann.penStyle ?? 'round'
      break
    case DrawTool.Text:
      currentFontSize.value = ann.fontSize
      textBgColor.value = ann.bgColor
      textStrokeColor.value = ann.textStrokeColor
      textStrokeWidth.value = ann.textStrokeWidth
      textFontFamily.value = ann.fontFamily
      textAlignVal.value = ann.textAlign
      textOpacity.value = ann.opacity
      break
    case DrawTool.Blur:
      blurRadius.value = ann.blurRadius
      break
    case DrawTool.BlurFreeDraw:
      blurRadius.value = ann.blurRadius
      blurLineWidth.value = ann.lineWidth
      break
    case DrawTool.Watermark:
      watermarkText.value = ann.text
      watermarkFontSize.value = ann.fontSize
      watermarkOpacity.value = ann.opacity
      watermarkFontFamily.value = ann.fontFamily
      break
  }
}

/** 将面板当前值应用到选中的标注 */
function applyPanelToSelected() {
  const sel = annMgr.getSelected()
  if (!sel) return

  // 通用属性
  const base: Partial<Annotation> = {
    strokeColor: currentStrokeColor.value,
    strokeWidth: currentStrokeWidth.value,
    fillColor: currentFillColor.value,
    opacity: opacity.value,
    borderStyle: borderStyle.value,
    lineStyle: lineStyle.value,
  }

  // 按类型追加专属属性
  switch (sel.tool) {
    case DrawTool.Rect:
      Object.assign(base, { cornerStyle: cornerStyle.value, borderRadius: borderRadius.value })
      break
    case DrawTool.Arrow:
      Object.assign(base, { arrowType: arrowType.value, startEndpoint: startEndpoint.value, endEndpoint: endEndpoint.value })
      break
    case DrawTool.Line:
      Object.assign(base, { startEndpoint: startEndpoint.value, endEndpoint: endEndpoint.value })
      break
    case DrawTool.Pen:
      Object.assign(base, { penStyle: penStyle.value })
      break
    case DrawTool.Text:
      Object.assign(base, {
        fontSize: currentFontSize.value,
        bgColor: textBgColor.value,
        textStrokeColor: textStrokeColor.value,
        textStrokeWidth: textStrokeWidth.value,
        fontFamily: textFontFamily.value,
        textAlign: textAlignVal.value,
        opacity: textOpacity.value,
      })
      break
    case DrawTool.Blur:
      Object.assign(base, { blurRadius: blurRadius.value })
      break
    case DrawTool.BlurFreeDraw:
      Object.assign(base, { blurRadius: blurRadius.value, lineWidth: blurLineWidth.value })
      break
    case DrawTool.Highlight:
      Object.assign(base, { lineWidth: currentStrokeWidth.value * 6 })
      break
    case DrawTool.Watermark:
      Object.assign(base, {
        text: watermarkText.value, fontSize: watermarkFontSize.value,
        opacity: watermarkOpacity.value, fontFamily: watermarkFontFamily.value,
      })
      break
  }

  annMgr.updateSelectedStyle(base)
  redraw()
}

// 需要独立浮动面板的工具
const toolsWithPanel = new Set([
  DrawTool.Rect, DrawTool.Diamond, DrawTool.Ellipse,
  DrawTool.Arrow, DrawTool.Line,
  DrawTool.Pen, DrawTool.Highlight,
  DrawTool.Text,
  DrawTool.Blur, DrawTool.BlurFreeDraw,
  DrawTool.Watermark,
])

function setTool(tool: DrawTool) {
  openGroup.value = null
  currentTool.value = currentTool.value === tool ? DrawTool.None : tool
  showOptions.value = currentTool.value !== DrawTool.None
  // 切换工具时取消标注选中
  annMgr.deselect()
  // 切换工具时重置面板拖拽偏移并重新计算基准位置
  panelTransX.value = 0
  panelTransY.value = 0
  if (toolsWithPanel.has(currentTool.value)) {
    updatePanelBasePosition()
  }
  syncToolState()
}

// 当前工具是否显示独立浮动面板（绘制工具 or 选中已有标注时）
const showFloatingPanel = computed(() => {
  if (toolsWithPanel.has(currentTool.value) && showOptions.value) return true
  // 选中已有标注时也显示面板
  const sel = annMgr.getSelected()
  return sel !== null && toolsWithPanel.has(sel.tool)
})

// 当前生效的工具类型（当前工具 or 选中标注的工具）
const effectiveTool = computed(() => {
  if (currentTool.value !== DrawTool.None) return currentTool.value
  const sel = annMgr.getSelected()
  return sel ? sel.tool : DrawTool.None
})

// 是否是几何形状工具
const isShapeTool = computed(() => {
  const t = effectiveTool.value
  return t === DrawTool.Rect || t === DrawTool.Diamond || t === DrawTool.Ellipse
})

// 是否是线条类工具（箭头/直线）
const isLineTool = computed(() => {
  const t = effectiveTool.value
  return t === DrawTool.Arrow || t === DrawTool.Line
})

// 是否是画笔类工具
const isPenTool = computed(() => {
  const t = effectiveTool.value
  return t === DrawTool.Pen || t === DrawTool.Highlight
})


function initSelectionManager() {
  if (!overlayRef.value) return
  selMgr = new SelectionManager(overlayRef.value)
  selMgr.onStateChange = (state) => {
    if (state === SelectState.Selected) {
      if (translateMode.value) {
        // 截图翻译模式：选区完成后直接触发翻译，不显示工具栏
        runScreenshotTranslate()
      } else if (recordMode.value) {
        // 录屏：只出一条「开始录制」，没有标注工具
        showToolbar.value = true
        nextTick(() => updateToolbarPosition())
      } else {
        showToolbar.value = true
        // 等 DOM 渲染后再定位，确保能取到真实宽度
        nextTick(() => updateToolbarPosition())
      }
    } else if (state === SelectState.Idle) {
      showToolbar.value = false
      currentTool.value = DrawTool.None
      showOptions.value = false
      cancelTextEditor()
      annMgr.reset()
    }
  }
  // 绑定内联文字编辑回调
  annMgr.onRequestTextInput = openTextEditor
}

/** 仿 Snow-Shot: 工具栏优先选区下方右对齐 → 超出时上方 → 都不行 clamp 到屏幕内 */
function updateToolbarPosition() {
  if (!selMgr) return
  const r = selMgr.rect
  const toolbarH = 40
  const gap = 8
  const screenH = imgHeight / scaleFactor
  const screenW = imgWidth / scaleFactor

  // 工具栏宽度，取 DOM 实际宽度（fallback 用较大值保证不截断）
  const toolbarEl = document.querySelector('.toolbar') as HTMLElement | null
  const toolbarW = toolbarEl ? toolbarEl.offsetWidth : 700

  // 水平定位：选区右对齐（仿 Snow-Shot: max_x - toolbarWidth）
  let tx = r.x + r.w - toolbarW
  tx = Math.max(4, Math.min(tx, screenW - toolbarW - 4))

  // 垂直定位：优先选区下方
  let ty = r.y + r.h + gap
  if (ty + toolbarH > screenH) {
    // 下方放不下，改为选区上方
    ty = r.y - toolbarH - gap
    if (ty < 0) {
      // 上方也放不下，放在选区内部底部
      ty = r.y + r.h - toolbarH - gap
      ty = Math.max(0, ty)
    }
  }

  toolbarX.value = tx
  toolbarY.value = ty
}

// ============ 绘制 ============

function redraw() {
  selMgr?.draw()
  drawAnnotations()
}

function drawAnnotations() {
  const canvas = annCanvasRef.value
  if (!canvas || !selMgr) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const r = selMgr.rect
  if (r.w < 1 || r.h < 1) return

  ctx.save()
  // 仿 Snow-Shot: clip 到选区范围，但不做 translate
  // 标注使用绝对坐标（相对整个截图），选区移动时标注不跟着动
  const sf = scaleFactor
  ctx.beginPath()
  ctx.rect(r.x * sf, r.y * sf, r.w * sf, r.h * sf)
  ctx.clip()
  annMgr.drawAll(ctx, sf)
  ctx.restore()
}

// ============ 窗口圆角裁剪 ============

/** 如果是窗口吸附且有圆角，用 roundRect clip 裁剪，圆角外变透明 */
function applyCornerRadiusClip(srcCanvas: HTMLCanvasElement, cornerRadius: number, sf: number): HTMLCanvasElement {
  if (cornerRadius <= 0) return srcCanvas

  const cr = Math.round(cornerRadius * sf)
  const w = srcCanvas.width
  const h = srcCanvas.height

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!

  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, cr)
  ctx.clip()
  ctx.drawImage(srcCanvas, 0, 0)

  return out
}

// ============ 背景投影处理 ============

/** 如果开启了"自动添加背景与投影"，将截图画布包裹进带背景、圆角、多层阴影的新画布 */
async function applyBgShadowIfEnabled(srcCanvas: HTMLCanvasElement, snapCornerRadius = 0): Promise<HTMLCanvasElement> {
  // 背景开关(见 bgOn):它就是设置里那一项,工具条上按一下等于把设置改了
  if (!bgOn.value) return srcCanvas

  const bgColor = (await settingsStore.get<string>('screenshot_bg_color')) ?? 'transparent'
  const padding = (await settingsStore.get<number>('screenshot_bg_padding')) ?? 32
  const shadowBlurVal = (await settingsStore.get<number>('screenshot_shadow_blur')) ?? 30
  const radius = (await settingsStore.get<number>('screenshot_corner_radius')) ?? 8

  const sw = srcCanvas.width
  const sh = srcCanvas.height
  const sf = scaleFactor
  const pad = Math.round(padding * sf)
  const blur = Math.round(shadowBlurVal * sf)
  const r = Math.round(radius * sf)
  // 内容圆角：取设置圆角和窗口吸附圆角的最大值，确保与输入 canvas 的实际圆角匹配
  const snapCR = Math.round(snapCornerRadius * sf)
  const innerR = Math.max(r, snapCR)

  // 最终画布 = 背景面板（padding + 内容），无额外边距
  const totalW = sw + pad * 2
  const totalH = sh + pad * 2

  // 截图内容在面板中的位置
  const imgX = pad
  const imgY = pad

  // 1. 在离屏大画布上画内容阴影（阴影围绕内容区域，投影到背景面板上）
  //    离屏画布需要额外空间容纳阴影扩散
  const maxSpread = Math.round(blur * 2 * 1.5 + blur * 0.8)
  const extra = Math.max(maxSpread, blur)
  const offW = totalW + extra * 2
  const offH = totalH + extra * 2

  const shadowCanvas = document.createElement('canvas')
  shadowCanvas.width = offW
  shadowCanvas.height = offH
  const sctx = shadowCanvas.getContext('2d')!

  // 内容区域在离屏画布中的位置
  const offImgX = extra + imgX
  const offImgY = extra + imgY

  // 三层阴影参数: [blur倍率, offsetY倍率, opacity]
  const shadowLayers: [number, number, number][] = [
    [0.3, 0.08, 0.18],   // 近处：小模糊、紧贴，较浓
    [0.8, 0.3,  0.14],   // 中层：中等模糊与偏移
    [2.0, 0.8,  0.10],   // 远处：大模糊、大偏移，较淡
  ]

  for (const [blurMul, offsetMul, alpha] of shadowLayers) {
    sctx.save()
    sctx.shadowColor = `rgba(0,0,0,${alpha})`
    sctx.shadowBlur = blur * blurMul
    sctx.shadowOffsetX = 0
    sctx.shadowOffsetY = blur * offsetMul
    sctx.beginPath()
    sctx.roundRect(offImgX, offImgY, sw, sh, innerR)
    sctx.fillStyle = '#000'
    sctx.fill()
    sctx.restore()
  }

  // 擦掉黑色填充块，只留阴影（扩大 1px 避免亚像素残留黑线）
  sctx.save()
  sctx.globalCompositeOperation = 'destination-out'
  sctx.beginPath()
  sctx.roundRect(offImgX - 1, offImgY - 1, sw + 2, sh + 2, innerR)
  sctx.fill()
  sctx.restore()

  // 2. 组合到最终画布（裁剪掉离屏画布的 extra 边距）
  const out = document.createElement('canvas')
  out.width = totalW
  out.height = totalH
  const ctx = out.getContext('2d')!

  // 背景色填充（带圆角）— 先画背景再画阴影，阴影投在背景上
  if (bgColor !== 'transparent') {
    ctx.beginPath()
    ctx.roundRect(0, 0, totalW, totalH, r)
    ctx.fillStyle = bgColor
    ctx.fill()
  }

  // 将阴影层裁剪到面板范围内绘制（阴影投射在背景面板上，不溢出）
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(0, 0, totalW, totalH, r)
  ctx.clip()
  ctx.drawImage(shadowCanvas, -extra, -extra)
  ctx.restore()

  // 绘制截图内容（圆角裁剪）
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(imgX, imgY, sw, sh, innerR)
  ctx.clip()
  ctx.drawImage(srcCanvas, imgX, imgY)
  ctx.restore()

  return out
}

// ============ 完成截图 → 复制到剪贴板 ============

async function copyToClipboard() {
  /*
    文字还在编辑框里就先落下去。
    编辑框开着的时候焦点未必在 textarea 上(点过面板里的滑块/按钮之后就不在了),
    这时按回车走的是这里而不是编辑器自己的回车 —— 结果是截图里带着一个虚线编辑框。
    正确的手感是 截图 → 打字 → 回车,一步到位,不用先点一下别处。
  */
  if (showTextEditor.value) commitTextEditor()
  const bgCanvas = canvasRef.value
  if (!selMgr || !bgCanvas) return

  const r = selMgr.rect
  if (r.w < 2 || r.h < 2) return

  const sf = scaleFactor
  // 窗口吸附时内缩 1 物理像素，去掉 DWM 边框/阴影残留
  const inset = selMgr.isSnapped ? 1 : 0
  const cropCanvas = document.createElement('canvas')
  const psx = Math.round(r.x * sf) + inset
  const psy = Math.round(r.y * sf) + inset
  const psw = Math.round(r.w * sf) - inset * 2
  const psh = Math.round(r.h * sf) - inset * 2
  cropCanvas.width = psw
  cropCanvas.height = psh
  const cropCtx = cropCanvas.getContext('2d')!

  // 绘制背景截图
  cropCtx.drawImage(bgCanvas, psx, psy, psw, psh, 0, 0, psw, psh)

  // 绘制标注层
  cropCtx.save()
  cropCtx.translate(-psx, -psy)
  // 出图不要选中框:那圈虚线和把手是操作提示,不是标注
  annMgr.drawAll(cropCtx, sf, false)
  cropCtx.restore()

  // 窗口圆角裁剪
  const croppedCanvas = applyCornerRadiusClip(cropCanvas, selMgr.snapCornerRadius, sf)

  // 背景投影处理
  const finalCanvas = await applyBgShadowIfEnabled(croppedCanvas, selMgr.snapCornerRadius)
  const fw = finalCanvas.width
  const fh = finalCanvas.height

  // 仿 Snow-Shot：先视觉隐藏（opacity=0），但窗口仍在，保证 IPC 可用
  if (containerRef.value) {
    containerRef.value.style.opacity = '0'
  }
  await appWindow.setIgnoreCursorEvents(true).catch(() => {})

  try {
    // 获取 RGBA 像素数据，用二进制 IPC 传输（不走 JSON 序列化）
    const finalCtx = finalCanvas.getContext('2d')!
    const imageData = finalCtx.getImageData(0, 0, fw, fh)
    // 构造二进制 buffer：[width:u32_le][height:u32_le][rgba_pixels...]
    const buf = new ArrayBuffer(8 + imageData.data.byteLength)
    const view = new DataView(buf)
    view.setUint32(0, fw, true)
    view.setUint32(4, fh, true)
    new Uint8Array(buf, 8).set(imageData.data)
    await invoke('copy_rgba_to_clipboard', buf)
  } catch (err) {
    console.error('Failed to copy to clipboard:', err)
  }

  // 剪贴板写入完成后再关窗口
  cancelCapture()
}

// ============ 保存到文件 ============

async function saveToFile(fast = false) {
  /*
    文字还在编辑框里就先落下去。
    编辑框开着的时候焦点未必在 textarea 上(点过面板里的滑块/按钮之后就不在了),
    这时按回车走的是这里而不是编辑器自己的回车 —— 结果是截图里带着一个虚线编辑框。
    正确的手感是 截图 → 打字 → 回车,一步到位,不用先点一下别处。
  */
  if (showTextEditor.value) commitTextEditor()
  const bgCanvas = canvasRef.value
  if (!selMgr || !bgCanvas) return

  const r = selMgr.rect
  if (r.w < 2 || r.h < 2) return

  const sf = scaleFactor
  // 窗口吸附时内缩 1 物理像素，去掉 DWM 边框/阴影残留
  const inset = selMgr.isSnapped ? 1 : 0
  const cropCanvas = document.createElement('canvas')
  const psx = Math.round(r.x * sf) + inset
  const psy = Math.round(r.y * sf) + inset
  const psw = Math.round(r.w * sf) - inset * 2
  const psh = Math.round(r.h * sf) - inset * 2
  cropCanvas.width = psw
  cropCanvas.height = psh
  const cropCtx = cropCanvas.getContext('2d')!
  cropCtx.drawImage(bgCanvas, psx, psy, psw, psh, 0, 0, psw, psh)
  // 绝对坐标系：裁剪画布原点在选区左上角，需偏移
  cropCtx.save()
  cropCtx.translate(-psx, -psy)
  // 出图不要选中框:那圈虚线和把手是操作提示,不是标注
  annMgr.drawAll(cropCtx, sf, false)
  cropCtx.restore()

  // 窗口圆角裁剪
  const croppedCanvas = applyCornerRadiusClip(cropCanvas, selMgr.snapCornerRadius, sf)

  // 背景投影处理
  const finalCanvas = await applyBgShadowIfEnabled(croppedCanvas, selMgr.snapCornerRadius)

  // 转为 PNG blob
  const blob = await new Promise<Blob | null>(resolve => finalCanvas.toBlob(resolve, 'image/png'))
  if (!blob) return

  const arrayBuffer = await blob.arrayBuffer()
  const uint8 = new Uint8Array(arrayBuffer)

  if (fast) {
    // 快速保存：桌面/Screenshots/
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `screenshot_${timestamp}.png`
    try {
      await invoke('save_screenshot_file', { data: Array.from(uint8), filename })
    } catch (err) {
      console.error('Fast save failed:', err)
    }
  } else {
    // 对话框保存
    const filePath = await save({
      defaultPath: `screenshot_${Date.now()}.png`,
      filters: [{ name: 'PNG', extensions: ['png'] }, { name: 'WebP', extensions: ['webp'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }],
    })
    if (filePath) {
      try {
        await invoke('save_screenshot_to_path', { data: Array.from(uint8), path: filePath })
      } catch (err) {
        console.error('Save failed:', err)
      }
    }
  }

  cancelCapture()
}

// ============ 钉到屏幕 ============

let pinCounter = 0

async function pinToScreen() {
  const bgCanvas = canvasRef.value
  if (!selMgr || !bgCanvas) return

  const r = selMgr.rect
  if (r.w < 2 || r.h < 2) return

  const sf = scaleFactor
  const cropCanvas = document.createElement('canvas')
  const psw = Math.round(r.w * sf)
  const psh = Math.round(r.h * sf)
  cropCanvas.width = psw
  cropCanvas.height = psh
  const cropCtx = cropCanvas.getContext('2d')!
  const psx = Math.round(r.x * sf)
  const psy = Math.round(r.y * sf)
  cropCtx.drawImage(bgCanvas, psx, psy, psw, psh, 0, 0, psw, psh)
  // 绝对坐标系：裁剪画布原点在选区左上角，需偏移
  cropCtx.save()
  cropCtx.translate(-psx, -psy)
  // 出图不要选中框:那圈虚线和把手是操作提示,不是标注
  annMgr.drawAll(cropCtx, sf, false)
  cropCtx.restore()

  const dataUrl = cropCanvas.toDataURL('image/png')
  const label = `pin_${Date.now()}_${pinCounter++}`

  cancelCapture()

  // 创建钉图窗口：先监听 ready 信号，等 PinWindow mount 后再发送数据
  try {
    const unlistenReady = await listen<{ label: string }>('pin-ready', async (event) => {
      if (event.payload.label !== label) return
      unlistenReady()
      await tauriEmit(`pin-image-data:${label}`, {
        dataUrl,
        x: psx,
        y: psy,
        w: psw,
        h: psh,
      })
    })

    new WebviewWindow(label, {
      url: 'index.html',
      title: 'Pin',
      width: 1,
      height: 1,
      decorations: false,
      shadow: true,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      visible: false,
    })
  } catch (err) {
    console.error('Failed to create pin window:', err)
  }
}

// ============ 录屏 ============

/**
 * 开始录制。
 *
 * # 顺序是有讲究的：先让遮罩让开，再起 ffmpeg
 *
 * gdigrab 抓的是**桌面真实画面**，而遮罩上盖的是一张冻住的截图。
 * 先起 ffmpeg 再藏遮罩，开头那几帧录到的就是那张静止图。
 * 所以这里先 cancelCapture()（它会把窗口挪到屏外再隐藏），等一帧，才开录。
 */
async function startRecording() {
  if (!selMgr || selMgr.state !== SelectState.Selected) return
  // 从截图工具条点进来的，选区还是截图那套蓝；那圈框是琥珀色的，先对上
  recordMode.value = true
  setSelectionLook('record')
  const r = selMgr.rect
  const sf = scaleFactor

  /*
    给 ffmpeg 的是**屏幕绝对物理坐标**，不是窗口内部坐标。
    monX/monY 是这块显示器在虚拟桌面里的原点 —— 不加它，副屏上框的区域会录成主屏的。
  */
  const px = Math.round(r.x * sf) + monitorX
  const py = Math.round(r.y * sf) + monitorY
  const pw = Math.round(r.w * sf)
  const ph = Math.round(r.h * sf)
  if (pw < 16 || ph < 16) return

  const fps = ((await settingsStore.get<number>('record_fps')) ?? 30) as number
  const dir = ((await settingsStore.get<string>('record_dir')) ?? '') as string
  const audio = ((await settingsStore.get<boolean>('record_audio')) ?? true) as boolean
  const maxMinutes = ((await settingsStore.get<number>('record_max_min')) ?? 30) as number

  cancelCapture()
  // 等一帧，让遮罩真的从屏幕上下去了再开录
  await new Promise((res) => setTimeout(res, 120))

  const rect = { x: px, y: py, w: (pw >> 1) << 1, h: (ph >> 1) << 1 }

  /*
    **两个小窗口先摆好，再起 ffmpeg。**

    反过来的话，那圈框的开窗动画（Windows 默认是从中心放大）会有几帧画在选区
    里面，而 gdigrab 抓的就是选区 —— 成品视频开头就多一圈往外扩的边。
    动画本身没问题，只是不能让它落在录制开始之后。
  */
  await openRecorderWindows(rect)
  // 控制条上那个喇叭图标靠这个知道该不该亮
  await tauriEmit('rec-audio-mode', audio)

  try {
    await invoke<string>('start_recording', {
      x: rect.x, y: rect.y, width: rect.w, height: rect.h, fps, dir: dir || null, audio, maxMinutes,
    })
  } catch (e) {
    console.error('start_recording failed:', e)
    await tauriEmit('record-cancelled', {})
  }
}

/**
 * 开两个小窗：一圈琥珀色的框（鼠标穿透）+ 一条控制条。
 *
 * 都走「子窗先喊 ready、父边再发数据」这套握手 —— 和钉图窗口一样。
 * 不握手直接发的话，webview 还没 mount，那个事件就掉地上了：
 * 窗口建出来了、永远不显示。
 */
async function openRecorderWindows(rect: { x: number; y: number; w: number; h: number }) {
  /*
    先把上一轮留下的同名窗口拆掉。

    录完之后那条控制条不会自己关（要留着给「打开文件夹 / 转 GIF」），于是
    紧接着再录一段时，`new WebviewWindow('rec_bar')` 撞上已经存在的标签，
    **建不出来而且不报错** —— 屏幕上还是上一段的结果条，新这段既没有计时也没有
    停止按钮，只能去托盘里救。踩过一次。
  */
  for (const label of ['rec_frame', 'rec_bar']) {
    const old = await WebviewWindow.getByLabel(label)
    if (old) {
      await old.destroy().catch(() => {})
    }
  }

  const mk = async (label: string, readyEvent: string, initEvent: string, opts: Record<string, unknown>) => {
    const un = await listen(readyEvent, async () => {
      un()
      await tauriEmit(initEvent, rect)
    })
    new WebviewWindow(label, {
      url: 'index.html',
      title: 'XGTools Recorder',
      decorations: false,
      shadow: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      visible: false,
      width: 1,
      height: 1,
      ...opts,
    })
  }
  // 两个窗口各自贴好位置、show 完，才会发 *-shown。等齐了才算「摆好了」
  const shown = (ev: string) =>
    new Promise<void>((resolve) => {
      let done = false
      listen(ev, () => { if (!done) { done = true; resolve() } }).then((un) => {
        // 兜底：万一某个窗口没起来，别把开录整个卡死在这儿
        setTimeout(() => { if (!done) { done = true; resolve() } ; un() }, 2000)
      })
    })

  try {
    const waits = [shown('rec-frame-shown'), shown('rec-bar-shown')]
    await mk('rec_frame', 'rec-frame-ready', 'rec-frame-init', {})
    await mk('rec_bar', 'rec-bar-ready', 'rec-bar-init', {})
    await Promise.all(waits)
    // 关掉动画之后 DWM 还要一两帧才真正把窗口画上去
    await new Promise((res) => setTimeout(res, 80))
  } catch (err) {
    console.error('Failed to create recorder windows:', err)
  }
}

// ============ 长截图 ============

/**
 * 开始长截图。
 *
 * 和开录一样：**先让遮罩整个下去，再开始抓**。遮罩上盖的是一张冻住的截图，
 * 留着不动的话抓到的每一帧都一模一样 —— 拼接器只会说"没滚动"，一行都接不出来。
 */
async function startLongShot() {
  if (!selMgr || selMgr.state !== SelectState.Selected) return
  const r = selMgr.rect
  const sf = scaleFactor

  // 和录屏一样：给后端的是屏幕绝对物理坐标，副屏才不会抓错
  const px = Math.round(r.x * sf) + monitorX
  const py = Math.round(r.y * sf) + monitorY
  const pw = Math.round(r.w * sf)
  const ph = Math.round(r.h * sf)
  if (pw < 40 || ph < 80) return

  cancelCapture()
  await new Promise((res) => setTimeout(res, 120))

  const rect = { x: px, y: py, w: pw, h: ph }
  await openLongShotWindows(rect)

  try {
    await invoke('start_long_shot', { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
  } catch (e) {
    console.error('start_long_shot failed:', e)
    await tauriEmit('long-shot-cancelled', {})
  }
}

/**
 * 那圈框 + 那条控制条。
 *
 * 框复用录屏那个窗口（`rec_frame`）—— 两件事不可能同时进行，而它要干的活
 * 一模一样：在让开的遮罩原处标出"正在处理这一块"。颜色和关闭时机从 init 带过去。
 */
async function openLongShotWindows(rect: { x: number; y: number; w: number; h: number }) {
  // 上一轮留下的同名窗口先拆掉,不然 new WebviewWindow 撞标签,建不出来还不报错
  for (const label of ['rec_frame', 'ls_bar']) {
    const old = await WebviewWindow.getByLabel(label)
    if (old) await old.destroy().catch(() => {})
  }

  const mk = async (label: string, readyEvent: string, initEvent: string, payload: unknown) => {
    const un = await listen(readyEvent, async () => {
      un()
      await tauriEmit(initEvent, payload)
    })
    new WebviewWindow(label, {
      url: 'index.html',
      title: 'XGTools Long Shot',
      decorations: false,
      shadow: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      visible: false,
      width: 1,
      height: 1,
    })
  }

  const shown = (ev: string) =>
    new Promise<void>((resolve) => {
      let done = false
      listen(ev, () => { if (!done) { done = true; resolve() } }).then((un) => {
        // 兜底：某个窗口没起来也别把整件事卡死在这儿
        setTimeout(() => { if (!done) { done = true; resolve() } ; un() }, 2000)
      })
    })

  try {
    const waits = [shown('rec-frame-shown'), shown('ls-bar-shown')]
    await mk('rec_frame', 'rec-frame-ready', 'rec-frame-init', {
      ...rect,
      accent: '#2ec4b6',
      // 抓的时候画面一直在动,框再闪就吵
      breathe: false,
      closeOn: ['long-shot-ended', 'long-shot-cancelled'],
    })
    await mk('ls_bar', 'ls-bar-ready', 'ls-bar-init', rect)
    await Promise.all(waits)
    await new Promise((res) => setTimeout(res, 80))
  } catch (err) {
    console.error('Failed to create long-shot windows:', err)
  }
}

// ============ OCR ============

interface OcrTextBlock {
  box_points: { x: number; y: number }[]
  text: string
  text_score: number
}

const ocrResults = ref<OcrTextBlock[]>([])
const ocrLoading = ref(false)
/*
  这一次截图要不要加背景投影。

  开局取设置里的值,工具条上那个按钮只改它、**不写回设置** ——
  「这张图要不要背景」是每张图各自的事,为了一张图去设置页里翻一遍开关、
  截完还得记得改回来,那才是麻烦。
*/
/**
 * 要不要给截图加背景 / 圆角 / 阴影。
 *
 * 工具条上那颗按钮是**切换键**:按一下就记住,下一张截图接着用这个状态。
 * 以前是「只管这一次,下一张弹回设置里的默认」—— 想连着截十张带背景的图,
 * 就得按十次,每次都得先想起来它已经弹回去了。现在它和设置页那一项是同一个值,
 * 按钮改了设置也跟着改,不存在「界面上开着、设置里关着」这种对不上的状态。
 */
const bgOn = ref(false)

async function toggleBg() {
  bgOn.value = !bgOn.value
  try {
    await settingsStore.set('screenshot_auto_bg_shadow', bgOn.value)
    await settingsStore.save()
  } catch (e) {
    // 存不下就只在这一次生效,不值得为它打断截图
    console.error('[Screenshot] 背景开关存盘失败:', e)
  }
}

const ocrMode = ref(false)
let ocrInited = false

// ============ 截图翻译 ============

interface TranslateBlock {
  block: OcrTextBlock
  translated: string
}

const translateMode = ref(false)

/*
  录屏模式。框选那一步和截图完全一样 —— 同一套遮罩、同一个选区管理器、
  同一套窗口吸附和像素吸附。差别只在选完之后：截图出标注工具条，
  录屏出一个只有「开始录制」的短条。

  另开一套框选代码的话，吸附、放大镜、方向键微调这些干活都得再写一遍，
  而且两边迟早会不一样。
*/
const recordMode = ref(false)
const translateResults = ref<TranslateBlock[]>([])
const translateLoading = ref(false)

async function runOcr() {
  const bgCanvas = canvasRef.value
  if (!selMgr || !bgCanvas) return

  const r = selMgr.rect
  if (r.w < 2 || r.h < 2) return

  // 如果已有 OCR 结果，则关闭
  if (ocrMode.value) {
    ocrResults.value = []
    ocrMode.value = false
    return
  }

  ocrLoading.value = true
  console.log('[OCR] start, ocrInited:', ocrInited)

  try {
    // 初始化（首次）
    if (!ocrInited) {
      console.log('[OCR] calling ocr_init...')
      await invoke('ocr_init')
      ocrInited = true
      console.log('[OCR] ocr_init done')
    }

    // 获取选区图像数据
    const sf = scaleFactor
    const psx = Math.round(r.x * sf)
    const psy = Math.round(r.y * sf)
    const psw = Math.round(r.w * sf)
    const psh = Math.round(r.h * sf)

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = psw
    cropCanvas.height = psh
    const cropCtx = cropCanvas.getContext('2d')!
    cropCtx.drawImage(bgCanvas, psx, psy, psw, psh, 0, 0, psw, psh)

    // Canvas → PNG blob → ArrayBuffer（参考 Snow-Shot）
    const pngBlob = await new Promise<Blob | null>(resolve => cropCanvas.toBlob(resolve, 'image/png', 1))
    if (!pngBlob) throw new Error('Failed to create PNG blob')
    const pngBuffer = new Uint8Array(await pngBlob.arrayBuffer())

    console.log('[OCR] calling ocr_detect, png size:', pngBuffer.length, 'w:', psw, 'h:', psh)
    const result = await invoke<{ text_blocks: OcrTextBlock[]; scale_factor: number }>('ocr_detect', pngBuffer, {
      headers: {
        'x-scale-factor': sf.toFixed(3),
      },
    })
    console.log('[OCR] result:', JSON.stringify(result).slice(0, 500))

    ocrResults.value = result.text_blocks.filter(b => b.text_score > 0.3)
    console.log('[OCR] filtered blocks:', ocrResults.value.length)
    if (ocrResults.value.length > 0) {
      ocrMode.value = true
    }
  } catch (err) {
    console.error('[OCR] failed:', err)
  } finally {
    ocrLoading.value = false
  }
}

function getOcrBlockStyle(block: OcrTextBlock) {
  if (!selMgr) return {}
  const r = selMgr.rect
  const sf = scaleFactor

  const pts = block.box_points
  // box_points 是物理像素坐标（相对选区），转 CSS 像素（相对选区）
  const ltx = pts[0].x / sf
  const lty = pts[0].y / sf
  const rtx = pts[1].x / sf
  const rty = pts[1].y / sf
  const lbx = pts[3].x / sf
  const lby = pts[3].y / sf

  const w = Math.sqrt((rtx - ltx) ** 2 + (rty - lty) ** 2)
  const h = Math.sqrt((lbx - ltx) ** 2 + (lby - lty) ** 2)
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4 / sf
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 / sf

  let angle = Math.atan2(rty - lty, rtx - ltx) * 180 / Math.PI
  if (Math.abs(angle) < 3) angle = 0

  // 根据框宽度和文字长度动态计算字号，使文字尽量匹配原始大小
  const text = block.text || ''
  // 估算字符宽度：中文字符宽度 ≈ 字号，英文/数字 ≈ 字号 * 0.6
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const asciiCount = text.length - cjkCount
  // 每个字符的等效宽度系数
  const charWidthFactor = cjkCount + asciiCount * 0.55
  // 基于高度的字号（不超过框高）
  const fontByH = h * 0.9
  // 基于宽度的字号（让文字填满框宽）
  const fontByW = charWidthFactor > 0 ? w / charWidthFactor : fontByH
  const fontSize = Math.max(8, Math.min(fontByH, fontByW))

  return {
    position: 'absolute' as const,
    left: `${r.x + cx - w / 2}px`,
    top: `${r.y + cy - h / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
    transform: `rotate(${angle}deg)`,
    fontSize: `${fontSize}px`,
    lineHeight: `${h}px`,
    overflow: 'visible',
    whiteSpace: 'nowrap' as const,
  }
}

// ============ 取消截图 ============

function cancelCapture() {
  capturing.value = false
  showToolbar.value = false
  showOptions.value = false
  currentTool.value = DrawTool.None
  ocrResults.value = []
  ocrLoading.value = false
  ocrMode.value = false
  translateMode.value = false
  recordMode.value = false
  translateResults.value = []
  translateLoading.value = false
  cancelTextEditor()
  selMgr?.reset()
  annMgr.reset()
  windowSnapMgr.reset()
  // 清掉 inline cursor，让 CSS 的 crosshair 下次直接生效
  if (containerRef.value) {
    containerRef.value.style.cursor = ''
  }
  // 先移到屏幕外再隐藏，避免下次 show 时闪烁旧内容
  appWindow.setAlwaysOnTop(false).catch(() => {})
  appWindow.setPosition(new PhysicalPosition(-10000, -10000)).catch(() => {})
  appWindow.hide().catch(() => {})
}

// ============ 鼠标事件 ============

function onMouseDown(e: MouseEvent) {
  e.preventDefault()
  if (!selMgr) return

  // 翻译/OCR 模式下不处理选区交互（让文字可选）
  if (ocrMode.value || translateResults.value.length > 0 || translateLoading.value) return

  // 标注模式（有工具）
  if (currentTool.value !== DrawTool.None && selMgr.state === SelectState.Selected) {
    if (e.button === 0) {
      if (currentTool.value === DrawTool.Eraser) {
        annMgr.setSelectRect(selMgr.rect)
        if (annMgr.eraseAt(e.clientX, e.clientY)) redraw()
        return
      }
      annMgr.setSelectRect(selMgr.rect)
      syncToolState()
      annMgr.handleMouseDown(e)
      redraw()
      return
    }
    if (e.button === 2) {
      // 标注模式右键 → 取消当前工具
      currentTool.value = DrawTool.None
      showOptions.value = false
      syncToolState()
      return
    }
  }

  // 无工具模式：选择 / 移动标注
  if (currentTool.value === DrawTool.None && selMgr.state === SelectState.Selected && e.button === 0) {
    annMgr.setSelectRect(selMgr.rect)
    syncToolState()
    if (annMgr.handleMouseDown(e)) {
      // 选中标注后，回填属性到面板
      const sel = annMgr.getSelected()
      if (sel) {
        loadAnnotationToPanel(sel)
        nextTick(() => updatePanelBasePosition())
      }
      redraw()
      return
    }
  }

  if (e.button === 2) {
    if (selMgr.state === SelectState.Idle) {
      cancelCapture()
      return
    }
    selMgr.handleMouseDown(e)
    showToolbar.value = false
    redraw()
    return
  }

  selMgr.handleMouseDown(e)
  updateCursor(e.clientX, e.clientY)
  redraw()
}

function onMouseMove(e: MouseEvent) {
  if (!selMgr) return

  // 翻译/OCR 模式下不处理选区交互
  if (ocrMode.value || translateResults.value.length > 0 || translateLoading.value) return

  // 标注移动中
  // 标注缩放中
  if (annMgr.isResizing) {
    annMgr.handleMouseMove(e)
    redraw()
    return
  }

  if (annMgr.isMovingSelected) {
    annMgr.handleMouseMove(e)
    redraw()
    return
  }

  // 标注绘制中
  if (annMgr.isDrawing) {
    annMgr.handleMouseMove(e)
    redraw()
    return
  }

  // 橡皮擦拖动
  if (currentTool.value === DrawTool.Eraser && e.buttons === 1 && selMgr.state === SelectState.Selected) {
    annMgr.setSelectRect(selMgr.rect)
    if (annMgr.eraseAt(e.clientX, e.clientY)) redraw()
    return
  }

  // 窗口吸附：Idle 状态时更新高亮
  if (selMgr.state === SelectState.Idle) {
    windowSnapMgr.update(e.clientX, e.clientY)
  }

  const needRedraw = selMgr.handleMouseMove(e)
  updateCursor(e.clientX, e.clientY)
  if (needRedraw) {
    redraw()
    if (selMgr.state === SelectState.Moving || selMgr.state === SelectState.Resizing) {
      updateToolbarPosition()
    }
    // 吸附动画：持续重绘直到动画结束
    if (selMgr.state === SelectState.Idle && windowSnapMgr.isAnimating()) {
      const animLoop = () => {
        redraw()
        if (windowSnapMgr.isAnimating()) requestAnimationFrame(animLoop)
      }
      requestAnimationFrame(animLoop)
    }
  }
}

function onMouseUp(e: MouseEvent) {
  if (!selMgr) return

  // 翻译/OCR 模式下不处理选区交互
  if (ocrMode.value || translateResults.value.length > 0 || translateLoading.value) return

  if (annMgr.isResizing || annMgr.isMovingSelected || annMgr.isDrawing) {
    annMgr.handleMouseUp(e)
    // 画完/缩放后，回填属性到面板
    const sel = annMgr.getSelected()
    if (sel) {
      loadAnnotationToPanel(sel)
      nextTick(() => updatePanelBasePosition())
    }
    redraw()
    return
  }

  selMgr.handleMouseUp(e)
  updateCursor(e.clientX, e.clientY)
  redraw()
}

function updateCursor(x: number, y: number) {
  if (!containerRef.value || !selMgr) return

  // 选中标注时，优先检测缩放控制点的光标
  if (selMgr.state === SelectState.Selected && annMgr.selectedId) {
    const resizeCursor = annMgr.getResizeCursor(x, y)
    if (resizeCursor) {
      containerRef.value.style.cursor = resizeCursor
      return
    }
  }

  if (currentTool.value !== DrawTool.None && selMgr.state === SelectState.Selected) {
    // 有工具时，悬浮在选中标注上显示 move
    if (annMgr.selectedId && annMgr.hasAnnotationAt(x, y)) {
      containerRef.value.style.cursor = 'move'
      return
    }
    containerRef.value.style.cursor = 'crosshair'
    return
  }
  // 无工具时，悬浮在标注上显示 move 光标
  if (currentTool.value === DrawTool.None && selMgr.state === SelectState.Selected && annMgr.annotations.length > 0) {
    annMgr.setSelectRect(selMgr.rect)
    if (annMgr.hasAnnotationAt(x, y)) {
      containerRef.value.style.cursor = 'move'
      return
    }
  }
  containerRef.value.style.cursor = selMgr.getCursor(x, y)
}

function onWheel(e: WheelEvent) {
  if (!selMgr) return
  /*
    Idle 状态:滚轮切换抓框的层级。

    **往上滚 = 往外一层**(元素 → 容器 → 窗口),往下滚 = 往里钻。
    和"把镜头拉远"是一个手势方向:滚上去看到的东西更大、更完整。
  */
  if (selMgr.state === SelectState.Idle) {
    e.preventDefault()
    if (windowSnapMgr.cycleLevel(e.deltaY > 0 ? -1 : 1)) {
      redraw()
      if (windowSnapMgr.isAnimating()) {
        const animLoop = () => {
          redraw()
          if (windowSnapMgr.isAnimating()) requestAnimationFrame(animLoop)
        }
        requestAnimationFrame(animLoop)
      }
    }
  }
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
}

function exitOcrMode() {
  ocrResults.value = []
  ocrMode.value = false
}

/**
 * 退出翻译。
 *
 * **用快捷键直接进来的「截图翻译」,退出就是整个退出**;而在普通截图里点工具条上那颗
 * 翻译按钮的,退出只是回到截图,工具条还在 —— 用户本来就在截图流程里。
 *
 * 以前不分这两种,一律只清翻译状态,capturing 却还留着:翻完按 Esc,屏幕上剩下一个
 * 普通截图的选区和工具条 —— 从「截图翻译」莫名其妙变成了「截图」,得再按一次才退得掉。
 */
function exitTranslateMode() {
  if (translateMode.value) {
    cancelCapture()
    return
  }
  translateResults.value = []
  translateLoading.value = false
}

function getTranslateBlockStyle(block: OcrTextBlock, translated: string) {
  if (!selMgr) return {}
  const r = selMgr.rect
  const sf = scaleFactor

  const pts = block.box_points
  const ltx = pts[0].x / sf
  const lty = pts[0].y / sf
  const rtx = pts[1].x / sf
  const rty = pts[1].y / sf
  const lbx = pts[3].x / sf
  const lby = pts[3].y / sf

  const w = Math.sqrt((rtx - ltx) ** 2 + (rty - lty) ** 2)
  const h = Math.sqrt((lbx - ltx) ** 2 + (lby - lty) ** 2)
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4 / sf
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 / sf

  let angle = Math.atan2(rty - lty, rtx - ltx) * 180 / Math.PI
  if (Math.abs(angle) < 3) angle = 0

  // 动态计算字号：让翻译文本尽量填满原文区域，最小 14px 保证可读
  const text = translated || ''
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  const asciiCount = text.length - cjkCount
  const charWidthFactor = cjkCount + asciiCount * 0.55
  const fontByH = h * 0.85
  const fontByW = charWidthFactor > 0 ? w / charWidthFactor : fontByH
  const fontSize = Math.max(14, Math.min(fontByH, fontByW))

  // 字号可能大于原框，扩展背景区域确保完全覆盖文字
  const actualH = Math.max(h, fontSize * 1.3)
  const actualW = Math.max(w, fontSize * charWidthFactor)

  return {
    position: 'absolute' as const,
    left: `${r.x + cx - actualW / 2}px`,
    top: `${r.y + cy - actualH / 2}px`,
    width: `${actualW}px`,
    height: `${actualH}px`,
    transform: `rotate(${angle}deg)`,
    fontSize: `${fontSize}px`,
    lineHeight: `${actualH}px`,
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
  }
}

const translateLoadingStyle = computed(() => {
  if (!selMgr) return {}
  const r = selMgr.rect
  return {
    left: r.x + r.w / 2 - 60 + 'px',
    top: r.y + r.h / 2 - 16 + 'px',
  }
})

async function runScreenshotTranslate() {
  /*
    再点一下就收起来。

    这个按钮点亮着的时候等于「翻译浮层开着」,而唯一的退路以前只有 Esc ——
    可点亮的按钮再点一下应该关掉它,这是按钮的通用预期。
  */
  if (translateResults.value.length > 0) {
    exitTranslateMode()
    return
  }

  const bgCanvas = canvasRef.value
  if (!selMgr || !bgCanvas) return

  const r = selMgr.rect
  if (r.w < 2 || r.h < 2) return

  translateLoading.value = true

  try {
    // 1. OCR
    if (!ocrInited) {
      await invoke('ocr_init')
      ocrInited = true
    }

    const sf = scaleFactor
    const psx = Math.round(r.x * sf)
    const psy = Math.round(r.y * sf)
    const psw = Math.round(r.w * sf)
    const psh = Math.round(r.h * sf)

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = psw
    cropCanvas.height = psh
    const cropCtx = cropCanvas.getContext('2d')!
    cropCtx.drawImage(bgCanvas, psx, psy, psw, psh, 0, 0, psw, psh)

    const pngBlob = await new Promise<Blob | null>(resolve => cropCanvas.toBlob(resolve, 'image/png', 1))
    if (!pngBlob) throw new Error('Failed to create PNG blob')
    const pngBuffer = new Uint8Array(await pngBlob.arrayBuffer())

    const result = await invoke<{ text_blocks: OcrTextBlock[]; scale_factor: number }>('ocr_detect', pngBuffer, {
      headers: { 'x-scale-factor': sf.toFixed(3) },
    })

    const blocks = result.text_blocks.filter(b => b.text_score > 0.3 && b.text.trim().length > 0)
    if (blocks.length === 0) {
      // 框里一个字都没有:没什么可翻的,也没什么可留在屏幕上的。
      // 快捷键进来的直接收工,别把人晾在一个"变成了普通截图"的选区里(见 exitTranslateMode)
      translateLoading.value = false
      exitTranslateMode()
      return
    }

    // 2. 目标语言
    const allText = blocks.map(b => b.text).join('')
    const chineseRatio = (allText.match(/[\u4e00-\u9fff]/g) || []).length / allText.length
    const targetLang: 'zh' | 'en' = chineseRatio > 0.3 ? 'en' : 'zh'

    // 3. 顺着翻译页配好的引擎链翻:AI 引擎合并成一次请求,其余逐块各自兜底
    const { texts } = await translateBlocks(blocks.map(b => b.text), targetLang)
    translateResults.value = blocks.map((block, i) => ({ block, translated: texts[i] || block.text }))
  } catch (err) {
    console.error('[ScreenshotTranslate] failed:', err)
  } finally {
    translateLoading.value = false
  }
}

function ocrSelectAll() {
  // 选中 OCR 层中的所有文字
  const ocrLayer = document.querySelector('.ocr-layer')
  if (!ocrLayer) return
  const range = document.createRange()
  range.selectNodeContents(ocrLayer)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function onKeyDown(e: KeyboardEvent) {
  // 翻译模式下的键盘处理
  if (translateResults.value.length > 0 || translateLoading.value) {
    if (e.key === 'Escape') {
      exitTranslateMode()
      return
    }
    // Ctrl+C 由浏览器原生处理（已选中文字时自动复制）
    return
  }

  // OCR 模式下的键盘处理
  if (ocrMode.value) {
    if (e.key === 'Escape') {
      exitOcrMode()
      return
    }
    if (e.ctrlKey && e.key === 'a') {
      e.preventDefault()
      ocrSelectAll()
      return
    }
    // Ctrl+C 由浏览器原生处理（已选中文字时自动复制）
    return
  }

  // Esc
  if (e.key === 'Escape') {
    // 画到一半按 Esc：丢掉正在画的这一笔就够了，别顺手把工具也退了
    if (annMgr.cancelDrawing()) { redraw(); return }
    // 先取消选中
    if (annMgr.selectedId) {
      annMgr.deselect()
      redraw()
      return
    }
    if (currentTool.value !== DrawTool.None) {
      currentTool.value = DrawTool.None
      showOptions.value = false
      syncToolState()
      return
    }
    if (selMgr?.state === SelectState.Selected) {
      selMgr.reset()
      selMgr.onStateChange?.(SelectState.Idle)
      showToolbar.value = false
      annMgr.reset()
      redraw()
      return
    }
    cancelCapture()
    return
  }

  // Delete 删除选中标注
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (annMgr.selectedId) {
      annMgr.deleteSelected()
      redraw()
      return
    }
  }

  // Enter 完成截图 → 复制到剪贴板
  if (e.key === 'Enter') {
    if (selMgr?.state === SelectState.Selected) {
      e.preventDefault()
      copyToClipboard()
      return
    }
  }

  // Ctrl 组合键
  if (e.ctrlKey) {
    if (e.key === 'z') { e.preventDefault(); if (annMgr.undo()) redraw() }
    if (e.key === 'y') { e.preventDefault(); if (annMgr.redo()) redraw() }
    if (e.key === 'c') { e.preventDefault(); copyToClipboard() }
    if (e.key === 's') { e.preventDefault(); saveToFile() }
    return
  }

  // 取色器快捷键（Idle / Creating 状态）
  if (selMgr && (selMgr.state === SelectState.Idle || selMgr.state === SelectState.Creating)) {
    // Shift → 切换颜色格式
    if (e.key === 'Shift') {
      selMgr.cycleColorFormat()
      redraw()
      return
    }
    // C → 复制颜色值并退出截图
    if (e.key.toLowerCase() === 'c' && !e.ctrlKey) {
      const color = selMgr.getColorAtCursor()
      navigator.clipboard.writeText(color)
      cancelCapture()
      return
    }
    // WASD / 方向键 → 微调鼠标位置
    let dx = 0, dy = 0
    switch (e.key) {
      case 'w': case 'W': case 'ArrowUp': dy = -1; break
      case 's': case 'S': case 'ArrowDown': dy = 1; break
      case 'a': case 'A': case 'ArrowLeft': dx = -1; break
      case 'd': case 'D': case 'ArrowRight': dx = 1; break
    }
    if (dx !== 0 || dy !== 0) {
      e.preventDefault()
      selMgr.mouseX += dx
      selMgr.mouseY += dy
      redraw()
      return
    }
  }

  // 工具快捷键
  if (selMgr?.state === SelectState.Selected) {
    switch (e.key.toLowerCase()) {
      case 'r': setTool(DrawTool.Rect); break
      case 'o': setTool(DrawTool.Ellipse); break
      case 'a': setTool(DrawTool.Arrow); break
      case 'l': setTool(DrawTool.Line); break
      case 'p': setTool(DrawTool.Pen); break
      case 't': setTool(DrawTool.Text); break
      case 'b': setTool(DrawTool.Blur); break
      case 'h': setTool(DrawTool.Highlight); break
      case 'e': setTool(DrawTool.Eraser); break
    }
  }
}

// ============ 截图入口 ============

/** 防止 executeScreenshot 并发执行 */
let _executeLock = false

async function executeScreenshot() {
  // 防并发：如果上一次 executeScreenshot 还在 await 中，直接忽略
  if (_executeLock) return
  _executeLock = true

  try {
    await _doExecuteScreenshot()
  } finally {
    _executeLock = false
  }
}

async function _doExecuteScreenshot() {
  // 每次新截图都回到设置里的默认值 —— 上一张临时关掉了背景,
  // 不该让下一张跟着一起没有
  bgOn.value = (await settingsStore.get<boolean>('screenshot_auto_bg_shadow')) ?? false

  // 如果上次截图还在进行，先同步重置状态（不走 cancelCapture 的隐藏窗口逻辑）
  if (capturing.value) {
    capturing.value = false
    showToolbar.value = false
    showOptions.value = false
    currentTool.value = DrawTool.None
    ocrResults.value = []
    ocrLoading.value = false
    ocrMode.value = false
    translateResults.value = []
    translateLoading.value = false
    cancelTextEditor()
    selMgr?.reset()
    annMgr.reset()
    windowSnapMgr.reset()
  }

  capturing.value = true
  scaleFactor = window.devicePixelRatio
  showToolbar.value = false
  showOptions.value = false
  currentTool.value = DrawTool.None
  annMgr.reset()

  // 恢复上次遗留的状态
  if (containerRef.value) {
    containerRef.value.style.opacity = '1'
    containerRef.value.style.cursor = ''  // 清掉 inline，让 CSS crosshair 生效
  }
  await appWindow.setIgnoreCursorEvents(false).catch(() => {})

  try {
    // 截屏（必须等待完成）
    const rawData = await invoke<ArrayBuffer>('capture_screen')
    const dv = new DataView(rawData)
    imgWidth = dv.getUint32(0, true)
    imgHeight = dv.getUint32(4, true)
    const monX = dv.getInt32(8, true)
    const monY = dv.getInt32(12, true)
    monitorX = monX
    monitorY = monY
    const monW = dv.getUint32(16, true)
    const monH = dv.getUint32(20, true)

    const rgbaPixels = new Uint8ClampedArray(rawData, 24)

    await Promise.all([
      appWindow.setPosition(new PhysicalPosition(monX, monY)),
      appWindow.setSize(new PhysicalSize(monW, monH)),
    ])

    const bgCanvas = canvasRef.value!
    const olCanvas = overlayRef.value!
    const anCanvas = annCanvasRef.value!

    bgCanvas.width = imgWidth
    bgCanvas.height = imgHeight
    olCanvas.width = imgWidth
    olCanvas.height = imgHeight
    anCanvas.width = imgWidth
    anCanvas.height = imgHeight

    const cssW = imgWidth / scaleFactor
    const cssH = imgHeight / scaleFactor
    for (const c of [bgCanvas, olCanvas, anCanvas]) {
      c.style.width = `${cssW}px`
      c.style.height = `${cssH}px`
    }

    const bgCtx = bgCanvas.getContext('2d')!
    bgCtx.putImageData(new ImageData(rgbaPixels, imgWidth, imgHeight), 0, 0)

    // 像素级抓框:这一帧的边缘图,几十毫秒,截一次算一次
    pixelSnap.setFrame(rgbaPixels, imgWidth, imgHeight)
    windowSnapMgr.pixel = pixelSnap

    // 设置标注管理器的背景 canvas
    annMgr.bgCanvas = bgCanvas

    initSelectionManager()
    selMgr!.bgCanvas = bgCanvas
    selMgr!.windowSnap = windowSnapMgr
    selMgr!.init(imgWidth, imgHeight, scaleFactor)
    redraw()

    // 初始化窗口吸附
    try {
      await windowSnapMgr.init(scaleFactor, monX, monY, cssW, cssH)
    } catch (e) {
      console.warn('[Screenshot] windowSnap init failed (non-fatal):', e)
    }

    // 异步查询回调 → 触发重绘
    windowSnapMgr.onAsyncUpdate = () => {
      redraw()
      if (windowSnapMgr.isAnimating()) {
        const animLoop = () => {
          redraw()
          if (windowSnapMgr.isAnimating()) requestAnimationFrame(animLoop)
        }
        requestAnimationFrame(animLoop)
      }
    }

    await appWindow.setAlwaysOnTop(true)
    await appWindow.show()
    await appWindow.setFocus()

    await nextTick()
    containerRef.value?.focus()

    // 主动获取鼠标位置初始化取色器+十字线（不等 mousemove）
    // 注意：不触发 windowSnapMgr.update()，吸附高亮等用户真正移动鼠标时再开始
    try {
      const [absX, absY] = await invoke<[number, number]>('get_cursor_position')
      const cssX = (absX - monX) / scaleFactor
      const cssY = (absY - monY) / scaleFactor
      selMgr!.mouseX = cssX
      selMgr!.mouseY = cssY
      selMgr!.hasMousePosition = true
      redraw()
    } catch {}
  } catch (err) {
    console.error('[Screenshot] executeScreenshot failed:', err)
    cancelCapture()
  }
}


let _unlistens: (() => void)[] = []

onMounted(async () => {
  applySavedLocale()   // 副窗口独立 WebView，语言要自己从 settings.json 取一次
  document.body.classList.add('screenshot-window')
  await appWindow.hide()

  // 监听截图事件（检查截图开关）
  await settingsStore.init()
  _unlistens.push(await listen('execute-screenshot', async () => {
    setSelectionLook('normal')      // 普通截图:淡蓝框
    const enabled = (await settingsStore.get<boolean>('screenshot_enabled')) ?? true
    if (!enabled) return
    // 截图进行中再按快捷键 → 取消当前截图
    if (capturing.value) {
      cancelCapture()
      return
    }
    translateMode.value = false
    executeScreenshot()
  }))

  // 监听截图翻译事件
  _unlistens.push(await listen('execute-screenshot-translate', async () => {
    // 截图进行中再按快捷键 → 取消当前截图
    if (capturing.value) {
      cancelCapture()
      return
    }
    translateMode.value = true
    setSelectionLook('translate')   // 翻译截图:淡红框、十字线也淡红、不显示像素尺寸
    executeScreenshot()
  }))

  /*
    录屏。和截图一样：再按一次就是取消框选；
    但已经在录的时候不能再开一个 —— 屏幕就一块，两个 ffmpeg 抢同一块区域没意义。
  */
  _unlistens.push(await listen('execute-record', async () => {
    const enabled = (await settingsStore.get<boolean>('record_enabled')) ?? true
    if (!enabled) return
    if (capturing.value) { cancelCapture(); return }
    try {
      const st = await invoke<{ recording: boolean }>('recording_status')
      if (st.recording) return
    } catch { /* 后端没应声就当没在录 */ }
    translateMode.value = false
    recordMode.value = true
    setSelectionLook('record')
    executeScreenshot()
  }))

  // 监听强制取消事件（托盘菜单）
  _unlistens.push(await listen('force-cancel-screenshot', () => {
    _executeLock = false
    capturing.value = false
    cancelCapture()
  }))

  // 预热 OCR 模型（后台加载，不阻塞）
  invoke('ocr_init').then(() => {
    ocrInited = true
    console.log('[OCR] pre-warm done')
  }).catch(e => console.warn('[OCR] pre-warm failed:', e))
})

onUnmounted(() => { _unlistens.forEach(fn => fn()) })

// ============ 工具定义 ============

/*
  ── 工具条为什么要分组 ──────────────────────────────

  十四个标注工具原来平铺成一排，加上右边那七八个操作按钮，一条工具条二十来颗
  三十见方的小图标 —— 挤、难点，而且**一眼扫不出哪个是哪个**。

  按「要干的事」收成五组：画形状、画线、写字、打码、擦掉。每组只占一颗按钮，
  显示的是这一组**上次用过的那个**（不是一个抽象的组图标）—— 于是常用路径
  和以前一样是「点一下就用」，没有多一层。右下角那个小三角是提示：
  这颗底下还有别的。

  展开的规矩：**点一下用，已经选中了再点一下才展开**（右键也展开）。
  悬停自动展开试过，鼠标横穿工具条时一路弹菜单，很烦。
*/
type ToolMeta = { tool: DrawTool; iconClass: string; key: string }

const TOOL_META: ToolMeta[] = [
  { tool: DrawTool.Rect, iconClass: 'icon-[lucide--square]', key: 'toolRect' },
  { tool: DrawTool.Diamond, iconClass: 'icon-[lucide--diamond]', key: 'toolDiamond' },
  { tool: DrawTool.Ellipse, iconClass: 'icon-[lucide--circle]', key: 'toolEllipse' },
  { tool: DrawTool.Arrow, iconClass: 'icon-[lucide--move-right]', key: 'toolArrow' },
  { tool: DrawTool.Line, iconClass: 'icon-[lucide--minus]', key: 'toolLine' },
  { tool: DrawTool.Pen, iconClass: 'icon-[lucide--pencil]', key: 'toolPen' },
  { tool: DrawTool.Highlight, iconClass: 'icon-[lucide--highlighter]', key: 'toolHighlight' },
  { tool: DrawTool.Text, iconClass: 'icon-[lucide--type]', key: 'toolText' },
  { tool: DrawTool.SerialNumber, iconClass: 'icon-[lucide--list-ordered]', key: 'toolSerial' },
  { tool: DrawTool.Blur, iconClass: 'icon-[lucide--grid-3x3]', key: 'toolBlur' },
  { tool: DrawTool.BlurFreeDraw, iconClass: 'icon-[lucide--fingerprint]', key: 'toolBlurDraw' },
  { tool: DrawTool.Watermark, iconClass: 'icon-[lucide--stamp]', key: 'toolWatermark' },
  { tool: DrawTool.Eraser, iconClass: 'icon-[lucide--eraser]', key: 'toolEraser' },
]

const metaOf = (t: DrawTool) => TOOL_META.find((m) => m.tool === t) ?? TOOL_META[0]

const TOOL_GROUPS: { id: string; nameKey: string; tools: DrawTool[] }[] = [
  { id: 'shape', nameKey: 'groupShape', tools: [DrawTool.Rect, DrawTool.Diamond, DrawTool.Ellipse, DrawTool.Arrow, DrawTool.Line] },
  { id: 'draw', nameKey: 'groupDraw', tools: [DrawTool.Pen, DrawTool.Highlight] },
  { id: 'text', nameKey: 'groupText', tools: [DrawTool.Text, DrawTool.SerialNumber] },
  { id: 'mask', nameKey: 'groupMask', tools: [DrawTool.Blur, DrawTool.BlurFreeDraw, DrawTool.Watermark] },
  { id: 'erase', nameKey: 'groupErase', tools: [DrawTool.Eraser] },
]

/** 每一组现在代表哪个工具。记着上次用的那个，下次点一下直接就是它 */
const groupPick = reactive<Record<string, DrawTool>>(
  Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g.tools[0]])),
)

/** 哪一组正展开着。null = 都收着 */
const openGroup = ref<string | null>(null)

function onGroupClick(g: { id: string; tools: DrawTool[] }) {
  if (g.tools.length > 1 && currentTool.value === groupPick[g.id]) {
    // 已经在用这一组了，再点就是「给我看看还有什么」
    openGroup.value = openGroup.value === g.id ? null : g.id
    return
  }
  openGroup.value = null
  setTool(groupPick[g.id])
}

function pickFromGroup(gid: string, tool: DrawTool) {
  groupPick[gid] = tool
  openGroup.value = null
  if (currentTool.value !== tool) setTool(tool)
}
</script>

<template>
  <div
    ref="containerRef"
    class="screenshot-container"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
    @wheel="onWheel"
    @contextmenu="onContextMenu"
    @keydown="onKeyDown"
    tabindex="0"
  >
    <canvas ref="canvasRef" class="layer" />
    <canvas ref="overlayRef" class="layer" style="z-index: 1" />
    <canvas ref="annCanvasRef" class="layer" style="z-index: 2; pointer-events: none" />

    <!-- OCR 结果层 -->
    <div
      v-if="ocrMode && ocrResults.length > 0"
      class="ocr-layer"
      style="z-index: 10"
      @mousedown.stop
      @mousemove.stop
      @mouseup.stop
    >
      <div
        v-for="(block, idx) in ocrResults" :key="idx"
        class="ocr-block"
        :style="getOcrBlockStyle(block)"
      >{{ block.text }}</div>
    </div>

    <!-- 翻译结果覆盖层 -->
    <div
      v-if="translateResults.length > 0"
      class="translate-layer"
      style="z-index: 11"
      @mousedown.stop
      @mousemove.stop
      @mouseup.stop
      @contextmenu.prevent.stop="cancelCapture"
    >
      <div
        v-for="(item, idx) in translateResults" :key="idx"
        class="translate-block"
        :style="getTranslateBlockStyle(item.block, item.translated)"
      >{{ item.translated }}</div>
    </div>

    <!-- 翻译加载中 -->
    <div
      v-if="translateLoading"
      class="translate-loading-overlay"
      :style="translateLoadingStyle"
    >
      <span class="icon-[lucide--loader-2] w-5 h-5 spin text-white" />
      <span class="text-white text-sm">{{ t('shot.translating') }}</span>
    </div>

    <!--
      录屏的短条。沿用 .toolbar 这个类 —— 定位函数是按 `.toolbar` 查 DOM 宽度的，
      另起一个类名就得把那套定位也再写一遍。
    -->
    <div
      v-if="showToolbar && recordMode"
      class="toolbar"
      :style="{ left: toolbarX + 'px', top: toolbarY + 'px' }"
      @mousedown.stop
    >
      <span class="toolbar-grip icon-[lucide--grip-vertical]" :title="t('shot.dragToolbar')"
        @mousedown="onToolbarDragStart" />
      <button class="tb rec-go" :title="t('rec.start')" @click="startRecording">
        <span class="icon-[lucide--circle-dot] tb-icon" />
        <span class="rec-go-text">{{ t('rec.start') }}</span>
      </button>
      <button class="tb action-close" :title="t('shot.close')" @click="cancelCapture">
        <span class="icon-[lucide--x] tb-icon" />
      </button>
    </div>

    <!-- 工具栏 -->
    <div
      v-if="showToolbar && !recordMode"
      class="toolbar"
      :style="{ left: toolbarX + 'px', top: toolbarY + 'px' }"
      @mousedown.stop
    >
      <!-- 抓手:按住拖动整条工具栏 -->
      <span class="toolbar-grip icon-[lucide--grip-vertical]" :title="t('shot.dragToolbar')"
        @mousedown="onToolbarDragStart" />
      <!-- 标注工具：五组，每组一颗 -->
      <div class="toolbar-group">
        <div v-for="g in TOOL_GROUPS" :key="g.id" class="tb-slot">
          <button
            class="tb"
            :class="{ active: currentTool === groupPick[g.id], open: openGroup === g.id }"
            :title="t('shot.' + metaOf(groupPick[g.id]).key)"
            @click="onGroupClick(g)"
            @contextmenu.prevent="g.tools.length > 1 && (openGroup = openGroup === g.id ? null : g.id)"
          >
            <span :class="metaOf(groupPick[g.id]).iconClass" class="tb-icon" />
            <!-- 右下角的小三角:提示这颗底下还压着别的工具 -->
            <span v-if="g.tools.length > 1" class="tb-more" />
          </button>

          <div v-if="openGroup === g.id" class="tb-flyout" @mousedown.stop>
            <button
              v-for="tl in g.tools" :key="tl"
              class="tb" :class="{ active: currentTool === tl }"
              :title="t('shot.' + metaOf(tl).key)"
              @click="pickFromGroup(g.id, tl)"
            >
              <span :class="metaOf(tl).iconClass" class="tb-icon" />
            </button>
          </div>
        </div>
      </div>

      <div class="divider" />

      <!-- 撤销/重做 -->
      <button class="tb" :title="t('shot.undo')" :disabled="!annMgr.canUndo" @click="annMgr.undo(); redraw()">
        <span class="icon-[lucide--undo-2] tb-icon" />
      </button>
      <button class="tb" :title="t('shot.redo')" :disabled="!annMgr.canRedo" @click="annMgr.redo(); redraw()">
        <span class="icon-[lucide--redo-2] tb-icon" />
      </button>

      <div class="divider" />

      <!-- 操作按钮 -->
      <button class="tb" :class="{ active: ocrMode }" :title="t('shot.ocr')" :disabled="ocrLoading" @click="runOcr">
        <span v-if="ocrLoading" class="icon-[lucide--loader-2] tb-icon spin" />
        <span v-else class="icon-[lucide--scan-text] tb-icon" />
      </button>
      <button class="tb" :class="{ active: translateResults.length > 0 }" :title="t('shot.translate')" :disabled="translateLoading" @click="runScreenshotTranslate">
        <span v-if="translateLoading" class="icon-[lucide--loader-2] tb-icon spin" />
        <span v-else class="icon-[lucide--languages] tb-icon" />
      </button>
      <!--
        录制。框都框好了，临时改主意想录一段不用退出去重按一次快捷键 ——
        这一组本来就是「框好了之后拿它干嘛」，录制和翻译、钉图是一类事。
      -->
      <button class="tb action-record" :title="t('rec.start')" @click="startRecording">
        <span class="icon-[lucide--circle-dot] tb-icon" />
      </button>
      <!--
        长截图。和录制并排：框好之后「拿它干嘛」的又一件事。
        内容超出一屏时才有意义,但这里不做判断 —— 判断不了(选区里是什么应用、
        能不能滚,截图这边无从得知),给个按钮让人自己决定就好。
      -->
      <button class="tb action-longshot" :title="t('ls.start')" @click="startLongShot">
        <span class="icon-[lucide--gallery-vertical-end] tb-icon" />
      </button>
      <!--
        这一次要不要背景投影。改的是本次截图,不写回设置 ——
        为一张图去设置页翻开关、截完还得改回来,那才是麻烦。
      -->
      <button class="tb" :class="{ active: bgOn }" :title="t('shot.bg')" @click="toggleBg">
        <span class="tb-icon" :class="bgOn ? 'icon-[lucide--image]' : 'icon-[lucide--image-off]'" />
      </button>
      <button class="tb" :title="t('shot.pin')" @click="pinToScreen">
        <span class="icon-[lucide--pin] tb-icon" />
      </button>
      <button class="tb" :title="t('shot.save')" @click="saveToFile(false)">
        <span class="icon-[lucide--download] tb-icon" />
      </button>
      <button class="tb action-copy" :title="t('shot.copy')" @click="copyToClipboard">
        <span class="icon-[lucide--copy] tb-icon" />
      </button>
      <button class="tb action-close" :title="t('shot.close')" @click="cancelCapture">
        <span class="icon-[lucide--x] tb-icon" />
      </button>

    </div>

    <!-- 工具属性面板（独立定位，可拖拽） -->
    <div
      v-if="showToolbar && showFloatingPanel"
      ref="textPanelRef"
      class="tool-panel"
      :style="{ left: panelBaseX + 'px', top: panelBaseY + 'px', transform: `translate(${panelTransX}px, ${panelTransY}px)` }"
      @mousedown.stop="onPanelMouseDown"
    >
      <!-- 拖拽手柄 -->
      <div class="panel-drag-handle" @mousedown="onPanelDragStart">
        <span class="icon-[lucide--grip-vertical] tb-icon" />
      </div>

      <!-- ====== 描边颜色（所有工具通用） ====== -->
      <div class="panel-section">
        <span class="panel-title">{{ t('shot.stroke') }}</span>
        <div class="opt-row">
          <button
            v-for="c in STROKE_COLORS" :key="c"
            class="color-btn lg" :class="{ active: currentStrokeColor === c }"
            :style="{ background: c }"
            @click="currentStrokeColor = c; syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 填充/背景色（几何形状 + 画笔） ====== -->
      <div v-if="isShapeTool || isPenTool" class="panel-section">
        <span class="panel-title">{{ t('shot.background') }}</span>
        <div class="opt-row">
          <button
            v-for="c in FILL_COLORS" :key="'fill'+c"
            class="color-btn lg" :class="{ active: currentFillColor === c, 'no-fill': c === 'transparent' }"
            :style="c !== 'transparent' ? { background: c } : {}"
            @click="currentFillColor = c; syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 文本背景色（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.background') }}</span>
        <div class="opt-row">
          <button
            v-for="c in TEXT_BG_COLORS" :key="'bg'+c"
            class="color-btn lg" :class="{ active: textBgColor === c, 'no-fill': c === 'transparent' }"
            :style="c !== 'transparent' ? { background: c } : {}"
            @click="textBgColor = c; syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 文本描边（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.textStroke') }}</span>
        <div class="opt-row">
          <button
            v-for="c in TEXT_STROKE_COLORS" :key="'ts'+c"
            class="color-btn lg" :class="{ active: textStrokeColor === c, 'no-fill': c === 'transparent' }"
            :style="c !== 'transparent' ? { background: c } : {}"
            @click="setTextStrokeColor(c)"
          />
        </div>
      </div>

      <!-- ====== 文本描边宽度（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.textStrokeWidth') }}</span>
        <div class="opt-row">
          <input
            type="range" :min="0" :max="4" :step="0.5"
            :value="textStrokeWidth"
            class="slider"
            @input="textStrokeWidth = parseFloat(($event.target as HTMLInputElement).value); syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 画笔样式（仅画笔） ====== -->
      <div v-if="effectiveTool === DrawTool.Pen" class="panel-section">
        <span class="panel-title">{{ t('shot.brushStyle') }}</span>
        <div class="opt-row">
          <button
            v-for="s in PEN_STYLES" :key="s"
            class="style-btn" :class="{ active: penStyle === s }"
            @click="penStyle = s; syncToolState()"
          >
            <span v-if="s === 'round'" class="icon-[lucide--pen-tool] tb-icon" />
            <span v-else class="icon-[lucide--paintbrush] tb-icon" />
          </button>
        </div>
      </div>

      <!-- ====== 描边宽度（非文字/水印工具） ====== -->
      <div v-if="currentTool !== DrawTool.Text && currentTool !== DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.strokeWidth') }}</span>
        <div class="opt-row">
          <button
            v-for="w in STROKE_WIDTH_PRESETS" :key="w"
            class="style-btn" :class="{ active: currentStrokeWidth === w }"
            @click="currentStrokeWidth = w; syncToolState()"
          >
            <span class="stroke-preview" :style="{ height: w + 'px' }" />
          </button>
        </div>
      </div>

      <!-- ====== 边框样式（几何形状 + 线条类） ====== -->
      <div v-if="isShapeTool || isLineTool" class="panel-section">
        <span class="panel-title">{{ t('shot.borderStyle') }}</span>
        <div class="opt-row">
          <button
            v-for="s in BORDER_STYLES" :key="s"
            class="style-btn" :class="{ active: borderStyle === s }"
            @click="borderStyle = s; syncToolState()"
          >
            <svg width="24" height="2" viewBox="0 0 24 2">
              <line v-if="s === 'solid'" x1="0" y1="1" x2="24" y2="1" stroke="currentColor" stroke-width="2" />
              <line v-else-if="s === 'dashed'" x1="0" y1="1" x2="24" y2="1" stroke="currentColor" stroke-width="2" stroke-dasharray="5,3" />
              <line v-else x1="0" y1="1" x2="24" y2="1" stroke="currentColor" stroke-width="2" stroke-dasharray="1.5,2.5" />
            </svg>
          </button>
        </div>
      </div>

      <!-- ====== 线条风格（几何形状 + 线条类） ====== -->
      <div v-if="isShapeTool || isLineTool" class="panel-section">
        <span class="panel-title">{{ t('shot.lineStyle') }}</span>
        <div class="opt-row">
          <button
            v-for="s in LINE_STYLES" :key="s"
            class="style-btn" :class="{ active: lineStyle === s }"
            @click="lineStyle = s; syncToolState()"
          >
            <svg width="24" height="12" viewBox="0 0 24 12">
              <path v-if="s === 'sharp'" d="M2,10 L12,2 L22,10" stroke="currentColor" stroke-width="1.5" fill="none" />
              <path v-else-if="s === 'curve'" d="M2,10 Q12,-2 22,10" stroke="currentColor" stroke-width="1.5" fill="none" />
              <path v-else d="M2,10 L12,2 L22,10" stroke="currentColor" stroke-width="3" fill="none" />
            </svg>
          </button>
        </div>
      </div>

      <!-- ====== 箭头类型（仅箭头） ====== -->
      <div v-if="effectiveTool === DrawTool.Arrow" class="panel-section">
        <span class="panel-title">{{ t('shot.arrowType') }}</span>
        <div class="opt-row">
          <button
            v-for="t in ARROW_TYPES" :key="t"
            class="style-btn" :class="{ active: arrowType === t }"
            @click="arrowType = t; syncToolState()"
          >
            <svg width="24" height="12" viewBox="0 0 24 12">
              <line x1="2" y1="6" x2="16" y2="6" stroke="currentColor" :stroke-width="t === 'thin' ? 1 : 1.5" />
              <path v-if="t === 'thin'" d="M14,2 L20,6 L14,10" stroke="currentColor" stroke-width="1" fill="none" />
              <path v-else-if="t === 'normal'" d="M14,2 L20,6 L14,10" stroke="currentColor" stroke-width="1.5" fill="none" />
              <path v-else d="M14,2 L20,6 L14,10 Z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <!-- ====== 端点样式（箭头/直线） ====== -->
      <div v-if="isLineTool" class="panel-section">
        <span class="panel-title">{{ t('shot.endpoint') }}</span>
        <div class="opt-row">
          <button
            class="style-btn" :class="{ active: startEndpoint === 'none' && endEndpoint === 'arrow' }"
            @click="startEndpoint = 'none'; endEndpoint = 'arrow'; syncToolState()"
          >
            <svg width="24" height="8" viewBox="0 0 24 8">
              <line x1="2" y1="4" x2="4" y2="4" stroke="currentColor" stroke-width="1.5" />
              <line x1="4" y1="4" x2="18" y2="4" stroke="currentColor" stroke-width="1.5" />
              <path d="M16,1 L22,4 L16,7" stroke="currentColor" stroke-width="1.5" fill="none" />
            </svg>
          </button>
          <button
            class="style-btn" :class="{ active: startEndpoint === 'arrow' && endEndpoint === 'arrow' }"
            @click="startEndpoint = 'arrow'; endEndpoint = 'arrow'; syncToolState()"
          >
            <svg width="24" height="8" viewBox="0 0 24 8">
              <path d="M8,1 L2,4 L8,7" stroke="currentColor" stroke-width="1.5" fill="none" />
              <line x1="4" y1="4" x2="20" y2="4" stroke="currentColor" stroke-width="1.5" />
              <path d="M16,1 L22,4 L16,7" stroke="currentColor" stroke-width="1.5" fill="none" />
            </svg>
          </button>
        </div>
      </div>

      <!-- ====== 边角样式（仅矩形） ====== -->
      <div v-if="effectiveTool === DrawTool.Rect" class="panel-section">
        <span class="panel-title">{{ t('shot.corner') }}</span>
        <div class="opt-row">
          <button
            v-for="s in CORNER_STYLES" :key="s"
            class="style-btn" :class="{ active: cornerStyle === s }"
            @click="cornerStyle = s; syncToolState()"
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path v-if="s === 'sharp'" d="M2,14 L2,2 L14,2" stroke="currentColor" stroke-width="1.5" fill="none" />
              <path v-else d="M2,14 L2,6 Q2,2 6,2 L14,2" stroke="currentColor" stroke-width="1.5" fill="none" />
            </svg>
          </button>
        </div>
      </div>

      <!-- ====== 字体（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.font') }}</span>
        <div class="opt-row">
          <button
            v-for="f in FONT_FAMILIES" :key="f.value"
            class="font-btn" :class="[{ active: textFontFamily === f.value }, 'font-' + f.icon]"
            @click="textFontFamily = f.value; syncToolState()"
          >
            <span v-if="f.icon === 'handwriting'" class="icon-[lucide--pen-line] tb-icon" />
            <span v-else-if="f.icon === 'normal'" class="icon-[lucide--a-large-small] tb-icon" />
            <span v-else class="icon-[lucide--code] tb-icon" />
          </button>
        </div>
      </div>

      <!-- ====== 字体大小（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.fontSize') }}</span>
        <div class="opt-row">
          <button
            v-for="s in FONT_SIZE_LABELS" :key="s.label"
            class="size-btn" :class="{ active: currentFontSize === s.value }"
            @click="currentFontSize = s.value; syncToolState()"
          >{{ s.label }}</button>
        </div>
      </div>

      <!-- ====== 文本对齐（仅文字工具） ====== -->
      <div v-if="effectiveTool === DrawTool.Text" class="panel-section">
        <span class="panel-title">{{ t('shot.textAlign') }}</span>
        <div class="opt-row">
          <button
            v-for="a in TEXT_ALIGNS" :key="a"
            class="align-btn" :class="{ active: textAlignVal === a }"
            @click="textAlignVal = a; syncToolState()"
          >
            <span v-if="a === 'left'" class="icon-[lucide--align-left] tb-icon" />
            <span v-else-if="a === 'center'" class="icon-[lucide--align-center] tb-icon" />
            <span v-else class="icon-[lucide--align-right] tb-icon" />
          </button>
        </div>
      </div>

      <!-- ====== 马赛克强度（矩形马赛克 + 涂抹马赛克） ====== -->
      <div v-if="effectiveTool === DrawTool.Blur || effectiveTool === DrawTool.BlurFreeDraw" class="panel-section">
        <span class="panel-title">{{ t('shot.mosaic') }}</span>
        <div class="opt-row">
          <input
            type="range" :min="4" :max="30" :step="1"
            :value="blurRadius"
            class="slider"
            @input="blurRadius = parseInt(($event.target as HTMLInputElement).value); syncToolState()"
          />
          <span class="slider-val">{{ blurRadius }}</span>
        </div>
      </div>

      <!-- ====== 涂抹线宽（仅涂抹马赛克） ====== -->
      <div v-if="effectiveTool === DrawTool.BlurFreeDraw" class="panel-section">
        <span class="panel-title">{{ t('shot.smudgeWidth') }}</span>
        <div class="opt-row">
          <input
            type="range" :min="8" :max="60" :step="2"
            :value="blurLineWidth"
            class="slider"
            @input="blurLineWidth = parseInt(($event.target as HTMLInputElement).value); syncToolState()"
          />
          <span class="slider-val">{{ blurLineWidth }}</span>
        </div>
      </div>

      <!-- ====== 水印文本 ====== -->
      <div v-if="effectiveTool === DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.watermarkText') }}</span>
        <div class="opt-row">
          <input
            type="text"
            :value="watermarkText"
            class="wm-input"
            :placeholder="t('shot.watermarkPlaceholder')"
            @input="watermarkText = ($event.target as HTMLInputElement).value; syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 水印字号 ====== -->
      <div v-if="effectiveTool === DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.fontSizeShort') }}</span>
        <div class="opt-row">
          <input
            type="range" :min="12" :max="72" :step="2"
            :value="watermarkFontSize"
            class="slider"
            @input="watermarkFontSize = parseInt(($event.target as HTMLInputElement).value); syncToolState()"
          />
          <span class="slider-val">{{ watermarkFontSize }}</span>
        </div>
      </div>

      <!-- ====== 水印字体 ====== -->
      <div v-if="effectiveTool === DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.font') }}</span>
        <div class="opt-row">
          <button
            class="font-btn" :class="{ active: watermarkFontFamily === 'sans-serif' }"
            @click="watermarkFontFamily = 'sans-serif'; syncToolState()"
          >
            <span class="icon-[lucide--a-large-small] tb-icon" />
          </button>
          <button
            class="font-btn" :class="{ active: watermarkFontFamily === 'serif' }"
            @click="watermarkFontFamily = 'serif'; syncToolState()"
          >
            <span class="icon-[lucide--type] tb-icon" />
          </button>
          <button
            class="font-btn" :class="{ active: watermarkFontFamily === 'monospace' }"
            @click="watermarkFontFamily = 'monospace'; syncToolState()"
          >
            <span class="icon-[lucide--code] tb-icon" />
          </button>
        </div>
      </div>

      <!-- ====== 水印透明度 ====== -->
      <div v-if="effectiveTool === DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.opacity') }}</span>
        <div class="opt-row">
          <input
            type="range" :min="0.02" :max="0.5" :step="0.01"
            :value="watermarkOpacity"
            class="slider"
            @input="watermarkOpacity = parseFloat(($event.target as HTMLInputElement).value); syncToolState()"
          />
          <span class="slider-val">{{ Math.round(watermarkOpacity * 100) }}%</span>
        </div>
      </div>

      <!-- ====== 透明度（所有工具通用，水印除外） ====== -->
      <div v-if="currentTool !== DrawTool.Watermark" class="panel-section">
        <span class="panel-title">{{ t('shot.opacity') }}</span>
        <div class="opt-row">
          <input
            v-if="effectiveTool === DrawTool.Text"
            type="range" :min="0" :max="1" :step="0.05"
            :value="textOpacity"
            class="slider"
            @input="textOpacity = parseFloat(($event.target as HTMLInputElement).value); syncToolState()"
          />
          <input
            v-else
            type="range" :min="0" :max="1" :step="0.05"
            :value="opacity"
            class="slider"
            @input="opacity = parseFloat(($event.target as HTMLInputElement).value); syncToolState()"
          />
        </div>
      </div>

      <!-- ====== 图层操作（所有工具通用） ====== -->
      <div class="panel-section">
        <span class="panel-title">{{ t('shot.layers') }}</span>
        <div class="opt-row">
          <button class="style-btn sm" :title="t('shot.sendToBack')" :disabled="annMgr.annotations.length < 2" @click="annMgr.moveLastToBottom(); redraw()">
            <span class="icon-[lucide--chevrons-down] tb-icon" />
          </button>
          <button class="style-btn sm" :title="t('shot.sendBackward')" :disabled="annMgr.annotations.length < 2" @click="annMgr.moveLastDown(); redraw()">
            <span class="icon-[lucide--chevron-down] tb-icon" />
          </button>
          <button class="style-btn sm" :title="t('shot.bringForward')" :disabled="annMgr.annotations.length < 2" @click="annMgr.moveFirstUp(); redraw()">
            <span class="icon-[lucide--chevron-up] tb-icon" />
          </button>
          <button class="style-btn sm" :title="t('shot.bringToFront')" :disabled="annMgr.annotations.length < 2" @click="annMgr.moveFirstToTop(); redraw()">
            <span class="icon-[lucide--chevrons-up] tb-icon" />
          </button>
        </div>
      </div>
    </div>

    <!-- 内联文字编辑器 -->
    <textarea
      v-if="showTextEditor"
      ref="textEditorRef"
      v-model="textEditorValue"
      class="inline-text-editor"
      :style="{
        left: textEditorX + 'px',
        top: textEditorY + 'px',
        color: 'transparent',
        caretColor: currentStrokeColor,
        fontSize: currentFontSize + 'px',
        fontFamily: textFontFamily,
        textAlign: textAlignVal,
        backgroundColor: 'transparent',
      }"
      :placeholder="t('shot.textPlaceholder')"
      @keydown="onTextEditorKeyDown"
      @input="autoResizeTextEditor(); updateTextPreview()"
      @mousedown.stop
      @blur="onTextEditorBlur"
    />
  </div>
</template>

<style scoped>
/* 录屏那条只有一颗主按钮，给它文字和琥珀黄底，和截图工具条的图标按钮区分开 */
.rec-go {
  width: auto !important;
  padding: 0 16px;
  gap: 7px;
  background: #e8952f !important;
  color: #fff !important;
}
.rec-go:hover { background: #f5a544 !important; }
.rec-go-text { font-size: 12.5px; white-space: nowrap; }

.screenshot-container {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  margin: 0; padding: 0;
  overflow: hidden;
  cursor: crosshair;
  outline: none;
  background: transparent;
}

.layer {
  position: absolute;
  top: 0; left: 0;
}

/* ===== 工具栏 ===== */
.toolbar {
  position: absolute;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 2px;
  /* 高度 = 36 的按钮 + 上下各 6 = 48。原来 30+8=38，太瘦，按钮也难点 */
  padding: 6px 8px;
  background: rgba(28, 28, 30, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(16px);
  opacity: 0;
  animation: fade-in 200ms ease-out forwards;
  white-space: nowrap;
  flex-shrink: 0;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.toolbar-grip {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin: 0 3px 0 -1px;
  color: rgba(255, 255, 255, 0.6);
  cursor: grab;
}
.toolbar-grip:hover { color: rgba(255, 255, 255, 0.9); }
.toolbar-grip:active { cursor: grabbing; }

.toolbar-group {
  display: flex;
  gap: 1px;
}

.divider {
  width: 1px;
  height: 24px;
  background: rgba(255, 255, 255, 0.14);
  margin: 0 5px;
}

.tb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px; height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #d4d4d6;
  cursor: pointer;
  transition: background 120ms, color 120ms;
  font-size: 14px;
  padding: 0;
}
.tb:hover { background: rgba(255,255,255,0.12); color: #fff; }
.tb.active { background: #4096ff; color: #fff; }
.tb.open { background: rgba(255,255,255,0.18); color: #fff; }
.tb:disabled { opacity: 0.3; cursor: default; }
.tb .tb-icon { width: 18px; height: 18px; }

/* 一组一格。展开的浮层挂在这一格上,自动跟着按钮走 */
.tb-slot { position: relative; display: flex; }

/* 右下角那个小三角 —— 「这颗底下还有别的」 */
.tb-more {
  position: absolute;
  right: 4px; bottom: 4px;
  width: 0; height: 0;
  border-left: 4px solid transparent;
  border-bottom: 4px solid rgba(255, 255, 255, 0.45);
  pointer-events: none;
}
.tb:hover .tb-more, .tb.active .tb-more { border-bottom-color: rgba(255, 255, 255, 0.85); }

/* 展开的那一小排。和工具条同一套外观,看着是从它里面拉出来的 */
.tb-flyout {
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  padding: 5px;
  background: rgba(28, 28, 30, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 10px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(16px);
  animation: fade-in 140ms ease-out forwards;
  z-index: 2;
}

.action-copy { color: #4096ff; }
.action-copy:hover { background: #4096ff; color: #fff; }
.action-record { color: #e8952f; }
.action-record:hover { background: #e8952f; color: #fff; }
/* 长截图用青色，和录制的琥珀分开 —— 两颗挨着，颜色一样会点错 */
.action-longshot { color: #2ec4b6; }
.action-longshot:hover { background: #2ec4b6; color: #06302c; }
.action-close { color: #ff4d4f; }
.action-close:hover { background: #ff4d4f; color: #fff; }

.opt-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.opt-label {
  font-size: 11px;
  color: #888;
  min-width: 28px;
  text-align: right;
}

.color-btn {
  width: 20px; height: 20px;
  border-radius: 4px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 100ms;
}
.color-btn.active { border-color: #4096ff; }
.color-btn.no-fill {
  background: repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 8px 8px;
}

.size-btn {
  padding: 2px 8px;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 4px;
  background: transparent;
  color: #ccc;
  font-size: 11px;
  cursor: pointer;
  transition: all 100ms;
}
.size-btn.active {
  background: #4096ff;
  color: #fff;
  border-color: #4096ff;
}
.size-btn:hover { border-color: #4096ff; }

/* ===== 工具属性面板（独立浮动，可拖拽） ===== */
.tool-panel {
  position: absolute;
  z-index: 200;
  padding: 12px 14px;
  background: rgba(30, 30, 30, 0.95);
  border-radius: 10px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 3px rgba(64,150,255,0.3);
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 210px;
}

.panel-drag-handle {
  display: flex;
  justify-content: center;
  padding: 2px 0 4px;
  cursor: grab;
  color: #555;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin: -4px -4px 0;
}
.panel-drag-handle:active { cursor: grabbing; }

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.panel-title {
  font-size: 11px;
  color: #666;
  letter-spacing: 0.3px;
}

.color-btn.lg {
  width: 24px;
  height: 24px;
}

.font-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 30px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 5px;
  background: transparent;
  color: #bbb;
  cursor: pointer;
  transition: all 100ms;
}
.font-btn.active {
  background: #4096ff;
  color: #fff;
  border-color: #4096ff;
}
.font-btn:hover { border-color: #4096ff; color: #fff; }

.align-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 30px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 5px;
  background: transparent;
  color: #bbb;
  cursor: pointer;
  transition: all 100ms;
}
.align-btn.active {
  background: #4096ff;
  color: #fff;
  border-color: #4096ff;
}
.align-btn:hover { border-color: #4096ff; color: #fff; }

.style-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 30px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 5px;
  background: transparent;
  color: #bbb;
  cursor: pointer;
  transition: all 100ms;
}
.style-btn.active {
  background: #4096ff;
  color: #fff;
  border-color: #4096ff;
}
.style-btn:hover { border-color: #4096ff; color: #fff; }
.style-btn:disabled { opacity: 0.3; cursor: default; }
.style-btn.sm { width: 30px; height: 28px; }

.stroke-preview {
  display: block;
  width: 18px;
  background: currentColor;
  border-radius: 1px;
  min-height: 1px;
}

.slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255,255,255,0.15);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #4096ff;
  border: 2px solid #fff;
  cursor: pointer;
}

.slider-val {
  min-width: 28px;
  text-align: right;
  font-size: 12px;
  color: #bbb;
  user-select: none;
}

/* ===== 水印文本输入 ===== */
.wm-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: #fff;
  font-size: 12px;
  outline: none;
}
.wm-input:focus {
  border-color: rgba(64, 150, 255, 0.6);
}
.wm-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

/* ===== 内联文字编辑器 ===== */
.inline-text-editor {
  position: absolute;
  z-index: 50;
  min-width: 4px;
  min-height: 1.4em;
  max-width: 50vw;
  padding: 2px 4px;
  border: 1px dashed rgba(64, 150, 255, 0.5);
  border-radius: 2px;
  outline: none;
  resize: none;
  line-height: 1.3;
  overflow: hidden;
  background: transparent;
  white-space: pre;
  word-wrap: normal;
}
.inline-text-editor::placeholder {
  color: rgba(255,255,255,0.3);
}

/* OCR */
.ocr-layer {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  pointer-events: auto;
  cursor: text;
}
.ocr-block {
  user-select: text;
  background: rgba(255, 255, 255, 0.42);
  backdrop-filter: blur(2px);
  color: #1e1e1e;
  font-family: 'Microsoft YaHei', sans-serif;
  cursor: text;
  padding: 0 2px;
  box-sizing: border-box;
}
.ocr-block::selection {
  background: rgba(64, 150, 255, 0.4);
}

/* 翻译覆盖层 */
.translate-layer {
  position: fixed;
  top: 0; left: 0;
  width: 100vw; height: 100vh;
  pointer-events: auto;
  cursor: default;
}
.translate-block {
  position: absolute;
  background: rgba(255, 255, 255, 0.92);
  color: #1e1e1e;
  font-family: 'Microsoft YaHei', sans-serif;
  padding: 0 2px;
  border-radius: 2px;
  user-select: text;
  cursor: text;
  box-sizing: border-box;
}
.translate-block::selection {
  background: rgba(64, 150, 255, 0.4);
}
.translate-loading-overlay {
  position: absolute;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 8px;
  backdrop-filter: blur(8px);
}

/* Loading spinner */
@keyframes spin {
  to { transform: rotate(360deg); }
}
.spin {
  animation: spin 1s linear infinite;
}
</style>
