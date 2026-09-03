/**
 * Markdown 的格式命令：加粗、斜体、代码、标题、引用、列表、链接、文本颜色。
 *
 * # 为什么要自己写
 *
 * CodeMirror 的 markdown 包只给了两条按键（回车续写标记、退格删标记），
 * atomic-editor 也没有格式命令 —— 也就是说在这之前，Ctrl+B 在这个编辑器里
 * **什么都不会发生**。所有格式都得手打星号。
 *
 * 右键菜单里那两格图标走的也是这里，改行为只改这一个文件。
 *
 * # 三条贯穿全文的规矩
 *
 * 1. **一律是开关，不是插入。** 按一次加粗、再按一次取消。只会插入的话，
 *    想去掉加粗就得手动删两边的星号，那还不如不要快捷键。
 *
 * 2. **没刮选就作用在光标所在的那个词上。** 这是 Obsidian / Word 的做法，
 *    也是绝大多数人按 Ctrl+B 时脑子里想的事：光标停在「重点」中间按一下，
 *    得到的应该是 `**重点**`，而不是在词中间插进一对空星号把词劈成两半。
 *
 * 3. **块级命令按行走，整段一起。** 刮中五行按 Ctrl+Shift+8，五行一起变成
 *    无序列表；再按一次五行一起变回来。逐行判断的话，选区里混着列表和普通行
 *    时会一半变一半不变。
 *
 * # 中文的词怎么算
 *
 * 「光标所在的那个词」在英文里是 `\w+`，中文里没有空格可依。这里把
 * **连续的中日韩字符**也算作一个词 —— 光标停在「重点」里按 Ctrl+B，
 * 圈住的是「重点」两个字，而不是从上一个空格一路圈到下一个空格
 * （那样会把整句话都加粗）。断不准的时候用户自己刮一下就是了，
 * 所以这里宁可圈小不圈大。
 */
import type { EditorState, ChangeSpec, StateCommand } from '@codemirror/state'
import { EditorSelection } from '@codemirror/state'
import type { KeyBinding } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

// ── 行内标记 ──────────────────────────────────────────

/** 一个词由哪些字符组成。CJK 单独一段，免得和拉丁字母连成一个大词 */
const WORD = /[\p{L}\p{N}_]/u
const CJK = /[㐀-鿿぀-ヿ가-힯]/u

function sameClass(a: string, b: string) {
  const cjk = CJK.test(a)
  return cjk === CJK.test(b) && WORD.test(a) && WORD.test(b)
}

/**
 * 光标底下那个词的范围。碰不到词就返回 null（调用方会退化成「插一对空标记」）。
 *
 * 光标贴在词尾（`重点|`）也算在这个词上 —— 打完一个词马上按 Ctrl+B 是最常见的
 * 用法，这时候光标正好在词的右边界上。
 */
function wordAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let i = pos - line.from
  // 先看左边一格：贴在词尾时以左边那个字为准
  const seed = text[i] && WORD.test(text[i]) ? text[i] : text[i - 1]
  if (!seed || !WORD.test(seed)) return null
  if (!(text[i] && sameClass(text[i], seed))) i -= 1
  let from = i
  let to = i + 1
  while (from > 0 && sameClass(text[from - 1], seed)) from -= 1
  while (to < text.length && sameClass(text[to], seed)) to += 1
  return { from: line.from + from, to: line.from + to }
}

/** 把选区两头的空白剪掉。全是空白就返回原样，调用方会放弃 */
function trimRange(state: EditorState, from: number, to: number) {
  const s = state.sliceDoc(from, to)
  const head = s.length - s.replace(/^\s+/, '').length
  const tail = s.length - s.replace(/\s+$/, '').length
  return { from: from + head, to: to - tail }
}

/**
 * 成对标记的开关：`**` `*` `` ` `` `~~` `==`。
 *
 * 判「已经有了」看的是**选区外面**紧挨着的两段，而不是选区里面 ——
 * 双击选中「重点」时选到的是 `重点`，两边的 `**` 在选区外；
 * 而刮选时人常常会连星号一起刮进来。两种都得认，所以两边都查一次。
 */
export function toggleMark(mark: string): StateCommand {
  return togglePair(mark, mark)
}

/**
 * 成对包裹的开关。两头不一样的也走这儿 —— `<u>` / `</u>` 就是这种。
 */
export function togglePair(open: string, close: string): StateCommand {
  return ({ state, dispatch }) => {
    const a = open.length
    const b = close.length
    const tr = state.changeByRange((range) => {
      let { from, to } = range
      if (from === to) {
        const w = wordAt(state, from)
        if (w) { from = w.from; to = w.to }
      } else {
        /*
          **两头的空白要剪掉。**

          刮选很容易多带一个尾空格，而 markdown 的强调标记**紧贴空格就不成立** ——
          `**加粗 **` 里那个闭合的 `**` 前面是空格，解析器不认，结果是屏幕上原样
          显示四个星号、字一点没加粗。用的人只会觉得「加粗按了没用」。
          （踩过：`- [ ]  1**3112312 **`）
        */
        const t = trimRange(state, from, to)
        from = t.from; to = t.to
        if (from >= to) return { range }
      }
      const inner = state.sliceDoc(from, to)
      const before = state.sliceDoc(Math.max(0, from - a), from)
      const after = state.sliceDoc(to, Math.min(state.doc.length, to + b))

      // 标记在选区外面：`**[重点]**`
      if (before === open && after === close) {
        return {
          changes: [{ from: from - a, to: from }, { from: to, to: to + b }],
          range: EditorSelection.range(from - a, to - a),
        }
      }
      // 标记被选进来了：`[**重点**]`
      if (inner.length >= a + b && inner.startsWith(open) && inner.endsWith(close)) {
        return {
          changes: [{ from, to: from + a }, { from: to - b, to }],
          range: EditorSelection.range(from, to - a - b),
        }
      }
      // 都没有 —— 包上。空选区就把光标放进这对标记中间
      const changes: ChangeSpec[] = [
        { from, insert: open },
        { from: to, insert: close },
      ]
      return {
        changes,
        range: from === to
          ? EditorSelection.cursor(from + a)
          : EditorSelection.range(from + a, to + a),
      }
    })
    if (tr.changes.empty) return false
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
    return true
  }
}

/**
 * Ctrl+E：一行之内是行内代码，跨了行就是代码块。
 *
 * 分两种是因为它们本来就是两件事：一行里的 `` `x` `` 是「这是个变量名」，
 * 而跨行的是「这是一段代码」。用同一个键是因为用户按下去时想的都是
 * 「把这段变成代码」，不该让他先分辨自己选中的是几行。
 */
export const toggleCode: StateCommand = (target) => {
  const { state } = target
  const r = state.selection.main
  const multi = state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number
  if (!multi) return toggleMark('`')(target)

  const first = state.doc.lineAt(r.from)
  const last = state.doc.lineAt(r.to)
  const before = first.number > 1 ? state.doc.line(first.number - 1).text.trim() : ''
  const afterLine = last.number < state.doc.lines ? state.doc.line(last.number + 1).text.trim() : ''
  // 已经被围栏夹着了 —— 再按一次就是拆围栏
  if (before.startsWith('```') && afterLine.startsWith('```')) {
    const up = state.doc.line(first.number - 1)
    const down = state.doc.line(last.number + 1)
    target.dispatch(state.update({
      changes: [
        { from: up.from, to: Math.min(state.doc.length, up.to + 1) },
        { from: Math.max(0, down.from - 1), to: down.to },
      ],
      userEvent: 'input.format',
    }))
    return true
  }
  target.dispatch(state.update({
    changes: [
      { from: first.from, insert: '```\n' },
      { from: last.to, insert: '\n```' },
    ],
    selection: EditorSelection.range(first.from + 4, last.to + 4),
    userEvent: 'input.format',
  }))
  return true
}

/**
 * Ctrl+K：插链接。
 *
 * 刮中的那段当链接文字，光标落在圆括号里等着贴网址 —— 这个顺序是对的：
 * 网址几乎总是在剪贴板里，而文字几乎总是已经写在正文里了。
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    let { from, to } = range
    if (from === to) {
      const w = wordAt(state, from)
      if (w) { from = w.from; to = w.to }
    }
    const text = state.sliceDoc(from, to)
    const insert = `[${text}]()`
    return {
      changes: { from, to, insert },
      // 光标落在 () 里面
      range: EditorSelection.cursor(from + insert.length - 1),
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

// ── 块级标记 ──────────────────────────────────────────

/** 选区盖到的每一行（空选区就是光标那一行） */
function linesOf(state: EditorState) {
  const r = state.selection.main
  const out = []
  for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
    out.push(state.doc.line(n))
  }
  return out
}

const HEAD = /^(\s*)(#{1,6})\s+/
const QUOTE = /^(\s*)>\s?/
const BULLET = /^(\s*)([-*+])\s+(?:\[[ xX]\]\s+)?/
const ORDERED = /^(\s*)(\d+)([.)])\s+/
const TASK = /^(\s*)([-*+])\s+\[([ xX])\]\s+/

/** 剥掉一行开头的块级标记，返回缩进和正文 */
function stripBlock(text: string): { indent: string; body: string } {
  const m = TASK.exec(text) ?? BULLET.exec(text) ?? ORDERED.exec(text) ?? HEAD.exec(text)
  if (!m) {
    const ind = /^\s*/.exec(text)![0]
    return { indent: ind, body: text.slice(ind.length) }
  }
  return { indent: m[1], body: text.slice(m[0].length) }
}

/**
 * 标题：Ctrl+1~6 设成那一级，Ctrl+0 变回正文。
 *
 * 已经是这一级了再按一次就变回正文 —— 和加粗一样是个开关，
 * 不然「按错了想撤销」只能去手删井号。
 */
function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = []
    for (const line of linesOf(state)) {
      const cur = HEAD.exec(line.text)
      const { indent, body } = stripBlock(line.text)
      const same = cur && cur[2].length === level
      const insert = level === 0 || same ? indent + body : `${indent}${'#'.repeat(level)} ${body}`
      if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert })
    }
    if (!changes.length) return false
    dispatch(state.update({ changes, userEvent: 'input.format' }))
    return true
  }
}

/**
 * 块级前缀的开关：引用、无序、有序、待办。
 *
 * **整段跟着第一行走**：选区里只要有一行还没这个前缀，就全都加上；
 * 全都有了才全都去掉。逐行各判各的话，选区里混着的时候会一半变一半不变，
 * 再按一次又反过来 —— 永远对不齐。
 */
type Block = 'quote' | 'bullet' | 'ordered' | 'task'

const HAS: Record<Block, RegExp> = {
  quote: QUOTE,
  bullet: BULLET,
  ordered: ORDERED,
  task: TASK,
}

function toggleBlock(kind: Block): StateCommand {
  return ({ state, dispatch }) => {
    const lines = linesOf(state)
    const all = lines.every((l) => HAS[kind].test(l.text))
    const changes: ChangeSpec[] = []
    let seq = 0
    for (const line of lines) {
      const { indent, body } = kind === 'quote'
        ? (() => {
            const m = QUOTE.exec(line.text)
            return m
              ? { indent: m[1], body: line.text.slice(m[0].length) }
              : { indent: /^\s*/.exec(line.text)![0], body: line.text.trimStart() }
          })()
        : stripBlock(line.text)
      seq += 1
      let insert: string
      if (all) insert = indent + body
      else if (kind === 'quote') insert = `${indent}> ${body}`
      else if (kind === 'bullet') insert = `${indent}- ${body}`
      else if (kind === 'task') insert = `${indent}- [ ] ${body}`
      else insert = `${indent}${seq}. ${body}`
      if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert })
    }
    if (!changes.length) return false
    dispatch(state.update({ changes, userEvent: 'input.format' }))
    return true
  }
}

/** 分隔线：另起一行插 `---`。不做开关 —— 它没有「正文」可以变回去 */
const insertRule: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head)
  const insert = line.text.trim() ? `\n\n---\n\n` : `---\n`
  dispatch(state.update({
    changes: { from: line.to, insert },
    selection: EditorSelection.cursor(line.to + insert.length),
    scrollIntoView: true,
    userEvent: 'input.format',
  }))
  return true
}

// ── 文本颜色 ──────────────────────────────────────────

/*
  markdown 没有「颜色」这回事，上色一律是夹一段行内 HTML：
  `<span style="color:red">红字</span>`。Obsidian、GitHub 都这么干，
  我们的渲染层也早就认得（见 editor/inlineHtml.ts）。

  **只写颜色名，不写十六进制。** inlineHtml 那边会把颜色名换成 `--xg-ink-*`，
  亮色暗色各一套；写死 `#ff0000` 的话，暗色模式下那抹红又暗又闷。
  这也正是这里能给的颜色只有固定几种的原因 —— 有几个 ink 变量就给几种。
*/
export const INK_COLORS = [
  'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple',
] as const
export type InkColor = (typeof INK_COLORS)[number]

/** 我们自己写出来的那种颜色 span（不含用户手写的复杂 style） */
const INK_OPEN = /^<span style="color:([a-z]+)">$/

/**
 * 把一行拆成「每个字 + 它现在是什么颜色」。
 *
 * 标签本身不进这个流 —— 它们是**格式**，不是内容。只有正文字符留下，
 * 每个字记着它所在位置的颜色（最里层的那个 span 说了算）和它在文档里的偏移。
 * 重新拼回去的时候按颜色分段，标签是现算出来的，不是从原文里搬的。
 *
 * 用栈配对而不是正则一把梭：`<span>` 会嵌套，靠「最近的一个 `</span>`」
 * 配出来的边界是错的。**用户手写的 `style="color:#e11d48;font-weight:bold"`
 * 那种不算颜色 span** —— 它的标签当普通字符留在流里，原样带回去，
 * 那是他自己挑的样式，不该被一次上色顺手抹掉。
 */
type Ch = { ch: string; color: string | null; at: number }

function readLine(text: string, lineFrom: number): Ch[] {
  const tok = /<span[^>]*>|<\/span>/g
  const stack: (string | null)[] = []   // 每一层 span 的颜色，非颜色 span 记 null
  const out: Ch[] = []
  const cur = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i]
    return null
  }
  let at = 0
  let m: RegExpExecArray | null
  const push = (from: number, to: number) => {
    for (let i = from; i < to; i++) out.push({ ch: text[i], color: cur(), at: lineFrom + i })
  }
  while ((m = tok.exec(text))) {
    push(at, m.index)
    if (m[0] === '</span>') {
      // 配不上的闭标签当普通字符留着 —— 别把别人的残缺标记吞掉
      if (stack.length) stack.pop()
      else push(m.index, m.index + m[0].length)
    } else {
      const ink = INK_OPEN.exec(m[0])
      if (ink) stack.push(ink[1])
      // 非颜色 span:标签本身当普通字符留在流里,原样带回去
      else { stack.push(null); push(m.index, m.index + m[0].length) }
    }
    at = m.index + m[0].length
  }
  push(at, text.length)
  return out
}

/** 按颜色分段拼回去。相邻同色合并成一段,不会拆出一串只裹一个字的 span */
function writeLine(chars: Ch[]): string {
  let out = ''
  let i = 0
  while (i < chars.length) {
    const c = chars[i].color
    let j = i
    while (j < chars.length && chars[j].color === c) j++
    const body = chars.slice(i, j).map((x) => x.ch).join('')
    out += c ? `<span style="color:${c}">${body}</span>` : body
    i = j
  }
  return out
}


/**
 * 给选中的字上色。`color` 传 null 就是把颜色去掉。
 *
 * # 只改选中的那几个字，别的颜色原样留着
 *
 * 做法是先把整行摊成「每个字 + 它的颜色」，把选中那一段的颜色改掉，再拼回去。
 * 这样三种情况自然就对了：
 *
 *  · 选区正好盖住一个已有的颜色 → **换掉**，不是再裹一层
 *    （裹两层的话里面那层说了算，屏幕上颜色根本没变，而源码套了两三层）
 *  · 选区盖住一个颜色的**一半** → 那一半跟着变，**另一半保持原色**
 *    （`1` `[23]橙` `45` `[6789]红`，刮 `23456` 变蓝 → `789` 还是红的）
 *  · 选区里夹着好几种颜色 → 一起变成新的那种
 *
 * 拿「扩边界再整段替换」是做不到第二条的 —— 那会把只沾到一半的颜色整个吃掉。
 *
 * # 跨行的选区要一行一行地改
 *
 * `<span>` 是行内元素，markdown 里它一碰到换行 / 下一个列表项就断了 ——
 * 整段裹一个的结果是源码里出现一对跨行的标签，而屏幕上一点颜色都没有
 * （踩过：`2. 321<span …>` 换行 `- 333</span>`）。
 */
/**
 * 这一行里**不许被颜色 span 切开**的地方。
 *
 * # 为什么必须有
 *
 * 上色以前是拿光标选区去裹一对 `<span>`，完全不管这段范围横跨了什么。
 * 于是刮到一半的记号就被劈开了，写出来的东西两边都不成立：
 *
 *     1**3112312**            上色  →  1**<span …>3112312**</span>
 *     12`31231`               上色  →  1<span …>2`</span><span …>31231`</span>
 *     ==12312313==            上色  →  ==12<span …>312313==</span>
 *
 * 屏幕上的样子是「加粗没了 / 代码块烂了 / `==` 冒出来了」——
 * 全是同一个病：**span 跨过了记号的边界**。
 *
 * 挡两类东西：
 *  · **记号本身**（`**` `~~` `==` `#` `>` 反引号…）—— 它们保持原来的颜色，
 *    于是拼回去的时候自然落在 span 外面，得到 `**<span>加粗</span>**`
 *  · **原样展示的整段**（行内代码、代码块、公式）—— 那里面塞 span 只会
 *    变成一串看得见的尖括号，不是颜色
 */
function protectedRanges(state: EditorState, from: number, to: number) {
  const out: { from: number; to: number }[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (MARK_NODES.has(node.name) || OPAQUE_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to })
      }
    },
  })
  /*
    公式（`$…$`）不在 lezer 的 markdown 里，它是我们自己按正则画出来的
    （见 editor/mathBlocks.ts），语法树里找不到，只能同样按正则挡一下。
  */
  const text = state.sliceDoc(from, to)
  for (const m of text.matchAll(/\$[^$\n]+\$/g)) {
    out.push({ from: from + m.index, to: from + m.index + m[0].length })
  }
  return out
}

/**
 * 这一行开头的块级前缀有多长（缩进 + `- ` / `1. ` / `- [ ] ` / `> ` / `## `）。
 *
 * 和 `stripBlock` 分开写：那个是给「换块级样式」用的，不认引用；
 * 这里要的是「正文从第几列开始」，引用也得算进去。
 * 一行里可能叠着好几层（`> - `），所以循环剥到剥不动为止。
 */
function blockPrefixLen(text: string): number {
  let i = 0
  for (;;) {
    const rest = text.slice(i)
    const m = TASK.exec(rest) ?? BULLET.exec(rest) ?? ORDERED.exec(rest)
      ?? HEAD.exec(rest) ?? QUOTE.exec(rest)
    if (!m || !m[0]) break
    i += m[0].length
  }
  return i
}

/** 记号本身：保持原色，于是会落在新 span 外面 */
const MARK_NODES = new Set([
  'EmphasisMark', 'StrikethroughMark', 'HighlightMark', 'HeaderMark',
  'QuoteMark', 'ListMark', 'LinkMark', 'CodeMark', 'TaskMarker',
])

/** 原样展示的整段：里面塞 span 只会多出一串尖括号 */
const OPAQUE_NODES = new Set([
  'InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'CommentBlock', 'URL',
])

export function applyColor(color: InkColor | null): StateCommand {
  return ({ state, dispatch }) => {
    const r = state.selection.main
    if (r.empty) return false

    const first = state.doc.lineAt(r.from)
    const last = state.doc.lineAt(r.to)
    const changes: { from: number; to: number; insert: string }[] = []

    for (let n = first.number; n <= last.number; n++) {
      const line = state.doc.line(n)
      const a0 = Math.max(r.from, line.from)
      const b0 = Math.min(r.to, line.to)
      if (a0 >= b0) continue
      /*
        **从这一行的正文开始，别从行首开始。**

        `- ` `1. ` `> ` `## ` `- [ ] ` 这些块级前缀不该被上色 —— 给圆点上色本来
        就没意义，更要命的是**记号和它后面那个空格必须连着**：只挡住 `-` 而让
        span 从空格开始，写出来是 `-<span …> 123456</span>`，短横线后面紧跟着
        一个 `<`，markdown 当场就不认它是列表了，圆点变成一根横杠。
        （现场：刮选带上了行首的 `- `，一上色整条列表塌了。）

        挡记号那一步（protectedRanges）挡不住这个 —— 空格不属于记号节点。
        所以这里直接把起点推到正文列上。
      */
      const bodyFrom = line.from + blockPrefixLen(line.text)
      // 每一行各自剪掉两头空白：行首的缩进裹进颜色里没有意义
      const t = trimRange(state, Math.max(a0, bodyFrom), b0)
      if (t.from >= t.to) continue

      const off = protectedRanges(state, line.from, line.to)
      const chars = readLine(line.text, line.from)
      let hit = false
      for (const c of chars) {
        if (c.at < t.from || c.at >= t.to) continue
        if (off.some((p) => c.at >= p.from && c.at < p.to)) continue
        if (c.color !== color) hit = true
        c.color = color
      }
      if (!hit) continue
      const insert = writeLine(chars)
      if (insert !== line.text) changes.push({ from: line.from, to: line.to, insert })
    }

    if (!changes.length) return false
    dispatch(state.update({ changes, userEvent: 'input.format' }))
    return true
  }
}

// ── 键位表 ────────────────────────────────────────────

/**
 * 这套键位是照着 Obsidian 定的（他天天在那边写），Obsidian 没有默认键的
 * 几项（引用、三种列表、分隔线）取 Word / Google 文档那一套的数字键 ——
 * 那是大部分人手指上已经有的肌肉记忆。
 *
 * `Mod` 在 Windows 上是 Ctrl，macOS 上是 ⌘。
 */
export const markdownShortcuts: KeyBinding[] = [
  { key: 'Mod-b', run: toggleMark('**'), preventDefault: true },
  { key: 'Mod-i', run: toggleMark('*'), preventDefault: true },
  // markdown 没有下划线，走行内 HTML —— 渲染层认得（见 editor/inlineHtml.ts）
  { key: 'Mod-u', run: togglePair('<u>', '</u>'), preventDefault: true },
  { key: 'Mod-e', run: toggleCode, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleMark('~~'), preventDefault: true },
  { key: 'Mod-Shift-h', run: toggleMark('=='), preventDefault: true },
  { key: 'Mod-k', run: insertLink, preventDefault: true },

  { key: 'Mod-0', run: setHeading(0), preventDefault: true },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    key: `Mod-${n}`, run: setHeading(n), preventDefault: true,
  })),

  { key: 'Mod-Shift-q', run: toggleBlock('quote'), preventDefault: true },
  { key: 'Mod-Shift-8', run: toggleBlock('bullet'), preventDefault: true },
  { key: 'Mod-Shift-7', run: toggleBlock('ordered'), preventDefault: true },
  { key: 'Mod-Shift-9', run: toggleBlock('task'), preventDefault: true },
  { key: 'Mod-Shift-Minus', run: insertRule, preventDefault: true },
]
