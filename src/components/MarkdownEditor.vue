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
import { shallowRef, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView, keymap, drawSelection, dropCursor, rectangularSelection,
  highlightActiveLine, highlightSpecialChars,
} from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  indentOnInput, foldService, foldEffect, unfoldEffect, foldedRanges, codeFolding,
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
import { isDarkNow, VAULT_FONT_STACK, type VaultFont } from '@/composables/useAppSettings'

const props = withDefaults(defineProps<{
  modelValue: string
  readOnly?: boolean
  /** 笔记主题色(十六进制)。复选框、选区高亮、链接都用它 */
  accent?: string
  /** 正文字体档位 */
  font?: VaultFont
  /** 正文字号(px) */
  fontSize?: number
  /** 铺满整栏。关掉时收窄居中 —— 靠 --atomic-editor-measure 那个变量控制 */
  fullWidth?: boolean
  /** 点了渲染出来的链接。Tauri 里要走系统浏览器,不能让 webview 自己导航走 */
  onOpenLink?: (url: string) => void
  /** [[双链]] 的自动补全候选 */
  wikiSuggest?: (q: string) => Promise<WikiLinkSuggestion[]>
  /** 点了 [[双链]] */
  onOpenWiki?: (target: string) => void
}>(), { readOnly: false, accent: '#8b6cef', font: 'default', fontSize: 16, fullWidth: false })

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const host = shallowRef<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const roCompartment = new Compartment()

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
    return
  }
  const range = view.state.facet(foldService)
    .map((f) => f(view.state, line.from, line.to))
    .find(Boolean)
  if (range) view.dispatch({ effects: foldEffect.of(range) })
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

function extensions() {
  const openLink = (url: string) => props.onOpenLink?.(url)
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    rectangularSelection(),
    highlightActiveLine(),
    closeBrackets(),
    startAsteriskList,      // 回车续列表 / 空条目退一级
    extendEmphasisPair,     // **加粗** 成对扩写
    autoCloseCodeFence,     // ``` 自动配对
    EditorView.lineWrapping,
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
    search({ top: true }),
    /*
      base: markdownLanguage 才有 GFM(表格、删除线、任务列表、自动链接);
      纯 CommonMark 的话 inlinePreview 根本看不到 Task / Table 这些节点。
      extensions: highlightMarkdown 是 ==高亮== 的解析规则 —— 少了它
      `==xx==` 会原样显示,而且不报错,很难看出是解析层缺东西。
    */
    markdown({
      base: markdownLanguage,
      codeLanguages: [...ATOMIC_CODE_LANGUAGES],
      extensions: highlightMarkdown,
    }),
    // 把括号自动配对扩展到 Markdown 的成对符号上
    markdownLanguage.data.of({
      closeBrackets: { brackets: ['(', '[', '{', "'", '"', '*', '_', '`'] },
    }),
    atomicMarkdownSyntax,
    atomicEditorTheme,
    keymap.of([
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...markdownKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    // 装饰这三个要排在主题之后
    tables({ onLinkClick: openLink }),
    imageBlocks(),
    inlinePreview({ onLinkClick: openLink }),
    wikiLinks({
      suggest: props.wikiSuggest,
      onOpen: (t) => props.onOpenWiki?.(t),
      openOnClick: true,
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      emit('update:modelValue', u.state.doc.toString())
    }),
    roCompartment.of(readOnlyExtension(props.readOnly)),
  ]
}

onMounted(() => {
  if (!host.value) return
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
  })
})

onBeforeUnmount(() => {
  view.value?.destroy()
  view.value = null
})

/*
  外部换了内容(切标签、外部改动)才整份替换。
  **必须先比一次** —— 不比的话,用户自己敲的每一个字都会因为 modelValue 回流
  而触发一次全文替换,光标直接跳到文末,根本没法打字。
*/
watch(() => props.modelValue, (v) => {
  const ed = view.value
  if (!ed || v === ed.state.doc.toString()) return
  ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: v } })
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

/** 当前选区;没选中就取光标所在的词 */
function target() {
  const ed = view.value
  if (!ed) return null
  const sel = ed.state.selection.main
  if (!sel.empty) return { from: sel.from, to: sel.to }
  const line = ed.state.doc.lineAt(sel.head)
  const text = line.text
  let i = sel.head - line.from
  const word = /[\p{L}\p{N}_]/u
  let a = i, b = i
  while (a > 0 && word.test(text[a - 1] ?? '')) a--
  while (b < text.length && word.test(text[b] ?? '')) b++
  return { from: line.from + a, to: line.from + b }
}

/** 用 `mark` 把选中的内容裹起来;已经裹着就脱掉(再点一次取消加粗) */
function wrap(mark: string, endMark = mark) {
  const ed = view.value
  const t = target()
  if (!ed || !t) return
  const inner = ed.state.sliceDoc(t.from, t.to)
  const outer = ed.state.sliceDoc(
    Math.max(0, t.from - mark.length),
    Math.min(ed.state.doc.length, t.to + endMark.length),
  )
  if (inner.startsWith(mark) && inner.endsWith(endMark) && inner.length > mark.length + endMark.length) {
    const bare = inner.slice(mark.length, inner.length - endMark.length)
    ed.dispatch({ changes: { from: t.from, to: t.to, insert: bare },
      selection: { anchor: t.from, head: t.from + bare.length } })
  } else if (outer === mark + inner + endMark) {
    ed.dispatch({ changes: { from: t.from - mark.length, to: t.to + endMark.length, insert: inner },
      selection: { anchor: t.from - mark.length, head: t.from - mark.length + inner.length } })
  } else {
    ed.dispatch({ changes: { from: t.from, to: t.to, insert: mark + inner + endMark },
      selection: { anchor: t.from + mark.length, head: t.to + mark.length } })
  }
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

defineExpose({
  focus: () => view.value?.focus(),
  wrap, setBlock, insertBlock, paste, clip, selectedText,
  selectAll: () => {
    const ed = view.value
    if (!ed) return
    ed.dispatch({ selection: { anchor: 0, head: ed.state.doc.length } })
    ed.focus()
  },
  clearFormat: () => {
    const ed = view.value
    const t = target()
    if (!ed || !t) return
    const bare = ed.state.sliceDoc(t.from, t.to).replace(/[*_`~=]|==/g, '')
    ed.dispatch({ changes: { from: t.from, to: t.to, insert: bare } })
    ed.focus()
  },
})
</script>

<template>
  <div ref="host" class="xg-md-editor h-full min-h-0 overflow-hidden"
    :class="fullWidth ? 'is-wide' : ''" :data-theme="themeAttr" :style="cssVars" />
</template>

<style scoped>
/* 编辑器自己管滚动,外面这层只负责给它一个有界的高度 */
.xg-md-editor :deep(.cm-editor) { height: 100%; }
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
  padding-inline: 10px;
}

.xg-md-editor.is-wide :deep(.cm-content) { padding-inline: 38px; }

@container (max-width: 560px) {
  .xg-md-editor.is-wide :deep(.cm-content) { padding-inline: 10px; }
}

/*
  选区高亮。CM6 的 drawSelection 自己画一层 div,不是浏览器原生选区,
  所以 ::selection 管不着它,必须改这个类。
*/
.xg-md-editor :deep(.cm-selectionBackground),
.xg-md-editor :deep(.cm-focused .cm-selectionBackground),
.xg-md-editor :deep(.cm-line ::selection),
.xg-md-editor :deep(.cm-line::selection) {
  background: var(--atomic-editor-selection-bg) !important;
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
</style>
