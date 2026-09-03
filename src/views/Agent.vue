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
import { ref, reactive, nextTick, computed, onBeforeUnmount, onMounted, watch, useTemplateRef } from 'vue'
import { useI18n } from '@/i18n'
import { settings, AGENT_SIDEBAR, AGENT_DOC } from '@/composables/useAppSettings'
import { renderChatMd, onChatLinkClick } from '@/composables/useChatMarkdown'
import { dsh, initDsh, installDsh, refreshDsh, startDsh, stopDsh, resetRevive } from '@/composables/useDsh'
import {
  chat, chatReady, connectChat, newSession, sendPrompt,
  sessions, loadSessions, openSession, pinned, togglePin, renameSession, archiveSession,
  sessionSearch, searchSessions,
  models, loadModels, selectModel, setDefaultModel, currentModelLabel, type SessionRow,
  presets, loadPresets, selectPreset,
  projections, togglePlan, commands, runCommand,
  workspaces, loadWorkspaces, addWorkspace,
  permission, selectPermission, PERMISSION_PRESETS,
  type ChatFile,
} from '@/composables/useDshChat'
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from '@/components/ui/popover'
import DshBoot from '@/components/DshBoot.vue'
import {
  activeAtToken, formatFileMention, listFileReferences,
  draftFromBytes, mediaTypeOf, IMAGE_EXTS,
  isBigPaste, textDraftFrom, attachmentBlock,
  type FileCandidate, type Draft, type TextDraft,
} from '@/composables/dshCompose'
import { invoke } from '@tauri-apps/api/core'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import PendingCard from '@/components/agent/PendingCard.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import RulesDialog from '@/components/agent/RulesDialog.vue'
import { openRules } from '@/composables/useAgentRules'
import { vault } from '@/composables/useVault'
import {
  projects, currentProject, grouped,
  loadProjects, addProject, updateProject, removeProject,
  addCategory, renameCategory, removeCategory, toggleCategory,
} from '@/composables/useProjects'
import NewProjectDialog from '@/components/agent/NewProjectDialog.vue'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import ProjectFiles from '@/components/agent/ProjectFiles.vue'
import SessionItem from '@/components/agent/SessionItem.vue'
import SkillsDialog from '@/components/agent/SkillsDialog.vue'
import SyncProjectsDialog from '@/components/agent/SyncProjectsDialog.vue'
import InfoTip from '@/components/InfoTip.vue'
import ProjectItem from '@/components/agent/ProjectItem.vue'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { skills, type Skill } from '@/composables/useSkills'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { open as openExternal } from '@tauri-apps/plugin-shell'

const { t } = useI18n()




onMounted(async () => {
  nextTick(autoGrow)
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

/*
  引擎那盏灯搬去窗口右上角了(TitleBar.vue,和三颗控制点并排)。
  判断在 useDshStatus 里,这一页不再自己写一份 —— 两份迟早说岔。
*/

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

/**
 * 上下的淡出。
 *
 * **用遮罩,不是盖一层渐变色。** 盖颜色那版当场翻车:云母/亚克力材质下,
 * 卡片的底本身是半透明的,而渐变刷的是一个实色 —— 于是上下各出现一道
 * 又黑又脏的横带,和周围完全不是一个东西。
 *
 * 遮罩是让**内容本身**淡成透明,底下透出来的还是卡片原来的材质,
 * 所以换材质、换主题、换不透明度都不用管。
 *
 * 底部淡出的位置跟着输入框的实际高度走 —— 输入框长高了,淡出也要跟着上移,
 * 否则文字会在框沿上被硬生生切一刀。
 */
const chatMask = computed(() =>
  `linear-gradient(to bottom, transparent 0, #000 36px,`
  + ` #000 calc(100% - ${composerH.value + 40}px),`
  + ` transparent calc(100% - ${composerH.value - 4}px))`)

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

/*
  ── 聊天和正文之间那条把手 ──

  这两栏里**总有一栏是定宽的**:谁在中间谁铺满,靠右那一栏定宽(见 docCenter)。
  所以拖的永远是「靠右那一栏」,存的也是这一个数 —— 换边之后拖的还是它,
  不用为两栏各存一份宽度(存两份的话,换一次边宽度就跳一下)。

  往右拖 = 右边那栏变窄,所以是减号。
*/
const docDragging = ref(false)

/**
 * 三栏真正能分的宽度。
 *
 * **不能直接拿 clientWidth** —— 这个容器自己带着 78px 的左内边距(给导航栏让位)
 * 和 10px 的右内边距,而 clientWidth 是**含内边距**的。照它算,上限会宽出 88px,
 * 于是能把对话拖到比下限还窄:输入框那排按钮被切掉一半,发送键直接跑到框外面。
 * 实测踩过。
 */
function rowWidth() {
  const el = rootEl.value
  if (!el) return 9999
  const cs = getComputedStyle(el)
  return el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0')
}

/**
 * 靠右那一栏的下限。
 *
 * **对话那一栏永远要够 460** —— 输入框那排按钮就是这么宽,再窄发送键就跑到框外面。
 * 而对话有时在中间(铺满,不受这个数管)、有时靠右(定宽 = 这个数),
 * 所以下限得跟着换边一起变。写死一个 320 的话,一换成「正文在中间」,
 * 对话被压到三百多,按钮当场被切掉。踩过。
 */
function minDocWidth() {
  return docCenter.value ? AGENT_SIDEBAR.minChat : AGENT_DOC.min
}

function maxDocWidth() {
  // 两条把手各 10px
  const room = rowWidth() - settings.agentSidebarWidth - 20 - AGENT_DOC.minChat
  return Math.max(minDocWidth(), Math.min(AGENT_DOC.max, room))
}

function onDocDragStart(e: PointerEvent) {
  docDragging.value = true
  const startX = e.clientX
  const startW = settings.agentDocWidth
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)

  const move = (ev: PointerEvent) => {
    const w = startW - (ev.clientX - startX)
    settings.agentDocWidth = Math.round(Math.min(maxDocWidth(), Math.max(minDocWidth(), w)))
  }
  const up = (ev: PointerEvent) => {
    docDragging.value = false
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
  const d = maxDocWidth()
  if (settings.agentDocWidth > d) settings.agentDocWidth = d
  const lo = minDocWidth()
  if (settings.agentDocWidth < lo) settings.agentDocWidth = Math.min(lo, d)
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

/*
  权限图标要跟着档位变。

  窄的时候这颗药丸**只剩一个图标**,图标再不变就完全看不出现在是哪一档 ——
  「只读」和「完全访问」长一个样,那是危险的:用户以为自己在只读里,
  其实它能改任何文件。眼睛 = 只读,盾牌 = 工作区可写,带感叹号的盾 = 完全访问。
*/
const permIcon = computed(() =>
  currentPermission.value === 'read-only' ? 'icon-[lucide--eye]'
  : currentPermission.value === 'workspace-write' ? 'icon-[lucide--shield-check]'
  : 'icon-[lucide--shield-alert]')

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

/*
  ── 每篇会话看到哪儿了 ──

  两件事,规矩不一样:

  · **头一回打开一篇**:落到最底下。聊天是从上往下长的,最新那句在最末尾 ——
    打开停在开头,等于让人从头翻到尾才看得到刚聊到哪儿。
  · **看过之后又切回来**:回到上次停的地方。人离开时正盯着中间某一段,
    回来被扔到别处,那一段就得重新找。

  **存的是「离底部多远」,不是绝对位置。** 存绝对位置踩过坑:切会话的一瞬间内容
  还没渲染出来,量到的 scrollTop 是 0,存下来之后每次回来都被送回顶部 ——
  而「0」在这套算法里恰好又是合法值,看不出是坏数据。离底部的距离没这个毛病:
  内容没渲染时距离是 0,而 0 的含义正好是「贴着底」,和我们想要的默认一致。

  表放在模块级(不是组件里):离开笔记页再回来时整个组件会重建,
  存在组件里的东西那时候就没了。
*/
const chatScroll = new Map<string, number>()

/*
  **只记「他自己滚过」的那些会话。**

  一开始是不管三七二十一都记,结果掉进一个自我循环:某次定位没成功、停在了顶部,
  这个「顶部」被当成他的意愿记了下来,以后每次回来都送他去顶部,再记一次顶部……
  越陷越深,而且从数据上看不出是坏的 —— 顶部本来就是合法位置。

  分辨的办法很简单:滚轮、触摸、按键翻页才算「他自己滚的」;我们代码里设的
  scrollTop 不触发这些。没滚过就说明他没表达过意愿,那就按默认来 —— 落到最新那条。
*/
const userScrolled = new Set<string>()

/** 离底部还有多远。贴着底就是 0 */
function bottomGap(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
}

function rememberChatScroll() {
  const el = listEl.value
  if (el && chat.sessionId && userScrolled.has(chat.sessionId)) {
    chatScroll.set(chat.sessionId, bottomGap(el))
  }
}

/** 他自己动手滚了。记下来,以后回到这一篇就还他这个位置 */
function onUserScroll() {
  if (chat.sessionId) userScrolled.add(chat.sessionId)
}

/**
 * 换会话之后落到该落的位置。
 *
 * **要多试几次。** 消息是分批渲染出来的:先出骨架,markdown 排完版之后高度还会再长。
 * 只在第一帧设一次的话,那时候 scrollHeight 还是个小数字,设了等于没设。
 * 中途用户自己滚了就立刻收手 —— 他已经知道要看哪儿了,再抢就是跟他打架。
 */
function restoreChatScroll(sessionId: string) {
  const gap = chatScroll.get(sessionId) ?? 0
  let last = -1
  let userMoved = false
  const onWheel = () => { userMoved = true }

  const step = (attempt: number) => {
    if (chat.sessionId !== sessionId || userMoved) return
    const el = listEl.value
    /*
      这一栏可能还没挂上来:切会话的一瞬间界面处在「空态」那一支,
      滚动容器根本不存在。这时候不能直接放弃,等下一轮再来。
    */
    if (!el) {
      if (attempt < 8) setTimeout(() => step(attempt + 1), 120)
      return
    }
    el.addEventListener('wheel', onWheel, { passive: true, once: true })
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - gap)
    if (attempt < 6 && el.scrollHeight !== last) {
      last = el.scrollHeight
      setTimeout(() => step(attempt + 1), attempt === 0 ? 60 : 160)
    } else {
      el.removeEventListener('wheel', onWheel)
    }
  }
  requestAnimationFrame(() => step(0))
}

/*
  会话一换就记下旧的、定位新的。
  用 watch 而不是写在点击处理里:会话也可能从别处被切走(命令面板、新建),
  盯着值本身才不会漏。
*/
watch(() => chat.sessionId, (now, before) => {
  const el = listEl.value
  if (el && before && userScrolled.has(before)) chatScroll.set(before, bottomGap(el))
  if (now) restoreChatScroll(now)
})

// 读完历史内容才真的铺开,这时候再定位一次才准
watch(() => chat.loadingHistory, (loading) => {
  if (!loading && chat.sessionId) restoreChatScroll(chat.sessionId)
})

// 离开这一页时也记一笔 —— 切去笔记页再回来,位置还在
onBeforeUnmount(rememberChatScroll)

async function send() {
  const text = input.value.trim()
  if (!text && !drafts.value.length && !textDrafts.value.length) return

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
  const files = textDrafts.value.map((d) => ({ name: d.name, text: d.text, block: attachmentBlock(d) }))
  input.value = ''
  drafts.value = []
  textDrafts.value = []
  if (panel.value?.id.startsWith('paste:')) panel.value = null
  closeMentions()
  nextTick(autoGrow)
  await sendPrompt(text, images, files)
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
/**
 * 输入框跟着内容长。
 *
 * 底线两行(一行太窄,一眼看不到自己在写什么),封顶五行(再长就自己滚,
 * 不然一篇长提示词能把半屏对话顶没)。行高按 15px 字号 × 1.625 算。
 */
/**
 * 输入框实际占了多高 —— 列表的下内边距要照着它留。
 *
 * 不能写死:挂了几张图、贴了几个附件条、打到第五行,它能从 100 长到 260。
 * 写死的话最后一条消息会缩在输入框后面,滚到底也看不全 —— 而这恰恰是
 * 你最想看的那一条。所以量着来。
 */
const composerBox = useTemplateRef<HTMLElement>('composerBox')
const composerH = ref(110)
let composerRO: ResizeObserver | null = null

watch(composerBox, (el) => {
  composerRO?.disconnect()
  if (!el) return
  composerRO = new ResizeObserver(() => { composerH.value = el.offsetHeight })
  composerRO.observe(el)
  composerH.value = el.offsetHeight
}, { immediate: true })

onBeforeUnmount(() => composerRO?.disconnect())

const COMPOSER_LINE = 24
const COMPOSER_MIN = COMPOSER_LINE * 2
const COMPOSER_MAX = COMPOSER_LINE * 5

function autoGrow() {
  const el = composerEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN), COMPOSER_MAX)}px`
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

/**
 * 粘贴。两种东西会被接住:
 *  · 图片 —— 截了图直接 Ctrl+V 是最顺手的一条路
 *  · 大段文本 —— 收成一个附件条,不让它把输入框顶成一屏
 *
 * 其余情况一律不拦,让浏览器照常粘进去 —— 粘一个网址、一句报错、
 * 两三行日志,那本来就是要打的字的一部分。
 */
async function onComposerPaste(e: ClipboardEvent) {
  const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (imgs.length) {
    e.preventDefault()
    for (const f of imgs) {
      const name = f.name || `pasted.${(f.type.split('/')[1] ?? 'png')}`
      if (!mediaTypeOf(name)) continue
      const d = draftFromBytes(name, new Uint8Array(await f.arrayBuffer()))
      if (d) drafts.value = [...drafts.value, d]
    }
    return
  }

  const text = e.clipboardData?.getData('text/plain') ?? ''
  if (!isBigPaste(text)) return
  e.preventDefault()
  textDrafts.value = [...textDrafts.value, textDraftFrom(text, textDrafts.value.length + 1)]
}

// ── 文本附件 ──────────────────────────────────────────

const textDrafts = ref<TextDraft[]>([])

/** 图标按猜出来的类型换 —— 一眼分得清哪个是代码哪个是文档 */
function draftIcon(d: TextDraft) {
  return d.kind === 'code' ? 'icon-[lucide--file-code]'
       : d.kind === 'md' ? 'icon-[lucide--file-text]'
       : 'icon-[lucide--file]'
}

function dropTextDraft(id: string) {
  textDrafts.value = textDrafts.value.filter((d) => d.id !== id)
  // 正在正文栏看的就是它,一起收掉,免得看着一份已经不存在的材料
  if (panel.value?.id === `paste:${id}`) panel.value = null
}

/** 点附件条:在正文栏摊开。能改 —— 贴进来的东西常常要先删掉一半再发 */
function viewTextDraft(d: TextDraft) {
  docPath.value = ''
  panel.value = {
    id: `paste:${d.id}`,
    title: d.name,
    text: d.text,
    plain: d.kind !== 'md',
    // 改哪儿算哪儿,没有「保存」这一步 —— 这东西还没落盘,发出去之前它就是草稿本身
    sync: (next: string) => { d.text = next },
  }
}

// ── 搜索与筛选 ──
const searchOpen = ref(false)
const sessionSearchInput = useTemplateRef<HTMLInputElement>('sessionSearchInput')

/**
 * 点到别处就把搜索框收回去。
 *
 * **只在没打字的时候收**:打了字还收的话,结果列表跟着消失 ——
 * 而你多半正要去点其中一条。空框留着只是白占一行,收掉才对。
 */
function onSearchBlur() {
  if (!sessionSearch.query.trim()) searchOpen.value = false
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  // 开了就直接能打 —— 点了放大镜还要再点一下框才能输入，谁都会觉得没反应
  if (searchOpen.value) nextTick(() => sessionSearchInput.value?.focus())
  // 关掉就清空,免得下次打开还留着上次的词
  if (!searchOpen.value) searchSessions('')
}
/** 搜索结果只带 sessionId 和片段,标题要从列表里查回来 */
const titleOf = (id: string) =>
  sessions.rows.find((x) => x.sessionId === id)?.title || t('agent.untitled')

// ── 会话排序与操作 ──

/**
 * 「聊天」这一页只列**还没立成项目**的对话。
 *
 * 一个项目就是一次对话，它已经有自己的位置了（在项目里）。
 * 两边都列一遍的话，「立不立成项目」就没有任何区别 —— 那这个功能等于白做。
 */
const looseSessions = computed(() => {
  const taken = new Set(projects.items.map((p) => p.sessionId).filter(Boolean))
  return sessions.rows.filter((s) => !taken.has(s.sessionId))
})

/** 置顶的排前面,组内各自按时间倒序 */
const sortedSessions = computed(() => {
  const set = new Set(pinned.ids)
  const rows = looseSessions.value
  const top = rows.filter((s) => set.has(s.sessionId))
  const rest = rows.filter((s) => !set.has(s.sessionId))
  return [...top, ...rest]
})

/**
 * 会话列表切成「置顶」和「闲聊」两区。
 *
 * 一个都没置顶的时候不画标题 —— 那会变成一个只有一区却顶着「闲聊」两个字的列表,
 * 白占一行还让人以为另一区藏在哪儿。
 */
const sessionGroups = computed(() => {
  const set = new Set(pinned.ids)
  const top = sortedSessions.value.filter((s) => set.has(s.sessionId))
  const rest = sortedSessions.value.filter((s) => !set.has(s.sessionId))
  const groups: { key: 'pinned' | 'casual'; items: SessionRow[]; showLabel: boolean }[] = []
  if (top.length) groups.push({ key: 'pinned', items: top, showLabel: true })
  if (rest.length) groups.push({ key: 'casual', items: rest, showLabel: top.length > 0 })
  return groups
})

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

/*
  下拉的开合自己管。

  选完一项之后菜单该收起来 —— 这是所有下拉的常识,但组件库默认不收
  (它不知道你这一项算不算「选完了」)。所以每个下拉挂一个开关,
  点了就关。空态和会话态那两套下拉不会同时存在,可以共用同一个开关。
*/
const wsOpen = ref(false)
/** 项目内那两颗：换项目、本项目设置 */
const projSwitchOpen = ref(false)
const projCfgOpen = ref(false)
/** 新建项目类 */
const newCatOpen = ref(false)
const presetOpen = ref(false)
const permOpen = ref(false)
const modelOpen = ref(false)

/**
 * 工作台只剩两页。
 *
 * 以前还有一页「当前项目」—— 那是第三层：选类、选项目、再选一个子页签才
 * 摸得到内容。现在点项目就直接进去，左栏整个换成它的文件树，不再多一站。
 */
const SIDE_TABS = ['chat', 'projects'] as const

const sideTab = ref<(typeof SIDE_TABS)[number]>('chat')

// Teleport 的目标在 TitleBar 里。挂载完成前先禁用，免得目标还没进 DOM 就找不到
const teleportReady = ref(false)
onMounted(() => { teleportReady.value = true })

/** 点顶上那两个页签。点「项目」时退出当前项目 —— 他要的就是回到列表 */
function pickTab(tb: (typeof SIDE_TABS)[number]) {
  if (tb === 'projects' && sideTab.value === 'projects') projects.currentId = ''
  sideTab.value = tb
}
const newProjectOpen = ref(false)

/** 进一个项目:记住它,并且直接跳到「当前项目」的文件页 —— 进来就是要看这个项目的东西 */
/**
 * 进一个项目。
 *
 * 一个项目就是一次对话 —— 进去就接着上回聊；还没聊过就现开一个，
 * 并且把它记在项目上（不记的话下次进来又是一张白纸）。
 * 工作目录跟着项目的文件夹走，模型才会在对的范围里干活。
 */
async function enterProject(id: string) {
  const pr = projects.items.find((x) => x.id === id)
  if (!pr) return
  projects.currentId = id
  sideTab.value = 'projects'
  closeDoc()
  if (pr.sessionId) {
    if (pr.sessionId !== chat.sessionId) await openSession(pr.sessionId)
    return
  }
  await newSession(pr.folder || undefined)
  if (chat.sessionId) await updateProject(id, { sessionId: chat.sessionId })
}

/** 退回项目列表。对话不动 —— 只是左栏换回列表 */
function leaveProject() {
  projects.currentId = ''
  closeDoc()
}

// ── 正文栏 ────────────────────────────────────────────
//
// 工作台是「AI 干活、我看结果」,所以正文和对话并排。哪个在中间由用户定 ——
// 有人想盯着文件改,有人几乎只说话。

/** 当前在正文栏里打开的文件(项目内相对路径),空 = 还没开 */
const mdEditor = ref<{ selectedLines?: () => { from: number; to: number; empty: boolean } | null } | null>(null)
const docPath = ref('')
const docText = ref('')
const docSaving = ref(false)

/*
  正文栏不止能开项目里的文件。

  贴进来的材料、技能库里的一份 SKILL.md —— 这些都不在项目文件夹里(技能在
  ~/.dsh/skills,材料压根还没落盘),`vault_read`/`vault_write` 那条路走不通。
  与其为它们各做一个查看器,不如让正文栏收一份「随便什么文本」:
  给标题、给内容、给一个「保存」的做法,存去哪它自己知道。

  `save` 可以没有 —— 没有就是只能看,那一栏的保存按钮跟着消失,
  而不是摆一个按了没反应的按钮。
*/
type SidePanel = {
  id: string
  title: string
  text: string
  /**
   * 按纯文本显示,不当 markdown 渲染。
   *
   * 代码走 markdown 渲染器会被改得面目全非:`s.history[i]` 被认成链接、
   * `${x}` 被认成强调,看着就像贴进来的东西已经烂了 —— 而它一个字都没变。
   */
  plain?: boolean
  /** 有「保存」这一步的(落盘的文件)。没有就不画那个按钮 */
  save?: (text: string) => Promise<void>
  /** 边改边同步(还没落盘的草稿)。改完不用按任何东西 */
  sync?: (text: string) => void
}
const panel = ref<SidePanel | null>(null)

/** 正文栏开着没有 —— 项目文件和外来内容共用这一栏,同一时刻只有一个 */
const docOpen = computed(() => !!docPath.value || !!panel.value)
const docTitle = computed(() => panel.value?.title ?? docPath.value)
const docKey = computed(() => panel.value?.id ?? docPath.value)
const canSaveDoc = computed(() => (panel.value ? !!panel.value.save : !!docPath.value))

/** 编辑器绑这一个:开着哪一种就读写哪一种,编辑器本身不用知道有两种 */
const docBody = computed<string>({
  get: () => panel.value?.text ?? docText.value,
  set: (v) => {
    if (!panel.value) { docText.value = v; return }
    panel.value.text = v
    panel.value.sync?.(v)
  },
})

function closeDoc() {
  docPath.value = ''
  panel.value = null
}

/** 点旧消息里的材料条:在正文栏摊开。这份已经发出去了,只能看不能改 */
function viewChatFile(f: ChatFile) {
  docPath.value = ''
  panel.value = {
    id: `sent:${f.name}:${f.text.length}`,
    title: f.name,
    text: f.text,
    plain: !f.name.toLowerCase().endsWith('.md'),
  }
}

// ── 技能库 ────────────────────────────────────────────

const skillsOpen = ref(false)

/**
 * 改完技能目录重启边车。
 *
 * 目录名单是**启动时**读进去的,不重启改了也不算数。不自动重启是因为
 * 你可能正聊到一半 —— 掐掉重连很讨厌,什么时候重启该你说了算。
 */
async function restartEngine() {
  skillsOpen.value = false
  skills.needsRestart = false
  await stopDsh()
  resetRevive()
  await startDsh()
}

/**
 * 在正文栏打开一份技能,并且能改完直接存回去。
 *
 * 技能就是一份 md,没道理还要切去别的软件改 —— 尤其是「这条规则写得不对」
 * 这种当场想改的时候。
 */
function openSkill(sk: Skill) {
  skillsOpen.value = false
  docPath.value = ''
  panel.value = {
    id: `skill:${sk.path}`,
    title: sk.name,
    text: '',
    save: async (next: string) => { await writeTextFile(sk.path, next) },
  }
  void (async () => {
    // 技能不在项目文件夹里,走不了 vault_read 那条路(它只认工作区内的相对路径)
    try {
      const md = await readTextFile(sk.path)
      if (panel.value?.id === `skill:${sk.path}`) panel.value.text = md
    } catch (e) {
      if (panel.value?.id === `skill:${sk.path}`) panel.value.text = String(e)
    }
  })()
}

/** 正文在中间还是对话在中间。项目里定了就听项目的,没定跟全局 */
const docCenter = computed(() =>
  (currentProject.value?.layout ?? settings.agentLayout) === 'doc-center')

/*
  存档里的宽度也要收一次 —— 可能是在更大的窗口上拖出来的。

  **不能只在 onMounted 收**:设置是异步读回来的,挂载那一刻手里还是默认值
  (默认值当然不超标),读回来的大数值随后直接盖上去,等于没收。踩过:
  从大屏切回小屏,对话区被挤成一条缝,输入框那排按钮一半在框外面。
  盯着值本身才不会漏。
*/
watch(() => [settings.agentDocWidth, settings.agentSidebarWidth, docCenter.value],
  () => nextTick(clampToWindow), { immediate: true })

function swapPanes() {
  const next = docCenter.value ? 'chat-center' : 'doc-center'
  const cur = currentProject.value
  // 在项目里改就只改这个项目;不在项目里就改全局默认
  if (cur) void updateProject(cur.id, { layout: next })
  else settings.agentLayout = next
}

/**
 * 把一段话引进输入框:`@路径#行号`。
 *
 * 只写位置,不把正文抄进来 —— 抄进来的话输入框会被一大段原文塞满,
 * 而且模型拿到的是一份**快照**:你随后改了文件,它手里那份还是旧的。
 * 给位置,它自己去读,读到的永远是当下的。
 */
function quoteIntoComposer(rel: string, from: number, to: number) {
  const at = from === to ? `#${from}` : `#${from}-${to}`
  const path = /\s/.test(rel) ? `@"${rel}"${at}` : `@${rel}${at}`
  const cur = input.value
  input.value = cur && !cur.endsWith(' ') ? `${cur} ${path} ` : `${cur}${path} `
  nextTick(() => { composerEl.value?.focus(); autoGrow() })
}

/**
 * Alt+K —— 在正文栏里刮选一段,把它的位置送进输入框。
 *
 * 为什么是这条路而不是「点文件插引用」:你想让它看的多半是文件里的**某一处**,
 * 不是整篇。点一下就该打开来看(和在 VSCode 里点文件一样),
 * 要引用再刮选、按快捷键 —— 两个动作各归各的,不用先猜「这一下会发生什么」。
 */
function onDocKeydown(e: KeyboardEvent) {
  if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'k' && e.key !== 'K')) return
  const rel = docPath.value
  if (!rel) return
  const sel = mdEditor.value?.selectedLines?.()
  if (!sel) return
  e.preventDefault()
  quoteIntoComposer(rel, sel.from, sel.to)
}

/** 双击文件:在正文栏打开 */
async function openProjectFile(rel: string) {
  const root = currentProject.value?.folder
  if (!root) return
  try {
    docText.value = await invoke<string>('vault_read', { root, rel })
    panel.value = null      // 这一栏一次只放一样东西
    docPath.value = rel
  } catch (e) {
    chat.items.push({ kind: 'notice', id: `d${Date.now()}`, text: String(e) })
  }
}

/** 正文改了就存回去。这一栏是能改的 —— 看见不对随手就改,不用切去笔记页 */
async function saveDoc() {
  docSaving.value = true
  try {
    if (panel.value?.save) await panel.value.save(panel.value.text)
    else {
      const root = currentProject.value?.folder
      if (!root || !docPath.value) return
      await invoke('vault_write', { root, rel: docPath.value, content: docText.value })
    }
  } catch (e) {
    chat.items.push({ kind: 'notice', id: `d${Date.now()}`, text: String(e) })
  } finally {
    docSaving.value = false
  }
}

/**
 * 开一个新会话。
 *
 * 在项目里开的**自动归到这个项目** —— 人在项目里按新会话,意思就是
 * 「接着这件事再聊一轮」,还要他事后再右键归一次,等于让他替我们记账。
 */
async function startSession() {
  const inProject = currentProject.value
  await newSession(inProject?.folder || undefined)
  // 项目就是一次对话，在项目里开新的 = 把它换成这一次
  if (inProject && chat.sessionId) await updateProject(inProject.id, { sessionId: chat.sessionId })
}

/**
 * 把一次随手聊立成一个项目。
 *
 * 名字直接用会话标题 —— 那本来就是模型根据你第一句话起的，
 * 比再弹一个框让你想名字实在。不满意进去改。
 */
async function promoteSession(row: SessionRow, categoryId: string) {
  const it = await addProject({
    categoryId,
    name: row.title || t('agent.untitled'),
    icon: '📁',
    folder: '',
    sessionId: row.sessionId,
  })
  await enterProject(it.id)
}

/** 建好就直接进去 —— 人建项目就是为了开始干这件事，不该建完还停在列表上 */
async function createProject(p: { name: string; icon: string }) {
  const it = await addProject({
    categoryId: newProjectCat.value,
    name: p.name,
    icon: p.icon,
    folder: '',
    sessionId: '',
  })
  await enterProject(it.id)
}

// ── 项目页的搜索 ──
const projSearchOpen = ref(false)
const projQuery = ref('')
const projSearchInput = useTemplateRef<HTMLInputElement>('projSearchInput')

function toggleProjSearch() {
  projSearchOpen.value = !projSearchOpen.value
  if (projSearchOpen.value) nextTick(() => projSearchInput.value?.focus())
  else projQuery.value = ''
}

/** 和会话搜索一个规矩：只在没打字的时候收 —— 打了字还收，结果就跟着没了 */
function onProjSearchBlur() {
  if (!projQuery.value.trim()) projSearchOpen.value = false
}

/**
 * 过滤后的分组。
 *
 * 类名对得上就整类留下（你搜「财务」是想看财务下面所有项目）；
 * 否则只留名字对得上的项目，空掉的类不画 —— 一排只剩标题的空类比没搜到还乱。
 */
const shownGroups = computed(() => {
  const q = projQuery.value.trim().toLowerCase()
  if (!q) return grouped.value
  return grouped.value
    .map((g) => (g.cat.name.toLowerCase().includes(q)
      ? g
      : { ...g, items: g.items.filter((p) => p.name.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length)
})

/*
  ── 改名 ──

  项目类和项目共用一个对话框(名字 + 图标),靠 `kind` 分辨改的是谁。
  **图标也能重挑** —— 名字和图标一起构成「这是哪个」,只让改一半的话,
  图标就永远钉在建的那天随手点的那个上。
*/
const edit = reactive({ open: false, kind: '' as '' | 'cat' | 'project', id: '', name: '', icon: '' })

function startRenameCat(cat: { id: string; name: string; icon: string }) {
  Object.assign(edit, { open: true, kind: 'cat', id: cat.id, name: cat.name, icon: cat.icon || '📁' })
}

function startEditProject(pr: { id: string; name: string; icon: string }) {
  Object.assign(edit, { open: true, kind: 'project', id: pr.id, name: pr.name, icon: pr.icon || '📁' })
}

async function doEdit(v: { name: string; icon: string }) {
  if (!edit.id) return
  if (edit.kind === 'cat') await renameCategory(edit.id, v.name, v.icon)
  else await updateProject(edit.id, { name: v.name, icon: v.icon })
  edit.id = ''
}

// ── 删项目 ──
/*
  和上面归档那处一样的坑,原样照办:**要删的对象自己留一份快照,不能等点确认时再读 ref。**

  AlertDialogAction 被点中时会先把弹窗关掉,关闭触发 @update:open 把 delTarget 清成 null ——
  这件事发生在按钮自己的 @click **之前**。于是 doDeleteProject 拿到 null 直接 return,
  表现就是「点了删除,什么都没发生」。写的时候忘了这条,又踩了一遍。
*/
const delTarget = ref<{ id: string; name: string } | null>(null)
let pendingDelete: { id: string; name: string } | null = null

function askDeleteProject(pr: { id: string; name: string }) {
  pendingDelete = { id: pr.id, name: pr.name }
  delTarget.value = pendingDelete
}

async function doDeleteProject() {
  const t = pendingDelete
  pendingDelete = null
  delTarget.value = null
  if (t) await removeProject(t.id)
}

// ── 同步别家的项目 ──
const syncOpen = ref(false)

/**
 * 把别家的项目接过来：**建一个指向同一个文件夹的项目**，不复制任何东西。
 *
 * 默认放进「未分类」——归到哪一类是他的事，我们猜不准，
 * 猜错了他还得先找到它再挪一次。
 */
async function linkExternal(ex: { path: string; name: string }) {
  syncOpen.value = false
  const it = await addProject({
    categoryId: '',
    name: ex.name,
    icon: '📁',
    folder: ex.path,
    sessionId: '',
  })
  await enterProject(it.id)
}

/**
 * 把别家的**一次会话**接过来 —— 一个会话就是一个项目。
 *
 * 同一个工作区底下可以并排放好几个：`c:\XGCode` 里既有「改 XGTools」，
 * 也有「弄视频生成」。所以这里不看文件夹重不重，只记住它是从哪一次会话来的
 * （`originId`）—— 判重按会话，不按文件夹。
 */
async function linkExternalSession(s: { id: string; title: string; cwd: string }) {
  syncOpen.value = false
  const it = await addProject({
    categoryId: '',
    name: s.title,
    icon: '💬',
    folder: s.cwd,
    sessionId: '',
    originId: s.id,
  })
  await enterProject(it.id)
}

/** 在哪个类下新建项目 */
const newProjectCat = ref('')
function startNewProject(catId: string) {
  newProjectCat.value = catId
  newProjectOpen.value = true
}

async function createCategory(name: string, icon: string) {
  const c = await addCategory(name, icon)
  if (c) projects.collapsed = { ...projects.collapsed, [c.id]: false }
}

/**
 * 树里新建。
 *
 * 名字走项目自己的输入框(不用系统弹窗 —— 这个应用里不出现原生弹窗)。
 * 建完把树重新挂一次(换 key)，否则新建的东西得手动收起再展开才看得见。
 */
const filesVersion = ref(0)
const newEntry = reactive({ open: false, isDir: false, name: '' })

function createInProject(isDir: boolean) {
  newEntry.isDir = isDir
  newEntry.name = ''
  newEntry.open = true
}

async function doCreateInProject() {
  const root = currentProject.value?.folder
  const name = newEntry.name.trim()
  if (!root || !name) return
  newEntry.open = false
  try {
    const rel = await invoke<string>('vault_create', { root, rel: name, isDir: newEntry.isDir })
    filesVersion.value++
    if (!newEntry.isDir) await openProjectFile(rel)
  } catch (e) {
    chat.items.push({ kind: 'notice', id: `d${Date.now()}`, text: String(e) })
  }
}

/**
 * 给这个项目挑一个文件夹。
 *
 * 两条路分开给:`vault` 直接从笔记库那儿开始翻,`disk` 从磁盘随便挑。
 * 合成一个按钮的话,想从笔记库里挑的人得在选择器里一层层找到笔记库 ——
 * 而那个路径他自己都未必记得。
 *
 * **换了文件夹,这个项目的对话要跟着换。** 会话的工作目录是**建的时候**定死的,
 * 改不了 —— 左边这棵文件树和右边那轮对话说的必须是同一个地方,不然模型看的
 * 和你看的不是一回事。所以换文件夹就用新目录重开一轮;
 * 旧的那轮不会丢,它回到「聊天」列表里。
 */
async function pickFolder(from: 'vault' | 'disk' = 'disk') {
  const cur = currentProject.value
  if (!cur) return
  const picked = await openFileDialog({
    directory: true,
    multiple: false,
    defaultPath: from === 'vault' && vault.root ? vault.root : undefined,
  })
  if (typeof picked !== 'string' || picked === cur.folder) return

  const hadSession = !!cur.sessionId
  await updateProject(cur.id, { folder: picked })
  filesVersion.value++
  closeDoc()

  await newSession(picked)
  if (chat.sessionId) await updateProject(cur.id, { sessionId: chat.sessionId })
  if (hadSession) {
    chat.items.push({ kind: 'notice', id: `w${Date.now()}`, text: t('agent.folderChanged') })
  }
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
    和其他页一样,从顶栏下面开始(78px = 10 外缩 + 58 栏高 + 10 间距)。

    以前这一页是顶到窗口最上沿的,为的是多要 68px 高度,然后在聊天区**内部**
    留一段空白躲开右上角那三颗控制点。躲得开的前提是「聊天永远在最右」——
    正文栏能换到右边之后这个前提就没了,那一栏的第一行直接被控制点压住。
    补丁只会越打越多(换边、开关正文栏都得重算),所以改成:顶上那一行谁都不占,
    左边 Logo、右边引擎状态 + 控制点,凑成一条完整的顶栏。
  -->
  <!--
    聊天 / 项目 —— 送去顶栏中间。

    为什么不留在侧栏里：这两个是**整页的两种状态**（随手聊 / 干一件事），
    不是侧栏自己的局部切换。而且顶上那一行本来就空着（左 Logo、右状态灯），
    放在那里既把行填满了，也把侧栏顶上那 40px 还给了列表。

    Teleport 只挪 DOM 位置，组件树不变，所以 sideTab 还是这一页自己的状态。
  -->
  <Teleport to="#titlebar-slot" :disabled="!teleportReady">
    <!--
      对齐侧栏：它管的就是左栏里装什么，站在侧栏正上方、同宽，
      才看得出这一层关系；放在窗口正中间的话它像是在管整个页面。

      68 = 页面左内边距i 78 减去 TitleBar 自己的 left-2.5（10）——
      定位基准是 TitleBar 根元素，不是插槽（插槽宽度是 0）。
      这三个数（10 / 58 / 78）是全局模数，改一个得三处一起改。
    -->
    <div class="float-card absolute h-[58px] rounded-[14px] border bg-card p-1.5 flex items-center gap-1"
      :style="{ left: '68px', width: settings.agentSidebarWidth + 'px' }">
      <button v-for="tb in SIDE_TABS" :key="tb" @click="pickTab(tb)" :class="[
        'flex-1 h-full rounded-[10px] text-[13px] transition-colors',
        sideTab === tb ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
      ]">{{ t('agent.side_' + tb) }}</button>
    </div>
  </Teleport>

  <div ref="rootEl" class="absolute inset-0 pt-[4.875rem] pl-[4.875rem] pr-2.5 pb-2.5 flex"
    :class="dragging || docDragging ? 'select-none' : ''">

    <!-- ═══════ 会话侧栏 ═══════ -->
    <aside :style="{ width: settings.agentSidebarWidth + 'px' }"
      class="float-card shrink-0 rounded-[14px] border bg-card flex flex-col overflow-hidden">

      <template v-if="sideTab === 'chat'">
      <!--
        顶上这一行整体 58，里面每颗是 44 的圆角方块 ——
        58 是全局模数（导航栏卡片宽、顶栏高都是它），44 是里面那个点击格子。
        两边各 7 的内边距把 44 垫成 58，这样它才和左边导航栏的图标横向对得上。

        搜索单独放左边，右边三颗是「对这一栏做点什么」；中间不再写「工作区」三个字 ——
        那三个字不告诉任何人任何事，位置留给搜索框展开。
      -->
      <div class="h-[58px] shrink-0 relative px-[7px] flex items-center">
        <button @click="toggleSearch" :title="t('agent.searchSessions')" :class="[
          'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors hover:bg-muted/60 hover:text-foreground',
          searchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
        ]">
          <span class="icon-[lucide--search] w-[18px] h-[18px]" />
        </button>

        <span class="flex-1" />

        <button @click="loadSessions" :title="t('agent.refreshSessions')" :disabled="sessions.loading"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--rotate-cw] w-[18px] h-[18px]" :class="sessions.loading ? 'animate-spin' : ''" />
        </button>
        <!--
          随手聊也要能配东西。以前规矩和技能只在项目里够得着，
          而这一页（不属于任何项目的对话）照样要守规矩、照样会用技能。
        -->
        <button @click="openRules('')" :title="t('agent.globalAgent')"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--scroll-text] w-[18px] h-[18px]" />
        </button>
        <button @click="skillsOpen = true" :title="t('agent.skills')"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--sparkles] w-[18px] h-[18px]" />
        </button>

        <!--
          展开态整个盖上去，不是把按钮挤走 —— 挤走会让这一行的宽度跳一下。
          底得是实的：底下就是那几颗按钮，半透明的话图标会从搜索框里透出来像鬼影。
          （和笔记页那个搜索框同一套做法。）
        -->
        <div v-if="searchOpen" class="absolute inset-x-[7px] top-1/2 -translate-y-1/2 h-11 rounded-xl bg-card">
          <span class="icon-[lucide--search] w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 z-10
                       text-muted-foreground pointer-events-none" />
          <input ref="sessionSearchInput" :value="sessionSearch.query"
            @input="searchSessions(($event.target as HTMLInputElement).value)"
            @keydown.escape="toggleSearch" @blur="onSearchBlur"
            :placeholder="t('agent.searchPlaceholder')"
            class="w-full h-11 pl-10 pr-10 rounded-xl bg-background border border-border text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
          <button @click="toggleSearch" :title="t('convert.cancel')"
            class="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-lg flex items-center justify-center
                   text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <span class="icon-[lucide--x] w-3.5 h-3.5" />
          </button>
        </div>
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
          <!--
            两个区:上面「置顶」下面「闲聊」。

            以前只是一条分隔线 —— 分是分开了,但没说清上下各是什么,
            而且置顶攒多了会把闲聊整个顶到看不见的地方。现在置顶那一区能收起来,
            收不收记在设置里(每次进来重收一遍就等于没收)。
          -->
          <template v-for="g in sessionGroups" :key="g.key">
            <button v-if="g.key === 'pinned'" @click="settings.agentPinnedFold = !settings.agentPinnedFold"
              class="w-full flex items-center gap-1.5 px-2 py-1.5 mt-0.5 rounded-lg text-[11.5px]
                     text-muted-foreground transition-colors hover:bg-muted/50">
              <span class="w-3 h-3 shrink-0"
                :class="settings.agentPinnedFold ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
              {{ t('agent.groupPinned') }}
              <span class="ml-auto tabular-nums">{{ g.items.length }}</span>
            </button>
            <button v-else-if="g.showLabel" @click="settings.agentCasualFold = !settings.agentCasualFold"
              class="w-full flex items-center gap-1.5 px-2 py-1.5 mt-0.5 rounded-lg text-[11.5px]
                     text-muted-foreground transition-colors hover:bg-muted/50">
              <span class="w-3 h-3 shrink-0"
                :class="settings.agentCasualFold ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
              {{ t('agent.groupCasual') }}
              <span class="ml-auto tabular-nums">{{ g.items.length }}</span>
            </button>

          <template v-if="g.key === 'pinned' ? !settings.agentPinnedFold : !(g.showLabel && settings.agentCasualFold)">
          <SessionItem v-for="s in g.items" :key="s.sessionId"
            :title="s.title" :time="relTime(s.updatedAt)" :running="s.running"
            :active="s.sessionId === chat.sessionId" :pinned="pinned.ids.includes(s.sessionId)"
            :cats="projects.cats"
            @open="openSession(s.sessionId)" @pin="togglePin(s.sessionId)" @rename="startRename(s)"
            @archive="askArchive(s)" @promote="(cid: string) => promoteSession(s, cid)" />
          </template>
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

      <!--
        ═══ 项目：项目类（折叠）→ 项目 ═══

        两层,不是三层。项目类只是归类的壳,项目才是干活的地方 ——
        点一个项目就直接进去(左栏整个换成它的文件树),中间不再多一站。

        尺寸和「聊天」那一页对齐:顶上一条 58,每一行 44。
      -->
      <template v-else-if="sideTab === 'projects' && !currentProject">
      <!-- 和「聊天」那一页同一套：左搜索、右几颗动作，整条 58、每颗 44 -->
      <div class="h-[58px] shrink-0 relative px-[7px] flex items-center">
        <button @click="toggleProjSearch" :title="t('agent.searchProjects')" :class="[
          'size-11 shrink-0 rounded-xl flex items-center justify-center transition-colors hover:bg-muted/60 hover:text-foreground',
          projSearchOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'
        ]">
          <span class="icon-[lucide--search] w-[18px] h-[18px]" />
        </button>

        <span class="flex-1" />

        <button @click="newCatOpen = true" :title="t('agent.newCategory')"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--folder-plus] w-[18px] h-[18px]" />
        </button>
        <!-- 把别家 AI 的项目接过来。指向同一个文件夹，不复制 —— 详见对话框里那两句 -->
        <button @click="syncOpen = true" :title="t('agent.syncProjects')"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--refresh-cw] w-[18px] h-[18px]" />
        </button>
        <button @click="skillsOpen = true" :title="t('agent.skills')"
          class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted/60 hover:text-foreground">
          <span class="icon-[lucide--sparkles] w-[18px] h-[18px]" />
        </button>

        <div v-if="projSearchOpen" class="absolute inset-x-[7px] top-1/2 -translate-y-1/2 h-11 rounded-xl bg-card">
          <span class="icon-[lucide--search] w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 z-10
                       text-muted-foreground pointer-events-none" />
          <input ref="projSearchInput" v-model="projQuery"
            @keydown.escape="toggleProjSearch" @blur="onProjSearchBlur"
            :placeholder="t('agent.searchProjectsPlaceholder')"
            class="w-full h-11 pl-10 pr-10 rounded-xl bg-background border border-border text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
          <button @click="toggleProjSearch" :title="t('convert.cancel')"
            class="absolute right-2 top-1/2 -translate-y-1/2 size-7 rounded-lg flex items-center justify-center
                   text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <span class="icon-[lucide--x] w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-[7px] pb-2.5">
        <p v-if="!projects.items.length && !projects.cats.length"
          class="mt-6 px-2 text-center text-[13px] text-muted-foreground leading-relaxed">
          {{ t('agent.noProjects') }}
        </p>

        <template v-for="g in shownGroups" :key="g.cat.id || '_'">
          <!-- 类这一行 44 高;右边那颗「往这一类里加项目」正好是 44×44 -->
          <div class="group/cat h-11 flex items-center gap-0.5">
            <ContextMenu>
              <ContextMenuTrigger as-child>
            <button @click="g.cat.id && toggleCategory(g.cat.id)"
              class="flex-1 min-w-0 h-11 flex items-center gap-1.5 px-2 rounded-xl text-[12.5px]
                     text-muted-foreground transition-colors hover:bg-muted/50">
              <span class="w-3.5 h-3.5 shrink-0"
                :class="projects.collapsed[g.cat.id] ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'" />
              <!-- 图标是「这是哪一类」的一半。存了不画等于白让人挑一次 -->
              <span class="shrink-0 text-[14px]">{{ g.cat.icon || '📁' }}</span>
              <span class="truncate">{{ g.cat.name }}</span>
              <span class="ml-auto tabular-nums text-[11px]">{{ g.items.length }}</span>
            </button>
              </ContextMenuTrigger>
              <ContextMenuContent v-if="g.cat.id" class="w-40">
                <ContextMenuItem @select="startRenameCat(g.cat)">
                  <span class="icon-[lucide--pencil] w-4 h-4" />
                  {{ t('agent.renameCategory') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <!-- 删类不删项目：里面的项目掉到「未分类」，删的是这个壳 -->
                <ContextMenuItem @select="removeCategory(g.cat.id)"
                  class="text-destructive focus:text-destructive">
                  <span class="icon-[lucide--trash-2] w-4 h-4" />
                  {{ t('agent.delCategory') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <!-- 悬停才出现 —— 平时它是噪音,要用的时候一定找得到 -->
            <button v-if="g.cat.id" @click="startNewProject(g.cat.id)" :title="t('agent.newProject')"
              class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                     opacity-0 group-hover/cat:opacity-100 transition-opacity hover:bg-muted hover:text-foreground">
              <span class="icon-[lucide--plus] w-[18px] h-[18px]" />
            </button>
          </div>

          <template v-if="!projects.collapsed[g.cat.id]">
            <ProjectItem v-for="pr in g.items" :key="pr.id" :project="pr" :cats="projects.cats"
              @open="enterProject(pr.id)" @rename="startEditProject(pr)"
              @move="(cid: string) => updateProject(pr.id, { categoryId: cid })"
              @remove="askDeleteProject(pr)" />
            <p v-if="!g.items.length" class="pl-7 pr-2 py-1 text-[11.5px] text-muted-foreground/70">
              {{ t('agent.catEmpty') }}
            </p>
          </template>
        </template>
      </div>
      </template>

      <!--
        ═══ 进了项目：整栏就是它的文件 ═══

        顶上一条:左边退出去,中间是项目名(点一下换一个项目),右边设置。
        下面直接是文件树 —— 和笔记页同一套操作:单击插引用、双击打开来看/改。
      -->
      <div v-else-if="currentProject" class="flex-1 min-h-0 flex flex-col">
        <!-- 和别处一样:整条 58,里面每颗 44 -->
        <div class="h-[58px] shrink-0 px-[7px] flex items-center gap-0.5">
          <button @click="leaveProject" :title="t('agent.backToProjects')"
            class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                   transition-colors hover:bg-muted hover:text-foreground">
            <span class="icon-[lucide--chevron-left] w-[18px] h-[18px]" />
          </button>

          <Popover v-model:open="projSwitchOpen">
            <PopoverTrigger as-child>
              <button class="flex-1 min-w-0 h-11 px-2 rounded-xl flex items-center gap-1.5 text-[13px]
                             transition-colors hover:bg-muted/60">
                <span class="shrink-0">{{ currentProject.icon || '📁' }}</span>
                <span class="truncate font-medium">{{ currentProject.name }}</span>
                <span class="icon-[lucide--chevron-down] w-3 h-3 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" class="w-60 p-1 max-h-80 overflow-y-auto">
              <template v-for="g in grouped" :key="g.cat.id || '_'">
                <p v-if="g.items.length" class="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
                  {{ g.cat.name }}
                </p>
                <PopoverClose v-for="pr in g.items" :key="pr.id" as-child>
                  <button @click="enterProject(pr.id)" :class="[
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[13px] transition-colors',
                    pr.id === currentProject.id ? 'bg-muted' : 'hover:bg-muted/60'
                  ]">
                    <span class="shrink-0">{{ pr.icon || '📁' }}</span>
                    <span class="truncate">{{ pr.name }}</span>
                  </button>
                </PopoverClose>
              </template>
            </PopoverContent>
          </Popover>

          <Popover v-model:open="projCfgOpen">
            <PopoverTrigger as-child>
              <button :title="t('agent.projSettings')"
                class="size-11 shrink-0 rounded-xl flex items-center justify-center text-muted-foreground
                       transition-colors hover:bg-muted hover:text-foreground">
                <span class="icon-[lucide--settings-2] w-[18px] h-[18px]" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-56 p-1">
              <PopoverClose as-child>
                <button @click="skillsOpen = true"
                  class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
                  <span class="icon-[lucide--sparkles] w-3.5 h-3.5 text-muted-foreground" />
                  {{ t('agent.skills') }}
                </button>
              </PopoverClose>
              <PopoverClose as-child>
                <button @click="openRules(currentProject.folder)"
                  class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
                  <span class="icon-[lucide--scroll-text] w-3.5 h-3.5 text-muted-foreground" />
                  {{ t('agent.rules') }}
                </button>
              </PopoverClose>
              <PopoverClose v-if="vault.root" as-child>
                <button @click="pickFolder('vault')"
                  class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
                  <span class="icon-xg-obsidian w-3.5 h-3.5 text-muted-foreground" />
                  <span class="flex-1 text-left truncate">{{ t('agent.pickFromVault') }}</span>
                </button>
              </PopoverClose>
              <PopoverClose as-child>
                <button @click="pickFolder('disk')"
                  class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] transition-colors hover:bg-muted/60">
                  <span class="icon-[lucide--hard-drive] w-3.5 h-3.5 text-muted-foreground" />
                  <span class="flex-1 text-left truncate">{{ t('agent.pickFromDisk') }}</span>
                </button>
              </PopoverClose>
              <div class="h-px bg-border my-1" />
              <PopoverClose as-child>
                <button @click="removeCurrentProject"
                  class="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-[13px] text-destructive
                         transition-colors hover:bg-destructive/10">
                  <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
                  {{ t('agent.delProject') }}
                </button>
              </PopoverClose>
            </PopoverContent>
          </Popover>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2.5">
          <!--
            还没绑文件夹。两个入口分开给:「笔记库里」和「磁盘上」——
            这是两种不同的心智,合成一个「选文件夹」按钮的话,想从笔记库里挑的人
            要在文件选择器里一层层翻到笔记库去,而那个路径他自己都未必记得。
            没设过笔记库就只剩磁盘那一个,不摆一个点了没用的按钮。
          -->
          <div v-if="!currentProject.folder" class="mt-2 space-y-1.5">
            <p class="px-1 text-[12.5px] text-muted-foreground leading-relaxed">{{ t('agent.noFolder') }}</p>
            <button v-if="vault.root" @click="pickFolder('vault')"
              class="w-full h-9 rounded-lg border border-dashed border-border text-[12.5px]
                     flex items-center justify-center gap-2
                     text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <span class="icon-xg-obsidian w-3.5 h-3.5" />
              {{ t('agent.pickFromVault') }}
            </button>
            <button @click="pickFolder('disk')"
              class="w-full h-9 rounded-lg border border-dashed border-border text-[12.5px]
                     flex items-center justify-center gap-2
                     text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <span class="icon-[lucide--hard-drive] w-3.5 h-3.5" />
              {{ t('agent.pickFromDisk') }}
            </button>
          </div>
          <template v-else>
            <!-- 和笔记页一样能往里加东西 —— 不然要新建一个文件得先切去资源管理器 -->
            <div class="flex items-center gap-1 px-1 pb-1">
              <span class="text-[11px] text-muted-foreground truncate">
                {{ currentProject.folder.split(/[\\/]/).filter(Boolean).pop() }}
              </span>
              <!-- 说明收进 ⓘ 里，不常驻在界面上 —— 见 InfoTip 的注释 -->
              <InfoTip :text="t('agent.filesHint')" />
              <div class="flex-1" />
              <button @click="createInProject(false)" :title="t('agent.newFile')"
                class="size-6 rounded-md flex items-center justify-center text-muted-foreground
                       transition-colors hover:bg-muted hover:text-foreground">
                <span class="icon-[lucide--file-plus] w-3.5 h-3.5" />
              </button>
              <button @click="createInProject(true)" :title="t('agent.newFolder')"
                class="size-6 rounded-md flex items-center justify-center text-muted-foreground
                       transition-colors hover:bg-muted hover:text-foreground">
                <span class="icon-[lucide--folder-plus] w-3.5 h-3.5" />
              </button>
            </div>
            <ProjectFiles :key="filesVersion" :root="currentProject.folder" @open="openProjectFile" />
          </template>
        </div>
      </div>

      <!--
        新会话。原来这儿是引擎状态灯（挪去右上角了）。

        **只在「聊天」页出现。** 一个项目就是一次对话 —— 项目列表上「开始做点什么」
        是新建项目类 / 新建项目(入口在顶上那一行和每个类右边的 ＋);
        进了项目里更不该有,那等于在一个「就是一次对话」的地方问你要不要再开一次。

        收在栏里做成圆角按钮（而不是跨满全宽的一条）：它是一个**动作**，
        不是栏的一部分；高 44，和顶上那一行、导航栏图标格子同一个模数。
      -->
      <div v-if="sideTab === 'chat'" class="shrink-0 px-[7px] py-[7px]">
        <button @click="startSession" :disabled="!chatReady"
          class="w-full h-11 rounded-xl border border-border bg-muted/40 flex items-center justify-center gap-2
                 text-[13px] transition-colors hover:bg-muted disabled:opacity-40 disabled:hover:bg-muted/40">
          <span class="icon-[lucide--circle-plus] w-4 h-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ t('agent.newChat') }}</span>
        </button>
      </div>
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
    <section v-if="docOpen" class="flex flex-col overflow-hidden float-card rounded-[14px] border bg-card"
      :style="{ order: docCenter ? 1 : 3,
                flex: docCenter ? '1 1 0%' : `0 0 ${settings.agentDocWidth}px` }">
      <div class="h-11 shrink-0 px-3 flex items-center gap-2 border-b border-border">
        <span class="icon-[lucide--file-text] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class="text-[13px] truncate">{{ docTitle }}</span>
        <button v-if="canSaveDoc" @click="saveDoc" :disabled="docSaving"
          class="ml-auto h-7 px-2.5 rounded-lg border border-border text-[12px] text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40">
          {{ t('agent.docSave') }}
        </button>
        <span v-else class="ml-auto" />
        <button @click="swapPanes" :title="t('agent.swapPanes')"
          class="size-7 rounded-lg flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground">
          <span class="icon-[lucide--arrow-left-right] w-3.5 h-3.5" />
        </button>
        <button @click="closeDoc" :title="t('convert.cancel')"
          class="size-7 rounded-lg flex items-center justify-center text-muted-foreground
                 transition-colors hover:bg-muted hover:text-foreground">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
      </div>
      <!--
        md 用笔记页那个编辑器 —— 同一套渲染,不做第二份。
        代码和纯文本走等宽文本框:markdown 渲染器会把 `x[i]`、`${y}` 认成链接和强调,
        看着像内容坏了,其实一个字没动。
      -->
      <!-- Alt+K 挂在这一层:编辑器内部按键先冒泡到这儿,不用去改编辑器的键位表 -->
      <div class="flex-1 min-h-0 overflow-hidden" @keydown="onDocKeydown">
        <textarea v-if="panel?.plain" v-model="docBody" spellcheck="false"
          :readonly="!panel.save && !panel.sync"
          class="w-full h-full resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed
                 select-text focus:outline-none" />
        <MarkdownEditor v-else ref="mdEditor" v-model="docBody" :scroll-key="docKey"
          :accent="settings.vaultAccent" :font="settings.vaultFont"
          :font-size="settings.vaultFontSize" :color-headings="settings.vaultColorHeadings" />
      </div>
    </section>

    <!-- 和侧栏那条同一个样子 —— 同一种东西就该长得一样,不用再学一次 -->
    <div v-if="docOpen" @pointerdown="onDocDragStart" :style="{ order: 2 }"
      class="w-2.5 shrink-0 cursor-col-resize flex items-center justify-center group">
      <div class="w-0.5 h-10 rounded-full bg-border transition-colors group-hover:bg-foreground/40"
        :class="docDragging ? 'bg-foreground/60' : ''" />
    </div>

    <!-- ═══════ 聊天区 ═══════ -->
    <section class="min-w-0 flex flex-col overflow-hidden relative"
      :style="{ order: docOpen ? (docCenter ? 3 : 1) : 2,
                flex: docOpen && docCenter ? `0 0 ${settings.agentDocWidth}px` : '1 1 0%' }"
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
      <div v-else-if="empty" class="flex-1 min-h-0 flex flex-col items-center justify-center px-6">
        <div class="flex items-center gap-2.5 mb-7">
          <span class="icon-[ri--deepseek-line] w-8 h-8 text-foreground" />
          <h1 class="text-[26px] font-medium tracking-tight">{{ greeting }}</h1>
        </div>
        <div class="w-full max-w-2xl">
          <!-- 工作区和模式放在框「上方」,和原版 DSH 一致:它们选的是这一轮的作用域,
               不是输入框里的一个开关,视觉上分开更说得通。 -->
          <div class="flex items-center gap-1 mb-2 px-1">
            <!-- 工作区:决定新会话建在哪个目录。空态选好,第一句话生效 -->
            <Popover v-model:open="wsOpen">
              <PopoverTrigger as-child>
                <button class="pill">
                  <span class="icon-[lucide--folder] w-3.5 h-3.5" />
                  {{ currentWorkspaceLabel }}
                  <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-72 p-1">
                <button v-for="w in workspaces.items" :key="w.workspaceId"
                  @click="workspaces.pendingId = w.workspaceId; wsOpen = false" :class="[
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
            <Popover v-model:open="presetOpen">
              <PopoverTrigger as-child>
                <button class="pill">
                  <span class="icon-[lucide--git-branch] w-3.5 h-3.5" />
                  {{ currentPresetLabel }}
                  <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-80 p-1">
                <button v-for="pr in presets.options" :key="pr.id"
                  @click="selectPreset(pr.id); presetOpen = false" :class="[
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

            <!--
              贴进来的大段材料。收成一条,不铺开 —— 铺开的话你说的那句话
              会被顶到看不见的地方。点开能看能改,× 撤掉。
            -->
            <div v-if="textDrafts.length" class="flex flex-wrap gap-1.5 px-4 pt-3">
              <div v-for="d in textDrafts" :key="d.id"
                class="group relative flex items-center gap-1.5 h-8 pl-2.5 pr-7 rounded-lg
                       border border-border bg-muted/40 max-w-[14rem]">
                <span :class="['w-3.5 h-3.5 shrink-0 text-muted-foreground', draftIcon(d)]" />
                <button @click="viewTextDraft(d)" :title="t('agent.pasteFileHint')"
                  class="text-[12.5px] truncate">{{ d.name }}</button>
                <button @click="dropTextDraft(d.id)"
                  class="absolute right-1 size-5 rounded-md flex items-center justify-center
                         text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                  <span class="icon-[lucide--x] w-3 h-3" />
                </button>
              </div>
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
                <span class="w-3.5 h-3.5"
                  :class="planOn ? 'icon-[lucide--clipboard-check]' : 'icon-[lucide--list-checks]'" />
                {{ t('agent.planMode') }}
              </button>
              <!-- 访问权限:原版的「工作区可写」下拉,背后是 /permission 命令 -->
              <Popover v-model:open="permOpen">
                <PopoverTrigger as-child>
                  <button class="pill">
                    <span class="w-3.5 h-3.5" :class="permIcon" />
                    {{ permissionLabel }}
                    <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" class="w-56 p-1">
                  <button v-for="pp in PERMISSION_PRESETS" :key="pp"
                    @click="selectPermission(pp); permOpen = false" :class="[
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
              <Popover v-model:open="modelOpen">
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
                    @click="selectModel(m.provider, m.model); modelOpen = false" :class="[
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

      <!--
        对话态。

        消息列表铺满整个区,**输入框浮在它上面** —— 不再是一上一下两块硬拼。
        上下各盖一层渐变:滚出去的文字是淡出去的,不是被一条硬边切断。
        列表的上下内边距要把这两层让开,不然第一条和最后一条永远是半透明的。
      -->
      <template v-else>
        <div ref="listEl" @wheel="onUserScroll" @touchmove="onUserScroll" @keydown="onUserScroll"
          class="absolute inset-0 overflow-y-auto px-6 pt-8"
          :style="{ paddingBottom: composerH + 28 + 'px', maskImage: chatMask, WebkitMaskImage: chatMask }">
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
                <div class="max-w-[85%] flex flex-col items-end gap-1.5">
                  <!--
                    夹带的材料收成条,不铺在气泡里。翻旧会话时尤其要紧:
                    发出去的那份是「话 + 几百行代码」黏在一起的,原样画出来
                    你问的那句话会被顶到屏幕外面。点开在正文栏看。
                  -->
                  <div v-if="m.files?.length" class="flex flex-wrap justify-end gap-1.5">
                    <button v-for="f in m.files" :key="f.name" @click="viewChatFile(f)"
                      class="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-border bg-muted/60
                             text-[12px] max-w-[14rem] transition-colors hover:bg-muted">
                      <span class="icon-[lucide--file-text] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span class="truncate">{{ f.name }}</span>
                    </button>
                  </div>
                  <div v-if="m.text" class="rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap wrap-break-word">
                    {{ m.text }}
                  </div>
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

        <div ref="composerBox" class="absolute inset-x-0 bottom-0 px-6 pb-2.5 z-20">
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

              <div v-if="textDrafts.length" class="flex flex-wrap gap-1.5 px-4 pt-3">
                <div v-for="d in textDrafts" :key="d.id"
                  class="group relative flex items-center gap-1.5 h-8 pl-2.5 pr-7 rounded-lg
                         border border-border bg-muted/40 max-w-[14rem]">
                  <span :class="['w-3.5 h-3.5 shrink-0 text-muted-foreground', draftIcon(d)]" />
                  <button @click="viewTextDraft(d)" :title="t('agent.pasteFileHint')"
                    class="text-[12.5px] truncate">{{ d.name }}</button>
                  <button @click="dropTextDraft(d.id)"
                    class="absolute right-1 size-5 rounded-md flex items-center justify-center
                           text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    <span class="icon-[lucide--x] w-3 h-3" />
                  </button>
                </div>
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
                  <span class="w-3.5 h-3.5"
                    :class="planOn ? 'icon-[lucide--clipboard-check]' : 'icon-[lucide--list-checks]'" />
                  <span class="hidden @[30rem]:inline">{{ t('agent.planMode') }}</span>
                </button>
                <!-- 访问权限:原版的「工作区可写」下拉,背后是 /permission 命令 -->
                <Popover v-model:open="permOpen">
                  <PopoverTrigger as-child>
                    <button class="pill" :title="permissionLabel">
                      <span class="w-3.5 h-3.5" :class="permIcon" />
                      <span class="hidden @[30rem]:inline">{{ permissionLabel }}</span>
                      <span class="icon-[lucide--chevron-down] w-3 h-3 opacity-60" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" class="w-56 p-1">
                    <button v-for="pp in PERMISSION_PRESETS" :key="pp"
                      @click="selectPermission(pp); permOpen = false" :class="[
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
                <Popover v-model:open="modelOpen">
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
                      @click="selectModel(m.provider, m.model); modelOpen = false" :class="[
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
    <NewProjectDialog v-model:open="newProjectOpen" :title="t('agent.newProject')"
      :placeholder="t('agent.projNamePlaceholder')" @submit="createProject" />
    <NewProjectDialog v-model:open="newCatOpen" :title="t('agent.newCategory')"
      :placeholder="t('agent.catNamePlaceholder')" @submit="(p) => createCategory(p.name, p.icon)" />
    <SkillsDialog v-model:open="skillsOpen" @open-skill="openSkill" @restart-engine="restartEngine" />
    <SyncProjectsDialog v-model:open="syncOpen" @link="linkExternal" @link-session="linkExternalSession" />

    <!-- 改名：项目类和项目共用,图标也能重挑 -->
    <NewProjectDialog v-model:open="edit.open"
      :title="edit.kind === 'cat' ? t('agent.renameCategory') : t('agent.rename')"
      :placeholder="edit.kind === 'cat' ? t('agent.catNamePlaceholder') : t('agent.projNamePlaceholder')"
      :initial-name="edit.name" :initial-icon="edit.icon" :submit-label="t('agent.rename')"
      @submit="doEdit" />

    <!-- 删项目：再问一次。这一条底下挂着一整段对话,点错了拿不回来 -->
    <AlertDialog :open="!!delTarget" @update:open="(v: boolean) => { if (!v) delTarget = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('agent.delProjectAsk', { name: delTarget?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('agent.delProjectBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('convert.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doDeleteProject"
            class="bg-destructive text-white hover:bg-destructive/90">
            {{ t('agent.delProject') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 新建文件 / 文件夹：只问一个名字 -->
    <Dialog v-model:open="newEntry.open">
      <DialogContent class="sm:max-w-sm p-0 gap-0 overflow-hidden">
        <DialogHeader class="px-5 pt-5 pb-3">
          <DialogTitle>{{ newEntry.isDir ? t('agent.newFolder') : t('agent.newFile') }}</DialogTitle>
          <DialogDescription>{{ t('agent.newEntryHint') }}</DialogDescription>
        </DialogHeader>
        <div class="px-5">
          <input v-model="newEntry.name" autofocus @keydown.enter="doCreateInProject"
            :placeholder="newEntry.isDir ? t('agent.newFolderPlaceholder') : t('agent.newFilePlaceholder')"
            class="w-full h-9 rounded-lg border border-border bg-background/40 px-2.5 text-[14px]
                   placeholder:text-muted-foreground/60 focus:outline-none focus:border-foreground/25" />
        </div>
        <div class="px-5 py-4 flex justify-end gap-2">
          <button @click="newEntry.open = false"
            class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted">
            {{ t('convert.cancel') }}
          </button>
          <button @click="doCreateInProject" :disabled="!newEntry.name.trim()"
            class="h-8 px-4 rounded-lg bg-foreground text-background text-sm transition-opacity
                   hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed">
            {{ t('agent.projCreate') }}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/*
  输入框:两处用同一套样式(空态居中、对话态贴底),所以抽成类而不是重复一长串 utility。
  bg-background/40 而不是实心 —— 开云母/亚克力时能透出材质,关掉时看着也正常。
*/
/*
  输入框现在**浮在对话上面**,不是垫在对话下面。

  所以底不能再是 40% 那种半透明了 —— 滚到它后面的消息会从框里透出来,
  正在打的字和别人的话叠在一起。92% + 背后模糊:既读不透,又还留着一点
  「浮着」的通透感;再加一点向上的投影,让它看起来是抬起来的一层。
*/
.composer {
  border: 1px solid var(--border);
  border-radius: 1rem;
  background: color-mix(in srgb, var(--background) 92%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 10px 30px -12px rgb(0 0 0 / 0.45);
  transition: border-color 160ms ease;
}

/* 底线两行。rows 只在没跑过 autoGrow 时管用,写死 min-height 才是每一帧都成立的 */
.composer textarea {
  min-height: 3rem;
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
/*
  开着的开关要一眼看出来 —— 而且是**隔着一米也看得出来**。

  上一版用的是 `--atomic-editor-accent` 加 16% 的淡底:那个变量只在笔记编辑器里
  有定义,这儿退回成了前景色,染出来就是一层灰 —— 和默认态、和悬停态都几乎一样,
  等于白设。窄屏下这颗只剩一个图标,那就彻底看不出开没开了。

  换成实心反色:底和字对调。这是整个界面里最重的一种强调,平时不该乱用,
  但「计划模式」改的是它接下来怎么跟你配合(先出方案,还是直接动手),
  值得这个分量。图标也跟着换 —— 只剩图标的时候,颜色和形状都得说话。
*/
.pill-on {
  background: var(--foreground);
  color: var(--background);
  border-color: transparent;
}
.pill-on:hover { background: color-mix(in srgb, var(--foreground) 85%, transparent); }

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
