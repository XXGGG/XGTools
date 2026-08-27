/**
 * 把一篇笔记导出成 HTML / PDF / Word / 图片，以及打印。
 *
 * # 为什么要先转成 HTML
 *
 * 四种导出全都建立在「这篇笔记渲染成什么样」之上：PDF 和打印走浏览器的
 * 打印管线（喂它 HTML）、Word 的 .doc 本来就吃 HTML、图片是把渲染好的
 * DOM 截下来。所以只需要一份 markdown → HTML，四条路共用。
 *
 * 这里不复用编辑器 —— 编辑器是 CodeMirror，它的 DOM 是虚拟滚动的，
 * 视口外的行根本不存在，截图和打印都只会拿到看得见的那一屏。
 *
 * # 为什么不打包一个 PDF 库
 *
 * PDF 走系统打印对话框里的「另存为 PDF」。自带 pdf 库(jsPDF 之类)的中文
 * 要额外塞字体、排版还是自己实现一套，效果远不如浏览器那套成熟的分页引擎。
 */
import MarkdownIt from 'markdown-it'
import katex from 'katex'
import { settings, VAULT_FONT_STACK } from './useAppSettings'

const md = new MarkdownIt({ html: true, linkify: true, breaks: false })

export type ExportKind = 'html' | 'pdf' | 'word' | 'image' | 'print'

/**
 * 把渲染好的 HTML 里的公式和流程图也变成图形。
 *
 * markdown-it 不认这两样：`$...$` 原样吐出来、mermaid 只当普通代码块。
 * 编辑器里看着是公式和图，导出来却是一堆源码 —— 那这份导出就不能发给人。
 *
 * # 为什么在 DOM 上做，不在 markdown 文本上做
 *
 * 在源码上正则替换会误伤代码块里的 `$` 和 ``` 围栏。渲染完之后正文和代码
 * 已经分到不同节点里了，只走文本节点、跳过 `pre`/`code`，就不会伤到代码。
 *
 * # 公式为什么输出 MathML
 *
 * KaTeX 默认那套 HTML 排版依赖它自带的一堆字体文件。导出的文件是要发给别人的，
 * 外链字体到了别人机器上就是一片豆腐块，而把字体全塞成 data URI 又要给每份
 * 导出凭空加一兆多。MathML 是浏览器原生支持的，一个字节的字体都不用带。
 */
async function enhance(doc: Document, resolve?: (src: string) => string) {
  // ── 公式 ──
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).parentElement?.closest('pre, code')) continue
    if (/\$.+\$/.test(n.nodeValue ?? '')) texts.push(n as Text)
  }
  for (const node of texts) {
    const html = (node.nodeValue ?? '')
      .replace(/\$\$(.+?)\$\$/g, (_, s) => tex(s, true))
      .replace(/\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g, (_, s) => tex(s, false))
    const span = doc.createElement('span')
    span.innerHTML = html
    node.replaceWith(span)
  }

  // ── mermaid ──
  const blocks = [...doc.querySelectorAll('pre > code.language-mermaid')]
  if (blocks.length) {
    const m = (await import('mermaid')).default
    // 导出的东西多半要打印或者发给人看,一律浅色底,别跟着应用的深色主题走
    m.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' })
    for (const [i, code] of blocks.entries()) {
      const box = doc.createElement('div')
      box.style.cssText = 'text-align:center;margin:1.2em 0'
      try {
        const { svg } = await m.render(`xgexp${i}`, code.textContent ?? '')
        box.innerHTML = svg
      } catch {
        // 图画不出来就把源码留着,总比留一块空白强
        continue
      }
      code.parentElement!.replaceWith(box)
    }
  }

  await inlineImages(doc, resolve)
}

/**
 * 把笔记里的图片换成 data URI。
 *
 * # 为什么非做不可
 *
 * 笔记里的图写的是库内相对路径(`attachments/x.webp`)。这份 HTML 一旦离开
 * 应用 —— 存到别的目录、发给别人、或者只是丢进打印用的那个 iframe ——
 * 那个路径就什么都指不到,导出来的文件里全是碎图。打印和 PDF 也一样,
 * 它们走的是同一份 HTML。
 *
 * 网上的图(http/https)不碰:它们本来就能在任何地方打开,而且抓回来还要
 * 看对方给不给跨域,不值得为此让导出卡住。
 *
 * 拿不到的图就留着原路径 —— 至少还能从 src 看出少的是哪一张。
 */
async function inlineImages(doc: Document, resolve?: (src: string) => string) {
  if (!resolve) return
  for (const img of doc.querySelectorAll('img')) {
    const raw = img.getAttribute('src') ?? ''
    if (!raw || /^(data:|https?:)/.test(raw)) continue
    try {
      const blob = await (await fetch(resolve(raw))).blob()
      img.setAttribute('src', await new Promise<string>((ok, no) => {
        const fr = new FileReader()
        fr.onload = () => ok(String(fr.result))
        fr.onerror = no
        fr.readAsDataURL(blob)
      }))
    } catch { /* 读不到就保持原样 */ }
  }
}

function tex(src: string, display: boolean) {
  try {
    return katex.renderToString(src, { displayMode: display, output: 'mathml', throwOnError: false })
  } catch {
    return display ? `$$${src}$$` : `$${src}$`
  }
}

/**
 * 渲染成一份自带样式的完整 HTML。
 *
 * 样式必须内联进去：导出的文件会被发给别人、用别的软件打开，
 * 外链任何东西都会变成一份在别人机器上排版塌掉的文件。
 */
export async function renderStandalone(title: string, markdown: string, resolve?: (src: string) => string) {
  const doc = new DOMParser().parseFromString(`<body>${md.render(markdown)}</body>`, 'text/html')
  await enhance(doc, resolve)
  const body = doc.body.innerHTML
  const font = VAULT_FONT_STACK[settings.vaultFont]
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ${font}; font-size: ${settings.vaultFontSize}px; line-height: 1.75;
         color: #1a1a1a; background: #fff; max-width: 46em; margin: 3em auto; padding: 0 1.5em; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.35; margin: 1.6em 0 .6em; }
  h1 { font-size: 1.9em } h2 { font-size: 1.5em } h3 { font-size: 1.25em }
  p, li { margin: .5em 0 }
  code { background: #f2f2f4; border-radius: 4px; padding: .1em .35em;
         font-family: 'JetBrains Mono', Consolas, monospace; font-size: .9em }
  pre { background: #f6f6f8; border-radius: 8px; padding: 1em; overflow-x: auto }
  pre code { background: none; padding: 0 }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ddd; color: #555 }
  table { border-collapse: collapse; width: 100% }
  th, td { border: 1px solid #ddd; padding: .5em .7em; text-align: left }
  th { background: #f6f6f8 }
  img { max-width: 100% }
  hr { border: none; border-top: 1px solid #e5e5e5; margin: 2em 0 }
  /* 打印时别把标题和它下面的正文拆到两页 */
  @media print {
    body { margin: 0; max-width: none }
    h1,h2,h3,h4 { break-after: avoid }
    pre, blockquote, table { break-inside: avoid }
  }
</style></head><body>
${body}
</body></html>`
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}

/**
 * 在一个隐藏的 iframe 里装好这份 HTML，交给回调处理，然后拆掉。
 *
 * 用 iframe 而不是直接往当前页面塞：导出的样式是独立一套，混进应用的
 * 样式表里两边会互相污染；而且打印必须打印一份完整文档，不能是页面的一角。
 */
async function withFrame<T>(html: string, fn: (win: Window, doc: Document) => Promise<T> | T): Promise<T> {
  const frame = document.createElement('iframe')
  // 不能用 display:none —— 那样里面的内容没有布局,截图会拿到 0×0
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1200px;border:0;'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument!
    doc.open()
    doc.write(html)
    doc.close()
    // 等图片和字体就位,否则截图会缺图、打印会掉字体
    await new Promise<void>((r) => {
      if (doc.readyState === 'complete') r()
      else frame.onload = () => r()
    })
    await Promise.all([
      doc.fonts?.ready,
      ...[...doc.images].map((im) => im.complete
        ? Promise.resolve()
        : new Promise((r) => { im.onload = im.onerror = r })),
    ])
    return await fn(frame.contentWindow!, doc)
  } finally {
    frame.remove()
  }
}

/** 打印 / 另存为 PDF —— 同一条路，PDF 就是在打印对话框里选「另存为 PDF」 */
export async function printNote(title: string, markdown: string, resolve?: (src: string) => string) {
  const html = await renderStandalone(title, markdown, resolve)
  await withFrame(html, (win) => {
    win.focus()
    win.print()
  })
}

/**
 * 渲染成 PNG 的 dataURL。
 *
 * # ⚠️ 入口已经在 ⋯ 菜单里摘掉了
 *
 * 「导出长图」有已知缺陷,还没定位,暂时不给用户用。函数留着是因为
 * 它和 HTML / Word / 打印共用同一条 markdown→HTML 管线,删了会把管线一起拆掉。
 * 修好之后把 Vault.vue 里那段注释掉的菜单项放回来即可。
 */
export async function noteToPng(title: string, markdown: string, resolve?: (src: string) => string): Promise<string> {
  const html = await renderStandalone(title, markdown, resolve)
  return withFrame(html, async (_win, doc) => {
    const { toPng } = await import('html-to-image')
    const el = doc.body
    return toPng(el, {
      backgroundColor: '#ffffff',
      // 2 倍图:长图多半是发给人看的,一倍在高分屏上字发虚
      pixelRatio: 2,
      width: el.scrollWidth,
      height: el.scrollHeight,
    })
  })
}

/**
 * Word。生成的是 `.doc`（HTML 套一层 Word 的命名空间），不是真正的 .docx。
 *
 * Word 认这种格式已经二十年了，打开就能编辑；而生成真正的 .docx 要引一个
 * 几百 KB 的库、还要自己把 markdown 映射成 OOXML 的段落模型 ——
 * 对「把笔记发给不用 Markdown 的人」这个诉求来说，完全不成比例。
 */
export async function noteToDoc(title: string, markdown: string, resolve?: (src: string) => string) {
  const inner = await renderStandalone(title, markdown, resolve)
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:w="urn:schemas-microsoft-com:office:word"
  xmlns="http://www.w3.org/TR/REC-html40">${inner.slice(inner.indexOf('<head>'))}`
}
