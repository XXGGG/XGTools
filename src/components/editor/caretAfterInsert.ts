/**
 * 打进去的字,光标要落在它**后面**。
 *
 * # 症状
 *
 * 空的列表项(`3. ` 后面还没写字)里,用中文输入法打一个全角标点 ——【（，《
 * 之类 —— 字进去了,光标却停在它前面:
 *
 *     3. |【        ← 再打一个字会变成 `3. 1【`
 *
 * 普通段落里没这毛病,列表项里已经有字了也没有,而且时灵时不灵。
 *
 * # 为什么
 *
 * 中文标点走的是输入法的组合输入(composition),不是普通按键。这条路上光标不是
 * CM 自己算的,是去读浏览器给的 DOM 选区 —— 而输入法提交这个字的那一瞬间,
 * 浏览器有时报的是「这个字的开头」而不是结尾(组合区间的起点)。序号被换成了
 * 部件、标记那一段又是原子区,这一带的 DOM 结构本来就和文档对不上,更容易报偏。
 * 于是字插在了光标右边,光标自己没挪窝。
 *
 * 普通打字不走这条路(那边直接按选区替换,天然把光标放到末尾),所以只有输入法
 * 这一种情况会露出来;也因为是「有时报偏」,同样的操作有时对有时错。
 *
 * # 怎么修
 *
 * 光标停在自己刚打出来的那串字最前面,这在任何情况下都不是用户想要的。所以这里
 * 只认这一个形状:一次输入产生的一处改动、确实插入了内容、而事后光标正贴在这串
 * 新字的开头 —— 把它挪到末尾去。别的形状一概不碰:
 *
 * - 拼音打词中途 CM 自己算准了光标(落在末尾),进不来
 * - 自动补全的括号把光标放在**中间**(不是开头),进不来
 * - 纯删除、多处改动、非输入类事务,进不来
 */
import { EditorSelection, EditorState } from '@codemirror/state'

export const caretAfterInsert = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input.type')) return tr

  // 一次输入只会产生一处改动;插入了东西才谈得上「光标该在它后面」
  let from = -1, to = -1, count = 0
  tr.changes.iterChanges((_fromA, _toA, fromB, toB) => { count += 1; from = fromB; to = toB })
  if (count !== 1 || to <= from) return tr

  const after = tr.newSelection.main
  // 只认「光标正贴在这串新字的最前面」这一种;落在别处的都是正常的
  if (!after.empty || after.head !== from) return tr

  return [tr, { selection: EditorSelection.cursor(to) }]
})
