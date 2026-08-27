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
import { settings } from '@/composables/useAppSettings'

export type Entry = {
  path: string
  name: string
  isDir: boolean
  ext: string
  size: number
  modified: number
  /** 是不是一张 Excalidraw 画布。后端按内容判(见 looks_like_canvas) */
  isCanvas: boolean
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
  /**
   * 预览标签(学 VSCode):只是点开看看的,标题斜体,再点别的会把它顶掉。
   *
   * 改过内容、或者按过 Ctrl+S,就转成常驻。不这么做的话在树里点几下
   * 就攒出一排标签,而其中绝大多数只是「看一眼」。
   */
  preview?: boolean
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
/**
 * 界面上显示的文件名:去掉后缀。
 *
 * 类型已经由前面那个彩色圆点说明了,再挂一串 `.md` `.base` 是重复信息,
 * 而且长文件名本来就容易被截断,省下这几个字符很值。
 * 只去掉我们认识的那几种 —— 不认识的(比如 .png)留着,那时候后缀才是信息。
 */
const KNOWN_EXT = ['.excalidraw.md', '.md', '.base', '.canvas', '.excalidraw']

export function displayName(name: string): string {
  for (const e of KNOWN_EXT) {
    if (name.toLowerCase().endsWith(e)) return name.slice(0, -e.length)
  }
  return name
}

/**
 * 文件前缀的小图标 + 颜色。
 *
 * # 为什么按整个文件名判，不看扩展名
 *
 * 画布的文件名是 `xxx.excalidraw.md` —— 扩展名就是 `md`。只看最后一段
 * 后缀的话，一张画和一篇笔记在树上长得一模一样。
 *
 * # 为什么从圆点换成图标
 *
 * 彩色圆点只能靠颜色区分，而颜色是记不住的：得先在脑子里查一遍
 * 「蓝色是什么来着」。图标一眼就是它本身，颜色只负责让它更好认。
 *
 * `accent` 表示这一类跟着笔记主题色走 —— 笔记是这个应用的主角，
 * 用主题色标出来，扫一眼就知道哪些是正经笔记、哪些是附件。
 */
export type FileBadge = { icon: string, cls: string, accent?: boolean }

export function fileBadge(name: string, isCanvas = false): FileBadge {
  const n = name.toLowerCase()
  /*
    画布优先判。`isCanvas` 是后端读文件开头得出的 —— 名字里的 `.excalidraw`
    只是插件的默认命名,改掉了文件照样是画布,只认名字会认错。
  */
  if (isCanvas || n.endsWith('.excalidraw.md') || n.endsWith('.excalidraw') || n.endsWith('.canvas')) {
    return { icon: 'icon-[lucide--shapes]', cls: 'text-amber-500' }
  }
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'md': case 'txt':
      return { icon: 'icon-[lucide--file-text]', cls: '', accent: true }
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'avif':
      return { icon: 'icon-[lucide--image]', cls: 'text-emerald-500' }
    case 'pdf':
      return { icon: 'icon-[lucide--file-type]', cls: 'text-rose-400' }
    case 'json': case 'yaml': case 'yml': case 'base':
      return { icon: 'icon-[lucide--braces]', cls: 'text-sky-400' }
    default:
      return { icon: 'icon-[lucide--file]', cls: 'text-muted-foreground/50' }
  }
}

function kindOf(name: string): Tab['kind'] {
  const n = name.toLowerCase()
  /*
    `.excalidraw.md` 要排在 `.md` 前面判。

    Obsidian 的画布文件后缀就是 `.md` —— 它故意做成一篇 markdown,好让
    Obsidian 能搜到图里的文字。只看最后一段后缀的话,画布会被当普通笔记
    用编辑器打开,满屏是压缩过的 base64。
  */
  if (n.endsWith('.excalidraw.md') || n.endsWith('.excalidraw')) return 'canvas'
  const e = n.split('.').pop() ?? ''
  if (e === 'md' || e === 'txt') return 'markdown'
  if (e === 'canvas') return 'canvas'
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
/*
  恢复工作区。**必须幂等**:笔记页的 onMounted 会调,命令面板跳转过来时也会调,
  两边可能同时开跑 —— 那样 restoreTabs 会把每个存档标签各开两遍
  (openFile 的去重检查在 await 之前,两个并发调用都会判定「还没开」)。
  现象是标签栏里同一个文件出现两三次。

  返回同一个在途 Promise,后来的调用等它就行,不重跑。
*/
let restoring: Promise<void> | null = null

/**
 * 关掉那些文件已经不在了的标签。
 *
 * 在 Obsidian 那边删掉一篇、或者在我们这儿删掉,标签栏还留着一个点开是空白、
 * 一保存就报错的壳子。**有未保存改动的留着** —— 那份内容只存在于内存里,
 * 关掉就真没了,宁可让用户自己决定。
 */
export async function dropDeadTabs() {
  if (!vault.root) return
  for (const t of [...vault.tabs]) {
    if (t.content !== t.saved) continue
    try {
      await invoke<string>('vault_read', { root: vault.root, rel: t.path })
    } catch {
      closeTab(t.path)
    }
  }
}

export function restoreVault(): Promise<void> {
  if (restoring) return restoring
  restoring = (async () => {
    const saved = localStorage.getItem(ROOT_KEY)
    if (!saved) return
    vault.root = saved
    await startWatch()
    await refreshDir('')
    await restoreTabs()
  })()
  return restoring
}

export async function pickVault() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false })
  if (typeof picked !== 'string') return
  vault.root = picked
  localStorage.setItem(ROOT_KEY, picked)
  await startWatch()
  vault.children = {}
  vault.expanded = new Set()
  vault.tabs = []
  vault.activeTab = ''
  vault.error = ''
  await refreshDir('')
}

// ── 树 ────────────────────────────────────────────────

/**
 * 让后端盯着当前工作区,外面改了文件就来通知。
 *
 * 只在这里调用一次(换库、恢复库两处),后端自己会把上一个监听停掉。
 * 收到的是「哪几层变了」,不是具体哪个文件 —— 我们本来就是按目录缓存的,
 * 拿到目录直接重读就行,不用去猜是新增还是删除还是改名。
 */
async function startWatch() {
  try {
    await invoke('watch_vault', { root: vault.root })
  } catch (e) {
    // 监听挂不上不影响手动操作,不值得打断用户
    console.warn('[vault] 监听工作区失败:', e)
  }
}

let watchBound = false

/** 接住后端的变更通知。只绑一次 */
export async function bindVaultEvents() {
  if (watchBound) return
  watchBound = true
  const { listen } = await import('@tauri-apps/api/event')
  await listen<string[]>('vault-changed', async (e) => {
    for (const dir of e.payload ?? []) {
      // 只刷新已经展开过(缓存里有)的那几层。没展开过的下次展开自然会读到新的,
      // 现在去读等于替用户预加载他没打开的目录
      if (vault.children[dir] !== undefined) await refreshDir(dir)
    }
    await dropDeadTabs()
    await syncOpenTabs()
  })
}

/**
 * 磁盘上变了的文件,如果正开着,就把新内容读回来。
 *
 * # 为什么必须做
 *
 * 同一个库在别的机器上、在 Obsidian 里、在 git pull 之后都会变。只刷目录树
 * 的话,标签里还是打开那一刻的旧内容 —— 更糟的是下一次保存会拿这份旧的
 * **把别人的改动整个盖掉**。
 *
 * # 有未保存改动的不碰
 *
 * 那种情况下两边都有新东西,自动挑一边都是在替用户丢字。留着他自己的,
 * 他要么保存(覆盖磁盘)、要么关掉重开(取磁盘的),两条路都还在。
 */
async function syncOpenTabs() {
  if (!vault.root) return
  for (const t of vault.tabs) {
    if (t.kind === 'other' || t.content !== t.saved) continue
    try {
      const fresh = await invoke<string>('vault_read', { root: vault.root, rel: t.path })
      // 一样就别动:换内容会把光标和选区打回开头
      if (fresh === t.content) continue
      t.content = fresh
      t.saved = fresh
    } catch {
      // 读不出来多半是刚被删/正在被写,dropDeadTabs 那边会收拾
    }
  }
}

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
    /*
      **开不了的存档标签直接跳过,不报错。**
      两次会话之间用户在 Obsidian 那边删了/改名了文件是常事,那不是故障,
      没必要一开应用就甩一条红字。openFile 的 quiet 就是为这个。
    */
    for (const p of paths ?? []) await openFile(p, false, true)
    // active 指向的那个也可能没开出来 —— 不查一下就会激活一个不存在的标签,
    // 表现是标签栏有东西、内容区却是空态。
    if (active && vault.tabs.some((t) => t.path === active)) vault.activeTab = active
    else vault.activeTab = vault.tabs[0]?.path ?? ''
  } catch { /* 存档坏了就当没有,不值得为它报错 */ }
}

/** @param quiet 读不出来时不摆错误横幅(恢复存档标签用)。返回是否真的开出来了。 */
export async function openFile(
  rel: string,
  activate = true,
  quiet = false,
  /** 以预览方式打开(单击文件时)。双击、新建、还原这些都传 false */
  preview = false,
): Promise<boolean> {
  const exists = vault.tabs.find((t) => t.path === rel)
  if (exists) {
    // 已经开着的,再点一次不该把它降级成预览
    if (!preview) exists.preview = false
    if (activate) vault.activeTab = rel
    return true
  }
  const name = rel.split('/').pop() ?? rel
  let kind = kindOf(name)
  let content = ''
  if (kind !== 'other') {
    try {
      content = await invoke<string>('vault_read', { root: vault.root, rel })
    } catch (e) {
      if (!quiet) {
        vault.error = String(e)
        // 同上:多半是文件已经没了,刷一下让那一行消失
        void refreshDir(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
      }
      return false
    }
  }
  /*
    读完再按内容认一次画布。

    名字里的 `.excalidraw` 只是插件的默认命名,用户改掉之后文件还是画布 ——
    Obsidian 那边认的是 frontmatter 里的 `excalidraw-plugin`。只信文件名的话,
    改过名的画布会用 markdown 编辑器打开,满屏是压缩过的 base64。
  */
  if (kind === 'markdown' && content.includes('excalidraw-plugin:')) kind = 'canvas'

  // 开成功了就把上一次的错误收掉 —— 否则那条红字会一直挂着,
  // 明明后来一切正常,看着像还在坏
  vault.error = ''
  // 读盘期间可能有别的调用把同一个文件开出来了 —— 上面那次检查是在 await 之前做的,
  // 挡不住并发。这里再查一遍,否则同一个文件会出现两个标签。
  if (vault.tabs.some((t) => t.path === rel)) {
    if (activate) vault.activeTab = rel
    return true
  }
  /*
    预览位只有一个:新开的预览标签会顶掉上一个预览标签。

    **有未保存改动的不顶** —— 那已经不是「看一眼」了,顶掉等于丢用户的字。
  */
  if (preview) {
    const i = vault.tabs.findIndex((t) => t.preview && t.content === t.saved)
    if (i >= 0) vault.tabs.splice(i, 1)
  }
  vault.tabs.push({ path: rel, name, content, saved: content, kind, preview })
  if (activate) vault.activeTab = rel
  persistTabs()
  return true
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
    // 存过盘就不再是「随手看看」,转成常驻
    t.preview = false
  } catch (e) {
    vault.error = String(e)
  }
}

// ── 文件操作 ──────────────────────────────────────────

/** 在 `dirRel` 下新建。名字重复时自动加序号,而不是弹错误让用户自己想名字。 */
/**
 * 移除当前工作区。
 *
 * 只断开,不动磁盘上的任何文件 —— 「从工作区移除」是把库摘掉,不是删库。
 * 标签和展开状态一起清掉,否则重新选一个库之后,上一个库的标签还挂在那儿,
 * 点开就是「文件不存在」。
 */
export function clearVault() {
  void invoke('watch_vault', { root: '' })   // 没库了就别再盯着上一个
  localStorage.removeItem(ROOT_KEY)
  localStorage.removeItem(TABS_KEY)
  vault.root = ''
  vault.children = {}
  vault.expanded = new Set()
  vault.tabs = []
  vault.activeTab = ''
  vault.query = ''
  vault.hits = []
  vault.error = ''
  restoring = null      // 下次选库要能重新恢复,不能被上一次的在途 Promise 挡住
}

/** 新建一个带初始内容的文件。空文件打开就是一片空白,有些格式(画布、数据库)还打不开。 */
export async function createWithContent(dirRel: string, base: string, content: string) {
  const rel = await createEntry(dirRel, false, base)
  if (!rel) return ''
  try {
    await invoke('vault_write', { root: vault.root, rel, content })
    const tab = vault.tabs.find((t) => t.path === rel)
    if (tab) { tab.content = content; tab.saved = content }
  } catch (e) {
    vault.error = String(e)
  }
  return rel
}

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

/**
 * 把 `rel` 移进 `destDir`(空串 = 库根)。目录栏拖拽用。
 *
 * 移完要收拾三样东西,少收拾哪样都会留下一个指向旧路径的引用:
 * 打开着的标签(**连同被移动文件夹里面那些**)、两头的目录缓存、按路径存的单页宽度。
 */
/** 改过内容的标签自动转常驻 —— 编辑过就不再是「看一眼」 */
export function markEdited(rel: string) {
  const t = vault.tabs.find((x) => x.path === rel)
  if (t) t.preview = false
}

export async function moveEntry(rel: string, destDir: string) {
  const from = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (from === destDir) return          // 拖回原地,不值得跑一趟
  try {
    const next = await invoke<string>('vault_move', { root: vault.root, rel, destDir })
    await refreshDir(from)
    if (destDir !== from) await refreshDir(destDir)

    // 旧路径 → 新路径。移动的是文件夹时,它下面每一层都要跟着换前缀
    const remap = (path: string) =>
      path === rel ? next : path.startsWith(rel + '/') ? next + path.slice(rel.length) : path

    let touched = false
    for (const t of vault.tabs) {
      const np = remap(t.path)
      if (np === t.path) continue
      t.path = np
      t.name = np.split('/').pop() ?? np
      touched = true
    }
    vault.activeTab = remap(vault.activeTab)
    if (touched) persistTabs()

    for (const [k, v] of Object.entries(settings.vaultPageWidth)) {
      const nk = remap(k)
      if (nk === k) continue
      delete settings.vaultPageWidth[k]
      settings.vaultPageWidth[nk] = v
    }
  } catch (e) {
    vault.error = String(e)
    /*
      **失败之后一定要刷一遍那一层。**

      最常见的失败就是「源文件已经不在了」—— 在 Obsidian 那边删了或者改了名,
      我们这边的目录缓存还留着那一行。不刷的话那个幽灵行会一直挂在树上,
      用户每拖一次就报一次同样的错,看着像功能坏了。刷完它自己就消失。
    */
    await refreshDir(from)
  }
}

export async function deleteEntry(rel: string) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  try {
    await invoke('vault_delete', { root: vault.root, rel, toSystem: settings.vaultTrashToSystem })
    closeTab(rel)
    await refreshDir(dir)
  } catch (e) {
    vault.error = String(e)
  }
}

// ── 附件 ────────────────────────────────────────────

/**
 * 这张图该存到哪个目录(相对库根)。
 *
 * `noteRel` 是当前笔记的相对路径 —— 「跟着笔记走」要靠它算出笔记在哪一层。
 */
export function attachDirFor(noteRel: string) {
  const sub = settings.vaultAttachDir.trim().replace(/^\/+|\/+$/g, '')
  const dir = noteRel.includes('/') ? noteRel.slice(0, noteRel.lastIndexOf('/')) : ''
  if (settings.vaultAttachMode === 'note') return dir
  if (settings.vaultAttachMode === 'fixed') return sub
  return [dir, sub].filter(Boolean).join('/')
}

/**
 * 这一项要不要在文件树里藏起来。
 *
 * 只藏**附件目录本身**,不藏它里面的东西 —— 用户手动展开(比如把开关关掉)
 * 之后还是要能看见的。`note` 模式下没有专门的目录,自然也无从藏起。
 */
export function isHiddenEntry(e: Entry) {
  if (!settings.vaultHideAttachDir || !e.isDir) return false
  if (settings.vaultAttachMode === 'note') return false
  const sub = settings.vaultAttachDir.trim().replace(/^\/+|\/+$/g, '')
  if (!sub) return false
  return settings.vaultAttachMode === 'fixed' ? e.path === sub : e.name === sub
}

export type OrphanImage = { rel: string, size: number }

/** 扫出没有任何笔记引用的图片。只看附件目录,别处的图是用户自己摆的,不归我们管 */
export async function findOrphanImages(): Promise<OrphanImage[]> {
  if (!vault.root) return []
  try {
    return await invoke<OrphanImage[]>('vault_find_orphan_images', {
      root: vault.root,
      dirRel: settings.vaultAttachMode === 'note' ? '' : settings.vaultAttachDir,
    })
  } catch (e) {
    vault.error = String(e)
    return []
  }
}

/**
 * 附件文件名。用时间戳而不是原文件名:原名多半是 `image.png`、`截图.png`
 * 这种到处撞的名字,而时间戳天然唯一、排序即时间序,出了问题也好对。
 */
export function attachName(d = new Date()) {
  const p = (x: number, w = 2) => String(x).padStart(w, '0')
  return `pasted-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 粘贴进来的图。返回相对库根的路径,失败返回空串 */
export async function attachBytes(noteRel: string, ext: string, dataB64: string) {
  try {
    return await invoke<string>('vault_attach_bytes', {
      root: vault.root,
      dirRel: attachDirFor(noteRel),
      stem: attachName(),
      ext,
      dataB64,
      toWebpOn: settings.vaultWebp,
    })
  } catch (e) {
    vault.error = String(e)
    return ''
  }
}

/** 从外面拖进来的图。复制一份,不动用户原来那个文件 */
export async function attachFile(noteRel: string, src: string) {
  try {
    return await invoke<string>('vault_attach_file', {
      root: vault.root,
      dirRel: attachDirFor(noteRel),
      stem: attachName(),
      src,
      toWebpOn: settings.vaultWebp,
    })
  } catch (e) {
    vault.error = String(e)
    return ''
  }
}

// ── 文件恢复(历史快照) ──────────────────────────────

export type Snapshot = { id: string, at: number, size: number }

/** 存一份快照。内容和上一份一样时后端会跳过,返回 false */
export async function snapshot(rel: string, content: string) {
  if (!vault.root || !content) return false
  try {
    return await invoke<boolean>('vault_snapshot', { root: vault.root, rel, content })
  } catch {
    // 快照存不下不该打断写作,静默即可 —— 它是保险,不是主线
    return false
  }
}

export async function historyList(rel: string): Promise<Snapshot[]> {
  if (!vault.root) return []
  try {
    return await invoke<Snapshot[]>('vault_history_list', { root: vault.root, rel })
  } catch (e) {
    vault.error = String(e)
    return []
  }
}

export async function historyRead(rel: string, id: string) {
  try {
    return await invoke<string>('vault_history_read', { root: vault.root, rel, id })
  } catch (e) {
    vault.error = String(e)
    return ''
  }
}

export async function historyClear(rel: string) {
  try {
    await invoke('vault_history_clear', { root: vault.root, rel })
  } catch (e) {
    vault.error = String(e)
  }
}

// ── 回收站 ──────────────────────────────────────────

export type TrashItem = {
  id: string
  orig: string
  deletedAt: number
  isDir: boolean
  size: number
}

export async function trashList(): Promise<TrashItem[]> {
  if (!vault.root) return []
  try {
    return await invoke<TrashItem[]>('vault_trash_list', { root: vault.root })
  } catch (e) {
    vault.error = String(e)
    return []
  }
}

/** 还原一条,顺手刷新它落回去的那一层 */
export async function trashRestore(id: string) {
  try {
    const rel = await invoke<string>('vault_trash_restore', { root: vault.root, id })
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    await refreshDir(dir)
    return rel
  } catch (e) {
    vault.error = String(e)
    return ''
  }
}

/** 彻底删。`id` 不传就是清空整个回收站 —— 这一步没有下一层兜底 */
export async function trashPurge(id?: string) {
  try {
    await invoke('vault_trash_purge', { root: vault.root, id: id ?? null })
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
