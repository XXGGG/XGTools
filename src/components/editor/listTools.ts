/**
 * Markdown 列表的缩进、反缩进和序号重排。
 *
 * # 为什么不用 CM6 自带的 indentMore / indentLess
 *
 * 那两个是给**代码**用的：按 indentUnit 给每行加减空白，对「这是一条列表项」
 * 一无所知。用在 markdown 上有三个问题：
 *
 *  1. 它按 indentUnit 加减空白，不认「这一级从哪到哪」。
 *  2. 缩进之后序号不会重排 —— `1 2 3 4 5` 里把 2 缩进去，外层就成了
 *     `1 3 4 5`，而正确结果是外层 `1 2 3 4`、里层单独从 1 开始。
 *  3. 它只管加空白，不管加完还是不是合法的层级（见下面「不许跳级」）。
 *
 * # 缩进宽度不是一个固定值
 *
 * markdown 里「缩一级」缩多少格，取决于**上一条项的标记有多宽**：
 *
 *     - a        内容列 2   →  孩子缩 2 格
 *     -  a       内容列 3   →  孩子缩 3 格（标记后打了两个空格）
 *     1. a       内容列 3   →  孩子缩 3 格
 *     10. a      内容列 4   →  孩子缩 4 格
 *
 * 差一格就不算孩子，而是平级的下一条 —— 源码看着缩了，渲染纹丝不动。
 * 所以这里没有 `UNIT` 常量：缩进落到「哥哥的内容列」，反缩进退到「爹那一级」，
 * 两个方向都是从文档里读出来的，不是算出来的。
 *
 * 这也让它对**别处写的文件**免疫：Obsidian 默认写 4 空格，别的编辑器写 3 空格，
 * 都能一下退到位，不会出现「按两下才退完一级」。
 *
 * 显示上每一级的宽度是统一的（listMarkers.ts 里那套 `xg-ind-N` 的 padding），
 * 源码写几格和看起来缩多宽本来就是两件事。
 *
 * # 不许跳级
 *
 * markdown 的层级是**包含关系**算出来的，不是数空格算出来的：一条项要成为
 * 第 3 级，它上面必须真的有一条第 2 级的项接着它。所以
 *
 *     1. 甲
 *             1. 乙        ← 缩进 8 格，但上面只有第 1 级
 *
 * 里的「乙」**仍然只是第 2 级** —— 多出来的 4 格纯属源码里的死空白。
 * 用户看到的现象就是「一直按 Tab，源码越缩越深，画面上却卡在第 2 级不动」，
 * 而且回车续行时新行会按解析出来的第 2 级缩进，跟上一行对不齐。
 *
 * Notion 也是这个规矩（有 1 级才能有 2 级），这里照办：**Tab 顶多把选区
 * 推到「上一条列表项再深一级」为止**，推不动就原地不动，绝不写出跳级的空白。
 *
 * # 整块一起走
 *
 * 平移量按**选区里最浅的那一行**算一次，整个选区共用 —— 这样选中一片再缩进，
 * 相对层级不变。
 *
 * # 只捎自己的子孙
 *
 * 缩进和反缩进都只带**比自己深**的行（子项、续行），不碰后面同级的兄弟。
 * 捎上兄弟的话就是「动一下，底下一片全跟着走」。
 *
 * # 只管列表
 *
 * 选区里一条列表项都没有时返回 false，CM6 会接着走它默认的那套 ——
 * 在代码块里按 Tab 还是该按代码的规矩缩进。
 */
import { EditorView } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import type { EditorState, ChangeSpec } from '@codemirror/state'

const ORDERED = /^(\s*)(\d+)([.)])(\s+)([\s\S]*)$/
const BULLET = /^(\s*)([-*+])(\s+)([\s\S]*)$/

/**
 * 一个制表符占几列。
 *
 * **缩进要按列算,不能按字符数算。** Obsidian 默认写制表符,一个 Tab 是一个字符,
 * 却顶四列宽 —— 按字符数算的话,`\t1. 子项` 的缩进是 1,回写时变成一个空格,
 * 一个空格顶不到父项的内容列(`3. ` 是 3 列),这条子项当场掉成顶层的兄弟。
 * 一动这块列表(退格、Tab)整片层级就散架,而源文件看着"只是空白变了"。
 * CommonMark 规定 Tab 停位是 4,这里照办。
 */
const TAB = 4

/** 从第 col 列开始,走过 text 之后到第几列 */
function advance(col: number, text: string): number {
  for (const ch of text) col = ch === '\t' ? (Math.floor(col / TAB) + 1) * TAB : col + 1
  return col
}

/**
 * indent 是**列**不是字符数;lead 是原样的前导空白。
 * 没动过缩进的行按 lead 原样写回去 —— 制表符缩进的文件不会因为碰了一下就被换成空格。
 */
type Row =
  | { kind: 'ol', indent: number, lead: string, num: number, dot: string, sp: string, text: string }
  | { kind: 'ul', indent: number, lead: string, mark: string, sp: string, text: string }
  | { kind: 'plain', indent: number, lead: string, text: string }

function parse(line: string): Row {
  const o = ORDERED.exec(line)
  if (o) return { kind: 'ol', indent: advance(0, o[1]), lead: o[1], num: Number(o[2]), dot: o[3], sp: o[4], text: o[5] }
  const b = BULLET.exec(line)
  if (b) return { kind: 'ul', indent: advance(0, b[1]), lead: b[1], mark: b[2], sp: b[3], text: b[4] }
  const lead = /^(\s*)([\s\S]*)$/.exec(line)!
  return { kind: 'plain', indent: advance(0, lead[1]), lead: lead[1], text: lead[2] }
}

/**
 * 一条列表项的**内容列** —— 正文从第几列开始，也就是它的孩子必须缩到哪。
 *
 * 标记连同后面那截空格有多宽就是多少：`- ` 是 2、`1. ` 是 3、`10. ` 是 4，
 * 标记后面手打了两个空格的 `-  ` 是 3。CommonMark 认的是这个列，不是「几个空格算一级」。
 */
function contentCol(r: Row): number {
  if (r.kind === 'plain') return r.indent
  const mark = r.kind === 'ol' ? `${r.num}${r.dot}` : r.mark
  return advance(advance(r.indent, mark), r.sp)
}

/** 这一块列表原本用制表符缩进吗 —— 新缩进跟着它写,不把人家的文件搅成混着的 */
function usesTabs(rows: Row[]): boolean {
  return rows.some((r) => r.lead.includes('	'))
}

function render(r: Row, tabs = false): string {
  // 缩进没动过就把原来那截空白原样写回去;动过了按列重铺 —— 铺什么字符看这块原本用什么
  const pad = advance(0, r.lead) === r.indent
    ? r.lead
    : tabs
      ? '	'.repeat(Math.floor(r.indent / TAB)) + ' '.repeat(r.indent % TAB)
      : ' '.repeat(r.indent)
  // 空行也留住缩进 —— 退格是一级一级往回走的,中间那几步正文是空的,
  // 缩进就是它当前站在第几级,抹掉的话台阶就没了
  if (r.kind === 'plain') return pad + r.text
  return r.kind === 'ol'
    ? `${pad}${r.num}${r.dot}${r.sp}${r.text}`
    : `${pad}${r.mark}${r.sp}${r.text}`
}

/**
 * 按缩进层级重编有序列表的号。
 *
 * 用一个栈跟踪层级，而不是「缩进值 ÷ 4」—— 别的编辑器写出来的文件可能是
 * 2 空格或 3 空格缩进，硬除会把它们全算成同一层。
 * 同一层里从有序换成无序（或反过来）就重新计数：那本来就是两个列表。
 */
function renumber(rows: Row[]) {
  const stack: { indent: number, kind: 'ol' | 'ul', n: number }[] = []
  for (const r of rows) {
    if (r.kind === 'plain') {
      // 顶格的普通行会**终结**这个列表,后面的项要从 1 重新数
      if (r.indent === 0 && r.text) stack.length = 0
      continue
    }
    while (stack.length && r.indent < stack[stack.length - 1].indent) stack.pop()
    const top = stack[stack.length - 1]
    if (!top || r.indent > top.indent) {
      stack.push({ indent: r.indent, kind: r.kind, n: 0 })
    } else if (top.kind !== r.kind) {
      top.kind = r.kind
      top.n = 0
    }
    const cur = stack[stack.length - 1]
    cur.n += 1
    if (r.kind === 'ol') r.num = cur.n
  }
}

/**
 * 找到光标所在的那整块列表。
 *
 * 边界是**空行**或**顶格的非列表行** —— 缩进着的非列表行是列表项的续行
 * （一条列表项写了两段），把它切掉的话下半段会被算成另一个列表，序号从头再来。
 */
function blockRange(state: EditorState, fromLine: number, toLine: number) {
  const isPart = (n: number) => {
    const t = state.doc.line(n).text
    if (!t.trim()) return false
    return parse(t).kind !== 'plain' || /^\s+/.test(t)
  }
  let a = fromLine
  while (a > 1 && isPart(a - 1)) a -= 1
  let b = toLine
  while (b < state.doc.lines && isPart(b + 1)) b += 1
  return { a, b }
}

/** dir: 1 缩进、-1 反缩进 */
export function listIndent(dir: 1 | -1): Command {
  return ({ state, dispatch }) => {
    const { from, to } = state.selection.main
    const first = state.doc.lineAt(from).number
    const last = state.doc.lineAt(to).number

    // 选区里一条列表项都没有 —— 不是我们的活,让给 CM6 的默认缩进
    let touched = false
    for (let n = first; n <= last; n++) {
      if (parse(state.doc.line(n).text).kind !== 'plain') { touched = true; break }
    }
    if (!touched) return false

    const { a, b } = blockRange(state, first, last)
    const rows: Row[] = []
    for (let n = a; n <= b; n++) rows.push(parse(state.doc.line(n).text))
    const row = (n: number) => rows[n - a]

    // 选中行里最浅的那一级 —— 缩进方向整个选区共用一个平移量,靠它算
    let minIndent = Infinity
    for (let n = first; n <= last; n++) {
      const r = row(n)
      if (r.kind !== 'plain') minIndent = Math.min(minIndent, r.indent)
    }

    /*
      两个方向的平移量算法不一样,各自做那个方向上唯一说得通的事:

      · Tab —— **整个选区共用一个量**,相对层级原样保留。
        目标是「上面那位哥哥的内容列」(见 contentCol),推不到就原地不动。

      · Shift+Tab —— **每行各自退到「它爹那一级」**,退到顶格为止。
        反缩进是「把这一片拉平」,`1 2 1 2 1` 该变成 `1 1 1 1 1`;
        换成共用一个量的话,最浅那行已经顶格,算出来是 0,整片纹丝不动。
        往浅了走不会制造跳级,所以不需要那道限制。

      两边都**不用固定宽度**。固定宽度只有在整份文件缩进一致时才碰巧对,
      而真实的库里宽度是混的:`- ` 是 2、`1. ` 是 3、`10. ` 是 4,
      Obsidian 默认还写 4。减固定值的后果是一条 4 空格的项要按两下
      Shift+Tab 才退完一级(4 → 2 → 0),中间那下看着「没反应」。
    */

    /** 这一行的爹缩进多少 —— 上面最近的、比它浅的那条列表项;没有就是顶格 */
    function parentIndent(n: number): number {
      const mine = row(n).indent
      for (let i = n - 1; i >= a; i--) {
        const r = row(i)
        if (r.kind !== 'plain' && r.indent < mine) return r.indent
      }
      return 0
    }

    /*
      缩进的落点:**选区上面那条同级的哥哥的内容列**。

      「一次缩 N 格」是错的 —— markdown 里一条项要成为某条项的孩子,
      必须缩到那条项的**内容列**(标记连同后面的空格有多宽,就得缩多少):

          - a      内容列 2  →  孩子写 2 格
          -  a     内容列 3  →  孩子写 3 格(标记后打了两个空格)
          1. a     内容列 3  →  孩子写 3 格
          10. a    内容列 4  →  孩子写 4 格

      差一格就不算孩子,而是**平级的下一条** —— 源码看着缩进了,渲染纹丝不动。
      有序列表尤其明显:固定 2 格的话它根本嵌套不起来。

      找不到哥哥(上面那条比我浅,或者我就是第一条)就推不动:那说明我已经是
      老大,没有能垫脚的同级项,硬缩只会写出跳级的死空白。
    */
    let target = -1
    for (let n = first - 1; n >= a; n--) {
      const r = row(n)
      if (r.kind === 'plain' || r.indent > minIndent) continue   // 更深的是侄子,跳过
      if (r.indent === minIndent) target = contentCol(r)         // 哥哥,落在他的内容列
      break                                                       // 比我浅 = 我爹,我是老大
    }
    const uniform = target < 0 ? 0 : Math.max(0, target - minIndent)

    /*
      平移量按行铺开,选区底下的后代跟着走。

      两个方向都捎上,不然一夹一放树结构就散了:反缩进不捎,爹退到顶格而
      孙子还在原来的深度,当场变成跳级的孤儿;缩进不捎,儿子会从「儿子」
      掉成「弟弟」。续行(缩进着的非列表行)同理,不跟着走就掉出这一条。
    */
    const delta: number[] = new Array(b - a + 1).fill(0)
    let cur = 0
    let lastListIndent = 0
    for (let n = first; n <= last; n++) {
      const r = row(n)
      if (r.kind !== 'plain') {
        cur = dir > 0 ? uniform : parentIndent(n) - r.indent
        lastListIndent = r.indent
      }
      delta[n - a] = cur
    }
    /*
      往后只捎**比我深**的行 —— 我的子孙和续行,不碰后面同级的兄弟。

      两个方向都一样。捎上兄弟的话就是「我动一下,下面一片全跟着走」;
      兄弟因此改了辈分(反缩进时会从我的兄弟变成我的儿子)是 markdown 的
      表达能力问题,不是这里该替用户做主的事。
    */
    for (let n = last + 1; n <= b && row(n).indent > lastListIndent; n++) {
      delta[n - a] = cur
    }

    let moved = false
    for (let n = a; n <= b; n++) {
      const d = delta[n - a]
      const r = row(n)
      if (!d || (r.kind === 'plain' && !r.text)) continue   // 空行没有缩进可言
      r.indent = Math.max(0, r.indent + d)
      moved = true
    }
    if (!moved) return true   // 推不动;但也别让 Tab 插进一个制表符
    renumber(rows)

    const start = state.doc.line(a).from
    const end = state.doc.line(b).to
    const tabs = usesTabs(rows)
    const changes: ChangeSpec = { from: start, to: end, insert: rows.map((r) => render(r, tabs)).join('\n') }

    /*
      光标跟着缩进走。

      不显式给 selection 的话,CM6 会把光标映射到替换文本的开头 ——
      每按一次 Tab 光标就跳回列表块的第一行,根本没法连着按。
    */
    const anchorLine = state.doc.lineAt(from)
    const newFrom = state.doc.line(a).from
      + rows.slice(0, anchorLine.number - a).reduce((s, r) => s + render(r, tabs).length + 1, 0)
      + Math.max(0, from - anchorLine.from + delta[anchorLine.number - a])

    dispatch(state.update({
      changes,
      selection: from === to ? { anchor: newFrom } : undefined,
      scrollIntoView: true,
      userEvent: dir > 0 ? 'input.indent' : 'delete.dedent',
    }))
    return true
  }
}

/** 列表标记连同后面那截空格。m[0] 的长度就是「正文从第几列开始」 */
const MARKER = /^(\s*)(?:[-*+]|\d+[.)])(\s+)/

/** 整行就是一个**空的列表项**:只有缩进 + 标记(后面顶多剩空白) */
const EMPTY_ITEM = /^(\s*)(?:[-*+]|\d+[.)])[ \t]*$/

/**
 * 光标正好停在正文开头时，退格走**一级一级的台阶**，不是一个字符一个字符。
 *
 * 从一条第 3 级的项开始，连按三下的样子是：
 *
 *     1. a
 *        1. b
 *           1. c     ← 光标在 c 前面
 *
 *     第 1 下 → 去掉标记，字**留在原来那一级**   `      c`
 *     第 2 下 → 退到上一级                        `   c`
 *     第 3 下 → 回到行首                          `c`
 *
 * 也就是「这一行不要序号了」和「这一行要往回退」是两件事，各占一下。
 *
 * # 为什么要自己写
 *
 * `@codemirror/lang-markdown` 的 `deleteMarkupBackward` 在这里做的是
 * **把标记换成等宽的空格**（`      - ` → 8 个空格），好让正文列不动。
 * 后果有两个，都挺难受：
 *
 *  1. 退不完。剩下的空格只能一个一个删，第 3 级要按 6 下才回得到行首。
 *  2. 中途每一步都停在**只有空白的行**上。这种行在 `white-space: pre-wrap`
 *     里尾部空白会被浏览器折叠掉，看着光标贴在最左边；一打字空白不再是
 *     尾部了，立刻显形，字「啪」地弹到那一级的正文列去。
 *
 * 只在光标**正好在正文开头**时接管，其余位置一律放行走默认删字符。
 */
export const listBackspace: Command = (target) => {
  const { state } = target
  const sel = state.selection.main
  if (!sel.empty) return false

  const line = state.doc.lineAt(sel.head)

  /*
    **空项**上退格 = 把这一行整个删掉,光标回到上一行末尾。

    以前是把标记剥掉、留一个空行在列表中间。空行在 markdown 里是列表的终止符:
    后面那些项被当成一个新列表,连带子项的层级一起重排,画面上整片列表当场散架
    (2026-08-29 踩过:删掉一个空的「2.」,下面十几条的缩进全没了)。
    一个空项没有内容可保留,删行是唯一不牵连别人的做法;序号顺手重排。

    **不要求光标停在哪一列** —— 标记在画面上被换成了圆点/序号,光标落在标记里的
    哪一格全看渲染,卡着"正好在标记后面"这个条件的话,少数情况下就漏给了
    markdown 自带的 deleteMarkupBackward(它把标记换成等宽空格,于是留下半级空白行,
    整片列表照样散架)。空项整行都没内容,光标在这行的任何位置删掉它都是对的。
  */
  if (EMPTY_ITEM.test(line.text) && line.number > 1) {
    const { a, b } = blockRange(state, line.number, line.number)
    const i = line.number - a
    const prev = state.doc.line(line.number - 1)
    if (i === 0) {
      // 上一行不在这块列表里(空行或普通段落):直接把这行连换行一起删
      target.dispatch(state.update({
        changes: { from: prev.to, to: line.to },
        selection: { anchor: prev.to },
        scrollIntoView: true,
        userEvent: 'delete.backward',
      }))
      return true
    }
    const rows: Row[] = []
    for (let n = a; n <= b; n++) rows.push(parse(state.doc.line(n).text))
    rows.splice(i, 1)
    renumber(rows)
    const text = rows.map((r) => render(r, usesTabs(rows)))
    const head = state.doc.line(a).from
      + text.slice(0, i - 1).reduce((s, t) => s + t.length + 1, 0)
      + text[i - 1].length
    target.dispatch(state.update({
      changes: { from: state.doc.line(a).from, to: state.doc.line(b).to, insert: text.join('\n') },
      selection: { anchor: head },
      scrollIntoView: true,
      userEvent: 'delete.backward',
    }))
    return true
  }

  const m = MARKER.exec(line.text)
  const lead = /^\s*/.exec(line.text)![0].length
  // 有标记就是标记后面,没标记就是缩进后面
  if (sel.head - line.from !== (m ? m[0].length : lead)) return false
  if (!m && lead === 0) return false          // 顶格的普通行,没台阶可退

  const { a, b } = blockRange(state, line.number, line.number)
  const rows: Row[] = []
  for (let n = a; n <= b; n++) rows.push(parse(state.doc.line(n).text))
  const i = line.number - a
  const me = rows[i]

  /*
    没有标记的行才动缩进。落点是**上面那些项的内容列里、比我浅的那一个** ——
    和缩进用的是同一把尺子,所以退回去的位置和当初 Tab 出来的位置分毫不差。
    往上找,第一个比我浅的就是我爹那一级。
  */
  let indent = me.indent
  if (!m) {
    if (!rows.some((r) => r.kind !== 'plain')) return false   // 不在列表里,别乱接管
    indent = 0
    for (let n = line.number - 1; n >= a; n--) {
      const r = rows[n - a]
      if (r.kind === 'plain') continue
      const c = contentCol(r)
      if (c < me.indent) { indent = c; break }
    }
  }

  rows[i] = { kind: 'plain', indent, lead: indent === me.indent ? me.lead : ' '.repeat(indent), text: me.text }
  renumber(rows)

  /*
    退到顶格、而且行里有字的时候，前面补一个空行。

    markdown 里紧跟在列表项后面的那一行，哪怕顶格也算这条项的**续行**
    （lazy continuation），照样渲染在列表里 —— 看到的就是「明明已经退到底了，
    为什么还挤在这一坨里」。空行才是列表的终止符。
    正文是空的那一步不用补：空行自己就把列表断开了。
  */
  const escape = indent === 0 && !!me.text && a < line.number
  const text = rows.map((r) => render(r, usesTabs(rows)))
  if (escape) text.splice(i, 0, '')

  // 光标停在新的正文开头
  const head = state.doc.line(a).from
    + text.slice(0, i + (escape ? 1 : 0)).reduce((s, t) => s + t.length + 1, 0)
    + indent

  target.dispatch(state.update({
    changes: {
      from: state.doc.line(a).from,
      to: state.doc.line(b).to,
      insert: text.join('\n'),
    },
    selection: { anchor: head },
    scrollIntoView: true,
    userEvent: 'delete.backward',
  }))
  return true
}

/**
 * 刚敲完 `- [ ]` 就接着打字，自动把那个空格补上。
 *
 * GFM 要求 `[ ]` 后面跟一个空白才算任务项。而我们让光秃秃的 `- [ ]` 也画出
 * 方框（见 strictLists），用户看见方框自然就直接打字 —— 源码成了 `- [ ]1`，
 * 不再是任务项。更糟的是 atomic-editor 那条「藏掉 `- `」的规则不要求空格，
 * 于是圆点被藏了、方框又没画，整行就剩 `[ ]1` 三个字面字符，像是掉回了源码。
 *
 * 只管这一种情形：光标在行尾、行上正好是「标记 + `[ ]`」、打进来的不是空白。
 */
export const taskSpace = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || !text || /^\s/.test(text)) return false
  const line = view.state.doc.lineAt(from)
  if (from !== line.to) return false
  if (!/^\s*[-*+]\s+\[[ xX]\]$/.test(line.text)) return false
  view.dispatch({
    changes: { from, insert: ' ' + text },
    selection: { anchor: from + 1 + text.length },
    userEvent: 'input.type',
  })
  return true
})
