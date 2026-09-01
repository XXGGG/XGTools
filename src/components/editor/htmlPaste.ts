/**
 * 从网页、Word、Excel 里复制来的**表格**,粘进来要还是表格。
 *
 * 剪贴板里同时躺着两份东西:`text/html`(带结构)和 `text/plain`(纯文本)。
 * 编辑器默认拿的是纯文本那份 —— 而浏览器给出的纯文本会把表格的单元格首尾相接,
 * 「屏幕方向 推荐分辨率 宽高比」挤成一行不带分隔,粘完根本读不出哪一格是哪一格。
 * 所以碰到带表格的 HTML 就自己接管,按 GFM 的写法重排一遍。
 *
 * # 只在有表格的时候接管
 *
 * 别的内容一律放行,走原来的纯文本粘贴。从网页抄一段字进来通常就是要那段字,
 * 顺手把加粗、链接、字号全带进正文反而是添乱;而表格是**丢了结构就没法看**的
 * 那一类,不接管就等于粘了一堆废话。这条界线让「粘贴」这件事保持可预期。
 *
 * # 表格之外的结构也顺手转
 *
 * 一旦决定接管,就得把整段 HTML 都转掉 —— 用户圈选的往往是「标题 + 一段话 +
 * 表格」,只挑表格转会把上下文丢了。所以标题、列表、引用、代码块、粗体、链接
 * 这些常见的也一并翻成 markdown,认不出来的标签就退回它的文字。
 */

/** GFM 表格里 `|` 是分隔符,单元格内出现要转义;换行也塞不进去,只能用 <br> */
function cellText(md: string): string {
  return md.replace(/\|/g, '\\|').replace(/\n+/g, '<br>').trim()
}

/** 折叠 HTML 里那些排版用的空白:换行和连续空格在渲染时都只算一个空格 */
function collapse(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ')
}

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
])

/** 行内元素翻成 markdown。块级的交给 blockToMarkdown,这里只管一行之内的事 */
function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return collapse(node.nodeValue ?? '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const inner = () => Array.from(el.childNodes).map(inlineToMarkdown).join('')

  switch (el.tagName) {
    case 'BR': return '\n'
    case 'STRONG': case 'B': {
      const t = inner().trim()
      return t ? `**${t}**` : ''
    }
    case 'EM': case 'I': {
      const t = inner().trim()
      return t ? `*${t}*` : ''
    }
    case 'DEL': case 'S': case 'STRIKE': {
      const t = inner().trim()
      return t ? `~~${t}~~` : ''
    }
    case 'CODE': case 'KBD': case 'SAMP': {
      const t = collapse(el.textContent ?? '').trim()
      return t ? `\`${t}\`` : ''
    }
    case 'A': {
      const t = inner().trim()
      const href = el.getAttribute('href') ?? ''
      // 没有地址的锚点(网页里的目录跳转)就只留文字
      return href && !href.startsWith('#') ? `[${t}](${href})` : t
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? ''
      return src ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
    }
    default:
      return inner()
  }
}

/** 一个单元格里的内容。块级子元素(有些表格里嵌 <p>)之间补个空格,别粘成一坨 */
function cellToMarkdown(cell: HTMLElement): string {
  const parts = Array.from(cell.childNodes).map((n) => {
    const el = n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : null
    const md = inlineToMarkdown(n)
    return el && BLOCK.has(el.tagName) ? ` ${md} ` : md
  })
  return cellText(parts.join(''))
}

/** 从 align 属性或 text-align 样式里读这一列的对齐 */
function alignOf(cell: HTMLElement | undefined): 'left' | 'center' | 'right' | null {
  if (!cell) return null
  const raw = (cell.getAttribute('align') ?? cell.style.textAlign ?? '').toLowerCase()
  if (raw === 'center' || raw === 'right' || raw === 'left') return raw
  return null
}

function tableToMarkdown(table: HTMLTableElement): string {
  const rows: string[][] = []
  const aligns: ('left' | 'center' | 'right' | null)[] = []
  let headerRows = 0

  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.children).filter(
      (c) => c.tagName === 'TD' || c.tagName === 'TH',
    ) as HTMLElement[]
    if (!cells.length) continue

    const row: string[] = []
    for (const cell of cells) {
      row.push(cellToMarkdown(cell))
      /*
        合并单元格在 GFM 里表达不了,只能摊平:横跨几列就补几个空格子,
        让每一行的列数对得上 —— 对不上的话整张表在 markdown 里直接散架。
      */
      const span = Number(cell.getAttribute('colspan') ?? 1)
      for (let i = 1; i < span; i++) row.push('')
    }

    // 表头:thead 里的行,或者整行都是 th 的行(而且必须还在最上面)
    const isHead = tr.closest('thead') !== null || cells.every((c) => c.tagName === 'TH')
    if (isHead && rows.length === headerRows) {
      headerRows += 1
      cells.forEach((c, i) => { aligns[i] = aligns[i] ?? alignOf(c) })
    }
    rows.push(row)
  }

  if (!rows.length) return ''
  const cols = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? '')

  /*
    GFM 的表格必须有表头。原表没有表头(整张都是 td)时补一行空的 ——
    补空行看着奇怪,但总比整张表不被当成表格、退回一堆竖线要强。
  */
  const head = headerRows ? rows.slice(0, headerRows).map(pad)[0] : Array(cols).fill('')
  const body = rows.slice(headerRows).map(pad)

  const rule = Array.from({ length: cols }, (_, i) => {
    switch (aligns[i]) {
      case 'center': return ':---:'
      case 'right': return '---:'
      case 'left': return ':---'
      default: return '---'
    }
  })

  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(head), line(rule), ...body.map(line)].join('\n')
}

/** 块级元素翻成 markdown。返回的每一段之间由调用方补空行 */
function blockToMarkdown(node: Node, depth = 0): string {
  if (node.nodeType === Node.TEXT_NODE) return collapse(node.nodeValue ?? '').trim()
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as HTMLElement
  const children = () => Array.from(el.childNodes)
    .map((n) => blockToMarkdown(n, depth))
    .filter(Boolean)
    .join('\n\n')

  switch (el.tagName) {
    case 'TABLE':
      return tableToMarkdown(el as HTMLTableElement)

    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const t = inlineToMarkdown(el).trim()
      return t ? `${'#'.repeat(Number(el.tagName[1]))} ${t}` : ''
    }

    case 'HR':
      return '---'

    case 'PRE': {
      const code = el.textContent ?? ''
      const lang = el.querySelector('code')?.className.match(/language-([\w-]+)/)?.[1] ?? ''
      return `\`\`\`${lang}\n${code.replace(/\n+$/, '')}\n\`\`\``
    }

    case 'BLOCKQUOTE':
      return children().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')

    case 'UL': case 'OL': {
      const ordered = el.tagName === 'OL'
      const items = Array.from(el.children).filter((c) => c.tagName === 'LI') as HTMLElement[]
      return items.map((li, i) => {
        const marker = ordered ? `${i + 1}. ` : '- '
        // 嵌套的列表要缩进到自己这一级,缩进量按父级标记的宽度走
        const body = blockToMarkdown(li, depth + 1)
        const pad = ' '.repeat(marker.length)
        return marker + body.split('\n').join(`\n${pad}`)
      }).join('\n')
    }

    case 'LI': {
      // 列表项里既有直接的文字,也可能嵌着子列表
      const parts: string[] = []
      let inline = ''
      for (const n of Array.from(el.childNodes)) {
        const tag = n.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement).tagName : ''
        if (tag === 'UL' || tag === 'OL' || tag === 'TABLE' || tag === 'PRE') {
          if (inline.trim()) { parts.push(inline.trim()); inline = '' }
          parts.push(blockToMarkdown(n, depth + 1))
        } else {
          inline += inlineToMarkdown(n)
        }
      }
      if (inline.trim()) parts.push(inline.trim())
      return parts.join('\n')
    }

    case 'P':
      return inlineToMarkdown(el).trim()

    case 'BR':
      return ''

    default: {
      // 认不出来的容器(div/section/span 之流)看它里面有没有块级货色:
      // 有就当容器往下走,没有就整个当一段文字
      const hasBlock = Array.from(el.children).some((c) => BLOCK.has(c.tagName))
      return hasBlock ? children() : inlineToMarkdown(el).trim()
    }
  }
}

/**
 * 剪贴板里的 HTML → markdown。
 *
 * 没有表格就返回 null,交回默认的纯文本粘贴 —— 见文件头「只在有表格的时候接管」。
 */
export function htmlPasteToMarkdown(html: string): string | null {
  if (!html.trim()) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  if (!doc.querySelector('table')) return null

  // 样式和脚本会被 textContent 当成正文读出来,先摘干净
  doc.querySelectorAll('style, script, meta, link').forEach((n) => n.remove())

  const md = Array.from(doc.body.childNodes)
    .map((n) => blockToMarkdown(n))
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return md || null
}
