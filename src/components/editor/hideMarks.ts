/**
 * 「阅读模式」：光标点上去也不把记号露出来。
 *
 * # 为什么不能只靠 CSS
 *
 * 第一版是拿 CSS 把 `cm-atomic-*-mark` 藏掉的，结果加粗、高亮、`#` 照样露 ——
 * 因为那几个类名**只用在库里一条很窄的路上**（你正在一对 `**` 中间打字、
 * lezer 还没认出这是强调时的临时补偿）。真正常见的那条路走的是 lezer 的
 * `EmphasisMark` 之类的记号节点，样式来自 CodeMirror 生成的高亮类名
 * （`ͼ1a` 这种），**名字是随机的，选择器根本写不出来**。
 *
 * 所以改成从语法树下手：认出记号节点，直接用 `Decoration.replace` 把它抹掉。
 * 库那边「光标在这儿所以我不藏」的决定不受影响 —— 它不藏，我们藏，叠加即可。
 *
 * # 代码块里的记号不会被误伤
 *
 * 靠的是解析器，不是正则：围栏代码块里那一整段在语法树里是 `CodeText`，
 * 里面的 `**` 和 `<span>` 压根不会产生记号节点，也就轮不到这里来。
 * 正文里孤零零一个 `==` 同理 —— 它没被解析成高亮，就没有 `HighlightMark`。
 */
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { blockPrefixLen } from './markdownShortcuts'

/**
 * 要抹掉的记号节点。
 *
 * `ListMark`（`-` `1.`）**不在里面** —— 列表的圆点和序号是靠它画出来的，
 * 抹了整份列表就没有标记了。`LinkMark` 也不在：链接是整段换成一个部件，
 * 它自己管着显示。
 */
const MARKS = new Set([
  'EmphasisMark',      // * ** _ __
  'StrikethroughMark', // ~~
  'HighlightMark',     // ==  (来自 atomic-editor 的 highlightMarkdown)
  'HeaderMark',        // # ## ###
  'QuoteMark',         // >
  'CodeMark',          // ` 和 ```
  'CommentBlock',      // <!-- -->
])

const hide = Decoration.replace({})

/**
 * **只有「井号 + 空格 + 字」才算标题，光一个 `#` 不藏。**
 *
 * CommonMark 允许空标题：一行只写 `#`，解析器照样给出 ATXHeading。
 * 于是刚敲下一个井号它就被当成标题记号藏掉了 —— 人看到的是「我打的字没了」。
 * 判据：记号后面还有没有正文。没有就当普通字符，露着。
 */
function emptyHeading(state: EditorState, node: { name: string; from: number; to: number }): boolean {
  if (node.name !== 'HeaderMark') return false
  const line = state.doc.lineAt(node.from)
  return line.text.slice(node.to - line.from).trim() === ''
}

export const hideMarks = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = build(view) }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = build(u.view)
  }
}, { decorations: (v) => v.decorations })

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!MARKS.has(node.name) || node.to <= node.from) return
        /*
          围栏代码块那三个反引号要留着 —— 它带着语言名（```vue），
          而且代码块本来就是「原样展示」的东西，把围栏抹掉反而看不出边界。
          行内的单反引号才藏。
        */
        if (node.name === 'CodeMark' && node.to - node.from >= 3) return
        if (emptyHeading(view.state, node)) return
        b.add(node.from, node.to, hide)
      },
    })
  }
  return b.finish()
}

/**
 * **收起来的记号要当成一个整体，光标不许停在它中间。**
 *
 * # 这一条不加会怎样
 *
 * `==高亮==` 的 `==` 平时是藏起来的。你在「看得见的最后一个字」后面按回车 ——
 * 那个位置在文档里其实是**闭合记号的前面**，于是一刀把这对记号劈成两行：
 *
 *     ==12312313
 *     ==
 *
 * 两截都不成对，`==` 当场原样冒出来。`%%注释%%` 同理。
 * 用的人只觉得「我就换个行，它自己蹦出来了」—— 因为看不见的东西咬了他一口。
 *
 * 标成 atomic 之后，光标移动和点击都会整个跨过去，停在记号外面，
 * 回车也就落在该落的地方。
 *
 * # 为什么只挡「此刻收起来的」
 *
 * 光标已经进到那一段里时，记号是**露出来给你改**的（写作模式）——
 * 那会儿它就该是普通字符，能选能删。所以判据和显示保持一致：
 * 露出来的不挡，收起来的才挡。
 */
export const markerAtomicRanges = EditorView.atomicRanges.of((view) => {
  const rs: { from: number; to: number }[] = []
  const sel = view.state.selection.main
  for (const { from, to } of view.visibleRanges) {
    /*
      行首那截 `- ` / `1. ` / `- [ ] ` / `> ` / `## ` **一律选不中**。

      Notion 就是这样：圆点根本刮不到。而只要能刮到，每一个格式命令都得自己
      记得躲开它 —— 上色躲一次、加粗躲一次、删除线再躲一次，漏一个就炸
      （`-<span …> 123456</span>` 里短横线后面紧跟一个 `<`，
      markdown 当场就不认它是列表，圆点变成一根横杠）。
      与其在每个命令里打补丁，不如让它压根选不进来。
    */
    for (let n = view.state.doc.lineAt(from).number; n <= view.state.doc.lineAt(to).number; n++) {
      const line = view.state.doc.line(n)
      const len = blockPrefixLen(line.text)
      if (len > 0) rs.push({ from: line.from, to: line.from + len })
    }

    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!MARKS.has(node.name) || node.to <= node.from) return
        if (node.name === 'CodeMark' && node.to - node.from >= 3) return
        if (emptyHeading(view.state, node)) return
        // 光标正压在这个记号上 —— 那它现在是露着的，别挡
        if (sel.from <= node.to && sel.to >= node.from) return
        rs.push({ from: node.from, to: node.to })
      },
    })
  }
  // builder 要求升序，而上面是两轮扫出来的
  rs.sort((a, b2) => a.from - b2.from || a.to - b2.to)
  const b = new RangeSetBuilder<Decoration>()
  let last = -1
  for (const r of rs) {
    if (r.from < last) continue      // 和前一段重叠的丢掉，builder 不接受
    b.add(r.from, r.to, hide)
    last = r.to
  }
  return b.finish()
})

/**
 * 库在「你正在一对 `**` 中间打字」时会临时补一组样式类，那条路不走语法树，
 * 上面抹不到。它只是给字符上色不是替换，所以这里把字缩成看不见。
 *
 * 用 `font-size: 0` 而不是 `display: none`：记号在文档里仍然占着字符位置，
 * 盒子整个没了会让光标落点算错。
 */
export const hideMarksTheme = EditorView.theme({
  '.cm-atomic-strong-mark, .cm-atomic-em-mark, .cm-atomic-strike-mark, .cm-atomic-highlight-mark': {
    fontSize: '0 !important',
  },
})
