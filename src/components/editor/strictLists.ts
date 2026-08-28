/**
 * 让列表和分隔线按「看得见的规矩」来解析。
 *
 * 改两件事，都是 CommonMark 明文允许、但写笔记时纯属添乱的行为：
 *
 * # 一、光一个 `-` 或 `1.`（后面什么都没有）不算列表
 *
 * CommonMark 里「空列表项」是合法的：一行只有 `-`、或者只有 `1.`，就已经是
 * 一条列表项了。于是打字过程中会这样：
 *
 *     打「1」「.」  →  这一刻整行已经是合法列表，序号立刻被渲染成列表标记
 *     接着打「还」  →  变成 `1.还`，后面没空格，不是列表了，又变回普通文本
 *
 * 中文输入尤其容易撞上 —— 中文没有词间空格，`1.还没空格` 这种写法很常见，
 * 而它会在你打第二个字之前闪一下列表样式。用户看到的就是「没打空格也渲染」。
 *
 * 规矩改成：**标记符后面必须真的有东西**（`- ` / `1. `）才算列表。
 * `- ` 后面留空、正准备打字，照样是列表 —— 那是正常写作流程。
 *
 * # 二、一行只认第一个标记
 *
 * `1. - x` 在 CommonMark 里合法：有序项里同一行又开了个无序列表。写笔记时
 * 这只会添乱 —— 想把 `1. ` 换成 `- ` 而顺手打了个 `-`，画面上就冒出
 * 「一行两个标记」，光标还会落到新标记前面。第二个之后的标记一律当普通文字。
 *
 * # 三、去掉 Setext 标题
 *
 * Setext 是用下划线定标题的老写法：
 *
 *     标题文字
 *     ===        ← 上面那行变成 H1
 *     标题文字
 *     ---        ← 上面那行变成 H2
 *
 * 麻烦在于**一个 `-` 就够**（`---` 只是常见写法，不是要求）。所以在正文下面
 * 想打一条分隔线、或者想起个无序列表，上一行就被吸走变成标题了。
 * 我们统一用 `#` 开头写标题，Setext 有害无益，整个关掉。
 *
 * 关掉之后：正文下面的 `---` 老老实实是分隔线，单个 `-` 也不再抢上一行。
 *
 * # 为什么要动到 @lezer/markdown 的内部字段
 *
 * `MarkdownConfig.parseBlock` 支持按名字**替换**默认的块解析器，但没有公开
 * 「取出默认那个」的入口 —— 而这里想要的是加一道前置判断，判断通过之后
 * 照旧走原来那套（列表的上下文栈、缩进基准那些逻辑很细，抄一份必然走样）。
 *
 * 所以从导出的 `parser` 上按名字取原函数。这两个字段不在 .d.ts 里，
 * 升级 @lezer/markdown 之后有可能变形，因此下面在模块加载时就校验一次：
 * 拿不到就**当场抛**，而不是悄悄退化成「列表全不解析」。
 */
import { parser as baseParser, type BlockContext, type BlockParser, type LeafBlock, type Line, type MarkdownConfig } from '@lezer/markdown'

type ParserInternals = {
  blockNames: readonly string[]
  blockParsers: readonly (BlockParser['parse'] | undefined)[]
}

function defaultParser(name: string): NonNullable<BlockParser['parse']> {
  const p = baseParser as unknown as ParserInternals
  const at = p.blockNames?.indexOf(name) ?? -1
  const fn = at < 0 ? undefined : p.blockParsers[at]
  if (typeof fn !== 'function') {
    throw new Error(
      `@lezer/markdown 里取不到默认的 ${name} 块解析器 —— 内部结构变了。`
      + '别放着不管：这会让列表整个失去解析。',
    )
  }
  return fn
}

const DASH = 45
const PLUS = 43
const STAR = 42
const DOT = 46
const PAREN = 41

/**
 * 这一行是不是「光秃秃一个列表标记符」—— 标记符正好是这行最后一个字符。
 *
 * 只拦这一种。`-x`、`1.x`（后面不是空格）默认就已经不算列表了，不用管；
 * `- ` 后面留空是正常的「刚起了一条，还没打字」，得放行。
 */
function bareMarker(line: Line): boolean {
  const t = line.text
  let i = line.pos
  const c = t.charCodeAt(i)

  if (c === DASH || c === PLUS || c === STAR) {
    i += 1
  } else {
    let j = i
    while (j < t.length) {
      const d = t.charCodeAt(j)
      if (d < 48 || d > 57) break
      j += 1
    }
    if (j === i) return false              // 压根没有数字，不是有序列表
    const d = t.charCodeAt(j)
    if (d !== DOT && d !== PAREN) return false
    i = j + 1
  }

  // 标记符就是行尾 —— 拦下。后面还有东西的一律不插手:
  // 是空格就是正常列表,不是空格默认解析器自己会拒。
  return i >= t.length
}

/**
 * 这一行**前面已经有过一个标记**了吗。
 *
 * `1. - x` 在 CommonMark 里是合法的：有序项里同一行又开了个无序列表。
 * 写笔记时没人想要这个 —— 想在 `1. ` 后面打个 `- ` 换成无序，
 * 结果画面上冒出「一行两个标记」的 `1. ●`，光标还落到新标记前面去。
 *
 * 规矩定成：**一行只认第一个标记**，后面的一律当普通文字。
 */
function secondMarkerOnLine(line: Line): boolean {
  return /(?:^|\s)(?:[-*+]|\d+[.)])\s/.test(line.text.slice(0, line.pos))
}

/**
 * 刚敲完 `- ` / `1. `（还没打字）也算「这一段到此为止」。
 *
 * CommonMark 有条规矩：**空的列表项不能打断上面那段文字**。于是
 *
 *     1. 完美
 *     2. 完美
 *        - ⟨光标⟩
 *
 * 里那个 `- ` 只算「完美」那一段的续行，画面上就是一个光秃秃的横杠；
 * 要等打上第一个字才忽然变成列表项。写笔记时这一下很突兀。
 *
 * （父项也是无序列表时不会有这个问题 —— 那时候「已经在无序列表里」，
 * 规矩本来就放行。所以只有从有序切到无序、或者段落后面直接起列表时才撞上。）
 */
function emptyItemBreaksParagraph(_cx: BlockContext, line: Line): boolean {
  return /^\s*(?:[-*+]|\d+[.)])[ 	]+$/.test(line.text)
}

/** 包一层：不该算列表的两种情况直接返回 false，让它继续往下走成普通段落 */
function strict(name: string): BlockParser {
  const inner = defaultParser(name)
  return {
    name,
    parse: (cx, line) => (bareMarker(line) || secondMarkerOnLine(line) ? false : inner(cx, line)),
  }
}

/**
 * 光秃秃的 `- [ ]`（后面还没打字）也算任务项。
 *
 * GFM 的原话是「`[ ]` 后面必须跟一个空白」，所以刚敲完 `- [ ]` 的那一刻
 * 它还不是任务项 —— 画面上是一对方括号的字面文字，得再敲一个空格才「啪」地
 * 变成复选框。和空的 `- ` 不算列表是同一类毛病，一起治了：**行尾**也当空白算。
 *
 * 判定之外的部分照抄 lezer 的实现（就是给这一段挂一个 Task 节点、
 * 前三个字符是 TaskMarker），它没把那个类导出来，只能自己写一遍。
 */
class TaskLeaf {
  nextLine() { return false }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(leaf, cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
      cx.elt('TaskMarker', leaf.start, leaf.start + 3),
      ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
    ]))
    return true
  }
}

export const strictLists: MarkdownConfig = {
  remove: ['SetextHeading'],
  parseBlock: [
    { ...strict('BulletList'), endLeaf: emptyItemBreaksParagraph },
    strict('OrderedList'),
    {
      // 按名字替换掉 GFM 那份,只把「后面必须跟空白」放宽成「跟空白或者到行尾」
      name: 'TaskList',
      leaf: (cx, leaf) => (
        /^\[[ xX]\](?:[ 	]|$)/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new TaskLeaf()
          : null
      ),
    },
  ],
}
