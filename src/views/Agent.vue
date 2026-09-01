<script setup lang="ts">
/**
 * 智能体页 —— XGTools 自己的界面,驱动 DSH 这台引擎。
 *
 * 不嵌 iframe、不跑它的 React:协议由 Rust 桥接(见 dsh_bridge.rs),
 * 帧的语义在 useDshChat.ts,这里只负责画。
 * 这样设计语言完全归我们,上游改协议也只动那一个文件。
 *
 * 版式:整页 absolute inset-0 逃出 main 的 padding,自己控制四边留白,
 * 这样会话侧栏才能贴在导航栏「右边」而不是被压在下面。
 *   pl-[4.875rem] = 10(外缩) + 58(导航栏卡片宽) + 10(间距),和 App.vue 里的 pl- 同一个值。
 *   58 是浮空卡片的厚度,横竖通用;四边外缩一律 10px。改一个要三处一起改。
 */
import { ref, nextTick, computed, onBeforeUnmount, onMounted, watch, useTemplateRef } from 'vue'
import { useI18n } from '@/i18n'
import { settings, AGENT_SIDEBAR } from '@/composables/useAppSettings'
import { renderChatMd, onChatLinkClick } from '@/composables/useChatMarkdown'
import { dsh, dshUsable, initDsh, installDsh, startDsh, refreshDsh, resetRevive } from '@/composables/useDsh'
import {
  chat, chatReady, connectChat, newSession, sendPrompt,
  sessions, loadSessions, openSession, pinned, togglePin, renameSession, archiveSession,
  sessionSearch, searchSessions,
  models, loadModels, selectModel, setDefaultModel, currentModelLabel, type SessionRow,
  presets, loadPresets, selectPreset,
  projections, togglePlan, commands, runCommand,
  workspaces, loadWorkspaces, addWorkspace,
  permission, selectPermission, PERMISSION_PRESETS,
} from '@/composables/useDshChat'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import DshBoot from '@/components/DshBoot.vue'
import {
  activeAtToken, formatFileMention, listFileReferences,
  draftFromBytes, mediaTypeOf, IMAGE_EXTS,
  type FileCandidate, type Draft,
} from '@/composables/dshCompose'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import PendingCard from '@/components/agent/PendingCard.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import RulesDialog from '@/components/agent/RulesDialog.vue'
import { openRules } from '@/composables/useAgentRules'
import {
  projects, currentProject, grouped, categories,
  loadProjects, addProject, updateProject, removeProject, toggleCategory,
} from '@/composables/useProjects'
import NewProjectDialog from '@/components/agent/NewProjectDialog.vue'
import ProjectFiles from '@/components/agent/ProjectFiles.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { open as openExternal } from '@tauri-apps/plugin-shell'

const { t } = useI18n()

onMounted(async () => {
  void loadProjects()
  await initDsh()
  if (dsh.state.phase === 'ready' && dsh.state.url) await connectChat(dsh.state.url)
})

// 边车是异步起来的,ready 的那一刻才知道地址,所以要监听而不是只在挂载时读一次
watch(() => [dsh.state.phase, dsh.state.url], ([phase, url]) => {
  if (phase === 'ready' && url) connectChat(url as string)
}, { immediate: false })

// 事件流一通就拉会话列表和模型表。放在这里而不是 onMounted:挂载时多半还没连上,
// 那会儿拉只会拿到「DSH 还没连上」的错误。
// 模型也在这儿拉一次:空态页(还没会话)那颗模型按钮不该是空的
watch(chatReady, (ok) => { if (ok) { loadSessions(); loadModels(); loadPresets(); loadWorkspaces() } }, { immediate: true })

// ── 边车状态 ──

/** 装没装是「引导」的事,跑没跑是「灯」的事。这里只管跑没跑。 */
const dotClass = computed(() => ({
  stopped: 'bg-muted-foreground/50',
  starting: 'bg-amber-500 animate-pulse',
  ready: 'bg-emerald-500',
  failed: 'bg-red-500',
}[dsh.state.phase]))

/**
 * 失败原因排在「没装」前面。
 * 反过来写过一版:安装失败时这里显示的还是「未安装 DSH」—— 说的是事实,
 * 但把真正的原因盖掉了,用户只看到红灯配一句废话,完全没法排查。
 * 有具体报错就一定要让它冒出来。
 */
const stateLabel = computed(() => {
  if (dsh.installing) return t('agent.installing')
  if (chat.error) return chat.error
  if (dsh.state.phase === 'failed' && dsh.state.message) return dsh.state.message
  // 边车起来了但事件流还没通,不能说「已连接」—— 那样用户发消息会石沉大海
  if (dsh.state.phase === 'ready' && !chatReady.value) return t('agent.stateStarting')
  if (!dsh.pre) return t('agent.stateStopped')
  if (!dsh.pre.nodeOk) return t('agent.stateNoNode')
  if (!dsh.pre.pnpmVersion) return t('agent.stateNoPnpm')
  if (!dsh.pre.dshEntry) return t('agent.stateNotInstalled')
  return t(`agent.state${dsh.state.phase[0].toUpperCase()}${dsh.state.phase.slice(1)}`)
})

const canStart = computed(() =>
  dshUsable.value && (dsh.state.phase === 'stopped' || dsh.state.phase === 'failed'))

function onStateClick() {
  if (canStart.value) (resetRevive(), startDsh())
}

const refresh = () => refreshDsh()
const openNode = () => openExternal('https://nodejs.org/')
const openPnpm = () => openExternal('https://pnpm.io/installation')

/** 环境不齐时才占位:node 缺 → 只能让用户自己去装;dsh 缺 → 我们可以代劳 */
const blocker = computed<null | 'node' | 'pnpm' | 'install'>(() => {
  if (!dsh.pre) return null
  if (!dsh.pre.nodeOk) return 'node'
  // 装 DSH 只能用 pnpm(npm 在这棵 445 个包的树上会失控),没有 pnpm 就先引导装 pnpm,
  // 而不是给一个点了必然失败的「安装」按钮
  if (!dsh.pre.pnpmVersion) return 'pnpm'
  if (!dsh.pre.dshEntry) return 'install'
  return null
})

/** 安装失败的原因。展示在引导面板里 —— 只靠侧栏底部那一行太容易被忽略。 */
const installError = computed(() =>
  dsh.state.phase === 'failed' && dsh.state.message ? dsh.state.message : '')

/** 空态招呼语:设置里留空就回落到当前语言的默认文案(不把默认值写进存档,见 useAppSettings) */
const greeting = computed(() => settings.agentGreeting.trim() || t('agent.greeting'))
const flat = computed(() => settings.agentChatSurface === 'flat')

// ── 侧栏拖拽调宽 ──
const rootEl = ref<HTMLElement | null>(null)
const dragging = ref(false)

/**
 * 上限不能只写死 420:窗口窄的时候 420 也能把聊天区挤到没法用。
 * 所以真正的上限是「420」和「留给聊天区 minChat 之后还剩多少」里更小的那个。
 */
function maxWidth() {
  const total = rootEl.value?.clientWidth ?? 9999
  return Math.max(AGENT_SIDEBAR.min, Math.min(AGENT_SIDEBAR.max, total - AGENT_SIDEBAR.minChat))
}

function onDragStart(e: PointerEvent) {
  dragging.value = true
  const startX = e.clientX
  const startW = settings.agentSidebarWidth
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)   // 指针跑出把手也继续收事件,不然拖快了就断

  const move = (ev: PointerEvent) => {
    const w = startW + (ev.clientX - startX)
    settings.agentSidebarWidth = Math.round(Math.min(maxWidth(), Math.max(AGENT_SIDEBAR.min, w)))
  }
  const up = (ev: PointerEvent) => {
    dragging.value = false
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

/** 窗口缩小到放不下当前宽度时,自己收回去 —— 否则聊天区会被挤成一条缝 */
function clampToWindow() {
  const m = maxWidth()
  if (settings.agentSidebarWidth > m) settings.agentSidebarWidth = m
}
window.addEventListener('resize', clampToWindow)
onBeforeUnmount(() => window.removeEventListener('resize', clampToWindow))

const input = ref('')
const listEl = ref<HTMLElement | null>(null)

/*
  空态 = 真的没有消息,**不包括「正在把历史读回来」那几百毫秒**。

  以前把「正在读」也算成空态,于是点一条旧会话会看见:
  居中的大招呼语 + 摆在正中间的输入框 → 一瞬间又变成消息列表 + 输入框沉到底。
  整个页面「跳」一下 —— 因为这是两套完全不同的排版。
  正在读的时候维持正常排版,输入框待在它该在的地方,消息淡入就行。
*/
const empty = computed(() => chat.items.length === 0 && !chat.loadingHistory)

/**
 * 启动屏该不该盖着聊天区。
 *
 * 边车从拉起到事件流接通要好几秒,这段时间聊天区本来只是空态加左下角一行
 * 「正在启动」,太素。改成整块盖一个启动屏,连上了再散开。
 *
 * 三种情形算「还在启动」:边车正在起;起来了但事件流还没通;
 * 以及应用刚打开、连环境都还没探完(pre 为空)—— 这最后一种不算进去的话,
 * 首屏会先闪一下空态再换成启动屏。环境不齐(blocker)、起失败、用户手动停掉、
 * 连接报错(chat.error)的都不算,那些要露出各自的提示 —— 启动屏盖住一条报错,
 * 用户就只能对着一只鲸鱼干等。
 */
const booting = computed(() =>
  !chatReady.value && !blocker.value && !chat.error
  && (dsh.state.phase === 'starting'
    || dsh.state.phase === 'ready'
    || (dsh.state.phase === 'stopped' && !dsh.pre)))

// ── 三个下拉的显示文案 ──

const currentWorkspaceLabel = computed(() => {
  const hit = workspaces.items.find((w) => w.workspaceId === workspaces.pendingId)
  return hit?.title || t('agent.workspace')
})

const currentPresetLabel = computed(() => {
  const hit = presets.options.find((p) => p.id === presets.current)
  return hit?.name || t('agent.mode')
})

/** 会话里显示事件流折出来的档位;空态显示待用的;都没有就当默认档 */
const planOn = computed(() => projections.plan.active)

/** 当前工作区的路径。规矩要写进这个文件夹,没选工作区就只能写全局那份 */
const currentWorkspacePath = computed(() =>
  workspaces.items.find((w) => w.workspaceId === workspaces.pendingId)?.path ?? '')

/*
  上下文用量。

  DSH 一直在算,只是以前没地方看 —— 而「快压缩了」是必须有感知的事:
  压缩会把前面的对话揉成摘要,正在追一个长任务的时候突然被揉一次,
  模型的记性会明显变差。提前看得见,就能自己决定要不要开新会话。

  分母是模型的上下文窗口,分子优先用 projectedTokens(host 估的下一次请求量),
  没有就退回 pressureTokens(上一次请求的真实用量)。
*/
const ctx = computed(() => {
  const p = projections.pressure as { pressureTokens?: number; contextWindow?: number; projectedTokens?: number }
  const used = p.projectedTokens ?? p.pressureTokens
  const total = p.contextWindow
  if (!used || !total) return null
  return { used, total, pct: Math.min(100, Math.round((used / total) * 100)) }
})

const ctxTone = computed(() => {
  const pct = ctx.value?.pct ?? 0
  return pct >= 90 ? 'text-red-500' : pct >= 70 ? 'text-amber-500' : 'text-muted-foreground'
})

/** 12345 → 12.3k。用量表看的是量级,精确到个位没意义还占地方 */
const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const currentPermission = computed(() => permission.preset || 'workspace-write')
const permissionLabel = computed(() => t('agent.perm_' + currentPermission.value))

/**
 * 只在用户本来就贴着底部时才自动滚。
 * 无条件滚会把正在往上翻历史的人一把拽回底部 —— 长回复流式输出时尤其难受。
 */
function autoScroll() {
  const el = listEl.value
  if (!el) return
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}
watch(() => chat.items.map((i) => (i.kind === 'assistant' ? i.text.length : 1)).join(),
  () => nextTick(autoScroll))

async function send() {
  const text = input.value.trim()
  if (!text && !drafts.value.length) return

  /*
    斜杠开头的当命令跑,不当话说。

    命令和聊天走的是两条路:命令直接执行、立刻回结果、不经过模型,也不会被
    拿去当会话标题。以前没有入口,像 /compact(压缩上下文)、/export(导出记录)
    这些能力就一直够不着。
  */
  if (text.startsWith('/')) {
    input.value = ''
    closeMentions()
    const r = await runCommand(text)
    if (r?.text) chat.items.push({ kind: 'notice', id: `c${Date.now()}`, text: r.text })
    await nextTick()
    autoScroll()
    return
  }
  const images = drafts.value.map((d) => ({ mediaType: d.mediaType, data: d.data }))
  input.value = ''
  drafts.value = []
  closeMentions()
  nextTick(autoGrow)
  await sendPrompt(text, images)
  await nextTick()
  autoScroll()
}

// ── @ 引用文件 ────────────────────────────────────────
//
// 打 `@` 就地弹候选,选中插进去。**它不读文件** —— 插进去的只是一句规范的
// 提及,内容要模型自己调 read 去看。这一点和「附件」是两回事:附件是把东西
// 塞进这条消息,引用只是告诉它「去看这个」。

const composerEl = useTemplateRef<HTMLTextAreaElement>('composerEl')
const mentions = ref<FileCandidate[]>([])
/** 斜杠命令的候选。和 @ 共用同一个面板,同一时刻只会有一种 */
const slashes = ref<{ name: string; description: string; hint: string }[]>([])
const mentionAt = ref(-1)     // 那个 @ 在输入里的位置;-1 表示没在补全
const mentionPick = ref(0)
let mentionSeq = 0

function closeMentions() {
  mentions.value = []
  slashes.value = []
  mentionHint.value = ''
  mentionAt.value = -1
  mentionPick.value = 0
}

/*
  命令的说明由 DSH 给,是英文。常用的这几条自己翻一遍 ——
  这是给人看的菜单,一行英文摆在中文界面里,等于让人自己猜。
  翻不到的照原样显示,上游新增命令也不会漏掉。
*/
const CMD_ZH: Record<string, string> = {
  compact: '把前面聊过的压缩成摘要，腾出记忆额度',
  export: '把这段对话打包下载下来',
  feedback: '给这次会话留一句反馈',
  goal: '给这个长任务定一个目标（也能查看、暂停、清掉）',
  permission: '换一档权限（能改哪些文件、什么时候要问你）',
  plan: '进入或退出计划模式',
}

/** 打字时看看要不要弹命令菜单。只认「整句从 / 开头、还没打空格」 */
function updateSlashes() {
  const v = input.value
  if (!v.startsWith('/') || /\s/.test(v)) { slashes.value = []; return false }
  const q = v.slice(1).toLowerCase()
  slashes.value = commands.list
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .map((c) => ({
      name: c.name,
      description: CMD_ZH[c.name] ?? c.description,
      hint: c.input?.hint ?? '',
    }))
  mentionPick.value = 0
  return slashes.value.length > 0
}

/** 选中一条命令:要参数的补个空格等你写,不要参数的直接跑 */
function applySlash(c: { name: string; hint: string }) {
  if (c.hint) {
    input.value = `/${c.name} `
    slashes.value = []
    nextTick(() => composerEl.value?.focus())
  } else {
    input.value = `/${c.name}`
    slashes.value = []
    void send()
  }
}

const mentionHint = ref('')

/*
  输入框跟着内容长高。

  textarea 不会自己长,得每次先把高度清零、再按 scrollHeight 撑起来 ——
  不清零的话它只会越来越高,删字不回缩。上限 200px:再高就把对话挤没了,
  超过就自己滚。
*/
function autoGrow() {
  const el = composerEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

async function onComposerInput() {
  const el = composerEl.value
  if (!el) return
  autoGrow()
  if (updateSlashes()) { mentions.value = []; mentionHint.value = ''; return }
  if (input.value.startsWith('/')) { closeMentions(); return }
  const tok = activeAtToken(input.value, el.selectionStart ?? input.value.length)
  if (!tok) { closeMentions(); return }

  /*
    还没有会话就没有工作区,DSH 无从找起。这时候弹一个空面板最让人困惑 ——
    直接说清楚:先说一句话,这个 @ 才知道去哪儿找。
  */
  if (!chat.sessionId) {
    mentions.value = []
    mentionHint.value = t('agent.mentionNeedSession')
    mentionAt.value = tok.from
    return
  }
  mentionHint.value = ''
  mentionAt.value = tok.from
  // 打字很快时候补会乱序回来,只认最后一次发出的那一趟
  const seq = ++mentionSeq
  const rows = await listFileReferences(chat.sessionId, tok.query)
  if (seq !== mentionSeq || mentionAt.value !== tok.from) return
  mentions.value = rows.slice(0, 8)
  mentionHint.value = rows.length ? '' : t('agent.mentionNone')
  mentionPick.value = 0
}

function applyMention(c: FileCandidate) {
  const el = composerEl.value
  const caret = el?.selectionStart ?? input.value.length
  const text = formatFileMention(c.path, c.kind)
  if (text === null || mentionAt.value < 0) { closeMentions(); return }

  // 目录后面不补空格:多半还要接着往下选子路径
  const tail = c.kind === 'directory' ? '' : ' '
  const next = input.value.slice(0, mentionAt.value) + text + tail + input.value.slice(caret)
  const at = mentionAt.value + text.length + tail.length
  input.value = next
  closeMentions()
  nextTick(() => {
    el?.focus()
    el?.setSelectionRange(at, at)
    // 目录选完立刻再弹一层,接着往下钻
    if (c.kind === 'directory') void onComposerInput()
  })
}

// ── 图片附件 ──────────────────────────────────────────

const drafts = ref<Draft[]>([])

async function pickImages() {
  const picked = await openFileDialog({
    multiple: true,
    filters: [{ name: '图片', extensions: IMAGE_EXTS }],
  })
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : []
  for (const path of paths) {
    const name = path.split(/[\/]/).pop() ?? 'image'
    const d = draftFromBytes(name, await readFile(path))
    if (d) drafts.value = [...drafts.value, d]
  }
}

/** 从剪贴板粘图。截了图直接 Ctrl+V 是最顺手的一条路 */
async function onComposerPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return
  e.preventDefault()
  for (const f of files) {
    const name = f.name || `pasted.${(f.type.split('/')[1] ?? 'png')}`
    if (!mediaTypeOf(name)) continue
    const d = draftFromBytes(name, new Uint8Array(await f.arrayBuffer()))
    if (d) drafts.value = [...drafts.value, d]
  }
}

// ── 搜索与筛选 ──
const searchOpen = ref(false)
const onlyPinned = ref(false)
function toggleSearch() {
  searchOpen.value = !searchOpen.value
  // 关掉就清空,免得下次打开还留着上次的词
  if (!searchOpen.value) searchSessions('')
}
/** 搜索结果只带 sessionId 和片段,标题要从列表里查回来 */
const titleOf = (id: string) =>
  sessions.rows.find((x) => x.sessionId === id)?.title || t('agent.untitled')

// ── 会话排序与操作 ──

/** 置顶的排前面,组内各自按时间倒序 */
const sortedSessions = computed(() => {
  const set = new Set(pinned.ids)
  const top = sessions.rows.filter((s) => set.has(s.sessionId))
  if (onlyPinned.value) return top
  const rest = sessions.rows.filter((s) => !set.has(s.sessionId))
  return [...top, ...rest]
})
const pinnedCount = computed(() => sortedSessions.value.filter((s) => pinned.ids.includes(s.sessionId)).length)

const renameTarget = ref<SessionRow | null>(null)
const renameText = ref('')
function startRename(s: SessionRow) {
  renameTarget.value = s
  renameText.value = s.title
}
async function doRename() {
  const s = renameTarget.value
  if (!s || !renameText.value.trim()) return
  renameTarget.value = null
  try { await renameSession(s.sessionId, renameText.value.trim()) } catch { /* 已在内部记日志 */ }
}

const archiveTarget = ref<SessionRow | null>(null)
/*
  **要动的对象必须自己留一份快照,不能等点确认时再读 ref。**

  AlertDialogAction 被点中时会先把弹窗关掉,关闭触发 @update:open 把
  archiveTarget 清成 null —— 这件事发生在按钮自己的 @click **之前**。
  于是 doArchive 拿到 null 直接 return,表现就是「点了移除,什么都没发生」。
  Vault 的删除和重命名踩过同一个坑。
*/
let pendingArchive: SessionRow | null = null
function askArchive(s: SessionRow) {
  pendingArchive = s
  archiveTarget.value = s
}
async function doArchive() {
  const s = pendingArchive
  pendingArchive = null
  archiveTarget.value = null
  if (!s) return
  try { await archiveSession(s.sessionId) } catch { /* 已在内部记日志 */ }
}

// 换会话就重新读它的模型 —— 模型选择是**按会话**存的,不是全局
watch(() => chat.sessionId, (id) => { if (id) loadModels() })

/** 会话列表里的时间。精确到分秒没意义,「3 分钟前」才是人看的。 */
function relTime(ms: number): string {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60_000) return t('agent.justNow')
  if (d < 3_600_000) return t('agent.minutesAgo', { n: Math.floor(d / 60_000) })
  if (d < 86_400_000) return t('agent.hoursAgo', { n: Math.floor(d / 3_600_000) })
  return new Date(ms).toLocaleDateString()
}

/** 回车发送,Shift+回车换行 —— 聊天框的通用约定 */
function onKeydown(e: KeyboardEvent) {
  // 命令菜单开着时,同样归它
  if (slashes.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionPick.value = (mentionPick.value + 1) % slashes.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionPick.value = (mentionPick.value - 1 + slashes.value.length) % slashes.value.length
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault()
      applySlash(slashes.value[mentionPick.value])
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return }
  }

  // 候选面板开着时,方向键和回车归它 —— 否则「选一个文件」会变成「把消息发出去」
  if (mentions.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionPick.value = (mentionPick.value + 1) % mentions.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionPick.value = (mentionPick.value - 1 + mentions.value.length) % mentions.value.length
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
      e.preventDefault()
      applyMention(mentions.value[mentionPick.value])
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

// ── 侧栏三页签 ────────────────────────────────────────
//
// 「聊天」随手聊、不归项目;「项目」挑一件要干的事;「当前项目」进去之后要用的东西。
// 这三层就是工作台的骨架:先定范围,再干活。

const SIDE_TABS = ['chat', 'projects', 'current'] as const
const CUR_TABS = ['chat', 'files', 'settings'] as const

const sideTab = ref<(typeof SIDE_TABS)[number]>('chat')
const curTab = ref<(typeof CUR_TABS)[number]>('files')
const newProjectOpen = ref(false)

/** 进一个项目:记住它,并且直接跳到「当前项目」的文件页 —— 进来就是要看这个项目的东西 */
function enterProject(id: string) {
  projects.currentId = id
  sideTab.value = 'current'
  curTab.value = 'files'
}

// ── 正文栏 ────────────────────────────────────────────
//
// 工作台是「AI 干活、我看结果」,所以正文和对话并排。哪个在中间由用户定 ——
// 有人想盯着文件改,有人几乎只说话。

/** 当前在正文栏里打开的文件(项目内相对路径),空 = 还没开 */
const docPath = ref('')
const docText = ref('')
const docSaving = ref(false)

/** 正文在中间还是对话在中间。项目里定了就听项目的,没定跟全局 */
const docCenter = computed(() =>
  (currentProject.value?.layout ?? settings.agentLayout) === 'doc-center')

function swapPanes() {
  const next = docCenter.value ? 'chat-center' : 'doc-center'
  const cur = currentProject.value
  // 在项目里改就只改这个项目;不在项目里就改全局默认
  if (cur) void updateProject(cur.id, { layout: next })
  else settings.agentLayout = next
}

/** 单击文件:把它插进输入框,变成一句 @引用 —— 不用自己去找路径 */
function mentionFile(rel: string) {
  const mention = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`
  const cur = input.value
  input.value = cur && !cur.endsWith(' ') ? `${cur} ${mention} ` : `${cur}${mention} `
  nextTick(() => composerEl.value?.focus())
}

/** 双击文件:在正文栏打开 */
async function openProjectFile(rel: string) {
  const root = currentProject.value?.folder
  if (!root) return
  try {
    docText.value = await invoke<string>('vault_read', { root, rel })
    docPath.value = rel
  } catch (e) {
    chat.items.push({ kind: 'notice', id: `d${Date.now()}`, text: String(e) })
  }
}

/** 正文改了就存回去。这一栏是能改的 —— 看见不对随手就改,不用切去笔记页 */
async function saveDoc() {
  const root = currentProject.value?.folder
  if (!root || !docPath.value) return
  docSaving.value = true
  try {
    await invoke('vault_write', { root, rel: docPath.value, content: docText.value })
  } catch (e) {
    chat.items.push({ kind: 'notice', id: `d${Date.now()}`, text: String(e) })
  } finally {
    docSaving.value = false
  }
}

/** 建好就直接进去 —— 人建项目就是为了开始干这件事,不该建完还停在列表上 */
async function createProject(p: { name: string; category: string; icon: string }) {
  const it = await addProject({ ...p, folder: '' })
  enterProject(it.id)
}

/** 给这个项目挑一个文件夹。项目没有文件夹就只是个空壳 */
async function pickFolder() {
  const cur = currentProject.value
  if (!cur) return
  const picked = await openFileDialog({ directory: true, multiple: false })
  if (typeof picked === 'string') await updateProject(cur.id, { folder: picked })
}

async function removeCurrentProject() {
  const cur = currentProject.value
  if (!cur) return
  await removeProject(cur.id)
  sideTab.value = 'projects'
}

/** 刚复制过的那条消息。用来把按钮短暂换成「已复制」 */
const copiedId = ref('')

async function copyMessage(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return   // 剪贴板被拒就别显示「已复制」骗人
  }
  copiedId.value = id
  setTimeout(() => { if (copiedId.value === id) copiedId.value = '' }, 1400)
}

</script>

<template>
  <!--
    智能体页顶到窗口顶部(pt-2.5),不像其他页那样给浮空顶栏让出 78px。
    Logo 在 x=10..82,会话侧栏从 x=92 开始,横向不打架;
    右上角那三颗控制点会浮在聊天区上方 —— 所以聊天区**内部**要留出
    顶部空间(见下面 chat-top),否则第一条消息会被三颗点压住。
  -->
  <div ref="rootEl" class="absolute inset-0 pt-2.5 pl-[4.875rem] pr-2.5 pb-2.5 flex"
    :class="dragging ? 'select-none' : ''">

    <!-- ═══════ 会话侧栏 ═══════ -->
    <aside :style="{ width: settings.agentSidebarWidth + 'px' }"
      class="float-card shrink-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">

      <!--
        侧栏顶上这三个页签是工作台的骨架:
        「聊天」随手聊、不归任何项目;「项目」挑一件要干的事;
        「当前项目」进去之后这件事要用的全部东西。
        新会话按钮挪进了「聊天」那一页 —— 它本来就只对随手聊有意义,
        项目里的新会话在项目自己那一页。
      -->
      <div class="p-2 pb-1">
        <div class="flex gap-1 p-1 rounded-xl bg-muted/40">
          <button v-for="tb in SIDE_TABS" :key="tb"
            :disabled="tb === 'current' && !currentProject"
            @click="sideTab = tb" :class="[
              'flex-1 h-7 rounded-lg text-[12.5px] transition-colors disabled:opacity-40',
              sideTab === tb ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            ]">{{ t('agent.side_' + tb) }}</button>
        </div>
      </div>

      <div v-if="sideTab === 'chat'" class="px-2.5 pt-1.5">
        <button @click="newSession()" :disabled="!chatReady"
          class="w-full h-9 rounded-xl border border-border bg-muted/50 flex items-center justify-center gap-2
                 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
          <span class="icon-[lucide--circle-plus] w-4 h-4" />
          {{ t('agent.newChat') }}
        </button>
      </div>

      <template v-if="sideTab === 'chat'">
      <div class="px-3.5 pb-1 flex items-center gap-1">
        <span class="text-xs text-muted-foreground mr-auto">{{ t('agent.workspace') }}</span>
        <button @click="loadSessions" :title="t('agent.refreshSessions')" :disabled="sessions.loading"
          class="size-7 rounded-lg flex items-center justify-center text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--rotate-cw] w-3.5 h-3.5" :class="sessions.loading ? 'animate-spin' : ''" />
        </button>
        <button @click="toggleSearch" :title="t('agent.searchSessions')" :class="[
          'size-7 rounded-lg flex items-center justify-center transition-colors hover:bg-muted/60 hover:text-foreground',
          searchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
        ]">
          <span class="icon-[lucide--search] w-3.5 h-3.5" />
        </button>
        <button @click="onlyPinned = !onlyPinned" :title="t('agent.filterPinned')" :class="[
          'size-7 rounded-lg flex items-center justify-center transition-colors hover:bg-muted/60 hover:text-foreground',
          onlyPinned ? 'bg-muted text-foreground' : 'text-muted-foreground'
        ]">
          <span class="icon-[lucide--pin] w-3.5 h-3.5" />
        </button>
      </div>

      <!-- 搜索框:点放大镜才出来,平时不占地方 -->
      <div v-if="searchOpen" class="px-2.5 pb-2">
        <input :value="sessionSearch.query" @input="searchSessions(($event.target as HTMLInputElement).value)"
          :placeholder="t('agent.searchPlaceholder')"
          class="w-full h-8 px-2.5 rounded-lg bg-background/40 border border-border text-[13px]
                 placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
      </div>

      <!-- 会话列表。数据来自 DSH,应用重启也还在 —— 它存在 ~/.dsh/sessions/ 里。 -->
      <div class="flex-1 min-h-0 overflow-y-auto px-2.5 pb-2.5">
        <!-- 搜索态显示命中的片段而不是标题 —— 找的是内容 -->
        <template v-if="searchOpen && sessionSearch.query.trim()">
          <p v-if="!sessionSearch.hits.length" class="mt-4 text-center text-xs text-muted-foreground">
            {{ sessionSearch.searching ? '…' : t('agent.noHits') }}
          </p>
          <button v-for="h in sessionSearch.hits" :key="h.sessionId" @click="openSession(h.sessionId)"
            class="w-full text-left rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/50">
            <div class="text-[13px] truncate">{{ titleOf(h.sessionId) }}</div>
            <div class="text-[11px] text-muted-foreground leading-snug line-clamp-2">{{ h.snippet }}</div>
          </button>
          <p v-if="sessionSearch.hasMore" class="mt-2 text-center text-[11px] text-muted-foreground">
            {{ t('agent.refineSearch') }}
          </p>
        </template>
        <template v-else>
        <div v-if="sortedSessions.length" class="flex flex-col gap-0.5">
          <template v-for="(s, i) in sortedSessions" :key="s.sessionId">
            <!-- 置顶和普通之间一条分隔线,不用两个标题挤占本来就窄的侧栏 -->
            <div v-if="i === pinnedCount && pinnedCount > 0" class="h-px bg-border mx-2 my-1.5" />

            <ContextMenu>
              <ContextMenuTrigger as-child>
                <button @click="openSession(s.sessionId)" :class="[
                  'w-full text-left rounded-lg px-2.5 py-2 transition-colors',
                  s.sessionId === chat.sessionId ? 'bg-muted' : 'hover:bg-muted/50'
                ]">
                  <div class="flex items-center gap-1.5">
                    <!-- 跑着的会话给个呼吸点:后台还在干活的那条要一眼看得出来 -->
                    <span v-if="s.running" class="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                    <span v-if="pinned.ids.includes(s.sessionId)"
                      class="icon-[lucide--pin] w-3 h-3 shrink-0 text-muted-foreground" />
                    <span class="text-[13px] truncate" :class="s.title ? '' : 'text-muted-foreground italic'">
                      {{ s.title || t('agent.untitled') }}
                    </span>
                  </div>
                  <div class="text-[11px] text-muted-foreground mt-0.5">{{ relTime(s.updatedAt) }}</div>
                </button>
              </ContextMenuTrigger>

              <ContextMenuContent class="w-44">
                <ContextMenuItem @select="togglePin(s.sessionId)">
                  <span class="icon-[lucide--pin] w-4 h-4 mr-2" />
                  {{ pinned.ids.includes(s.sessionId) ? t('agent.unpin') : t('agent.pin') }}
                </ContextMenuItem>
                <ContextMenuItem @select="startRename(s)">
                  <span class="icon-[lucide--pencil] w-4 h-4 mr-2" />
                  {{ t('agent.rename') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @select="askArchive(s)" class="text-destructive focus:text-destructive">
                  <span class="icon-[lucide--archive] w-4 h-4 mr-2" />
                  {{ t('agent.archive') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </template>
        </div>

        <div v-else class="mt-6 px-2 text-center">
          <span class="icon-[lucide--messages-square] w-7 h-7 text-muted-foreground/40 mx-auto block" />
          <p class="mt-2.5 text-[13px] text-muted-foreground">{{ t('agent.noSessions') }}</p>
          <p class="mt-1 text-xs text-muted-foreground/70 leading-relaxed">{{ t('agent.noSessionsHint') }}</p>
        </div>
        </template>
      </div>
      </template>

      <!-- ═══ 项目：大类折叠 → 项目 ═══ -->
      <div v-else-if="sideTab === 'projects'" class="flex-1 min-h-0 overflow-y-auto px-2 pb-2.5">
        <p v-if="!projects.items.length" class="mt-6 px-2 text-center text-[13px] text-muted-foreground leading-relaxed">
          {{ t('agent.noProjects') }}
        </p>
        <template v-for="g in grouped" :key="g.category || '_'">
          <button v-if="g.category" @click="toggleCategory(g.category)"
            class="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] text-muted-foreground
                   transition-colors hover:bg-muted/50">
            <span class="w-3 h-3 shrink-0"
              :class="projects.collapsed[g.category] ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
            {{ g.category }}
          </button>
          <template v-if="!g.category || !projects.collapsed[g.category]">
            <button v-for="pr in g.items" :key="pr.id" @click="enterProject(pr.id)" :class="[
              'w-full flex items-center gap-2 py-1.5 rounded-lg text-[13px] transition-colors',
              g.category ? 'pl-6 pr-2' : 'px-2',
              projects.currentId === pr.id ? 'bg-muted text-foreground' : 'hover:bg-muted/60'
            ]">
              <span class="shrink-0">{{ pr.icon || '📁' }}</span>
              <span class="truncate">{{ pr.name }}</span>
            </button>
          </template>
        </template>

        <button @click="newProjectOpen = true"
          class="w-full mt-2 h-8 rounded-lg border border-dashed border-border text-[12.5px]
                 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
          ＋ {{ t('agent.newProject') }}
        </button>
      </div>

      <!-- ═══ 当前项目：会话 / 文件 / 设置 ═══ -->
      <div v-else-if="sideTab === 'current' && currentProject" class="flex-1 min-h-0 flex flex-col">
        <div class="px-2.5 pb-1 flex items-center gap-2 text-[13px]">
          <span>{{ currentProject.icon || '📁' }}</span>
          <span class="truncate font-medium">{{ currentProject.name }}</span>
        </div>
        <div class="px-2 pb-1">
          <div class="flex gap-1 p-1 rounded-xl bg-muted/40">
            <button v-for="sb in CUR_TABS" :key="sb" @click="curTab = sb" :class="[
              'flex-1 h-7 rounded-lg text-[12px] transition-colors',
              curTab === sb ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            ]">{{ t('agent.cur_' + sb) }}</button>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2.5">
          <!-- 会话：这个项目下的对话。第二步接真数据,先把位置留出来 -->
          <template v-if="curTab === 'chat'">
            <button @click="newSession(currentProject.folder || undefined)" :disabled="!chatReady"
              class="w-full h-8 rounded-lg border border-dashed border-border text-[12.5px]
                     text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40">
              ＋ {{ t('agent.newChat') }}
            </button>
            <p class="mt-3 px-1 text-[12px] text-muted-foreground leading-relaxed">
              {{ t('agent.curChatHint') }}
            </p>
          </template>

          <!-- 文件：项目文件夹的树。单击插引用,双击打开 -->
          <template v-else-if="curTab === 'files'">
            <button v-if="!currentProject.folder" @click="pickFolder"
              class="w-full mt-2 px-2 py-3 rounded-lg border border-dashed border-border text-[12.5px]
                     text-muted-foreground leading-relaxed transition-colors hover:bg-muted/50 hover:text-foreground">
              {{ t('agent.noFolder') }}
            </button>
            <template v-else>
              <ProjectFiles :root="currentProject.folder"
                @mention="mentionFile" @open="openProjectFile" />
              <p class="mt-2 px-1 text-[11px] text-muted-foreground leading-relaxed">
                {{ t('agent.filesHint') }}
              </p>
            </template>
          </template>

          <!-- 设置：这个项目自己的东西 -->
          <template v-else>
            <button @click="openRules(currentProject.folder)"
              class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
              <span class="icon-[lucide--scroll-text] w-3.5 h-3.5 text-muted-foreground" />
              {{ t('agent.rules') }}
            </button>
            <button @click="pickFolder"
              class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
              <span class="icon-[lucide--folder-open] w-3.5 h-3.5 text-muted-foreground" />
              <span class="flex-1 text-left truncate">{{ t('agent.projFolder') }}</span>
              <span class="text-[11px] text-muted-foreground truncate max-w-[7rem]">
                {{ currentProject.folder ? currentProject.folder.split(/[\/]/).pop() : t('agent.notSet') }}
              </span>
            </button>
            <button @click="removeCurrentProject"
              class="w-full flex items-center gap-2 px-2 py-2 mt-1 rounded-lg text-[13px] text-destructive
                     transition-colors hover:bg-destructive/10">
              <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
              {{ t('agent.delProject') }}
            </button>
          </template>
        </div>
      </div>

      <!--
        边车状态。灯的颜色只由 phase 决定,不掺「装没装」——
        装没装是上面那块引导管的事,混在一起会出现「绿灯但没装」这种自相矛盾的显示。
      -->
      <button @click="onStateClick" :disabled="dsh.state.phase === 'starting' || dsh.installing"
        class="px-3.5 py-2.5 border-t border-border flex items-center gap-1.5 text-left transition-colors
               hover:bg-muted/40 disabled:hover:bg-transparent">
        <span class="size-1.5 rounded-full shrink-0" :class="dotClass" />
        <span class="text-xs text-muted-foreground truncate">{{ stateLabel }}</span>
        <span v-if="canStart" class="icon-[lucide--play] w-3 h-3 ml-auto shrink-0 text-muted-foreground" />
      </button>
    </aside>

    <!--
      拖拽把手。宽度算在这条 10px 上,所以侧栏和聊天区之间的间距 = 把手宽度,
      不再另外给 gap —— 否则拖动时手感会和看到的缝对不上。
    -->
    <div @pointerdown="onDragStart"
      class="w-2.5 shrink-0 cursor-col-resize flex items-center justify-center group">
      <!-- 常显,不是悬停才出现 —— 不然没人知道这两栏之间能拖 -->
      <div class="w-0.5 h-10 rounded-full bg-border transition-colors group-hover:bg-foreground/40"
        :class="dragging ? 'bg-foreground/60' : ''" />
    </div>


    <!--
      ═══════ 正文栏 ═══════

      只在「项目里而且开着一个文件」时出现 —— 随手聊的时候它没有内容可显示,
      占着地方只会把对话挤窄。

      order 决定它和对话谁在中间:工作台是「AI 干活、我看结果」,
      两栏并排,哪个当主角由人定(项目里定了听项目的,没定跟全局)。
    -->
    <section v-if="docPath" class="flex flex-col overflow-hidden float-card rounded-[14px] border bg-card"
      :style="{ order: docCenter ? 1 : 3, flex: docCenter ? '1 1 0%' : '0 0 28rem' }">
      <div class="h-11 shrink-0 px-3 flex items-center gap-2 border-b border-border">
        <span class="icon-[lucide--file-text] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class="text-[13px] truncate">{{ docPath }}</span>
        <button @click="saveDoc" :disabled="docSaving"
          class="ml-auto h-7 px-2.5 rounded-lg border border-border text-[12px] text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40">
          {{ t('agent.docSave') }}
        </button>
        <button @click="swapPanes" :title="t('agent.swapPanes')"
          class="size-7 rounded-lg flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground">
          <span class="icon-[lucide--arrow-left-right] w-3.5 h-3.5" />
        </button>
        <button @click="docPath = ''" :title="t('convert.cancel')"
          class="size-7 rounded-lg flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
      </div>
      <!-- 用的就是笔记页那个编辑器 —— 同一套渲染,不做第二份 -->
      <div class="flex-1 min-h-0 overflow-hidden">
        <MarkdownEditor v-model="docText" :scroll-key="docPath"
          :accent="settings.vaultAccent" :font="settings.vaultFont"
          :font-size="settings.vaultFontSize" :color-headings="settings.vaultColorHeadings" />
      </div>
    </section>

    <div v-if="docPath" class="w-2.5 shrink-0" :style="{ order: 2 }" />

    <!-- ═══════ 聊天区 ═══════ -->
    <section class="min-w-0 flex flex-col overflow-hidden relative"
      :style="{ order: docPath ? (docCenter ? 3 : 1) : 2,
                flex: docPath && docCenter ? '0 0 28rem' : '1 1 0%' }"
      :class="flat ? '' : 'float-card rounded-[14px] border bg-card'">

      <!--
        启动屏。边车没起来之前盖在整个聊天区上;连上的那一刻从中间散开:
        放大到 1.6 倍 + 高斯模糊 + 淡出,底下的正常界面同时露出来 —— 就是交叉淡化。
        transition 列表里要写 scale 不能只写 transform(Tailwind v4 把 scale 编译成独立属性,
        坑见 App.vue 切页动画那段注释)。
      -->
      <Transition
        leave-active-class="transition-[opacity,scale,filter] duration-500 ease-in will-change-[opacity,transform,filter]"
        leave-to-class="opacity-0 scale-[1.6] blur-md">
        <DshBoot v-if="booting" />
      </Transition>

      <!--
        环境不齐的引导。放在空态之前是刻意的:Node 都没有的时候,给一个能用的输入框
        只会让人白打一段字再被拒。缺什么就说什么,能代劳的就给按钮。
      -->
      <div v-if="blocker" class="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div class="max-w-md text-center">
          <span class="icon-[ri--deepseek-line] w-10 h-10 mx-auto block text-muted-foreground/60" />

          <template v-if="blocker === 'node'">
            <p class="mt-5 text-[15px] leading-relaxed text-foreground">
              {{ dsh.pre?.nodeVersion
                ? t('agent.nodeTooOld', { v: dsh.pre.nodeVersion })
                : t('agent.nodeNeeded') }}
            </p>
            <div class="mt-5 flex items-center justify-center gap-2">
              <button @click="openNode" class="pill border border-border">
                <span class="icon-[lucide--external-link] w-3.5 h-3.5" />
                {{ t('agent.getNode') }}
              </button>
              <button @click="refresh" class="pill border border-border">
                <span class="icon-[lucide--rotate-cw] w-3.5 h-3.5" />
                {{ t('agent.retry') }}
              </button>
            </div>
          </template>

          <template v-else-if="blocker === 'pnpm'">
            <p class="mt-5 text-[15px] leading-relaxed text-foreground">{{ t('agent.pnpmNeeded') }}</p>
            <div class="mt-5 flex items-center justify-center gap-2">
              <button @click="openPnpm" class="pill border border-border">
                <span class="icon-[lucide--external-link] w-3.5 h-3.5" />
                {{ t('agent.getPnpm') }}
              </button>
              <button @click="refresh" class="pill border border-border">
                <span class="icon-[lucide--rotate-cw] w-3.5 h-3.5" />
                {{ t('agent.retry') }}
              </button>
            </div>
          </template>

          <template v-else>
            <p class="mt-5 text-[15px] leading-relaxed text-foreground">{{ t('agent.installHint') }}</p>
            <button @click="installDsh" :disabled="dsh.installing"
              class="mt-5 h-10 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium
                     transition-opacity disabled:opacity-50">
              {{ dsh.installing ? t('agent.installing') : t('agent.install') }}
            </button>
            <!-- 装的过程几分钟起步,不给点动静会被当成卡死 -->
            <p v-if="dsh.installing && dsh.installLine"
              class="mt-3 text-xs font-mono text-muted-foreground/70 truncate">{{ dsh.installLine }}</p>
            <!-- 失败原因必须摆在这儿。只写在侧栏底部那一行,用户根本不会往那看。 -->
            <p v-else-if="installError"
              class="mt-4 text-xs leading-relaxed text-red-500 wrap-break-word">{{ installError }}</p>
          </template>
        </div>
      </div>

      <!-- 空态:居中的招呼 + 输入框,和原版 DSH 一个路子 -->
      <div v-else-if="empty" class="flex-1 min-h-0 flex flex-col items-center justify-center px-6 pt-14">
        <div class="flex items-center gap-2.5 mb-7">
          <span class="icon-[ri--deepseek-line] w-8 h-8 text-foreground" />
          <h1 class="text-[26px] font-medium tracking-tight">{{ greeting }}</h1>
        </div>
        <div class="w-full max-w-2xl">
          <!-- 工作区和模式放在框「上方」,和原版 DSH 一致:它们选的是这一轮的作用域,
               不是输入框里的一个开关,视觉上分开更说得通。 -->
          <div class="flex items-center gap-1 mb-2 px-1">
            <!-- 工作区:决定新会话建在哪个目录。空态选好,第一句话生效 -->
            <Popover>
              <PopoverTrigger as-child>
                <button class="pill">
                  <span class="icon-[lucide--folder] w-3.5 h-3.5" />
                  {{ currentWorkspaceLabel }}
                  <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-72 p-1">
                <button v-for="w in workspaces.items" :key="w.workspaceId"
                  @click="workspaces.pendingId = w.workspaceId" :class="[
                    'w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors',
                    workspaces.pendingId === w.workspaceId ? 'bg-muted' : 'hover:bg-muted/60'
                  ]">
                  <div class="truncate">{{ w.title }}</div>
                  <div class="text-[11px] text-muted-foreground truncate">{{ w.path }}</div>
                </button>
                <div v-if="workspaces.items.length" class="h-px bg-border my-1 mx-1" />
                <button class="w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-muted/60
                       flex items-center gap-2" @click="addWorkspace">
                  <span class="icon-[lucide--folder-plus] w-4 h-4" />{{ t('agent.addWorkspace') }}
                </button>
              </PopoverContent>
            </Popover>

            <!--
              规矩:写给它看的一份说明(你是谁、这个文件夹干嘛的、产出往哪儿放)。
              挨着工作区放 —— 项目规矩是跟着文件夹走的,这两件事本来就是一回事。
            -->
            <button class="pill" :title="t('agent.rulesHint')"
              @click="openRules(currentWorkspacePath)">
              <span class="icon-[lucide--scroll-text] w-3.5 h-3.5" />
              {{ t('agent.rules') }}
            </button>

            <!-- 模式:DSH 的 agent preset(标准/PTC/极简/创造),空态选好开局生效 -->
            <Popover>
              <PopoverTrigger as-child>
                <button class="pill">
                  <span class="icon-[lucide--git-branch] w-3.5 h-3.5" />
                  {{ currentPresetLabel }}
                  <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-80 p-1">
                <button v-for="pr in presets.options" :key="pr.id"
                  @click="selectPreset(pr.id)" :class="[
                    'w-full text-left rounded-md px-2.5 py-2 transition-colors',
                    presets.current === pr.id ? 'bg-muted' : 'hover:bg-muted/60'
                  ]">
                  <div class="text-sm flex items-center gap-2">
                    <span class="flex-1 truncate">{{ pr.name }}</span>
                    <span v-if="presets.current === pr.id" class="icon-[lucide--check] w-3.5 h-3.5 shrink-0" />
                  </div>
                  <div class="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{{ pr.description }}</div>
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <div class="composer relative">
            <!--
              @ 引用的候选面板。贴着输入框上沿开,不挡正在打的字。
              它只负责把路径写成规范的引用 —— 文件内容不在这里读,模型自己去 read。
            -->
            <div v-if="mentions.length || mentionHint || slashes.length"
              class="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover
                     shadow-lg overflow-hidden z-20">
              <p v-if="mentionHint" class="px-3 py-2 text-[12px] text-muted-foreground">{{ mentionHint }}</p>
  <!-- 斜杠命令:名字 + 一句人话说明,要参数的把参数提示也写出来 -->
  <button v-for="(c, i) in slashes" :key="c.name" @mousedown.prevent="applySlash(c)"
    :class="['w-full text-left px-3 py-2 flex items-baseline gap-2 text-[13px] transition-colors',
             i === mentionPick ? 'bg-muted' : 'hover:bg-muted/60']">
    <span class="font-mono shrink-0">/{{ c.name }}</span>
    <span v-if="c.hint" class="font-mono text-[11px] text-muted-foreground shrink-0">{{ c.hint }}</span>
    <span class="truncate text-muted-foreground">{{ c.description }}</span>
  </button>
  <button v-for="(c, i) in mentions" :key="c.path" @mousedown.prevent="applyMention(c)"
                :class="['w-full text-left px-3 py-2 flex items-center gap-2 text-[13px] transition-colors',
                         i === mentionPick ? 'bg-muted' : 'hover:bg-muted/60']">
                <span :class="['w-3.5 h-3.5 shrink-0 text-muted-foreground',
                               c.kind === 'directory' ? 'icon-[lucide--folder]' : 'icon-[lucide--file-text]']" />
                <span class="truncate">{{ c.path }}</span>
              </button>
            </div>

            <!-- 待发送的图片:发出去之前一直摆在这儿,点 × 撤掉 -->
            <div v-if="drafts.length" class="flex flex-wrap gap-2 px-4 pt-3">
              <div v-for="(d, k) in drafts" :key="k" class="relative">
                <img :src="d.url" :alt="d.name" :title="d.name"
                  class="w-14 h-14 rounded-lg object-cover border border-border" />
                <button @click="drafts = drafts.filter((_, n) => n !== k)"
                  class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-background border border-border
                         flex items-center justify-center hover:bg-muted">
                  <span class="icon-[lucide--x] w-3 h-3" />
                </button>
              </div>
            </div>
            <textarea ref="composerEl" v-model="input" @keydown="onKeydown" @input="onComposerInput"
              @paste="onComposerPaste" rows="2" :placeholder="t('agent.placeholder')"
              class="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed
                     placeholder:text-muted-foreground/60 focus:outline-none" />
            <div class="composer-bar">
              <button :title="t('agent.attach')" class="pill-icon" @click="pickImages">
                <span class="icon-[lucide--plus] w-4 h-4" />
              </button>
              <!--
                计划模式:开着的时候它先出方案、等你点头才动手。
                做成常驻开关而不是藏进菜单 —— 这是「这一轮怎么跟我配合」,
                和权限、模型一样每次都要一眼看得见。
              -->
              <button class="pill" :class="planOn ? 'pill-on' : ''"
                :title="planOn ? t('agent.planModeOn') : t('agent.planModeOff')" @click="togglePlan">
                <span class="icon-[lucide--list-checks] w-3.5 h-3.5" />
                {{ t('agent.planMode') }}
              </button>
              <!-- 访问权限:原版的「工作区可写」下拉,背后是 /permission 命令 -->
              <Popover>
                <PopoverTrigger as-child>
                  <button class="pill">
                    <span class="icon-[lucide--shield-check] w-3.5 h-3.5" />
                    {{ permissionLabel }}
                    <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" class="w-56 p-1">
                  <button v-for="pp in PERMISSION_PRESETS" :key="pp"
                    @click="selectPermission(pp)" :class="[
                      'w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors flex items-center gap-2',
                      currentPermission === pp ? 'bg-muted' : 'hover:bg-muted/60'
                    ]">
                    <span :class="[
                      'w-3.5 h-3.5 shrink-0',
                      pp === 'read-only' ? 'icon-[lucide--eye]'
                        : pp === 'workspace-write' ? 'icon-[lucide--shield-check]' : 'icon-[lucide--shield-alert]'
                    ]" />
                    <span class="flex-1">{{ t('agent.perm_' + pp) }}</span>
                    <span v-if="currentPermission === pp" class="icon-[lucide--check] w-3.5 h-3.5 shrink-0" />
                  </button>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger as-child>
                  <button class="pill ml-auto" @click="loadModels">
                    <span :class="models.routable ? '' : 'text-amber-500'">{{ currentModelLabel }}</span>
                    <span v-if="models.current?.reasoningEffort" class="text-muted-foreground">
                      {{ models.current.reasoningEffort }}
                    </span>
                    <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" class="w-72 p-1 max-h-80 overflow-y-auto">
                  <p v-if="!models.routable" class="px-2.5 py-2 text-xs text-amber-500 leading-relaxed">
                    {{ t('agent.notRoutable') }}
                  </p>
                  <p v-if="!models.options.length" class="px-2.5 py-3 text-xs text-muted-foreground text-center">
                    {{ models.loading ? '…' : t('agent.noModels') }}
                  </p>
                  <button v-for="m in models.options" :key="m.provider + '/' + m.model"
                    @click="selectModel(m.provider, m.model)" :class="[
                      'group w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors',
                      m.provider === models.current?.provider && m.model === models.current?.model
                        ? 'bg-muted' : 'hover:bg-muted/60'
                    ]">
                    <div class="flex items-center gap-2">
                      <span class="truncate flex-1">{{ m.label }}</span>
                      <!--
                        设为默认:写进 DSH 设置(和原版设置页同一个开关),
                        以后每个新会话都用它。悬停才出现,免得每行都挂着字。
                      -->
                      <span @click.stop="setDefaultModel(m.provider, m.model)"
                        class="shrink-0 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground
                               opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground
                               transition-opacity cursor-pointer">
                        {{ t('agent.setDefault') }}
                      </span>
                    </div>
                    <div class="text-[11px] text-muted-foreground truncate">{{ m.provider }}</div>
                    <!-- 有推理强度档位的模型,把档位直接摊开,少一层点击 -->
                    <div v-if="m.reasoningOptions.length" class="flex flex-wrap gap-1 mt-1.5">
                      <span v-for="r in m.reasoningOptions" :key="r.id"
                        @click.stop="selectModel(m.provider, m.model, r.id)" :class="[
                          'px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition-colors',
                          models.current?.model === m.model && models.current?.reasoningEffort === r.id
                            ? 'bg-foreground/15 text-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                        ]">{{ r.label }}</span>
                    </div>
                  </button>
                </PopoverContent>
              </Popover>
              <button @click="send" :disabled="!input.trim()" :title="t('agent.send')" class="send-btn">
                <span class="icon-[lucide--arrow-up] w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 对话态 -->
      <template v-else>
        <!-- pt-16:给右上角那三颗控制点让位,否则第一条消息会钻到它们底下 -->
        <div ref="listEl" class="flex-1 min-h-0 overflow-y-auto px-6 pb-6 pt-16">
          <div class="max-w-2xl mx-auto flex flex-col gap-5">
            <!-- 拉历史的等待态:大会话要等一两秒,不给反馈像卡死 -->
            <div v-if="chat.loadingHistory && !chat.items.length"
              class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <span class="icon-[lucide--loader] w-4 h-4 animate-spin" />
              {{ t('agent.loadingHistory') }}
            </div>

            <!--
              读完了整段淡入。

              历史是一次性灌进来的:不淡入的话就是「空白 → 啪一下满屏文字」,
              眼睛得重新找一遍看到哪儿了。淡入 + 轻微上移只要 200ms,
              但足够让人知道「刚才那块是新出现的」。
            -->
            <div v-for="m in chat.items" :key="m.id" class="msg-in">

              <!-- 用户:右侧气泡 -->
              <div v-if="m.kind === 'user'" class="flex justify-end">
                <div class="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap wrap-break-word">
                  {{ m.text }}
                </div>
              </div>

              <!-- 助手:左侧全宽,不用气泡 —— 回复常常很长,气泡会把行宽压到难读 -->
              <div v-else-if="m.kind === 'assistant'" class="group/msg flex gap-3">
                <span class="icon-[ri--deepseek-line] w-5 h-5 mt-0.5 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <!--
                    模型的回复本来就是 markdown,按 markdown 渲染(对标原版)。
                    渲染器 html:false,原始 HTML 一律转义 —— 模型输出是不可信内容。
                    点击代理:链接要转给系统浏览器,不能让 webview 自己开。
                  -->
                  <div class="chat-md text-[15px] leading-relaxed wrap-break-word"
                    @click="onChatLinkClick" v-html="renderChatMd(m.text)" />
                  <!-- 流式光标:让「还在写」和「写完了」一眼可辨 -->
                  <span v-if="m.streaming" class="inline-block w-1.5 h-4 align-text-bottom bg-foreground/60 animate-pulse ml-0.5" />
                  <!--
                    复制这段回复。写完了才出现 —— 还在写的时候复制到的是半截,
                    给了反而误事。鼠标移到这条消息上才显形,不占版面。
                  -->
                  <button v-if="!m.streaming" @click="copyMessage(m.id, m.text)"
                    class="mt-1.5 h-6 px-2 rounded-md border border-border text-[11px] text-muted-foreground
                           opacity-0 group-hover/msg:opacity-100 transition-opacity
                           hover:bg-muted hover:text-foreground inline-flex items-center gap-1">
                    <span :class="copiedId === m.id ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'"
                      class="w-3 h-3" />
                    {{ copiedId === m.id ? t('agent.copied') : t('agent.copy') }}
                  </button>
                </div>
              </div>

              <!-- 工具调用:折叠成一行,点开看细节 -->
              <details v-else-if="m.kind === 'tool'" class="rounded-xl border border-border bg-background/30">
                <summary class="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer text-[13px] select-none">
                  <span :class="[
                    'w-3.5 h-3.5 shrink-0',
                    m.status === 'running' ? 'icon-[lucide--loader] animate-spin text-amber-500'
                    : m.status === 'failed' ? 'icon-[lucide--circle-x] text-red-500'
                    : 'icon-[lucide--circle-check] text-emerald-500'
                  ]" />
                  <span class="font-mono text-foreground">{{ m.name }}</span>
                  <span class="text-muted-foreground truncate">{{ m.detail.slice(0, 60) }}</span>
                </summary>
                <pre class="px-3.5 pb-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap wrap-break-word max-h-64 overflow-auto">{{ m.detail }}</pre>
              </details>

              <!-- 系统提示:重试、压缩上下文之类 -->
              <p v-else class="text-xs text-muted-foreground text-center">{{ m.text }}</p>

            </div>
          </div>
        </div>

        <!--
          需要人拍板的事(权限审批、向用户提问)。
          贴在输入框上方而不是弹对话框:它跟这一轮对话是连着的,
          盖一层模态会让人看不到智能体刚才说了什么、为什么要这个权限。
          不回应的话那次工具调用会一直挂着,所以这块必须显眼。
        -->
        <div v-if="chat.pending" class="px-6 pb-3">
          <div class="max-w-2xl mx-auto"><PendingCard /></div>
        </div>

        <div class="px-6 pb-5">
          <div class="max-w-2xl mx-auto">
            <div class="composer relative">
              <!--
                @ 引用的候选面板。贴着输入框上沿开,不挡正在打的字。
                它只负责把路径写成规范的引用 —— 文件内容不在这里读,模型自己去 read。
              -->
              <div v-if="mentions.length || mentionHint || slashes.length"
                class="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border bg-popover
                       shadow-lg overflow-hidden z-20">
                <p v-if="mentionHint" class="px-3 py-2 text-[12px] text-muted-foreground">{{ mentionHint }}</p>
  <!-- 斜杠命令:名字 + 一句人话说明,要参数的把参数提示也写出来 -->
  <button v-for="(c, i) in slashes" :key="c.name" @mousedown.prevent="applySlash(c)"
    :class="['w-full text-left px-3 py-2 flex items-baseline gap-2 text-[13px] transition-colors',
             i === mentionPick ? 'bg-muted' : 'hover:bg-muted/60']">
    <span class="font-mono shrink-0">/{{ c.name }}</span>
    <span v-if="c.hint" class="font-mono text-[11px] text-muted-foreground shrink-0">{{ c.hint }}</span>
    <span class="truncate text-muted-foreground">{{ c.description }}</span>
  </button>
  <button v-for="(c, i) in mentions" :key="c.path" @mousedown.prevent="applyMention(c)"
                  :class="['w-full text-left px-3 py-2 flex items-center gap-2 text-[13px] transition-colors',
                           i === mentionPick ? 'bg-muted' : 'hover:bg-muted/60']">
                  <span :class="['w-3.5 h-3.5 shrink-0 text-muted-foreground',
                                 c.kind === 'directory' ? 'icon-[lucide--folder]' : 'icon-[lucide--file-text]']" />
                  <span class="truncate">{{ c.path }}</span>
                </button>
              </div>

              <!-- 待发送的图片:发出去之前一直摆在这儿,点 × 撤掉 -->
              <div v-if="drafts.length" class="flex flex-wrap gap-2 px-4 pt-3">
                <div v-for="(d, k) in drafts" :key="k" class="relative">
                  <img :src="d.url" :alt="d.name" :title="d.name"
                    class="w-14 h-14 rounded-lg object-cover border border-border" />
                  <button @click="drafts = drafts.filter((_, n) => n !== k)"
                    class="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-background border border-border
                           flex items-center justify-center hover:bg-muted">
                    <span class="icon-[lucide--x] w-3 h-3" />
                  </button>
                </div>
              </div>
              <textarea ref="composerEl" v-model="input" @keydown="onKeydown" @input="onComposerInput"
                @paste="onComposerPaste" rows="1" :placeholder="t('agent.placeholder')"
                class="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed
                       placeholder:text-muted-foreground/60 focus:outline-none" />
              <div class="composer-bar">
                <button :title="t('agent.attach')" class="pill-icon" @click="pickImages">
                  <span class="icon-[lucide--plus] w-4 h-4" />
                </button>
                <!-- 和 DSH 一致:这是「开一段新的」,不是「把界面擦干净」——
                     旧会话仍在左边列表里,随时点回去 -->
                <!--
                  计划模式:开着的时候它先出方案、等你点头才动手。
                  做成常驻开关而不是藏进菜单 —— 这是「这一轮怎么跟我配合」,
                  和权限、模型一样每次都要一眼看得见。
                -->
                <button class="pill" :class="planOn ? 'pill-on' : ''"
                  :title="planOn ? t('agent.planModeOn') : t('agent.planModeOff')" @click="togglePlan">
                  <span class="icon-[lucide--list-checks] w-3.5 h-3.5" />
                  <span class="hidden @[30rem]:inline">{{ t('agent.planMode') }}</span>
                </button>
                <!-- 访问权限:原版的「工作区可写」下拉,背后是 /permission 命令 -->
                <Popover>
                  <PopoverTrigger as-child>
                    <button class="pill" :title="permissionLabel">
                      <span class="icon-[lucide--shield-check] w-3.5 h-3.5" />
                      <span class="hidden @[30rem]:inline">{{ permissionLabel }}</span>
                      <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" class="w-56 p-1">
                    <button v-for="pp in PERMISSION_PRESETS" :key="pp"
                      @click="selectPermission(pp)" :class="[
                        'w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors flex items-center gap-2',
                        currentPermission === pp ? 'bg-muted' : 'hover:bg-muted/60'
                      ]">
                      <span :class="[
                        'w-3.5 h-3.5 shrink-0',
                        pp === 'read-only' ? 'icon-[lucide--eye]'
                          : pp === 'workspace-write' ? 'icon-[lucide--shield-check]' : 'icon-[lucide--shield-alert]'
                      ]" />
                      <span class="flex-1">{{ t('agent.perm_' + pp) }}</span>
                      <span v-if="currentPermission === pp" class="icon-[lucide--check] w-3.5 h-3.5 shrink-0" />
                    </button>
                  </PopoverContent>
                </Popover>
                <!-- 上下文用量:有窗口大小才显示,不然一个没分母的数字没意义 -->
                <Popover v-if="ctx">
                  <PopoverTrigger as-child>
                    <button class="pill ml-auto" :class="ctxTone">
                      <span class="ctx-bar"><i :style="{ width: ctx.pct + '%' }" /></span>
                      {{ ctx.pct }}%
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-64 p-3">
                    <p class="text-xs font-medium">{{ t('agent.ctxUsed') }} {{ kilo(ctx.used) }} / {{ kilo(ctx.total) }}</p>
                    <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                      {{ t('agent.ctxDetail', {
                        sys: kilo(projections.breakdown.systemTokens),
                        tools: kilo(projections.breakdown.toolsTokens),
                        msg: kilo(projections.breakdown.messageTokens),
                      }) }}
                    </p>
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger as-child>
                    <button class="pill min-w-0" :class="ctx ? '' : 'ml-auto'" @click="loadModels"
                      :title="currentModelLabel">
                      <span class="truncate max-w-[9rem]" :class="models.routable ? '' : 'text-amber-500'">
                        {{ currentModelLabel }}
                      </span>
                      <span v-if="models.current?.reasoningEffort"
                        class="hidden @[34rem]:inline text-muted-foreground">
                        {{ models.current.reasoningEffort }}
                      </span>
                      <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60 shrink-0" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-72 p-1 max-h-80 overflow-y-auto">
                    <p v-if="!models.routable" class="px-2.5 py-2 text-xs text-amber-500 leading-relaxed">
                      {{ t('agent.notRoutable') }}
                    </p>
                    <p v-if="!models.options.length" class="px-2.5 py-3 text-xs text-muted-foreground text-center">
                      {{ models.loading ? '…' : t('agent.noModels') }}
                    </p>
                    <button v-for="m in models.options" :key="m.provider + '/' + m.model"
                      @click="selectModel(m.provider, m.model)" :class="[
                        'group w-full text-left rounded-md px-2.5 py-2 text-sm transition-colors',
                        m.provider === models.current?.provider && m.model === models.current?.model
                          ? 'bg-muted' : 'hover:bg-muted/60'
                      ]">
                      <div class="flex items-center gap-2">
                        <span class="truncate flex-1">{{ m.label }}</span>
                        <!--
                          设为默认:写进 DSH 设置(和原版设置页同一个开关),
                          以后每个新会话都用它。悬停才出现,免得每行都挂着字。
                        -->
                        <span @click.stop="setDefaultModel(m.provider, m.model)"
                          class="shrink-0 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground
                                 opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground
                                 transition-opacity cursor-pointer">
                          {{ t('agent.setDefault') }}
                        </span>
                      </div>
                      <div class="text-[11px] text-muted-foreground truncate">{{ m.provider }}</div>
                      <!-- 有推理强度档位的模型,把档位直接摊开,少一层点击 -->
                      <div v-if="m.reasoningOptions.length" class="flex flex-wrap gap-1 mt-1.5">
                        <span v-for="r in m.reasoningOptions" :key="r.id"
                          @click.stop="selectModel(m.provider, m.model, r.id)" :class="[
                            'px-1.5 py-0.5 rounded text-[10px] cursor-pointer transition-colors',
                            models.current?.model === m.model && models.current?.reasoningEffort === r.id
                              ? 'bg-foreground/15 text-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                          ]">{{ r.label }}</span>
                      </div>
                    </button>
                  </PopoverContent>
                </Popover>
                <button @click="send" :disabled="!input.trim()" :title="t('agent.send')" class="send-btn">
                  <span class="icon-[lucide--arrow-up] w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

    </section>

    <!-- 重命名 -->
    <AlertDialog :open="!!renameTarget" @update:open="(v: boolean) => { if (!v) renameTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('agent.renameTitle') }}</AlertDialogTitle>
        </AlertDialogHeader>
        <Input v-model="renameText" autofocus @keydown.enter="doRename" />
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doRename">{{ t('agent.rename') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 移除。文案不敢说「删除」—— DSH 只提供归档,日志还在磁盘上 -->
    <AlertDialog :open="!!archiveTarget" @update:open="(v: boolean) => { if (!v) archiveTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('agent.archiveTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('agent.archiveBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doArchive" class="bg-destructive text-white hover:bg-destructive/90">
            {{ t('agent.archive') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <RulesDialog />
    <NewProjectDialog v-model:open="newProjectOpen" :categories="categories" @create="createProject" />
  </div>
</template>

<style scoped>
/*
  输入框:两处用同一套样式(空态居中、对话态贴底),所以抽成类而不是重复一长串 utility。
  bg-background/40 而不是实心 —— 开云母/亚克力时能透出材质,关掉时看着也正常。
*/
.composer {
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--background) 40%, transparent);
  transition: border-color 160ms ease;
}
.composer:focus-within { border-color: color-mix(in srgb, var(--foreground) 24%, transparent); }

/*
  这一条按钮带里的响应式按**它自己的宽度**算,不是窗口宽度 ——
  正文栏一开,聊天区就窄了一半,窗口却没变。容器查询才是对的尺子。
*/
.composer-bar {
  container-type: inline-size;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem 0.5rem;
  /* 不许换行:一换行就会把「工作区可写」竖着码成一列 */
  flex-wrap: nowrap;
  overflow: hidden;
}

@keyframes xg-msg-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.msg-in { animation: xg-msg-in 200ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .msg-in { animation: none; } }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  height: 1.875rem;
  /* 挤不下时先缩自己,别把别人顶出去 */
  min-width: 0;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 0 0.625rem;
  border-radius: 0.625rem;
  font-size: 12.5px;
  color: var(--foreground);
  transition: background-color 140ms ease;
}
.pill:hover { background: color-mix(in srgb, var(--foreground) 7%, transparent); }
/* 开着的开关要一眼看出来:实心底色,和旁边那几个「点开才知道选了什么」的下拉区分开 */
.pill-on {
  background: color-mix(in srgb, var(--atomic-editor-accent, var(--foreground)) 16%, transparent);
  color: var(--foreground);
  border-color: color-mix(in srgb, var(--atomic-editor-accent, var(--foreground)) 40%, transparent);
}
.pill-on:hover { background: color-mix(in srgb, var(--atomic-editor-accent, var(--foreground)) 24%, transparent); }

/* 用量条:细细一根,和百分比并排。不用环形 —— 这一行里都是矮胖的药丸,圆环会显得突兀 */
.ctx-bar {
  display: inline-block;
  width: 26px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--foreground) 15%, transparent);
  overflow: hidden;
}
.ctx-bar > i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: currentColor;
  transition: width 200ms;
}

.pill-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.875rem;
  height: 1.875rem;
  border-radius: 0.625rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.pill-icon:hover { background: color-mix(in srgb, var(--foreground) 7%, transparent); color: var(--foreground); }

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.875rem;
  height: 1.875rem;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-foreground);
  transition: opacity 140ms ease;
}
.send-btn:disabled { opacity: 0.35; }

/*
  聊天里的 markdown 排版。

  尺寸整体比笔记页收一号:聊天是对话不是文章,行距字号都要更紧凑。
  v-html 渲染出来的节点不带 scoped 标记,所以整块都要 :deep()。
*/
.chat-md :deep(p) { margin: 0.4em 0; }
.chat-md :deep(p:first-child) { margin-top: 0; }
.chat-md :deep(p:last-child) { margin-bottom: 0; }
.chat-md :deep(h1), .chat-md :deep(h2), .chat-md :deep(h3), .chat-md :deep(h4) {
  font-weight: 600;
  line-height: 1.4;
  margin: 0.9em 0 0.35em;
}
.chat-md :deep(h1) { font-size: 1.25em; }
.chat-md :deep(h2) { font-size: 1.15em; }
.chat-md :deep(h3), .chat-md :deep(h4) { font-size: 1.05em; }
.chat-md :deep(ul), .chat-md :deep(ol) { margin: 0.4em 0; padding-left: 1.4em; }
.chat-md :deep(ul) { list-style: disc; }
.chat-md :deep(ol) { list-style: decimal; }
.chat-md :deep(li) { margin: 0.15em 0; }
.chat-md :deep(li > p) { margin: 0; }
.chat-md :deep(code) {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 0.86em;
}
.chat-md :deep(pre) {
  background: color-mix(in srgb, var(--foreground) 5%, transparent);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.75em 0.9em;
  margin: 0.5em 0;
  overflow-x: auto;
}
.chat-md :deep(pre code) { background: none; padding: 0; font-size: 0.82em; }
.chat-md :deep(blockquote) {
  border-left: 3px solid var(--border);
  padding-left: 0.9em;
  margin: 0.5em 0;
  color: var(--muted-foreground);
}
.chat-md :deep(a) { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.chat-md :deep(hr) { border: none; border-top: 1px solid var(--border); margin: 0.9em 0; }
.chat-md :deep(table) { border-collapse: collapse; margin: 0.5em 0; font-size: 0.92em; }
.chat-md :deep(th), .chat-md :deep(td) { border: 1px solid var(--border); padding: 0.3em 0.6em; text-align: left; }
.chat-md :deep(th) { background: color-mix(in srgb, var(--foreground) 5%, transparent); }
</style>
