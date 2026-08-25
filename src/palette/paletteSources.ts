/**
 * 命令面板的数据源与打分。
 *
 * 分成两拨,因为它们的代价差了一个量级:
 *   · 静态源(工具页、本机应用)—— 开一次面板取一次,之后在内存里过滤,敲键盘零开销
 *   · 动态源(笔记全文、DSH 会话)—— 每次查询都要落到磁盘或边车,必须防抖
 * 混在一起写的话,敲一个字就会去扫一遍整个笔记库。
 */
import { shallowRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { openPath } from '@tauri-apps/plugin-opener'
import { MENU_ITEMS } from '@/lib/sidebar-prefs'

export type PaletteKind = 'page' | 'app' | 'note' | 'session' | 'file'

export type PaletteItem = {
  id: string
  kind: PaletteKind
  title: string
  subtitle?: string
  /** iconify 的 class,和侧栏用的是同一套 */
  icon?: string
  /** 本机应用的图标是 base64 PNG,走 <img> 而不是 class */
  iconData?: string
  /** 应用的可执行文件真实路径。id 里那份是小写化过的,只能用来去重,不能拿去启动 */
  exec?: string
  /** 命中分数,越大越靠前;静态源在过滤时填,动态源由后端的顺序决定 */
  score?: number
}

/* ────────────────────────── 打分 ────────────────────────── */

/**
 * 子序列模糊匹配。返回 0 表示没命中。
 *
 * 加权的地方只有三处,再多就调不动了:
 *   · 连续命中加分 —— "vscode" 匹配 "VSCode" 要赢过匹配 "Visual Studio Code Ext"
 *   · 词首命中加分 —— 空格、连字符、下划线、大写字母开头都算词首
 *   · 越短的标题分越高 —— 同样命中时,"Note" 应该排在 "Note 的旧版备份" 前面
 */
export function fuzzyScore(text: string, q: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const query = q.toLowerCase()
  // 整串直接出现:给一个够大的底分,保证它一定排在零散命中前面
  const direct = t.indexOf(query)
  if (direct >= 0) {
    const atStart = direct === 0 ? 60 : isWordStart(text, direct) ? 40 : 0
    return 1000 + atStart - direct - text.length * 0.1
  }
  let ti = 0
  let score = 0
  let streak = 0
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi]
    let found = -1
    while (ti < t.length) {
      if (t[ti] === c) { found = ti; break }
      ti++
    }
    if (found < 0) return 0
    score += 10 + streak * 5 + (isWordStart(text, found) ? 15 : 0)
    streak++
    ti++
  }
  return score - text.length * 0.1
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if (prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '\\' || prev === '.') return true
  // 驼峰:小写后面跟大写
  return prev === prev.toLowerCase() && text[i] === text[i].toUpperCase() && text[i] !== prev
}

/* ────────────────────────── 静态源 ────────────────────────── */

type AppEntry = { id: string; name: string; path: string; icon?: string | null }
/*
  开始菜单条目有两个路径,别用错:
    path   —— 快捷方式 .lnk 的位置
    target —— 它指向的真正 exe
  launch_app 是 Command::new(path).spawn(),**.lnk 没法直接执行**,
  传 path 进去必然启动失败。所以一律用 target。
*/
type StartMenuEntry = { name: string; path: string; target: string; icon?: string | null }

/*
  必须是 ref,不能是普通变量。面板里的结果列表是个 computed,
  普通变量赋值它追踪不到 —— 现象是第一次唤起面板那一屏空白,
  敲一个字才突然出来(因为那次是 query 变化触发的重算)。
*/
const staticCache = shallowRef<PaletteItem[]>([])

/** 打开面板时调一次。t 是 i18n 的翻译函数,工具页的名字要跟着语言走。 */
export async function loadStatic(t: (k: string) => string): Promise<PaletteItem[]> {
  const items: PaletteItem[] = MENU_ITEMS.map(m => ({
    id: 'page:' + m.id,
    kind: 'page' as const,
    title: t(m.labelKey),
    icon: m.icon,
  }))
  items.push({ id: 'page:Settings', kind: 'page', title: t('nav.settings'), icon: 'icon-[lucide--settings]' })

  // 应用有两个来源:启动台里用户自己摆的那些,和扫出来的开始菜单缓存。
  // 前者他真的在用,排前面;两边按可执行文件路径去重。
  const seen = new Set<string>()
  const push = (name: string, path: string, icon: string | null | undefined, from: string) => {
    const key = path.toLowerCase()
    if (!name || seen.has(key)) return
    seen.add(key)
    items.push({
      id: 'app:' + from + ':' + key,
      kind: 'app',
      title: name,
      subtitle: prettyPath(path),
      iconData: icon || undefined,
      icon: 'icon-[lucide--app-window]',   // 缓存里多数条目没抽过图标,给个兜底
      exec: path,
    })
  }
  try {
    const docked = await invoke<AppEntry[]>('get_apps')
    docked.forEach(a => push(a.name, a.path, a.icon, 'dock'))
  } catch { /* 启动台没配过就没有这个文件,不是错误 */ }
  let scanned: StartMenuEntry[] = []
  try {
    scanned = await invoke<StartMenuEntry[]>('get_start_menu_cache')
  } catch { /* 没扫过开始菜单,下面会补扫 */ }
  scanned.forEach(a => push(a.name, a.target, a.icon, 'menu'))

  staticCache.value = items

  /*
    缓存是空的说明这台机器从没在「应用管理」里扫过开始菜单 ——
    那样命令面板里就一个本机应用都搜不到,「敲字找电脑里的东西」直接落空。
    所以这里补扫一次,但**不挡住面板弹出**:扫描要遍历两级开始菜单目录,
    比开面板慢得多。扫完直接往 staticCache 里灌,它是 ref,
    结果列表会自己重算,用户看到的是搜索结果凭空多出来一批应用。
  */
  if (!scanned.length) void backfillApps(items, seen)

  return items
}

async function backfillApps(items: PaletteItem[], seen: Set<string>) {
  try {
    const fresh = await invoke<StartMenuEntry[]>('scan_start_menu')
    const merged = [...items]
    for (const a of fresh) {
      const key = a.target.toLowerCase()
      if (!a.name || seen.has(key)) continue
      seen.add(key)
      merged.push({
        id: 'app:menu:' + key,
        kind: 'app',
        title: a.name,
        subtitle: prettyPath(a.target),
        iconData: a.icon || undefined,
        icon: 'icon-[lucide--app-window]',
        exec: a.target,
      })
    }
    staticCache.value = merged
  } catch { /* 扫不动就算了,面板照常能用 */ }
}

export function staticItems(): PaletteItem[] {
  return staticCache.value
}

/* ────────────────────────── 动态源 ────────────────────────── */

const VAULT_ROOT_KEY = 'xgtools.vault.root'

/** 笔记:走后端的全文搜索,它连文件名一起匹配。 */
export async function searchNotes(q: string, limit = 6): Promise<PaletteItem[]> {
  const root = localStorage.getItem(VAULT_ROOT_KEY)
  if (!root || !q.trim()) return []
  try {
    const hits = await invoke<{ path: string; name: string; snippet: string; line: number }[]>(
      'vault_search', { root, query: q, limit }
    )
    return hits.map(h => ({
      id: 'note:' + h.path,
      kind: 'note' as const,
      title: h.name,
      subtitle: h.snippet || h.path,
      icon: 'icon-[lucide--file-text]',
    }))
  } catch {
    return []
  }
}

/**
 * 全盘文件。后端按平台分流(Windows=Everything / macOS=Spotlight / Linux=plocate),
 * 前端不关心是谁 —— 见 file_search_commands.rs。
 *
 * 后端没就绪时静默返回空:面板不是报错的地方,状态和一键安装都放在
 * 启动台的「命令面板」设置页里说。
 */
export type FileSearchStatus = {
  backend: string
  ready: boolean
  detail: string
}

export async function fileSearchStatus(): Promise<FileSearchStatus | null> {
  try { return await invoke<FileSearchStatus>('file_search_status') } catch { return null }
}

export async function searchFiles(q: string, limit = 6): Promise<PaletteItem[]> {
  if (!q.trim()) return []
  try {
    const hits = await invoke<{ path: string; name: string; isDir: boolean }[]>(
      'file_search', { query: q, limit }
    )
    return hits.map(h => ({
      id: 'file:' + h.path,
      kind: 'file' as const,
      title: h.name,
      subtitle: prettyPath(h.path),
      icon: h.isDir ? 'icon-[lucide--folder]' : 'icon-[lucide--file]',
      exec: h.path,
    }))
  } catch {
    return []
  }
}

/** DSH 会话:边车没起来就直接返回空,不要在面板里报错。 */
export async function searchSessions(q: string, limit = 5): Promise<PaletteItem[]> {
  if (!q.trim()) return []
  try {
    const v = await invoke<any>('dsh_rpc', { method: 'session.search', payload: { query: q, limit } })
    const rows = v?.items ?? v?.results ?? []
    return rows.slice(0, limit).map((s: any) => ({
      id: 'session:' + s.sessionId,
      kind: 'session' as const,
      title: s.title || '(未命名会话)',
      subtitle: s.cwd ? prettyPath(s.cwd) : undefined,
      icon: 'icon-[ri--deepseek-line]',
    }))
  } catch {
    return []
  }
}

/* ────────────────────────── 执行 ────────────────────────── */

/**
 * 回车之后干什么。
 *
 * 除了启动应用之外都要把主窗口叫到前面来 —— 面板是个独立窗口,
 * 它自己关掉之后如果主窗口还在托盘里,用户会觉得"按了没反应"。
 */
export async function runItem(item: PaletteItem): Promise<void> {
  const [kind, ...rest] = item.id.split(':')
  const arg = rest.join(':')
  if (kind === 'app') {
    if (item.exec) await invoke('launch_app', { path: item.exec }).catch(() => {})
    return
  }
  if (kind === 'file') {
    // 交给系统按默认程序打开(目录就是打开文件管理器)。
    // 不走主窗口 —— 用户要的是那个文件,不是 XGTools。
    if (item.exec) await openPath(item.exec).catch(() => {})
    return
  }
  await showMain()
  if (kind === 'page') await emit('palette-go', { view: arg })
  else if (kind === 'note') await emit('palette-open-note', { path: arg })
  else if (kind === 'session') await emit('palette-open-session', { sessionId: arg })
}

async function showMain() {
  try {
    const main = await WebviewWindow.getByLabel('main')
    if (!main) return
    await main.show()
    await main.unminimize()
    await main.setFocus()
  } catch { /* 主窗口被关掉了就算了,事件照发 */ }
}

/* ────────────────────────── 杂 ────────────────────────── */

/** 路径里的用户名不进界面 —— 截图会流出去 */
function prettyPath(p: string): string {
  return p.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, '~').replace(/\\/g, '/')
}
