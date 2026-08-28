/**
 * 列表的两件显示层的事：标记按层级换样子，以及每一级的缩进画多宽。
 *
 *     有序：1.  →  a.  →  i.   （再往下循环）
 *     无序：●   →  ○   →  ■    （再往下循环）
 *
 * # 为什么要单独写一层
 *
 * markdown 源码里没有「第二级用字母」这回事 —— 有序列表永远写成 `1. 2. 3.`，
 * 层级是缩进关系。所以 a / i 只能是**显示层**的事，源码一个字都不改，
 * 拿去 Obsidian 打开还是标准 markdown。
 *
 * atomic-editor 自己也画列表标记，但它不分层级：无序一律实心圆点，
 * 有序直接把源码里的数字露出来。它没开放配置，所以在它上面再盖一层。
 *
 * # 缩进宽度也在这里盖
 *
 * 列表的缩进不是把源码里的空格画出来 —— atomic-editor 把行首那些空格
 * **整个藏起来**，改成按解析树的层级给整行加 `padding-left`。
 * 也就是说源码写 2 个空格还是 8 个空格，看起来一模一样。
 *
 * 它那个数是每级 0.6em，太挤，层级看不出来。这里给每行挂一个 `xg-ind-N`
 * 的类，CSS 用 `!important` 盖掉它的行内 `padding-left`（行内样式只有
 * `!important` 盖得住）。**必须用类而不是直接写行内样式** —— 两份行内
 * 样式谁后生效取决于装饰集的排序，不可靠；类名是叠加的，不会打架。
 *
 * 每一行都要挂，不只是带标记的那行：一条列表项写了两段的话，
 * 续行也归它管，漏掉就会和第一行对不齐。
 *
 * # 两种标记盖法不一样
 *
 * · **无序**：atomic-editor 已经把 `-` 换成了一个 `.cm-atomic-bullet` 部件。
 *   两个 replace 抢同一段会打架，所以这里不碰它，只靠上面那个层级类，
 *   让 CSS 去换那个圆点的字形（见 MarkdownEditor.vue 的样式）。
 *
 * · **有序**：atomic-editor 只给数字加了个 class，字本身是露出来的，
 *   那就可以安心用 replace 换成 `a.` / `i.`。
 *   **每一级都换，哪怕第一级换出来还是 `1.`** —— 换成部件之后，序号和圆点
 *   用的是同一个 span、同一套盒子，起点才对得齐；留一半走 atomic 的
 *   mark 装饰，两边盒子行为不一样，怎么调都差一截。
 *   **光标所在行也照换** —— 试过「编辑那行露出真实源码」，结果是点一下
 *   `a.` 就跳回 `1.`，看着像 bug。序号本来就是我们自己重排的，
 *   没有手改的必要，稳定比露源码重要。
 */
import { ViewPlugin, Decoration, WidgetType, EditorView, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, RangeSet } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/** 循环长度 3：1 / a / i，和 Notion 一样到第四级从头再来 */
const CYCLE = 3

/** 这一行是不是列表项的**第一行**（带标记那行），而不是它的续行 */
const MARKER_LINE = /^\s*(?:[-*+]|\d+[.)])\s/

/** 缩进宽度那套 CSS 只写到这一级，再深的共用最后一档 */
const MAX_INDENT_CLASS = 9

function toAlpha(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    x -= 1
    s = String.fromCharCode(97 + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return s || '1'
}

const ROMAN: [number, string][] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
  [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function toRoman(n: number): string {
  if (n <= 0) return '1'
  let x = n
  let s = ''
  for (const [v, sym] of ROMAN) {
    while (x >= v) { s += sym; x -= v }
  }
  return s
}

/** lvl 从 0 起算：0 → 数字，1 → 字母，2 → 罗马 */
function ordinal(n: number, lvl: number): string {
  const step = lvl % CYCLE
  return step === 1 ? toAlpha(n) : step === 2 ? toRoman(n) : String(n)
}

/**
 * 这个位置在第几级列表里，0 起算；不在列表里返回 -1。
 *
 * 数祖先里有几个 ListItem，**不是**拿缩进的空格数去除 —— 别的编辑器写出来的
 * 文件可能是 2 空格或 3 空格缩进，硬除会把它们全算成同一层。
 * 这也和 atomic-editor 自己算 padding 用的口径一致（它数的是 item 的祖先，
 * 所以顶级项是 0），两边对得上，盖上去才不会错位。
 */
function levelAt(node: SyntaxNode | null): number {
  let lvl = -1
  for (let n = node; n; n = n.parent) if (n.name === 'ListItem') lvl += 1
  return lvl
}

class OrdinalWidget extends WidgetType {
  constructor(readonly label: string) { super() }
  eq(other: OrdinalWidget) { return other.label === this.label }
  toDOM() {
    const span = document.createElement('span')
    /*
      **不要**挂 atomic 那个 `cm-atomic-list-marker` 类。

      它给序号加的那层 mark 外壳还留在 DOM 里,两个都挂同一个类的话
      外壳和这个部件会各占一个凹槽,序号被挤到左边一整格去。
      用自己的类名,样式只落在真正画字的这一个元素上。
    */
    span.className = 'xg-ordinal'
    span.textContent = this.label
    return span
  }
  ignoreEvent() { return false }
}

/** 缩进已经退出列表了,但解析树还把它算在列表里 —— 把树给的 padding 清掉 */
const OUT_OF_LIST = Decoration.line({ class: 'xg-out' })

type Pending = { from: number, to: number, deco: Decoration }

/** 标记那一段(行首空白 + 标记 + 后面的空格)的范围,用来做「光标进不去」 */
type Built = { decorations: DecorationSet, atomic: RangeSet<Decoration> }

function build(view: EditorView): Built {
  const { state } = view
  const tree = syntaxTree(state)
  const out: Pending[] = []
  const marks: Pending[] = []

  /*
    逐行定级,而不是逐个 ListItem 铺开。

    一条列表项管着好几行(自己 + 续行),而**内层项的行也在外层项的范围里** ——
    按项铺的话同一行会被外层和内层各挂一次类,两条 padding 规则打起来,
    谁赢取决于样式表里的先后,和层级没关系。
    按行找「最内层的那个 ListItem」就只会挂一次。
  */
  /*
    只有空白、一个字都没有的行也要定级。

    退格是一级一级往回走的,中间那几步正文还没写,行上只剩缩进。这种行
    解析树里不属于任何列表项,拿不到层级 —— 不管的话它会掉回 0 缩进,
    光标贴在最左边;等一打字,行首那些空格突然又算数了,字「啪」地弹回
    那一级去。所以这里自己维护一个「内容列 → 层级」的栈:碰到带标记的行
    就压进去,碰到空白行就拿它的缩进去栈里查自己站在第几级。
  */
  const stack: { col: number, lvl: number }[] = []

  const push = (at: number, lvl: number, extra = '') => out.push({
    from: at, to: at,
    deco: Decoration.line({
      class: `xg-lvl-${lvl % CYCLE} xg-ind-${Math.min(lvl, MAX_INDENT_CLASS)}${extra}`,
    }),
  })

  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = state.doc.lineAt(pos)
      const off = line.text.search(/\S/)

      if (off < 0) {
        // 只有空白的行:拿缩进去栈里查自己站在第几级
        while (stack.length && stack[stack.length - 1].col > line.text.length) stack.pop()
        const top = stack[stack.length - 1]
        if (line.text.length && top) {
          push(line.from, top.lvl)
          /*
            行首那些空格也要藏掉,和有正文的行一个待遇。
            `white-space: pre-wrap` 下行尾空白会「挂」在内容外面,光标就停在
            那一截的右端;等一打字空格被藏起来,字落回 padding 处 —— 中间
            差着十几像素,看着就是「字自己往左跳了一下」。
          */
          out.push({ from: line.from, to: line.to, deco: Decoration.replace({}) })
        }
        if (!line.text.length) stack.length = 0   // 真空行:列表到此为止
      } else {
        const lvl = levelAt(tree.resolveInner(line.from + off, 1))
        const m = MARKER_LINE.exec(line.text)

        if (lvl < 0) {
          stack.length = 0                          // 出了列表,栈清掉
        } else if (m) {
          while (stack.length && stack[stack.length - 1].col > off) stack.pop()
          stack.push({ col: m[0].length, lvl })
          // 带标记那行要单独认出来:只有它需要负的 text-indent 把标记拽进凹槽
          push(line.from, lvl, ' xg-mk')
          /*
            标记那一段整个划成「原子区」——光标不许停在里面。

            标记在画面上被换成了一颗圆点,可它在文档里仍然是 `- ` 两个字符,
            点在圆点左边就把光标落到了这两个字符**前面**;这时候一打字,
            字插到 `-` 前头,整行当场不再是列表项。
          */
          marks.push({ from: line.from, to: line.from + m[0].length, deco: Decoration.mark({}) })
        } else {
          /*
            续行按**自己缩进了多少**定级,不看解析树怎么说。

            解析树在这里帮不上忙:一条列表项底下连着写好几行、中间没有空行的话,
            CommonMark 把它们全并进**同一个段落**(lazy continuation),缩进
            一律忽略。也就是说

                - 三级
                      正文        ← 树里
                  正文            ← 这
                正文              ← 三行

            在树里是同一段、同一层,退多少格都渲染在第三级那个位置 ——
            用户看到的就是「退了一格位置没变」「退到首位了还在这一坨里」。

            所以这里改用缩进去查上面那个栈:缩进落在谁的内容列之内就归谁。
            退到比最外层还浅时栈会空掉,那就是真出了列表 —— 挂 xg-out
            把 atomic-editor 按树算出来的那份 padding 清掉。
          */
          while (stack.length && stack[stack.length - 1].col > off) stack.pop()
          const top = stack[stack.length - 1]
          if (top) push(line.from, top.lvl)
          else out.push({ from: line.from, to: line.from, deco: OUT_OF_LIST })
        }
      }
      pos = line.to + 1
    }
  }

  // 有序列表的序号换成 a. / i.
  tree.iterate({
    from: view.visibleRanges[0]?.from ?? 0,
    to: view.visibleRanges[view.visibleRanges.length - 1]?.to ?? state.doc.length,
    enter: (node) => {
      if (node.name !== 'ListMark' || node.from >= node.to) return
      const text = state.sliceDoc(node.from, node.to)
      const m = /^(\d+)([.)])$/.exec(text)
      if (!m) return
      const lvl = levelAt(node.node)
      if (lvl < 0) return
      out.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({
          widget: new OrdinalWidget(ordinal(Number(m[1]), lvl) + m[2]),
        }),
      })
    },
  })

  /*
    RangeSetBuilder 要求**升序**喂进去,乱序会当场抛。
    上面是两趟扫描拼起来的,天然不有序,所以这里排一遍。
    行装饰(零宽,落在行首)和同一行的标记替换撞上时,行装饰排前面。
  */
  out.sort((x, y) => x.from - y.from || x.to - y.to)
  const b = new RangeSetBuilder<Decoration>()
  for (const r of out) b.add(r.from, r.to, r.deco)

  const a = new RangeSetBuilder<Decoration>()
  for (const r of marks) a.add(r.from, r.to, r.deco)

  return { decorations: b.finish(), atomic: a.finish() }
}

export function listMarkers() {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      atomic: RangeSet<Decoration>
      constructor(view: EditorView) {
        const r = build(view)
        this.decorations = r.decorations
        this.atomic = r.atomic
      }
      // 光标移动不影响显示,不用跟着重算
      update(u: { docChanged: boolean, viewportChanged: boolean, view: EditorView }) {
        if (!u.docChanged && !u.viewportChanged) return
        const r = build(u.view)
        this.decorations = r.decorations
        this.atomic = r.atomic
      }
    },
    {
      decorations: (v) => v.decorations,
      // 光标落进标记那一段时,CM6 会把它推到边界上
      provide: (p) => EditorView.atomicRanges.of(
        (view) => view.plugin(p)?.atomic ?? RangeSet.empty,
      ),
      eventHandlers: {
        /*
          点在圆点上、或者圆点左边那片空白上,光标要落到**正文开头**。

          光是 atomicRanges 不够:它只保证光标不停在那一段的**中间**,
          而行首(那一段的左边界)本身是合法位置 —— 点一下就落在 `- ` 前面,
          一打字整行当场不再是列表项(`9- 123`)。方向键靠 atomicRanges
          跨过去就行,鼠标得单独接一下。
        */
        mousedown(this: { atomic: RangeSet<Decoration> }, e: MouseEvent, view: EditorView) {
          if (e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos == null) return false
          let hit = -1
          this.atomic.between(pos, pos, (_from, to) => { hit = to; return false })
          if (hit < 0 || pos >= hit) return false
          view.dispatch({ selection: { anchor: hit }, userEvent: 'select.pointer' })
          view.focus()
          e.preventDefault()
          return true
        },
      },
    },
  )
  return plugin
}
