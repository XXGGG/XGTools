/**
 * 光秃秃的 `#` 不算标题。
 *
 * CommonMark 允许「空标题」：一行只写 `#`（或 `##`），解析器照样给出 ATXHeading。
 * 后果是刚敲下一个井号，那一行立刻变成标题 —— 字号跳大、井号被当成记号藏掉，
 * 人看到的是「我打的字没了」。Obsidian 的做法是：**井号 + 空格 + 正文**才是标题，
 * 之前井号就老老实实显示成井号。这里照它办。
 *
 * 做法和 strictLists 一样：拿到默认的 ATXHeading 解析器，前面加一道判断 ——
 * 井号后面除了空白什么都没有，就说「这不是标题」，交给后面的段落解析器。
 */
import { parser as baseParser, type BlockParser, type MarkdownConfig } from '@lezer/markdown'

type ParserInternals = {
  blockNames: readonly string[]
  blockParsers: readonly (BlockParser['parse'] | undefined)[]
}

function defaultParser(name: string): NonNullable<BlockParser['parse']> {
  const p = baseParser as unknown as ParserInternals
  const at = p.blockNames?.indexOf(name) ?? -1
  const fn = at < 0 ? undefined : p.blockParsers[at]
  if (typeof fn !== 'function') {
    throw new Error(`@lezer/markdown 里取不到默认的 ${name} 块解析器 —— 内部结构变了。`)
  }
  return fn
}

/** 这一行从当前位置起是不是「只有井号」 */
const ONLY_HASHES = /^#{1,6}[ \t]*$/

export const strictHeadings: MarkdownConfig = {
  parseBlock: [
    (() => {
      const inner = defaultParser('ATXHeading')
      const p: BlockParser = {
        name: 'ATXHeading',
        parse: (cx, line) => (ONLY_HASHES.test(line.text.slice(line.pos)) ? false : inner(cx, line)),
      }
      return p
    })(),
  ],
}
