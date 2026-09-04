<script setup lang="ts">
/**
 * Markdown 编辑器 —— Obsidian 那种「边打边渲染」。
 *
 * # 为什么是 CodeMirror 而不是 ProseMirror / Milkdown
 *
 * 那一类富文本内核会把文档解析进自己的模型,保存时再序列化回 Markdown ——
 * 也就是**每次保存都重写整份文件**。模型不认识的语法会被改写或丢掉,而用户
 * 的库里恰恰全是这种东西:Obsidian 的 `[[双链]]`、`%%` 注释、`==高亮==`、
 * callout、内嵌的 ```base 代码块。这是在他真实的笔记库上跑,不能冒这个险。
 *
 * CodeMirror 的文档**就是那串 Markdown 文本**,所有渲染都是视图层的装饰,
 * 存出去和纯 textarea 逐字节相同。Obsidian 自己也是这么做的。
 *
 * # 装饰从哪来
 *
 * @atomic-editor/editor(MIT)。它本身是一组 CM6 扩展,另外附带一个 React
 * 组件 —— **我们只挑扩展,不碰那个组件**,所以这里没有 React。
 * 那个包 sideEffects 标了 false,生产构建会把组件连同它的 react import
 * 一起摇掉。
 *
 * 下面这份扩展清单是照它 React 组件里那份抄的,**顺序有讲究**:
 * 语法解析要先于装饰、装饰要在主题之后、更新监听要在装饰之后。
 */
import { shallowRef, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'
import { EditorState, Compartment, Annotation, Prec, Transaction } from '@codemirror/state'
import {
  EditorView, keymap, drawSelection, dropCursor, rectangularSelection,
  highlightActiveLine, highlightSpecialChars,
} from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  indentOnInput, foldService, foldEffect, unfoldEffect, foldedRanges, codeFolding,
  syntaxTree,
} from '@codemirror/language'
import { Decoration, WidgetType, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import {
  inlinePreview, imageBlocks, tables, wikiLinks,
  atomicEditorTheme, atomicMarkdownSyntax, highlightMarkdown,
  autoCloseCodeFence, extendEmphasisPair, startAsteriskList,
  readOnlyExtension,
} from '@atomic-editor/editor'
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages'
import '@atomic-editor/editor/styles.css'
import type { WikiLinkSuggestion } from '@atomic-editor/editor'
import { isDarkNow, settings, VAULT_FONT_STACK, type VaultFont } from '@/composables/useAppSettings'
import { mathAndDiagrams, resetMermaidTheme } from './editor/mathBlocks'
import { tableAffordances } from './editor/tableTools'
import { tableScrollbars, tableScrollbarTheme } from './editor/tableScrollbar'
import { strictHeadings } from './editor/strictHeadings'
import { listIndent, listBackspace, taskSpace } from './editor/listTools'
import {
  markdownShortcuts, applyColor, togglePair, clearInlineFormat, type InkColor,
} from './editor/markdownShortcuts'
import { markdownComments, markdownCommentsTheme } from './editor/comments'
import { hideMarks, hideMarksTheme, markerAtomicRanges } from './editor/hideMarks'
import { codeAffordances, codeAffordanceTheme } from './editor/codeAffordances'
import { plainCodeText } from './editor/plainCodeText'
import { EXTRA_CODE_LANGUAGES } from './editor/extraCodeLanguages'
import { inlineHtmlStyles, inlineHtmlTheme } from './editor/inlineHtml'
import { scrollMemory, foldMemory } from './editor/viewMemory'
import { htmlPasteToMarkdown } from './editor/htmlPaste'
import { caretAfterInsert } from './editor/caretAfterInsert'
import { useI18n } from '@/i18n'
import { strictLists } from './editor/strictLists'
import { listMarkers } from './editor/listMarkers'

const props = withDefaults(defineProps<{
  modelValue: string
  readOnly?: boolean
  /** 笔记主题色(十六进制)。复选框、选区高亮、链接都用它 */
  accent?: string
  /**
   * 把笔记里的相对路径解析成 webview 能加载的 URL。
   *
   * 图片写在笔记里是 `![](attachments/a.png)` 这种相对路径,webview 拿它
   * 当成相对于自己那个 http 源去请求,当然什么都拿不到。这个回调由外面
   * (它知道库根在哪)负责翻译成 asset:// 地址。
   */
  resolveAsset?: (src: string) => string
  /** 正文字体档位 */
  font?: VaultFont
  /** 正文字号(px) */
  fontSize?: number
  /** 铺满整栏。关掉时收窄居中 —— 靠 --atomic-editor-measure 那个变量控制 */
  fullWidth?: boolean
  /** 标题和引用要不要上色。关掉就全是正文色,只靠字号粗细分层 */
  colorHeadings?: boolean
  /**
   * 记号什么时候露出来。
   *
   * · `source` —— 关掉所有实时渲染装饰,看纯 Markdown 原文(和 VSCode 一样)
   * · `reveal` —— 平时收起来,光标点到那一段才露出原文给你改
   * · `clean`  —— 点上也不露,只看效果
   */
  markMode?: 'source' | 'reveal' | 'clean'
  /** 打字机滚动:光标行始终保持在视口中间。禅模式下打开 */
  typewriter?: boolean
  /** 底部有没有浮着状态栏。有的话正文要多留一截,不然最后一行被压住 */
  statusBar?: boolean
  /**
   * 滚动位置记在哪个名下(一般给笔记的路径)。
   *
   * 切到别的页面时整个笔记页会被 v-if 拆掉,编辑器连同滚动位置一起没了,
   * 回来重建就停在文档末尾。这里按这个 key 把位置存在模块级的表里 ——
   * 组件销毁了它还在,回来照着恢复。换标签页时同理。
   */
  scrollKey?: string
  /** 点了渲染出来的链接。Tauri 里要走系统浏览器,不能让 webview 自己导航走 */
  onOpenLink?: (url: string) => void
  /** [[双链]] 的自动补全候选 */
  wikiSuggest?: (q: string) => Promise<WikiLinkSuggestion[]>
  /** 点了 [[双链]] */
  onOpenWiki?: (target: string) => void
  /**
   * 粘贴进来一张图。回调负责把它存好,返回要插进正文的那段 markdown;
   * 返回空串就当没这回事(编辑器不会替它插任何东西)。
   */
  onPasteImage?: (file: File) => Promise<string>
}>(), { readOnly: false, accent: '#8b6cef', font: 'default', fontSize: 16, fullWidth: false,
   colorHeadings: true, markMode: 'reveal', typewriter: false, statusBar: false })

/** 这一档要不要「点上也不露」。三处装饰都问它 */
const cleanMarks = () => props.markMode === 'clean'
/** 装饰整批:源码模式给一套只上色不渲染的,其余两档给完整的实时渲染 */
const modeExtensions = () => (props.markMode === 'source' ? sourceMarks : decorations(cleanMarks()))

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const { t } = useI18n()

/** 标记「这次改动是外面灌进来的」,用来区分真正的用户输入 */
const fromProp = Annotation.define<boolean>()

/** 路径 → 滚动位置。模块级,组件被拆掉也留着 */


const host = shallowRef<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const roCompartment = new Compartment()
/*
  源码模式靠这个格子换扩展,不是靠 CSS。

  第一版想用 CSS 把装饰摁回普通文字 —— 那是错的:图片、表格、[[双链]] 这些
  是 `Decoration.replace`,**原文那段 DOM 根本不存在**,被换成了一个部件,
  CSS 再怎么写也变不回文字。真要看原文只能把产生装饰的扩展撤掉。

  用 Compartment 而不是重建 EditorState:重建会把光标、选区、滚动位置、
  撤销历史全丢掉,切一次源码模式回来就得重新找位置。格子只换这一小撮扩展,
  文档本身一动不动。
*/
const decoCompartment = new Compartment()
/*
  撤销历史单独一个隔间。

  换笔记时**必须把它重配一次**(重配会把历史状态清空)。这个编辑器在切标签时
  是复用的:同一个 EditorView 换一份文档。历史不清的话,撤到这篇最早那一步之后
  再按 Ctrl+Z,撤的就是「把上一篇换成这一篇」那一步 —— 屏幕上当场变回上一篇的正文,
  而标签、路径还是这一篇,再按一下又能撤到上上篇。用户看到的是「撤销把我的笔记换掉了」。
*/
const historyCompartment = new Compartment()

/*
  这个库的浅色主题靠根元素上的 data-theme="light",而我们全局用的是
  documentElement 上的 .dark 类。两套约定,所以这里把我们的状态翻译过去。
*/
const themeAttr = computed(() => (isDarkNow() ? undefined : 'light'))

/**
 * 勾要画成什么颜色 —— 由主题色的亮度决定,不是由深浅色主题决定。
 *
 * 勾是画在**主题色填充的方块上**的,所以它要和主题色对比,和页面背景无关。
 * 写死白色的话,用户挑了浅色主题色(比如那个橙)之后勾就基本看不见了。
 * 这里用 sRGB 相对亮度:亮底给深勾,暗底给白勾。
 */
const checkColor = computed(() => {
  const h = props.accent.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.5 ? '#14121c' : '#ffffff'
})

/*
  把编辑器的主题变量接到我们自己的 token 上。

  这个库的配色本来是自成一套的深色主题 —— 直接用的话,笔记页会和应用其他地方
  长得不像。它把每个颜色都开成了 CSS 变量,所以这里逐个映射过去,
  深浅色切换也自动跟着走(我们的 token 本来就是跟着主题变的)。

  bg 设成透明:底色由外面那张浮空卡片画,编辑器自己再画一层会盖住材质。
  measure 就是正文列宽 —— none 等于铺满,给个 ch 值就是收窄居中(库里默认就是居中的)。
*/
const cssVars = computed(() => ({
  '--atomic-editor-bg': 'transparent',
  '--atomic-editor-bg-surface': 'transparent',
  '--atomic-editor-bg-panel': 'var(--popover)',
  '--atomic-editor-fg': 'var(--foreground)',
  '--atomic-editor-fg-muted': 'var(--muted-foreground)',
  '--atomic-editor-fg-faint': 'color-mix(in srgb, var(--muted-foreground) 60%, transparent)',
  '--atomic-editor-border': 'var(--border)',
  '--atomic-editor-accent': props.accent,
  '--atomic-editor-accent-soft': `color-mix(in srgb, ${props.accent} 18%, transparent)`,
  '--atomic-editor-link': props.accent,
  '--atomic-editor-link-hover': props.accent,
  '--xg-check': checkColor.value,
  // 标题色:主题色往正文色靠一点,免得整页跳
  // 一级直接用主题色本身,不再往正文色兑 —— 兑过之后一级和二级几乎分不出来
  '--xg-head': props.accent,
  '--xg-chevron': 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23000\' stroke-width=\'2.5\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpath d=\'m6 9 6 6 6-6\'/%3E%3C/svg%3E")',
  '--atomic-editor-code-bg': 'color-mix(in srgb, var(--foreground) 7%, transparent)',
  '--atomic-editor-selection-bg': `color-mix(in srgb, ${props.accent} 28%, transparent)`,
  '--atomic-editor-font': VAULT_FONT_STACK[props.font],
  '--atomic-editor-font-mono': "'JetBrains Mono', Consolas, monospace",
  '--atomic-editor-body-size': props.fontSize + 'px',
  /*
    收窄时的正文列宽。

    用 em 不用 ch:ch 量的是「0」的宽度,中文里一个字比它宽得多,
    同样的 ch 值中英文排出来的行长差一大截。em 跟着字号走,换字号也不用重算。
    45em ≈ 720px(16px 字号下),比 Obsidian 默认的 700px 略宽一点。

    加的那 90px 是左右两侧的内边距(左 38 + 右 52,右边宽是给悬浮大纲腾的)。
    box-sizing 是 border-box,内边距算在 max-width 里面 —— 不补回去的话,
    给收窄模式加上外边距之后阅读宽度会凭空少一截。
  */
  '--atomic-editor-measure': props.fullWidth ? 'none' : '45em',
}))


/* ── 标题折叠 ────────────────────────────────────────────

   CM6 自带的 markdown 语言没有「按标题折叠整段」这回事(它只认代码块之类的
   语法节点),所以这两件事都得自己写:

   1. foldService —— 告诉编辑器一个标题行能折到哪。范围是从标题行末尾,
      到下一个**同级或更高级**标题之前。子标题连同正文一起收进去,
      和 Obsidian / Notion 的手感一致。
   2. 一个画在行首的把手。CM6 官方的 foldGutter 是独立一栏,会把正文整体推开
      一截,和我们这种「正文居中、左右留白」的版式冲突。这里改成绝对定位,
      压在左边那圈 padding 上,鼠标不在那一行就不显示 —— 不占版面。
*/

/** 一行是标题的话返回它的级别(1~6),否则 0 */
function headingLevel(text: string) {
  const m = /^(#{1,6})\s/.exec(text)
  return m ? m[1].length : 0
}

const headingFold = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const level = headingLevel(line.text)
  if (!level) return null
  // 往下找第一个级别 <= 自己的标题,那之前的全归这一段
  let end = state.doc.length
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const l = state.doc.line(i)
    const lv = headingLevel(l.text)
    if (lv && lv <= level) {
      end = l.from - 1
      break
    }
  }
  // 标题底下什么都没有就不给折 —— 折了也看不出区别,只是多一个能点的东西
  return end > line.to ? { from: line.to, to: end } : null
})

class FoldHandle extends WidgetType {
  constructor(readonly folded: boolean, readonly pos: number) {
    super()
  }

  eq(o: FoldHandle) {
    return o.folded === this.folded && o.pos === this.pos
  }

  toDOM(view: EditorView) {
    const b = document.createElement('span')
    b.className = 'xg-fold-handle' + (this.folded ? ' is-folded' : '')
    b.title = ''
    b.onmousedown = (e) => {
      // 必须挡住:否则这一下会先把光标挪到标题行上,折叠之后光标停在
      // 一个被收起来的位置,再打字就是在看不见的地方改东西
      e.preventDefault()
      e.stopPropagation()
      toggleFoldAt(view, this.pos)
    }
    return b
  }

  ignoreEvent() {
    return false
  }
}

function toggleFoldAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos)
  let existing: { from: number, to: number } | null = null
  foldedRanges(view.state).between(line.to, line.to, (from, to) => {
    existing = { from, to }
  })
  if (existing) {
    view.dispatch({ effects: unfoldEffect.of(existing) })
    rememberFolds()
    return
  }
  const range = view.state.facet(foldService)
    .map((f) => f(view.state, line.from, line.to))
    .find(Boolean)
  if (range) view.dispatch({ effects: foldEffect.of(range) })
  rememberFolds()
}

/*
  折叠状态跨切标签、跨切页面记住。

  编辑器在切标签时是复用的(同一个 EditorView 换一份文档),而 CM6 的折叠状态是
  EditorState 的一部分 —— 文档一换,折起来的段落全弹开了。收了半天的长文,
  切去别的标签看一眼再回来,又是全展开,得重收一遍。

  # 记录的时机:折的那一刻,不是切走的那一刻

  一开始是在「切标签」的 watcher 里顺手记一笔的,结果记出来永远是空的 ——
  换标签时 modelValue(正文)比 scrollKey(路径)先到,轮到 watcher 跑的时候
  编辑器里装的**已经是下一篇的正文**了,拿着上一篇的路径去读它的折叠,
  当然什么都没有。谁先谁后是 Vue 的调度细节,不该拿它当地基。

  所以改成:一折一展就地记一笔 —— 那个瞬间路径和正文一定是同一篇的。
  切回来时只管恢复,不用再关心顺序。

  记行号而不是字符偏移:别处改了字数偏移就全错位了,而行号在「切走再回来」
  这种场景里稳定得多;对不上的(那一行已经不是标题了)恢复时直接丢掉。
*/


function rememberFolds(key = props.scrollKey) {
  const ed = view.value
  if (!ed || !key) return
  const lines: number[] = []
  foldedRanges(ed.state).between(0, ed.state.doc.length, (from) => {
    lines.push(ed.state.doc.lineAt(from).number)
    return undefined
  })
  if (lines.length) foldMemory.set(key, lines)
  else foldMemory.delete(key)
}

function restoreFolds() {
  const ed = view.value
  const key = props.scrollKey
  const lines = key ? foldMemory.get(key) : undefined
  if (!ed || !lines?.length) return
  const effects = []
  for (const n of lines) {
    if (n > ed.state.doc.lines) continue
    const line = ed.state.doc.line(n)
    if (!headingLevel(line.text)) continue      // 那一行已经不是标题了,这条记录作废
    const range = ed.state.facet(foldService)
      .map((f) => f(ed.state, line.from, line.to))
      .find(Boolean)
    if (range) effects.push(foldEffect.of(range))
  }
  if (effects.length) ed.dispatch({ effects })
}

/** 把这一篇里折起来的段落全部展开 —— 收多了一个个点回去太费事 */
function unfoldAll() {
  const ed = view.value
  if (!ed) return
  const ranges: { from: number, to: number }[] = []
  foldedRanges(ed.state).between(0, ed.state.doc.length, (from, to) => { ranges.push({ from, to }) })
  if (!ranges.length) return
  ed.dispatch({ effects: ranges.map((r) => unfoldEffect.of(r)) })
  if (props.scrollKey) foldMemory.delete(props.scrollKey)
}

/** 这一篇有没有折起来的段落(外面用它决定要不要显示「全展开」) */
function hasFolds() {
  const ed = view.value
  if (!ed) return false
  let any = false
  foldedRanges(ed.state).between(0, ed.state.doc.length, () => { any = true })
  return any
}

/** 给每个能折的标题行挂一个把手 */
const foldHandles = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view)
  }

  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>()
    const folded = foldedRanges(view.state)
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos)
        if (headingLevel(line.text)) {
          let isFolded = false
          folded.between(line.to, line.to, () => { isFolded = true })
          b.add(line.from, line.from, Decoration.widget({
            widget: new FoldHandle(isFolded, line.from),
            side: -1,
          }))
        }
        pos = line.to + 1
      }
    }
    return b.finish()
  }
}, { decorations: (v) => v.decorations })

/*
  把图片的相对路径改成能加载的地址。

  库里那个 imageBlocks 是直接 `img.src = 原文` 的,没有留解析钩子,
  所以只能等它把 img 建出来之后再改一遍。用 ViewPlugin 在每次更新后扫一遍
  可视区里的 img —— 数量就是屏幕上那几张,不值得为它上 MutationObserver。

  只动相对路径:http(s)、data:、asset: 开头的都已经是能用的地址,碰了反而会坏。
*/
const fixImageSrc = ViewPlugin.fromClass(class {
  view: EditorView
  constructor(view: EditorView) {
    this.view = view
    this.fix()
  }

  update() {
    this.fix()
  }

  fix() {
    const resolve = currentResolveAsset
    if (!resolve) return
    for (const img of this.view.dom.querySelectorAll('img')) {
      const raw = img.getAttribute('data-xg-raw') ?? img.getAttribute('src') ?? ''
      if (!raw || /^(https?:|data:|blob:|asset:|http:\/\/asset)/.test(raw)) continue
      // 记下原文:CM6 会复用 DOM,不记的话第二遍就拿转换后的地址再转一次
      img.setAttribute('data-xg-raw', raw)
      const url = resolve(raw)
      if (url && url !== img.getAttribute('src')) img.setAttribute('src', url)
    }
  }
}, {})

/*
  ViewPlugin 是在 extensions() 里构造的,拿不到 props。这个模块级变量就是
  给它捎话用的 —— 同一时刻只有一个笔记编辑器活着,不存在串台。
*/
let currentResolveAsset: ((src: string) => string) | null = null

/**
 * 所有「把原文换成好看的东西」的扩展。源码模式下整批不装。
 *
 * 顺序有讲究:语法高亮要先于装饰,装饰要在主题之后。
 */
/*
  源码模式的语法配色。

  # 只给记号上色,正文保持前景色

  黑底白字、白底黑字 —— 这是读原文时最舒服的状态。VSCode 里整行标题都是绿的,
  那是因为它把 `markup.heading` 当成一个整体;但在这儿我们是**编辑**这份原文,
  正文一旦跟着变色,读起来就不像自己写的字了。所以只有 `#`、`-`、`>` 这些
  **记号本身**染色,内容一律不动。

  # 为什么按节点名而不是按 tag

  lezer-markdown 把 HeaderMark、ListMark、QuoteMark、EmphasisMark、CodeMark
  **全都标成同一个 tag**(processingInstruction),用 HighlightStyle 只能让它们
  一个颜色。想让 `#` 是绿的、`-` 是橙的,就只能自己走一遍语法树按节点名区分。

  # 颜色出处

  取自用户 VSCode 里那套 Vitesse(antfu 的主题)的 markdown 取值,深浅两套都抄了,
  不是我随手配的。
*/
const MARK_CLASS: Record<string, string> = {
  // 标题整行先染绿,`###` 那几个字符随后被 HeaderMark 盖成灰 ——
  // 顺序靠的是「后进的节点范围更小、嵌在里面」,内层的 color 自然赢
  ATXHeading1: 'xg-src-head',
  ATXHeading2: 'xg-src-head',
  ATXHeading3: 'xg-src-head',
  ATXHeading4: 'xg-src-head',
  ATXHeading5: 'xg-src-head',
  ATXHeading6: 'xg-src-head',
  SetextHeading1: 'xg-src-head',
  SetextHeading2: 'xg-src-head',
  HeaderMark: 'xg-src-mark',
  ListMark: 'xg-src-list',
  QuoteMark: 'xg-src-mark',
  EmphasisMark: 'xg-src-mark',
  StrikethroughMark: 'xg-src-mark',
  CodeMark: 'xg-src-code',
  LinkMark: 'xg-src-mark',
  URL: 'xg-src-link',
  HorizontalRule: 'xg-src-list',
  TaskMarker: 'xg-src-mark',
}

const MARK_DECOS: Record<string, Decoration> = Object.fromEntries(
  Object.entries(MARK_CLASS).map(([k, v]) => [k, Decoration.mark({ class: v })]),
)

/** 走一遍可视区的语法树,给记号挂上类名 */
const sourceMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view)
  }

  build(view: EditorView) {
    const b = new RangeSetBuilder<Decoration>()
    for (const { from, to } of view.visibleRanges) {
      syntaxTree(view.state).iterate({
        from,
        to,
        enter: (node) => {
          const d = MARK_DECOS[node.name]
          if (d && node.to > node.from) b.add(node.from, node.to, d)
        },
      })
    }
    return b.finish()
  }
}, { decorations: (v) => v.decorations })

/**
 * 实时渲染那一整套装饰。
 *
 * `clean` = 「点上也不露记号」那一档。它只传给**我们自己写的**那两个插件
 * （行内 HTML、`%%注释%%`）—— 库自带的 inlinePreview 没有这个开关，
 * 那几种记号（`**` `==` `~~`）走 CSS 把露出来的那截藏掉，见样式里的 `.is-clean`。
 */
function decorations(clean = false) {
  const openLink = (url: string) => props.onOpenLink?.(url)
  return [
    atomicMarkdownSyntax,
    tables({ onLinkClick: openLink }),
    imageBlocks(),
    fixImageSrc,
    inlinePreview({ onLinkClick: openLink }),
    // 列表标记按层级换样子(1/a/i、●/○/▪)。必须排在 inlinePreview 之后 ——
    // 它盖的正是 inlinePreview 画出来的那套标记
    listMarkers(),
    // 公式和流程图。放在 inlinePreview 之后:它俩都是「整段换成一个部件」,
    // 排在前面的话行内那些装饰会先把 $...$ 里的字符啃掉
    mathAndDiagrams(isDarkNow),
    tableAffordances(),
    // 宽表格的横向滚动条：跟着表格走、到底就贴底。规矩见那个文件
    tableScrollbars,
    tableScrollbarTheme,
    // 代码块右上角的复制按钮(写了语言就显示语言名,点它同样是复制)
    codeAffordances({ copy: t('vault.codeCopy'), copied: t('vault.codeCopied') }),
    codeAffordanceTheme,
    plainCodeText,
    // 行内 HTML:<span style="color:blue"> 这类真的按样式画出来
    inlineHtmlStyles(clean),
    inlineHtmlTheme,
    // `%%注释%%` 压暗 + 收起标记(右键菜单里那一项塞的就是这个,不认它等于那一项白给)
    markdownComments(clean),
    /*
      阅读模式:`**` `==` `#` 这些记号点上去也不露。
      **必须排在 inlinePreview 之后** —— 我们抹的正是它「因为光标在这儿」
      而特意留出来的那几个字符。
    */
    ...(clean ? [hideMarks, hideMarksTheme] : []),
    /*
      收起来的记号当成一个整体：光标不许停在 `==` 中间,不然在「看得见的最后一个字」
      后面按回车会把一对记号劈成两行,它们当场原样冒出来。两档都要。
    */
    markerAtomicRanges,
    // 输入法打出来的字,光标要落在它后面(空列表项里打全角标点会跑到前面)
    caretAfterInsert,
    wikiLinks({
      suggest: props.wikiSuggest,
      onOpen: (t) => props.onOpenWiki?.(t),
      openOnClick: true,
    }),
  ]
}

function extensions() {
  return [
    highlightSpecialChars(),
    historyCompartment.of(history()),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    rectangularSelection(),
    highlightActiveLine(),
    closeBrackets(),
    startAsteriskList,      // 回车续列表 / 空条目退一级
    taskSpace,              // `- [ ]` 后面直接打字,自动补空格
    extendEmphasisPair,     // **加粗** 成对扩写
    autoCloseCodeFence,     // ``` 自动配对
    EditorView.lineWrapping,
    /*
      禅模式的「打字机」那一半:让光标行停在视口中间。

      CM6 自带的做法是给 .cm-content 上下各垫半屏的内边距,再每次滚到光标 ——
      垫内边距会让文档开头凭空多出半屏空白,很怪。这里只在光标移动时滚一次,
      `y: 'center'` 就够,不动布局。
    */
    EditorView.updateListener.of((u) => {
      if (!props.typewriter || !u.selectionSet) return
      const pos = u.state.selection.main.head
      // **不能在 update 里同步 dispatch** —— CM6 会警告「重入更新」,
      // 严重时会丢掉这一轮的其他变更。挪到下一帧,那时候这轮更新已经收尾了。
      requestAnimationFrame(() => {
        u.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      })
    }),
    codeFolding(),
    headingFold,
    foldHandles,
    /*
      **这个类不能少。** 库那份 styles.css 里,正文列宽和字体族那条规则
      写的是 `.atomic-cm-editor .cm-content` —— 类不在,整条就不匹配,
      表现是 --atomic-editor-measure 怎么改都没反应(行宽和字体族一起失效,
      但字号仍然生效,因为那个是主题扩展里注入的,很容易误判成"变量没接上")。
      库自己的 React 组件把这个类加在容器上,我们不用那个组件,所以自己加。
    */
    EditorView.editorAttributes.of({ class: 'atomic-cm-editor' }),
    /*
      拼写检查交给系统,不自己带词典。

      webview 底下就是 Chromium,它自带各语言的拼写检查和右键「添加到词典」——
      自己塞一份词典进来体积大、更新不了、还只能覆盖有限几种语言。
      默认关着:中文笔记里满屏红波浪线比不检查还烦,想要的人去设置里开。
    */
    EditorView.contentAttributes.compute([], () => ({
      spellcheck: String(settings.vaultSpellcheck),
    })),
    search({ top: true }),
    /*
      查找替换面板的汉化和配色。

      CM6 自带的这块面板是给「代码编辑器」用的:全英文、自己带一套深色配色,
      放在这个浅色笔记界面里像贴上去的补丁。phrases 走它的官方 i18n 接口,
      配色则全部改走应用的 CSS 变量,深浅色跟着界面一起变。
    */
    EditorState.phrases.of(SEARCH_ZH),
    searchPanelTheme,
    /*
      base: markdownLanguage 才有 GFM(表格、删除线、任务列表、自动链接);
      纯 CommonMark 的话 inlinePreview 根本看不到 Task / Table 这些节点。
      extensions: highlightMarkdown 是 ==高亮== 的解析规则 —— 少了它
      `==xx==` 会原样显示,而且不报错,很难看出是解析层缺东西。
      strictLists 收紧列表和分隔线的判定,细节见那个文件的注释。
    */
    markdown({
      base: markdownLanguage,
      codeLanguages: [...ATOMIC_CODE_LANGUAGES, ...EXTRA_CODE_LANGUAGES],
      extensions: [highlightMarkdown, strictLists, strictHeadings],
    }),
    /*
      括号自动配对扩展到 Markdown 的成对符号上。

      **`[` 不在里面**,故意的。它一自动补 `]`,任务项就打不出来了:
      打 `[` 得到 `[|]`,再按 `]` 是「跨过闭括号」,那个本该在括号里的空格
      就落到了外面 —— 打出来是 `- []  正文`(两个空格),不是任务项。
      `[[双链]]` 不受影响:那个补全自己会把 `]]` 补上,不靠这里。
    */
    markdownLanguage.data.of({
      closeBrackets: { brackets: ['(', '{', "'", '"', '*', '_', '`'] },
    }),
    atomicEditorTheme,
    /*
      空列表项上的退格要盖过所有人。

      atomic-editor 的 wiki 链接挂的是 Prec.highest 的退格、表格挂的是 Prec.high,
      markdown 自带的 deleteMarkupBackward 也在。普通优先级排第一位仍可能被越过,
      于是空项被换成一行空白 —— 列表当场断成两截。listBackspace 只在真正该管的
      情形下返回 true,其余一律放行,所以拔到最高不会挡了别人的事。
    */
    Prec.highest(keymap.of([{ key: 'Backspace', run: listBackspace }])),
    keymap.of([
      /*
        列表的缩进要排在 indentWithTab **前面**。

        自带那个是给代码用的:2 空格、不认列表、更不会重排序号。
        我们这个只在选区碰到列表项时接管,别处返回 false 原样放行。
      */
      { key: 'Tab', run: listIndent(1) },
      { key: 'Shift-Tab', run: listIndent(-1) },
      /*
        退格排在 markdownKeymap 前面 —— 它那个 deleteMarkupBackward 是
        「把标记换成等宽空格」,会留下一行只有空白的半级行,而空白行是列表的
        终止符,后面整片的层级会跟着散架。理由见 listBackspace 的注释。
        (真正的优先级在下面的 Prec.highest 那份 —— 光排在数组前面还不够,
        atomic-editor 的 wiki 链接和表格各自挂了 highest / high 的退格。)
      */
      { key: 'Backspace', run: listBackspace },
      /*
        格式快捷键排在 defaultKeymap 前面。

        重叠的其实只有一个:macOS 的 defaultKeymap 里 Ctrl-b 是「光标左移一格」
        (那套 emacs 键位),而我们要拿它当加粗。排在前面就够了 ——
        不需要 Prec.high,上面那些 Tab / Backspace 才是真会打架的。
      */
      ...markdownShortcuts,
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...markdownKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    // 装饰整批放进格子里:换显示档位时整批换掉(源码模式一次性撤光)
    markdownCommentsTheme,
    decoCompartment.of(modeExtensions()),
    /*
      粘贴图片。

      **必须 preventDefault**,否则 CM6 会把剪贴板里那份文本表示也插进来 ——
      从截图工具粘过来经常带一段文件名,不拦的话正文里会多出一行垃圾。

      存盘是异步的,而 paste 事件不等人,所以先把光标位置记下来,
      存完再按那个位置插 —— 中间用户可能已经把光标挪走了。
    */
    EditorView.domEventHandlers({
      paste(e, view) {
        if (!e.clipboardData) return false

        const handler = props.onPasteImage
        const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
        if (handler && file) {
          e.preventDefault()
          const at = view.state.selection.main
          void handler(file).then((md) => {
            if (!md) return
            view.dispatch({
              changes: { from: at.from, to: at.to, insert: md },
              selection: { anchor: at.from + md.length },
            })
            view.focus()
          })
          return true
        }

        /*
          带表格的富文本:自己转成 markdown 表格再插。

          剪贴板里 HTML 和纯文本各有一份,默认插的是纯文本那份 —— 而浏览器给的
          纯文本会把单元格首尾相接,粘完读不出哪一格是哪一格。别的内容一律放行,
          走原来的纯文本粘贴(见 htmlPaste.ts 里的取舍)。
        */
        const md = htmlPasteToMarkdown(e.clipboardData.getData('text/html'))
        if (!md) return false
        e.preventDefault()
        const at = view.state.selection.main
        // 表格必须自己独占几行:光标停在半行上时先空一行,后面也留一行
        const before = view.state.doc.sliceString(view.state.doc.lineAt(at.from).from, at.from)
        const insert = `${before.trim() ? '\n\n' : ''}${md}\n`
        view.dispatch({
          changes: { from: at.from, to: at.to, insert },
          selection: { anchor: at.from + insert.length },
          userEvent: 'input.paste',
        })
        return true
      },
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      // 外面灌进来的内容不要再回抛。切标签时 modelValue 一变,下面那个 watch
      // 就会 dispatch 一次替换全文 —— 不拦的话这里会当成「用户编辑了」发回去,
      // 上层于是把刚点开的预览标签转成常驻,预览标签等于白做。
      if (u.transactions.some((tr) => tr.annotation(fromProp))) return
      emit('update:modelValue', u.state.doc.toString())
    }),
    roCompartment.of(readOnlyExtension(props.readOnly)),
  ]
}

onMounted(() => {
  if (!host.value) return
  currentResolveAsset = props.resolveAsset ?? null
  watchTableMenus()
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
  })
  restoreScroll()
  /*
    折叠也要在这儿恢复一次。

    切标签是同一个编辑器换文档,走下面那个 scrollKey 的 watcher;而**离开笔记页**
    (去设置、去智能体)是整个组件卸载重建 —— 那条 watcher 根本不会触发。
    收起来的段落就是在这条路上丢的:切标签回来好好的,去别的页面回来全展开了。
  */
  restoreFolds()
})

onBeforeUnmount(() => {
  rememberScroll()
  menuObserver?.disconnect()
  menuObserver = null
  currentResolveAsset = null
  view.value?.destroy()
  view.value = null
})

function rememberScroll(key = props.scrollKey) {
  const ed = view.value
  if (ed && key) scrollMemory.set(key, ed.scrollDOM.scrollTop)
}

function restoreScroll() {
  const ed = view.value
  const top = props.scrollKey ? scrollMemory.get(props.scrollKey) : undefined
  if (!ed || top === undefined) return
  /*
    要等一帧。刚建出来的编辑器只渲染了视口里那几行,scrollHeight 还没长到
    真实高度,这时候设 scrollTop 会被夹到当前高度 —— 也就是「回来停在半路」。
  */
  requestAnimationFrame(() => { if (view.value === ed) ed.scrollDOM.scrollTop = top })
}

// 换标签页:先把上一篇的位置记下来,再恢复这一篇的
watch(() => props.scrollKey, (_now, before) => {
  rememberScroll(before)
  restoreScroll()
  // 等这一份文档真的换进来了再恢复折叠 —— modelValue 的 watcher 排在后面
  nextTick(() => restoreFolds())
  /*
    顺手把撤销历史清空 —— 重配隔间就等于新开一份历史。

    换了一篇笔记,上一篇的编辑步骤就不该还能撤:在这篇里一路 Ctrl+Z 下去,
    撤到头之后本该没反应,而不是接着去撤上一篇的东西(那些改动的位置在这篇里
    根本对不上,撤出来是一团乱码般的混合体)。
  */
  view.value?.dispatch({ effects: historyCompartment.reconfigure(history()) })
})

/*
  外部换了内容(切标签、外部改动)才整份替换。
  **必须先比一次** —— 不比的话,用户自己敲的每一个字都会因为 modelValue 回流
  而触发一次全文替换,光标直接跳到文末,根本没法打字。
*/
watch(() => props.modelValue, (v) => {
  const ed = view.value
  if (!ed || v === ed.state.doc.toString()) return
  /*
    换完正文要把光标放回原处。

    整篇替换会把选区映射到 0,于是外部同步一进来,正在打字的人光标就
    跳到第一行第一个字符。夹到新文档长度之内 —— 新内容可能比原来短。
  */
  const keep = Math.min(ed.state.selection.main.head, v.length)
  /*
    整份替换这一步**不进撤销历史**。它不是用户的编辑,是外部同步(切标签、
    别的程序改了文件)。进了历史的话,Ctrl+Z 会把这一步撤掉 —— 正文变回替换前的内容,
    也就是上一篇笔记。addToHistory 只管这一条事务,用户自己敲的字照常能撤。
  */
  ed.dispatch({
    changes: { from: 0, to: ed.state.doc.length, insert: v },
    selection: { anchor: keep },
    annotations: [fromProp.of(true), Transaction.addToHistory.of(false)],
  })
})

watch(themeAttr, () => {
  // mermaid 的主题是初始化时定死的,换深浅色必须让它重来一遍,
  // 否则深色界面里嵌着一张白底图
  resetMermaidTheme()
  view.value?.dispatch({
    effects: decoCompartment.reconfigure(modeExtensions()),
  })
})

watch(() => props.markMode, () => {
  view.value?.dispatch({ effects: decoCompartment.reconfigure(modeExtensions()) })
})

watch(() => props.readOnly, (ro) => {
  view.value?.dispatch({ effects: roCompartment.reconfigure(readOnlyExtension(ro)) })
})

/*
  ── 给右键菜单用的编辑动作 ──────────────────────────────

  全部走 CM6 的 dispatch,不用 document.execCommand:后者已经废弃,而且它改的是
  DOM,CM6 的文档状态不会跟着变 —— 表现是界面上看着改了、存出去还是原文。

  光标没选中东西时,行内格式(加粗之类)作用在光标所在的那个词上,
  和 Obsidian 一样 —— 否则用户得先精确选词才能用菜单,比直接打符号还慢。
*/

/**
 * 右键菜单里的加粗 / 斜体 / 删除线……
 *
 * 直接转给 editor/markdownShortcuts 里的 togglePair —— 和快捷键同一份实现。
 * 这里原来另写了一份，结果是同一类 bug 得修两遍：
 * 尾空格那条修了两次，行首 `- ` 那条又差点只修一边。
 */
function wrap(mark: string, endMark = mark) {
  const ed = view.value
  if (!ed) return
  togglePair(mark, endMark)({ state: ed.state, dispatch: (tr) => ed.dispatch(tr) })
  ed.focus()
}

/**
 * 给选中的字上色。传 null 就是把颜色去掉。
 *
 * markdown 没有「颜色」这回事,一律是夹一段行内 HTML
 * (`<span style="color:red">`) —— Obsidian、GitHub 都这么写,
 * 我们的渲染层也认得(见 editor/inlineHtml.ts)。
 * **只写颜色名不写十六进制**:颜色名会被换成 `--xg-ink-*`,亮暗各一套;
 * 写死 `#ff0000` 的话暗色模式下那抹红又暗又闷。
 */
function color(c: InkColor | null) {
  const ed = view.value
  if (!ed) return
  applyColor(c)({ state: ed.state, dispatch: (tr) => ed.dispatch(tr) })
  ed.focus()
}

/**
 * 把选中的每一行换成另一种块级样式。
 *
 * `prefix` 为空串就是「正文」—— 把已有的标题/列表/引用记号全剥掉。
 * 有序列表要重新编号,所以单独给了个 `ordered`。
 */
function setBlock(prefix: string, ordered = false) {
  const ed = view.value
  if (!ed) return
  const sel = ed.state.selection.main
  const first = ed.state.doc.lineAt(sel.from).number
  const last = ed.state.doc.lineAt(sel.to).number
  const changes = []
  // 认得出的所有块级记号,换样式前先整段剥干净,免得叠成 "> - # 标题"
  const strip = /^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/
  for (let i = first, k = 0; i <= last; i++, k++) {
    const line = ed.state.doc.line(i)
    const bare = line.text.replace(strip, '')
    const mark = ordered ? `${k + 1}. ` : prefix
    changes.push({ from: line.from, to: line.to, insert: mark + bare })
  }
  ed.dispatch({ changes })
  ed.focus()
}

/** 在光标处插入一段(表格、分隔线这类);前后自动补空行,免得和上下文粘在一起 */
function insertBlock(text: string) {
  const ed = view.value
  if (!ed) return
  const line = ed.state.doc.lineAt(ed.state.selection.main.head)
  const before = line.text.trim() ? '\n' : ''
  ed.dispatch({
    changes: { from: line.to, insert: before + '\n' + text + '\n' },
    selection: { anchor: line.to + before.length + 1 + text.length },
  })
  ed.focus()
}

async function paste(plain = false) {
  const ed = view.value
  if (!ed) return
  try {
    const text = await navigator.clipboard.readText()
    // 「以纯文本形式粘贴」= 把 Markdown 记号也一并去掉,只留字
    const out = plain ? text.replace(/[*_`~#>[\]]/g, '') : text
    const sel = ed.state.selection.main
    ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: out },
      selection: { anchor: sel.from + out.length } })
  } catch { /* 剪贴板没授权或者是空的,不值得报错 */ }
  ed.focus()
}

async function clip(cut = false) {
  const ed = view.value
  if (!ed) return
  const sel = ed.state.selection.main
  if (sel.empty) return
  try { await navigator.clipboard.writeText(ed.state.sliceDoc(sel.from, sel.to)) } catch { /* 同上 */ }
  if (cut) ed.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
  ed.focus()
}

/** 选中的那段文字。右键菜单里那条「查找 "xxx"」要拿它做标题 */
function selectedText() {
  const ed = view.value
  if (!ed) return ''
  const sel = ed.state.selection.main
  return sel.empty ? '' : ed.state.sliceDoc(sel.from, sel.to)
}

/*
  表格菜单的中文化。

  库自带的可视化表格编辑(插入/删除行列)已经能用,但菜单项是写死的英文,
  夹在一屏中文界面里很突兀,而它的配置只开放了 onLinkClick,给不了文案。

  所以在菜单弹出来的那一刻把文字换掉。用 MutationObserver 而不是定时轮询:
  菜单是点了才建、关掉就销毁的,轮询要么慢半拍要么一直空转。
*/
/** CM6 查找面板的英文原文 → 中文。键必须和它源码里的 phrase() 参数逐字一致 */
const SEARCH_ZH: Record<string, string> = {
  'Find': '查找',
  'Replace': '替换为',
  'next': '下一个',
  'previous': '上一个',
  'all': '全部',
  'match case': '区分大小写',
  'regexp': '正则',
  'by word': '全词匹配',
  'replace': '替换',
  'replace all': '全部替换',
  'close': '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '替换了 $ 处',
  'replaced match on line $': '替换了第 $ 行的一处',
  'on line': '于行',
}

/*
  查找替换面板 —— 浮空的磨砂小卡片。

  # 为什么不让它占版面

  CM6 原生把面板挂在编辑器顶上,内容整体往下推一截:一按 Ctrl+F 正文就跳一下,
  再关掉又跳回来。查找是临时动作,不该让正文为它挪窝。
  这里把面板整个抬成 absolute 浮在正文上,和应用里其他浮空卡片一个路子。

  # 磨砂要的两个条件

  背景必须是**半透明**的(纯色的话背后没东西可糊),而且不能给它上面的
  `.cm-panels` 再垫一层实底 —— 那一层会先把正文挡住,blur 到的只是那块实底。

  # 位置

  右上角,离右边留出 3rem:再往右会压到悬浮大纲那条竖线上。
*/
const searchPanelTheme = EditorView.theme({
  /*
    面板要相对**编辑器**定位,不是相对更外面那张卡片。
    不写这一句的话它会一路往上找到文档卡片,`top: 10px` 落在面包屑那条顶栏里,
    面板上半截被顶栏盖住 —— 只剩「替换」那一行露在外面。
  */
  '&': { position: 'relative' },
  '.cm-panels': {
    position: 'absolute',
    /*
      3rem 而不是贴着顶:文档那条面包屑顶栏是**浮在正文上**的,
      编辑器的上边缘就是卡片的上边缘 —— 贴顶等于钻到顶栏底下去。
      这个值要跟着顶栏高度走,顶栏改高了这里也得改。
    */
    top: '3rem',
    right: '3rem',
    left: 'auto',
    width: 'auto',
    zIndex: 5,
    background: 'none',
    border: 'none',
    color: 'var(--foreground)',
  },
  '.cm-panels-bottom': { top: 'auto', bottom: '10px' },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '6px',
    maxWidth: 'min(40rem, 70vw)',
    // 右边空出来的一条是留给关闭按钮的:它是绝对定位的,不占位
    padding: '8px 58px 8px 10px',
    position: 'relative',
    fontSize: '12px',
    borderRadius: '14px',
    border: '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
    background: 'color-mix(in srgb, var(--card) 72%, transparent)',
    backdropFilter: 'blur(18px) saturate(180%)',
    WebkitBackdropFilter: 'blur(18px) saturate(180%)',
    boxShadow: '0 2px 6px rgb(0 0 0 / 0.06), 0 12px 32px rgb(0 0 0 / 0.12)',
  },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: 'var(--muted-foreground)',
    fontSize: '12px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-panel.cm-search input[type=checkbox]': {
    accentColor: 'var(--atomic-editor-accent)',
    width: '13px',
    height: '13px',
    margin: 0,
  },
  '.cm-panel.cm-search .cm-textfield': {
    height: '28px',
    minWidth: '10rem',
    padding: '0 9px',
    fontSize: '12px',
    color: 'var(--foreground)',
    background: 'color-mix(in srgb, var(--background) 70%, transparent)',
    border: '1px solid color-mix(in srgb, var(--border) 80%, transparent)',
    borderRadius: '9px',
    outline: 'none',
    transition: 'border-color 150ms',
  },
  '.cm-panel.cm-search .cm-textfield:focus': {
    borderColor: 'var(--atomic-editor-accent)',
    background: 'var(--background)',
  },
  '.cm-panel.cm-search .cm-button': {
    height: '28px',
    padding: '0 10px',
    fontSize: '12px',
    color: 'var(--muted-foreground)',
    background: 'none',
    backgroundImage: 'none',
    border: '1px solid transparent',
    borderRadius: '9px',
    cursor: 'pointer',
    transition: 'background 150ms, color 150ms',
  },
  '.cm-panel.cm-search .cm-button:hover': {
    background: 'color-mix(in srgb, var(--foreground) 8%, transparent)',
    color: 'var(--foreground)',
  },
  '.cm-panel.cm-search .cm-button:active': {
    backgroundImage: 'none',
    background: 'color-mix(in srgb, var(--foreground) 14%, transparent)',
  },
  /*
    关闭按钮:右边一颗圆角方块,淡红底,竖着居中。

    CM6 原生只给它一个 `×` 字符加几像素内边距,点击范围就那么一丁点大,要瞄准才点得到 ——
    可点的东西不该比它看起来更小。位置上它原本夹在一堆按钮中间,和「上一个/下一个/全部替换」
    混在一起,手会点错。这里把它拎出流外:绝对定位钉在面板右侧、上下居中 ——
    面板里带不带替换那一行、换不换行,它都在同一个地方,手是有肌肉记忆的。
    红是「关掉」的通用语义,压着饱和度用,不喧宾夺主。
  */
  '.cm-panel.cm-search [name=close]': {
    position: 'absolute',
    right: '10px',
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '38px',
    height: '38px',
    padding: 0,
    margin: 0,
    fontSize: '20px',
    lineHeight: '1',
    color: 'color-mix(in srgb, #ef4444 88%, var(--foreground))',
    background: 'color-mix(in srgb, #ef4444 14%, transparent)',
    border: '1px solid color-mix(in srgb, #ef4444 28%, transparent)',
    borderRadius: '11px',
    cursor: 'pointer',
    transition: 'background 150ms, color 150ms, border-color 150ms',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    background: 'color-mix(in srgb, #ef4444 26%, transparent)',
    borderColor: 'color-mix(in srgb, #ef4444 45%, transparent)',
    color: '#fff',
  },
  '.cm-searchMatch': {
    borderRadius: '3px',
    background: 'color-mix(in srgb, var(--atomic-editor-accent) 22%, transparent)',
  },
  '.cm-searchMatch-selected': {
    background: 'color-mix(in srgb, var(--atomic-editor-accent) 45%, transparent)',
  },
}, { dark: false })

const TABLE_MENU_ZH: Record<string, string> = {
  'Insert row above': '在上方插入行',
  'Insert row below': '在下方插入行',
  'Insert column left': '在左侧插入列',
  'Insert column right': '在右侧插入列',
  'Delete row': '删除本行',
  'Delete column': '删除本列',
}

let menuObserver: MutationObserver | null = null

function localizeTableMenus(root: ParentNode) {
  for (const el of root.querySelectorAll('.cm-atomic-table-menu-item')) {
    const zh = TABLE_MENU_ZH[el.textContent?.trim() ?? '']
    if (zh) el.textContent = zh
  }
}

function watchTableMenus() {
  menuObserver = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node instanceof HTMLElement) localizeTableMenus(node)
      }
    }
  })
  menuObserver.observe(document.body, { childList: true, subtree: true })
}

defineExpose({
  unfoldAll,
  hasFolds,
  focus: () => view.value?.focus(),
  /**
   * 视口正中间落在第几行(0 起)。大纲拿它高亮「正在看的那一节」。
   *
   * 走 posAtCoords 而不是自己按行高换算 —— 文档里有图片、表格、折叠段落,
   * 每一行的高度都不一样,按平均行高算出来的位置会越滚越偏。
   */
  centerLine: () => {
    const ed = view.value
    if (!ed) return 0
    const box = ed.scrollDOM.getBoundingClientRect()
    const pos = ed.posAtCoords({ x: box.left + 8, y: box.top + box.height / 2 })
    if (pos == null) return 0
    return ed.state.doc.lineAt(pos).number - 1
  },
  /**
   * 跳到某一行(大纲点击用)。
   *
   * scrollIntoView 给 `y: 'start'` 而不是默认的 'nearest' —— 目标行如果已经在
   * 视口边缘,'nearest' 会判定"看得见"就不滚,用户点了大纲却什么都没动。
   * 顺手把光标放过去,接着就能改。
   *
   * yMargin 要留够 **顶栏高度 + 一点呼吸**:那条面包屑顶栏是浮在正文上的,
   * 留 12 的话跳过去的标题正好钻到它底下,看着像没跳对地方。
   * 44 = top-2(8) + h-9(36),再加 20 的余量。
   */
  gotoLine: (line: number) => {
    const ed = view.value
    if (!ed) return
    const n = Math.min(Math.max(line + 1, 1), ed.state.doc.lines)
    const pos = ed.state.doc.line(n).from
    ed.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 64 }),
    })
    ed.focus()
  },
  /** 当前光标所在的相对位置。外面(拖放)要按它决定往哪插 */
  insertAtCursor: (text: string) => {
    const ed = view.value
    if (!ed) return
    const at = ed.state.selection.main
    ed.dispatch({
      changes: { from: at.from, to: at.to, insert: text },
      selection: { anchor: at.from + text.length },
    })
    ed.focus()
  },
  /**
   * 选中的是第几行到第几行(1 起)。没选东西就返回光标所在那一行。
   *
   * 给「刮选一段、按 Alt+K 把它引用进对话」用 —— 引用要带行号,
   * 不然模型只知道是这个文件,不知道你说的是哪一段。
   */
  selectedLines: () => {
    const ed = view.value
    if (!ed) return null
    const sel = ed.state.selection.main
    const from = ed.state.doc.lineAt(sel.from).number
    const to = ed.state.doc.lineAt(sel.to).number
    return { from, to, empty: sel.empty }
  },
  wrap, color, setBlock, insertBlock, paste, clip, selectedText,
  selectAll: () => {
    const ed = view.value
    if (!ed) return
    ed.dispatch({ selection: { anchor: 0, head: ed.state.doc.length } })
    ed.focus()
  },
  /**
   * 清除格式。实现在 editor/markdownShortcuts 里 ——
   * 它走语法树把**记号**剥掉，而不是按字符删。
   */
  clearFormat: () => {
    const ed = view.value
    if (!ed) return
    clearInlineFormat({ state: ed.state, dispatch: (tr) => ed.dispatch(tr) })
    ed.focus()
  },
})
</script>

<template>
  <div ref="host" class="xg-md-editor h-full min-h-0 overflow-hidden"
    :class="[fullWidth ? 'is-wide' : '', colorHeadings ? 'is-colored' : '',
             markMode === 'source' ? 'is-source' : '', markMode === 'clean' ? 'is-clean' : '',
             statusBar ? 'has-statusbar' : '']"
    :data-theme="themeAttr" :style="cssVars" />
</template>

<style scoped>

/*
  标记和正文之间那截距离,以及圆点按层级换字形。

  # 为什么间距要放进 box 里面,不能用 margin

  atomic-editor 原来是 `宽 0.9em + margin-right 0.3em`。margin **不算内容**,
  所以在一条空列表项(`- ` 后面还没打字)上,光标画在标记 box 的右缘、
  margin 的**里面** —— 紧贴着圆点;等打了字,字才排在 margin 之后。
  同一行里「光标位置」和「文字位置」差着一整个 margin,看着就是
  「光标贴着圆点,一打字又跳开了」。

  所以整截距离改成放在 box 内部:box 固定 1.4em(`box-sizing: border-box`),
  margin 归零。这样光标落在 box 右缘 = 正文列,和文字对齐。

    · 有序的 `1.` `10.` 是真文字,用 `padding-right` 把它顶到左边;
    · 圆点是 ::before 画的,直接绝对定位到 box 最左。

  # 字形

  实心 → 空心 → 实心小方块,和 Notion 一样。atomic-editor 那个 `•` 是它自己
  建的部件,DOM 碰不到,只能把原字符**变透明**、用 ::before 顶上去;
  层级从行上那个 `xg-lvl-N` 类来(见 editor/listMarkers.ts)。
  变透明而不是 `font-size: 0` —— 后者会把 1.4em 一起塌成 0,正文列当场左移。
*/
/*
  **只有真正画出标记的那个元素能占凹槽。**

  有序序号被我们换成了自己的部件，而 atomic-editor 原来给序号加的那层
  `.cm-atomic-list-marker` 外壳还在（它是 mark 装饰，替换掉内容之后壳子
  仍然留在 DOM 里）。凹槽宽度要是挂在这个类上，外壳和里面的部件就各占
  一格 —— 序号被挤到左边一整格去，正文也被推远一格，看着就是
  「圆点和序号对不齐、序号离正文特别远」。

  所以：外壳一律摊平（display:inline、不占宽度），凹槽只给下面这三种
  真正画东西的元素。
*/
.xg-md-editor :deep(.cm-atomic-list-marker:not(.cm-atomic-bullet):not(.cm-atomic-task-checkbox)) {
  display: inline;
  width: auto;
  padding: 0;
  margin: 0;
}

/*
  凹槽本体。宽度 1.4em，和 xg-ind-N 每一级的缩进量**必须相等** ——
  这样下一级的标记框左缘正好落在上一级正文的起点上（Notion 就是这么排的）。

  间距放在 box 内部（padding，不是 margin）：margin 不算内容，
  一条空列表项上光标会画在 margin 里面、紧贴着标记，一打字又跳开。
*/
.xg-md-editor :deep(.xg-ordinal),
.xg-md-editor :deep(.cm-atomic-bullet),
.xg-md-editor :deep(.cm-atomic-task-checkbox) {
  box-sizing: border-box;
  width: 1.4em;
  margin: 0;
  text-align: left;
  /*
    **必须显式清零。**`text-indent` 是会继承的,而带标记那行挂着
    `text-indent: -1.4em`(用来把标记拽进凹槽)。inline-block 是块级容器,
    它会**再**把这个负缩进作用到自己的第一行上 —— 序号被推出框外整整一格,
    框里空着,看着就是「序号和圆点差一格、序号离正文特别远」。
    圆点是绝对定位画的,不受 text-indent 影响,所以只有序号出问题。
  */
  text-indent: 0;
}

.xg-md-editor :deep(.xg-ordinal),
.xg-md-editor :deep(.cm-atomic-bullet) { display: inline-block; }

/* 序号是真文字，右边留一点，别贴着正文 */
.xg-md-editor :deep(.xg-ordinal) { padding-right: 0.3em; }

/*
  复选框：方框改成 ::before 画，元素本身只当那个 1.4em 的凹槽。

  原来方框是画在 `<input>` 自己身上的（border + background），
  和正文之间那截距离靠 `margin-right`。**margin 不算内容** ——
  一条还没打字的任务项上，光标就画在 input 的边框右缘、margin 的里面，
  紧贴着方框；等打了字，字才排在 margin 之后。和圆点当初一模一样的毛病。

  所以照圆点那套改：input 撑满 1.4em 凹槽、自己不画任何东西，
  方框和勾都用伪元素绝对定位到凹槽最左。这样光标落在凹槽右缘 = 正文列，
  和文字对齐；方框还是 1.05em 的正方形。
*/
.xg-md-editor :deep(.cm-atomic-task-checkbox) {
  width: 1.4em;
  height: 1.05em;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  display: inline-block;
  position: relative;
  /*
    竖向对齐正文。inline-block 默认底边坐在基线上,1.05em 高的方框就整个
    浮在字的上方;middle 把它的中点对到 x 高度的一半,再往下微调一点点
    对齐数字/汉字的视觉中心(它们比小写字母高)。
  */
  vertical-align: middle;
  transform: translateY(-0.08em);
}

.xg-md-editor :deep(.cm-atomic-task-checkbox)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 1.05em;
  height: 1.05em;
  box-sizing: border-box;
  border: 1.5px solid var(--atomic-editor-fg-muted, #888);
  border-radius: 0.22em;
}

.xg-md-editor :deep(.cm-atomic-task-checkbox:checked)::before {
  background: var(--atomic-editor-accent, #7c3aed);
  border-color: var(--atomic-editor-accent, #7c3aed);
}

/* 勾。原来靠 inline-grid 居中,现在方框是伪元素画的,勾也得自己定位到方框中心 */
.xg-md-editor :deep(.cm-atomic-task-checkbox)::after {
  position: absolute;
  left: 0.525em;
  top: 0.525em;
  transform: translate(-50%, -58%) rotate(45deg);
}

.xg-md-editor :deep(.cm-line.xg-mk) { text-indent: -1.4em !important; }

/*
  圆点是**画**出来的，不是字。

  原来用 ●／○／■ 三个字符，和序号对不齐 —— 三个字形各自的左边距都不一样。
  画成方块/圆角块之后位置和大小自己说了算。原字符变透明留在原地占位，
  不能用 `font-size: 0` 藏（那会把 1.4em 一起塌成 0，正文列当场左移）。
*/
.xg-md-editor :deep(.cm-atomic-bullet) {
  padding: 0;
  color: transparent;
  position: relative;
}

.xg-md-editor :deep(.cm-atomic-bullet)::before {
  content: '';
  position: absolute;
  left: 0.08em;                      /* 对着序号那个 1 的起笔位置调的 */
  top: 50%;
  transform: translateY(-50%);
  width: 0.36em;
  height: 0.36em;
  background: var(--atomic-editor-fg-muted, #888);
}

/* 一级实心圆 */
.xg-md-editor :deep(.xg-lvl-0 .cm-atomic-bullet)::before { border-radius: 50%; }

/* 二级空心圆 —— 内描边掏空，不占额外尺寸 */
.xg-md-editor :deep(.xg-lvl-1 .cm-atomic-bullet)::before {
  border-radius: 50%;
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--atomic-editor-fg-muted, #888);
}

/* 三级实心小方块。方的看着比同尺寸的圆重，收一点 */
.xg-md-editor :deep(.xg-lvl-2 .cm-atomic-bullet)::before {
  width: 0.3em;
  height: 0.3em;
  border-radius: 1px;
}

/*
  列表每一级的缩进宽度。

  这几行画的**不是**源码里的空格 —— atomic-editor 把行首空格整个藏了,
  缩进是它按层级给整行加的 `padding-left`(见 editor/listMarkers.ts 的注释)。
  它那个数是每级 0.6em,层级根本看不出来,所以这里整套盖掉:
  起点 2.2em(= 0.8 基准 + 1.4 标记凹槽),每级 1.4em。

  **每级的量必须正好等于凹槽宽度**,这样下一级的标记框左缘刚好落在上一级
  正文的起点上 —— Notion 就是这么排的。差一点点(比如凹槽 1.2 而每级 1.4)
  肉眼就能看出子项的圆点和父项的文字没对齐。

  必须 `!important` —— 那个 padding 是行内样式写的,普通规则盖不住。
  类名从 xg-ind-0 排到 xg-ind-9,再深的行共用最后一档(不会再变宽,
  但也不会塌回去)。
*/
.xg-md-editor :deep(.cm-line.xg-ind-0) { padding-left: 2.2em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-1) { padding-left: 3.6em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-2) { padding-left: 5em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-3) { padding-left: 6.4em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-4) { padding-left: 7.8em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-5) { padding-left: 9.2em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-6) { padding-left: 10.6em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-7) { padding-left: 12em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-8) { padding-left: 13.4em !important; }
.xg-md-editor :deep(.cm-line.xg-ind-9) { padding-left: 14.8em !important; }

/*
  缩进已经退出列表的行。

  解析树还把它算在上一条列表项里(没有空行隔开的话,后面几行都算那一段的
  续行),atomic-editor 就按树给它加了列表的 padding —— 看着就是「明明退到
  首行了,字还挤在列表里」。按缩进判定归零。
*/
.xg-md-editor :deep(.cm-line.xg-out) { padding-left: 0 !important; text-indent: 0 !important; }

/* 编辑器自己管滚动,外面这层只负责给它一个有界的高度 */
.xg-md-editor :deep(.cm-editor) { height: 100%; }
/*
  **别在这儿写 scrollbar-width。**(踩过的坑,留个记号)

  它的优先级压过 style.css 里那条 `* { scrollbar-width: none }`,原生滚动条
  就一直露在外面;更糟的是 Chromium 里只要设了 scrollbar-width,
  `::-webkit-scrollbar` 那一整套伪元素**直接失效** —— 那时候改箭头、改颜色
  一点反应都没有,根子就在这一行。

  现在正文没有可见的滚动条(全局默认就是藏起来的)。以后要做的话,
  自绘和样式化原生都试过,两条路的取舍见项目板。
*/
.xg-md-editor :deep(.cm-scroller) { overflow: auto; }

/*
  正文四周的留白。

  上下固定 14px:顶上已经有那条文档小行、底下是卡片边缘,再堆留白就显得空。

  左右分两种情况 ——
  · **收窄模式**给 10px:列宽本来就由 measure 卡着、内容已经居中,
    这时候的 padding 只会白白吃掉正文宽度。
  · **全宽模式**给 38px,让文字离卡片边缘远一点;但窗口被挤窄的时候
    (比如把目录栏和智能体都拉开),那 76px 就成了奢侈,退回 10px。

  用容器查询而不是媒体查询:这里要看的是**编辑器这一栏**有多宽,
  不是整个窗口 —— 窗口很宽但三栏都开着的时候,正文栏可能只剩三百多。
*/
.xg-md-editor { container-type: inline-size; }

.xg-md-editor :deep(.cm-content) {
  padding-block: 14px;
}

/*
  顶栏和底栏都浮在正文上,两头各补一截空白,免得首尾两行被压住。

  上面给到 76px 而不是刚好躲开顶栏的 50 —— 那个高度第一行**紧贴着**顶栏,
  看着像被顶栏推着走;空出一截之后正文才像一页纸的开头。
*/
.xg-md-editor :deep(.cm-content) { padding-top: 76px; }
.xg-md-editor.has-statusbar :deep(.cm-content) { padding-bottom: 48px; }

/*
  左右两侧的留白,**两种宽度模式一视同仁**,而且窄下来也不许贴边。

  两个坑:

   1. 以前只给全宽模式留 38px,收窄模式一直是 10px。宽窗口下看不出来
      (收窄靠 max-width + margin auto 居中,两边本来就空着),可窗口一压小,
      max-width 不起作用了,正文就直接贴到边上。
   2. 右边浮着**悬浮大纲**那一列短横线。它整个盒子占 52px
      (贴右缘 20px + 线段最长 20px + 自己的左内边距 12px),
      正文的右边距不让开这么多,长行就会从线段底下穿过去。

  所以右边比左边宽一截 —— 那不是排版失误,是给大纲条腾的位置。

  收窄模式的列宽由 measure 卡着(cssVars 里的 --atomic-editor-measure),
  留白在它外面,不占列宽。

  **留白放在 .cm-scroller 上,不放 .cm-content 上。** drawSelection 画选区时,中间那些整行
  是从 .cm-content 的左边缘一直铺到右边缘的 —— 留白要是算在 content 里,刮选一大段,
  两侧的空白也会被一起涂成紫色(用户报的「刮选把左右两边很多空的刮进来」)。
  挪到 scroller 上之后 content 的边就是正文的边,选区只盖住文字那一列。
*/
.xg-md-editor :deep(.cm-scroller) {
  padding-left: 38px;
  padding-right: 52px;
}

/* 这一栏本来就窄的时候,左边收到 20px;右边不能收,大纲条还在那儿 */
@container (max-width: 560px) {
  .xg-md-editor :deep(.cm-scroller) { padding-left: 20px; }
}

/*
  选区高亮。

  CM6 的 drawSelection 自己画一层 div(`.cm-selectionBackground`),不是浏览器
  原生选区,所以 ::selection 管不着它 —— 要改的是这个类。

  **别再给 `.cm-line ::selection` 上色。** drawSelection 特意把原生选区设成
  透明,就是为了不和自己画的那层重叠;之前这里用 !important 把它改了回来,
  于是两层半透明叠在一起,划过的地方比别处深一块 —— 用户报的「重复刮选」。
  表格单元格是独立的 contenteditable,drawSelection 画不到,那儿才需要 ::selection。
*/
.xg-md-editor :deep(.cm-selectionBackground),
.xg-md-editor :deep(.cm-focused .cm-selectionBackground) {
  background: var(--atomic-editor-selection-bg) !important;
}

.xg-md-editor :deep(.cm-atomic-table-cell-source ::selection),
.xg-md-editor :deep(.cm-atomic-table-cell-source::selection) {
  background: var(--atomic-editor-selection-bg);
}

/* 勾的颜色跟着主题色的亮度走(库里那条写死了白色) */
.xg-md-editor :deep(.cm-atomic-task-checkbox)::after {
  border-right-color: var(--xg-check);
  border-bottom-color: var(--xg-check);
}

/* 把手绝对定位的基准 —— 不设的话会退到 .cm-editor,直接跑出可视区 */
.xg-md-editor :deep(.cm-line) { position: relative; }

/*
  标题前的折叠把手。

  绝对定位压在正文左边那圈 padding 上,**不占文档流** —— 用 gutter 的话
  整个正文列会被推开一截,和「正文居中」的版式打架。
  平时透明,鼠标移到那一行才浮出来;已经折起来的那个一直显示,
  否则用户看不出这里还藏着东西。
*/
.xg-md-editor :deep(.xg-fold-handle) {
  position: absolute;
  /* 只有 10px 留白时,-18px 会被 overflow 裁掉一半,所以贴着行首放 */
  left: -15px;
  width: 14px;
  height: 1.2em;
  cursor: pointer;
  opacity: 0;
  transition: opacity .12s;
}

.xg-md-editor :deep(.xg-fold-handle)::before {
  content: "";
  position: absolute;
  inset: 0;
  background: currentColor;
  color: var(--atomic-editor-fg-muted, #888);
  -webkit-mask: var(--xg-chevron) center / 13px 13px no-repeat;
  mask: var(--xg-chevron) center / 13px 13px no-repeat;
  transition: rotate .12s;
}

/* 收起来的时候箭头指向右边 —— 和文件树、系统里的展开控件一个约定 */
.xg-md-editor :deep(.xg-fold-handle.is-folded)::before { rotate: -90deg; }

.xg-md-editor :deep(.cm-line:hover) .xg-fold-handle,
.xg-md-editor :deep(.xg-fold-handle.is-folded) { opacity: 1; }
.xg-md-editor :deep(.xg-fold-handle):hover::before { color: var(--atomic-editor-fg, #ddd); }

/* 折起来那一段的占位符 */
.xg-md-editor :deep(.cm-foldPlaceholder) {
  background: color-mix(in srgb, var(--atomic-editor-fg) 8%, transparent);
  border: none;
  border-radius: 4px;
  color: var(--atomic-editor-fg-muted, #888);
  margin: 0 .3em;
  padding: 0 .4em;
}

/*
  标题和引用上色。

  颜色全部由笔记主题色推出来,不另起一套彩虹 —— 六级标题六种色相是灾难,
  一页看下来眼睛没地方落。这里只动明度和饱和度:一级最重,越往下越淡,
  到四级往后基本就回到正文色了,反正那几级本来也很少用。

  用 color-mix 混向 --foreground 而不是写死数值:深色浅色两套主题下,
  「往正文色靠一点」这个意思是同一个,混出来的结果自动跟着主题走,
  不用维护两份色表。
*/
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h1),
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h2),
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h3) {
  color: var(--xg-head);
}

/*
  往**透明**兑,不往正文色兑。

  兑正文色在深色下没问题(正文接近白,兑得越多越亮=越淡),可浅色主题下
  正文接近黑 —— 兑得越多反而越暗,一级到六级整个反过来。
  兑透明是「让它更淡」这件事本身,和底色是黑是白无关。
*/
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h2) {
  color: color-mix(in srgb, var(--xg-head) 88%, transparent);
}

.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h3) {
  color: color-mix(in srgb, var(--xg-head) 74%, transparent);
}

/* 四级往后基本回到正文色 —— 那几级本来就很少用,再上色只会让页面更花 */
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h4),
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h5),
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-h6) {
  color: color-mix(in srgb, var(--xg-head) 55%, transparent);
}

/* 引用整块压淡并留一道竖线,和标题不是一个维度的强调,所以不给色相 */
.xg-md-editor.is-colored :deep(.cm-line.cm-atomic-blockquote) {
  color: var(--atomic-editor-fg-muted);
}

/*
  源码模式的**排版**部分。装饰本身是靠撤掉扩展关掉的(见 decoCompartment),
  这里只负责把字体和行距也换成「看代码」的样子:等宽、字号略小、
  行高统一 —— 否则标题那几行还是又大又粗,看着不像原文。
*/
.xg-md-editor.is-source :deep(.cm-content) {
  font-family: var(--atomic-editor-font-mono);
  font-size: calc(var(--atomic-editor-body-size) * 0.92);
}

.xg-md-editor.is-source :deep(.cm-line) {
  font-size: inherit !important;
  font-weight: normal !important;
  line-height: inherit !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

/* 源码模式下折叠把手没有意义:那时候标题只是一行 # 开头的文字 */
.xg-md-editor.is-source :deep(.xg-fold-handle) { display: none; }

/* 阅读模式的记号隐藏不在这儿 —— 它得从语法树下手，见 editor/hideMarks.ts */


/*
  源码模式的记号配色。取自 Vitesse(用户 VSCode 里那套)的 markdown 取值。
  深色是默认,浅色由 [data-theme="light"] 覆盖 —— 那个属性本来就绑在根节点上,
  跟着主题实时变,不用在 JS 里再判断一次深浅。
*/
.xg-md-editor :deep(.xg-src-head)  { color: #4d9375; }
.xg-md-editor :deep(.xg-src-list)  { color: #d4976c; }
.xg-md-editor :deep(.xg-src-quote) { color: #758575dd; }
.xg-md-editor :deep(.xg-src-mark)  { color: #758575dd; }
.xg-md-editor :deep(.xg-src-code)  { color: #c99076; }
.xg-md-editor :deep(.xg-src-link)  { color: #c98a7d; text-decoration: underline; }

.xg-md-editor[data-theme="light"] :deep(.xg-src-head)  { color: #1c6b48; }
.xg-md-editor[data-theme="light"] :deep(.xg-src-list)  { color: #a65e2b; }
.xg-md-editor[data-theme="light"] :deep(.xg-src-quote),
.xg-md-editor[data-theme="light"] :deep(.xg-src-mark)  { color: #a0ada0; }
.xg-md-editor[data-theme="light"] :deep(.xg-src-code)  { color: #a65e2b; }
.xg-md-editor[data-theme="light"] :deep(.xg-src-link)  { color: #b56959; }

/*
  公式和流程图。

  两者都用 --atomic-editor-fg 当前景色,跟着主题走;KaTeX 自带的样式里
  颜色是继承的,所以这里只需要管容器。
*/
.xg-md-editor :deep(.xg-math) { color: var(--atomic-editor-fg); }
.xg-md-editor :deep(.xg-math-block) { display: block; margin: .6em 0; text-align: center; }

.xg-md-editor :deep(.xg-math-error),
.xg-md-editor :deep(.xg-mermaid-error) {
  color: #e05780;
  font-family: var(--atomic-editor-font-mono);
  font-size: .85em;
  white-space: pre-wrap;
}

.xg-md-editor :deep(.xg-mermaid) {
  display: block;
  margin: .8em 0;
  padding: .8em;
  border-radius: 8px;
  background: color-mix(in srgb, var(--atomic-editor-fg) 4%, transparent);
  overflow-x: auto;
  text-align: center;
}

.xg-md-editor :deep(.xg-mermaid svg) { max-width: 100%; height: auto; }

/*
  表格 —— 窄着出生，打字才撑开。

  库里默认给 `<table>` 上了 `min-width: 100%`，于是一张两列的小表也横占整行，
  中间全是空格子。去掉那条以后表格是 `width: max-content`，有多少内容占多宽；
  再给单元格一个 6em 的下限，免得空表塌成几条竖线。
*/
.xg-md-editor :deep(.cm-atomic-table table) { min-width: 0; }
.xg-md-editor :deep(.cm-atomic-table th),
.xg-md-editor :deep(.cm-atomic-table td) { min-width: 6em; }

/*
  加一列 / 加一行的把手。

  外层改成 grid：表格占第 1 格，竖条在它右边、横条在它下边。
  网格项默认拉伸，所以竖条自动和表格等高、横条自动和表格等宽 ——
  表格宽度随打字一直在变，用绝对定位就得一直重新量。

  平时透明，鼠标进表格才淡淡浮出来，指到把手上才变实：
  不打扰阅读，但要用的时候找得到。
*/
.xg-md-editor :deep(.cm-atomic-table) {
  display: grid;
  grid-template-columns: minmax(0, max-content) auto;
  grid-template-rows: max-content max-content;
  justify-content: start;
  align-content: start;
}

.xg-md-editor :deep(.cm-atomic-table > table) { grid-area: 1 / 1; }

.xg-md-editor :deep(.xg-tbl-add) {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  color: var(--atomic-editor-fg);
  background: color-mix(in srgb, var(--atomic-editor-fg) 7%, transparent);
  opacity: 0;
  transition: opacity 140ms ease, background 140ms ease;
}

.xg-md-editor :deep(.xg-tbl-add-col) { grid-area: 1 / 2; width: 20px; margin-left: 5px; }
.xg-md-editor :deep(.xg-tbl-add-row) { grid-area: 2 / 1; height: 16px; margin-top: 5px; }

.xg-md-editor :deep(.cm-atomic-table:hover .xg-tbl-add) { opacity: .45; }

.xg-md-editor :deep(.xg-tbl-add:hover) {
  opacity: 1;
  background: color-mix(in srgb, var(--atomic-editor-accent) 22%, transparent);
}
</style>
