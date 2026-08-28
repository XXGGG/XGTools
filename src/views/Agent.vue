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
import { ref, nextTick, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from '@/i18n'
import { settings, AGENT_SIDEBAR } from '@/composables/useAppSettings'
import { renderChatMd, onChatLinkClick } from '@/composables/useChatMarkdown'
import { dsh, dshUsable, initDsh, installDsh, startDsh, refreshDsh } from '@/composables/useDsh'
import {
  chat, chatReady, connectChat, newSession, sendPrompt, respondPending,
  sessions, loadSessions, openSession, pinned, togglePin, renameSession, archiveSession,
  sessionSearch, searchSessions,
  models, loadModels, selectModel, setDefaultModel, currentModelLabel, type SessionRow,
  presets, loadPresets, selectPreset,
  workspaces, loadWorkspaces, addWorkspace,
  permission, selectPermission, PERMISSION_PRESETS,
} from '@/composables/useDshChat'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import DshBoot from '@/components/DshBoot.vue'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { open as openExternal } from '@tauri-apps/plugin-shell'

const { t } = useI18n()

onMounted(async () => {
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
  if (canStart.value) startDsh()
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

const empty = computed(() => chat.items.length === 0)

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
  if (!text) return
  input.value = ''
  await sendPrompt(text)
  await nextTick()
  autoScroll()
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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

/** 开新会话:不是清屏,是真的让 DSH 建一个新 session */
function clearThread() {
  newSession()
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

      <div class="p-2.5">
        <button @click="newSession()" :disabled="!chatReady"
          class="w-full h-10 rounded-xl border border-border bg-muted/50 flex items-center justify-center gap-2
                 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
          <span class="icon-[lucide--circle-plus] w-4 h-4" />
          {{ t('agent.newChat') }}
        </button>
      </div>

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

    <!-- ═══════ 聊天区 ═══════ -->
    <section class="flex-1 min-w-0 flex flex-col overflow-hidden relative"
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
          <div class="composer">
            <textarea v-model="input" @keydown="onKeydown" rows="2" :placeholder="t('agent.placeholder')"
              class="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed
                     placeholder:text-muted-foreground/60 focus:outline-none" />
            <div class="composer-bar">
              <button :title="t('agent.attach')" class="pill-icon">
                <span class="icon-[lucide--plus] w-4 h-4" />
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

            <div v-for="m in chat.items" :key="m.id">

              <!-- 用户:右侧气泡 -->
              <div v-if="m.kind === 'user'" class="flex justify-end">
                <div class="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap wrap-break-word">
                  {{ m.text }}
                </div>
              </div>

              <!-- 助手:左侧全宽,不用气泡 —— 回复常常很长,气泡会把行宽压到难读 -->
              <div v-else-if="m.kind === 'assistant'" class="flex gap-3">
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
          <div class="max-w-2xl mx-auto rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
            <div class="flex items-start gap-2.5">
              <span class="icon-[lucide--hand] w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium">{{ chat.pending.title }}</p>
                <p v-if="chat.pending.detail"
                  class="mt-1 text-xs font-mono leading-relaxed text-muted-foreground wrap-break-word max-h-24 overflow-auto">
                  {{ chat.pending.detail }}
                </p>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button v-for="o in chat.pending.options" :key="o.id" @click="respondPending(o.id)"
                    class="h-8 px-3.5 rounded-lg border border-border text-sm transition-colors hover:bg-muted">
                    {{ o.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="px-6 pb-5">
          <div class="max-w-2xl mx-auto">
            <div class="composer">
              <textarea v-model="input" @keydown="onKeydown" rows="1" :placeholder="t('agent.placeholder')"
                class="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed
                       placeholder:text-muted-foreground/60 focus:outline-none" />
              <div class="composer-bar">
                <button :title="t('agent.attach')" class="pill-icon">
                  <span class="icon-[lucide--plus] w-4 h-4" />
                </button>
                <!-- 和 DSH 一致:这是「开一段新的」,不是「把界面擦干净」——
                     旧会话仍在左边列表里,随时点回去 -->
                <button @click="clearThread" class="pill">
                  <span class="icon-[lucide--message-square-plus] w-3.5 h-3.5" />
                  {{ t('agent.newChat') }}
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

.composer-bar {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.5rem 0.5rem;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  height: 1.875rem;
  padding: 0 0.625rem;
  border-radius: 0.625rem;
  font-size: 12.5px;
  color: var(--foreground);
  transition: background-color 140ms ease;
}
.pill:hover { background: color-mix(in srgb, var(--foreground) 7%, transparent); }

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
