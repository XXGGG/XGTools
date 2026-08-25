/**
 * Markdown 工作区。
 *
 * 树是**惰性**的:只有展开某个目录时才去读它一层。一次性递归整个 vault
 * 在有几千个文件的库上要卡好几秒,而且绝大部分节点用户根本不会展开。
 *
 * 路径一律是「相对工作区根、用 / 分隔」的字符串,平台差异由 Rust 那边吃掉。
 */
import { reactive, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type Entry = {
  path: string
  name: string
  isDir: boolean
  ext: string
  size: number
  modified: number
}

export type Hit = { path: string; name: string; snippet: string; line: number }

export type Tab = {
  path: string
  name: string
  /** 编辑器里的当前内容 */
  content: string
  /** 磁盘上的内容。和 content 不一致就是「有未保存改动」。 */
  saved: string
  kind: 'markdown' | 'canvas' | 'other'
}

export type SortKey = 'name' | 'modified'

const ROOT_KEY = 'xgtools.vault.root'
const TABS_KEY = 'xgtools.vault.tabs'

export const vault = reactive<{
  root: string
  /** 每个已展开目录的子项。键是目录的相对路径,根是空串。 */
  children: Record<string, Entry[]>
  expanded: Set<string>
  sortKey: SortKey
  tabs: Tab[]
  activeTab: string
  query: string
  hits: Hit[]
  searching: boolean
  error: string
  loading: boolean
}>({
  root: '',
  children: {},
  expanded: new Set<string>(),
  sortKey: 'name',
  tabs: [],
  activeTab: '',
  query: '',
  hits: [],
  searching: false,
  error: '',
  loading: false,
})

export const hasVault = computed(() => !!vault.root)
export const activeTab = computed(() => vault.tabs.find((t) => t.path === vault.activeTab) ?? null)
export const dirtyPaths = computed(() =>
  new Set(vault.tabs.filter((t) => t.content !== t.saved).map((t) => t.path)))

/** 文件类型 → 圆点颜色。用颜色区分比塞一堆图标干净,窄侧栏里也不挤。 */
export function dotColor(ext: string): string {
  switch (ext) {
    case 'md': return 'bg-sky-400'
    case 'canvas':
    case 'excalidraw': return 'bg-violet-400'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return 'bg-emerald-400'
    case 'pdf': return 'bg-rose-400'
    case 'json': case 'yaml': case 'yml': return 'bg-amber-400'
    default: return 'bg-muted-foreground/40'
  }
}

function kindOf(name: string): Tab['kind'] {
  const e = name.toLowerCase().split('.').pop() ?? ''
  if (e === 'md' || e === 'txt') return 'markdown'
  if (e === 'excalidraw' || e === 'canvas') return 'canvas'
  return 'other'
}

function sortEntries(list: Entry[]): Entry[] {
  const by = vault.sortKey
  return [...list].sort((a, b) =>
    Number(b.isDir) - Number(a.isDir) ||
    (by === 'modified' ? b.modified - a.modified : a.name.localeCompare(b.name, 'zh')))
}

// ── 工作区 ────────────────────────────────────────────

/**
 * 恢复上次的工作区。
 *
 * **开机自启时这里会踩坑**:自启动比网络驱动器、云盘挂载都早,
 * 上次那个路径可能暂时还不存在。所以读失败不清掉存档 —— 清了用户就得重新挑,
 * 而问题其实几秒后自己就好了。只把错误摆出来,给一个「重试」。
 */
export async function restoreVault() {
  const saved = localStorage.getItem(ROOT_KEY)
  if (!saved) return
  vault.root = saved
  await refreshDir('')
  restoreTabs()
}

export async function pickVault() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false })
  if (typeof picked !== 'string') return
  vault.root = picked
  localStorage.setItem(ROOT_KEY, picked)
  vault.children = {}
  vault.expanded = new Set()
  vault.tabs = []
  vault.activeTab = ''
  vault.error = ''
  await refreshDir('')
}

// ── 树 ────────────────────────────────────────────────

export async function refreshDir(rel: string) {
  if (!vault.root) return
  vault.loading = true
  try {
    const list = await invoke<Entry[]>('vault_list', { root: vault.root, rel })
    vault.children = { ...vault.children, [rel]: sortEntries(list) }
    vault.error = ''
  } catch (e) {
    vault.error = String(e)
  } finally {
    vault.loading = false
  }
}

export async function toggleDir(rel: string) {
  if (vault.expanded.has(rel)) {
    vault.expanded.delete(rel)
  } else {
    vault.expanded.add(rel)
    if (!vault.children[rel]) await refreshDir(rel)
  }
  // Set 不是深响应的,换个新实例才能触发渲染
  vault.expanded = new Set(vault.expanded)
}

export function collapseAll() {
  vault.expanded = new Set()
}

/**
 * 展开全部。
 *
 * 会**真的去拉**还没读过的目录,否则第一次打开时只有根加载了,
 * 点「展开」什么都不会发生 —— 看着就是按钮坏了。
 *
 * 但要设深度上限:笔记库里混进一个 node_modules 或者 .git,
 * 无限递归会把界面卡死好几秒。6 层足够覆盖正常的笔记结构。
 */
export async function expandAll(maxDepth = 6) {
  if (!vault.root) return
  const next = new Set<string>()
  const queue: { dir: string; depth: number }[] = [{ dir: '', depth: 0 }]
  vault.loading = true
  try {
    while (queue.length) {
      const { dir, depth } = queue.shift()!
      if (depth > maxDepth) continue
      if (!vault.children[dir]) {
        try {
          const list = await invoke<Entry[]>('vault_list', { root: vault.root, rel: dir })
          vault.children[dir] = sortEntries(list)
        } catch { continue }
      }
      if (dir) next.add(dir)
      for (const e of vault.children[dir] ?? []) {
        if (e.isDir) queue.push({ dir: e.path, depth: depth + 1 })
      }
    }
    vault.expanded = next
  } finally {
    vault.loading = false
  }
}

export function setSort(k: SortKey) {
  vault.sortKey = k
  for (const [dir, list] of Object.entries(vault.children)) {
    vault.children[dir] = sortEntries(list)
  }
}

// ── 标签页 ────────────────────────────────────────────

function persistTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      active: vault.activeTab,
      paths: vault.tabs.map((t) => t.path),
    }))
  } catch { /* 隐私模式下写不了,不影响用 */ }
}

async function restoreTabs() {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return
    const { active, paths } = JSON.parse(raw) as { active: string; paths: string[] }
    for (const p of paths ?? []) await openFile(p, false)
    if (active) vault.activeTab = active
  } catch { /* 存档坏了就当没有,不值得为它报错 */ }
}

export async function openFile(rel: string, activate = true) {
  const exists = vault.tabs.find((t) => t.path === rel)
  if (exists) {
    if (activate) vault.activeTab = rel
    return
  }
  const name = rel.split('/').pop() ?? rel
  const kind = kindOf(name)
  let content = ''
  if (kind !== 'other') {
    try {
      content = await invoke<string>('vault_read', { root: vault.root, rel })
    } catch (e) {
      vault.error = String(e)
      return
    }
  }
  vault.tabs.push({ path: rel, name, content, saved: content, kind })
  if (activate) vault.activeTab = rel
  persistTabs()
}

export function closeTab(rel: string) {
  const i = vault.tabs.findIndex((t) => t.path === rel)
  if (i < 0) return
  vault.tabs.splice(i, 1)
  if (vault.activeTab === rel) {
    // 关掉当前页就落到右边那个,没有就落到左边 —— 浏览器的通用行为
    vault.activeTab = vault.tabs[i]?.path ?? vault.tabs[i - 1]?.path ?? ''
  }
  persistTabs()
}

export async function saveActive() {
  const t = activeTab.value
  if (!t || t.content === t.saved) return
  try {
    await invoke('vault_write', { root: vault.root, rel: t.path, content: t.content })
    t.saved = t.content
  } catch (e) {
    vault.error = String(e)
  }
}

// ── 文件操作 ──────────────────────────────────────────

/** 在 `dirRel` 下新建。名字重复时自动加序号,而不是弹错误让用户自己想名字。 */
export async function createEntry(dirRel: string, isDir: boolean, base: string) {
  const siblings = vault.children[dirRel] ?? []
  const taken = new Set(siblings.map((e) => e.name))
  let name = base
  let n = 1
  while (taken.has(name)) {
    const dot = base.lastIndexOf('.')
    name = dot > 0 && !isDir
      ? `${base.slice(0, dot)} ${++n}${base.slice(dot)}`
      : `${base} ${++n}`
  }
  const rel = dirRel ? `${dirRel}/${name}` : name
  try {
    await invoke<string>('vault_create', { root: vault.root, rel, isDir })
    await refreshDir(dirRel)
    if (!isDir) await openFile(rel)
    return rel
  } catch (e) {
    vault.error = String(e)
    return ''
  }
}

export async function renameEntry(rel: string, newName: string) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  try {
    const next = await invoke<string>('vault_rename', { root: vault.root, rel, newName })
    await refreshDir(dir)
    // 改名之后打开着的标签页要跟着改,否则它指向一个已经不存在的路径,保存必然失败
    const tab = vault.tabs.find((t) => t.path === rel)
    if (tab) {
      tab.path = next
      tab.name = next.split('/').pop() ?? next
      if (vault.activeTab === rel) vault.activeTab = next
      persistTabs()
    }
  } catch (e) {
    vault.error = String(e)
  }
}

export async function deleteEntry(rel: string) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  try {
    await invoke('vault_delete', { root: vault.root, rel })
    closeTab(rel)
    await refreshDir(dir)
  } catch (e) {
    vault.error = String(e)
  }
}

export async function revealEntry(rel: string) {
  try { await invoke('vault_reveal', { root: vault.root, rel }) }
  catch (e) { vault.error = String(e) }
}

export async function copyPath(rel: string) {
  try { await navigator.clipboard.writeText(rel) } catch { /* 没有剪贴板权限就算了 */ }
}

// ── 搜索 ──────────────────────────────────────────────

let searchTimer: number | undefined

/** 输入即搜,但要防抖 —— 每敲一个字就全库扫一遍会把大库卡住。 */
export function search(q: string) {
  vault.query = q
  window.clearTimeout(searchTimer)
  if (!q.trim()) {
    vault.hits = []
    return
  }
  searchTimer = window.setTimeout(async () => {
    vault.searching = true
    try {
      vault.hits = await invoke<Hit[]>('vault_search', { root: vault.root, query: q, limit: 60 })
    } catch (e) {
      vault.error = String(e)
    } finally {
      vault.searching = false
    }
  }, 250)
}
