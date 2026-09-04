/**
 * 没标语言的代码块，整块字是紫的 —— 这是主题的锅，不是内容的。
 *
 * 那一段在语法树里是 `CodeText`，高亮标签是 `t.monospace`；atomic 的主题给这个标签
 * 配的是**链接色**（行内代码也走同一个标签，但它的壳子 `.cm-atomic-inline-code`
 * 自己设了正文色，所以看不出来）。代码块是「原样展示」的地方，不该有颜色倾向：
 * 压回正文色。
 *
 * scope 限定在 markdown 语言本身：带语言的代码块里，token 属于各自的语言
 * （rust / ts / …），这条规则碰不到它们，配色照旧。
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { Prec } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'

export const plainCodeText = Prec.high(syntaxHighlighting(
  HighlightStyle.define([{ tag: t.monospace, color: 'var(--foreground)' }], { scope: markdownLanguage }),
))
