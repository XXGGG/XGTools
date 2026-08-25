/**
 * DSH 对话:把事件帧变成能渲染的消息列表。
 *
 * 分工:Rust 那层只搬字节,不理解业务;协议语义全在这里。
 * 好处是上游改协议只改这一个文件,而且 Rust 不用跟着重编译。
 *
 * 帧的来源有两条流:
 *   · events.mux  —— 会话事件 + 需要人回应的请求(权限审批、向用户提问)
 *   · events.host —— 宿主级变化(会话增删、工作区切换)
 * 两条都从 `dsh://frame` 事件过来,靠 payload 里的 `stream` 区分。
 */
import { reactive, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** 一条能渲染的消息。工具调用单独成条 —— 它和文字的展示形态完全不同。 */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; name: string; status: 'running' | 'done' | 'failed'; detail: string }
  | { kind: 'notice'; id: string; text: string }

/** 需要用户拍板的事:权限审批 / 向用户提问。挂着不回,那次工具调用就永远卡住。 */
export type Pending = {
  rpcId: string
  kind: 'approval' | 'question'
  title: string
  detail: string
  options: { id: string; label: string }[]
}

export const chat = reactive<{
  sessionId: string
  items: ChatItem[]
  busy: boolean
  pending: Pending | null
  streams: Record<string, string>
  error: string
}>({
  sessionId: '',
  items: [],
  busy: false,
  pending: null,
  streams: {},
  error: '',
})

let wired = false
let seq = 0
const nextId = () => `i${++seq}`

/** 正在流式输出的那条助手消息。chunk 往它身上追加,不新建。 */
function streamingAssistant(): Extract<ChatItem, { kind: 'assistant' }> | null {
  for (let i = chat.items.length - 1; i >= 0; i--) {
    const it = chat.items[i]
    if (it.kind === 'assistant' && it.streaming) return it
    // 遇到别的消息就说明上一段已经收尾了,不能再往回追
    if (it.kind === 'user') break
  }
  return null
}

function appendChunk(text: string) {
  const cur = streamingAssistant()
  if (cur) cur.text += text
  else chat.items.push({ kind: 'assistant', id: nextId(), text, streaming: true })
}

function sealAssistant() {
  const cur = streamingAssistant()
  if (cur) cur.streaming = false
}

/** 从各种嵌套结构里捞文本。上游字段名在 rc 之间变过,所以逐个兜。 */
function textOf(v: any): string {
  if (typeof v === 'string') return v
  if (!v || typeof v !== 'object') return ''
  if (typeof v.text === 'string') return v.text
  if (Array.isArray(v.content)) {
    return v.content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
  }
  if (Array.isArray(v)) return v.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
  return ''
}

/**
 * 处理一帧。
 *
 * **帧的真实形状**(实测抓的,不是照文档猜的):
 * ```
 * { type: "server-request", rpcId, method: "session/event",
 *   payload: { event: { type, seq, time, data } } }
 * ```
 * 三个坑,踩过一次:
 *  1. 所有推送都套着 `server-request` 信封,连纯通知也是 —— 看见 server-request
 *     就当成「要人回应」会把全部事件吞掉,界面永远空白。
 *  2. 真正需要回应的只有待决请求;给通知回 `/api/respond` 会拿到
 *     `{accepted:false, reason:"not-pending"}`,无害但纯属白跑。
 *  3. 事件体里是 **`data`** 不是 `payload`。
 */
function handleFrame(raw: string) {
  let frame: any
  try { frame = JSON.parse(raw) } catch { return }
  if (frame?.type !== 'server-request') return

  const method = String(frame.method ?? '')

  // 需要人拍板的:审批 / 提问。只有这一类才回 rpcId。
  if (method.includes('approval') || method.includes('permission') || method.includes('question')) {
    const p = frame.payload ?? {}
    const isQuestion = method.includes('question')
    chat.pending = {
      rpcId: frame.rpcId,
      kind: isQuestion ? 'question' : 'approval',
      title: isQuestion ? (textOf(p.question) || '智能体想问你一件事') : '需要你批准',
      detail: textOf(p) || JSON.stringify(p).slice(0, 300),
      options: Array.isArray(p.options) && p.options.length
        ? p.options.map((o: any, i: number) => ({ id: String(o?.id ?? i), label: String(o?.label ?? o ?? '') }))
        : [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }],
    }
    return
  }

  if (method !== 'session/event') return   // projection / queue 等暂不渲染

  const ev = frame.payload?.event ?? frame.payload
  const sid = String(frame.payload?.sessionId ?? ev?.sessionId ?? '')
  if (sid && chat.sessionId && sid !== chat.sessionId) return
  applyEvent(ev)
}

/**
 * 把一个会话事件渲染进列表。
 *
 * 实时帧和历史回放共用这一个函数 —— `session.history` 返回的
 * `HistoryEntry.event` 跟事件流里的 event 是同一套结构,所以「翻出旧会话」
 * 和「正在对话」走的是完全相同的渲染路径,不会出现两边长得不一样。
 */
function applyEvent(ev: any) {
  const data = ev?.data ?? {}
  switch (String(ev?.type ?? '')) {
    case 'turn/start':
      chat.busy = true
      break

    case 'turn/end': {
      chat.busy = false
      sealAssistant()
      // 兜底:轮次都结束了,不该还有工具在转。上游漏发 result、
      // 或者 callId 对不上时,这里保证图标一定会停。
      for (const i of chat.items) if (i.kind === 'tool' && i.status === 'running') i.status = 'done'
      // 出错时一定要说出来。不说的话现象是「发了消息什么都没有」,
      // 而真实原因可能只是 API key 过期 —— 用户完全无从判断。
      const err = data?.reason?.kind === 'error' ? data.reason.error : null
      if (err) chat.items.push({ kind: 'notice', id: nextId(), text: errorText(err) })
      break
    }

    case 'assistant/chunk': {
      const c = data?.chunk
      if (!c) break
      if (c.type === 'text' || c.type === 'text-delta') appendChunk(String(c.text ?? ''))
      else if (c.type === 'finish' && c.reason?.kind === 'error') {
        sealAssistant()
        chat.items.push({ kind: 'notice', id: nextId(), text: errorText(c.reason.failure) })
      }
      break
    }

    case 'assistant/message': {
      const full = (data?.content ?? []).map((x: any) => (x?.type === 'text' ? x.text : '')).join('')
      const cur = streamingAssistant()
      if (cur) { if (full.length > cur.text.length) cur.text = full; cur.streaming = false }
      else if (full) chat.items.push({ kind: 'assistant', id: nextId(), text: full, streaming: false })
      break
    }

    case 'tool/call':
      sealAssistant()
      chat.items.push({
        kind: 'tool',
        id: String(data?.callId ?? nextId()),
        name: String(data?.name ?? '工具'),
        status: 'running',
        // arguments 是模型原样吐出的 **JSON 字符串**,不是对象 —— 再 stringify 一次
        // 会得到一堆转义反斜杠。直接用。
        detail: typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? {}),
      })
      break

    case 'tool/result': {
      /*
       * callId 在 tool/call 和 tool/result 里的路径**不一样**:
       *   tool/call   → data.callId
       *   tool/result → data.message.source.callId
       * 按 data.callId 找 result 永远匹配不上,现象是工具那一行的转圈图标
       * 永远转下去,哪怕命令早就跑完了。踩过一次。
       */
      const callId = String(data?.message?.source?.callId ?? data?.callId ?? '')
      const item = chat.items.find((i) => i.kind === 'tool' && i.id === callId)
      if (item && item.kind === 'tool') {
        item.status = data?.error ? 'failed' : 'done'
        const out = textOf(data?.message?.content ?? data?.message)
        if (out) item.detail = out.slice(0, 2000)
      }
      break
    }

    case 'llm/retry-started':
      chat.items.push({ kind: 'notice', id: nextId(), text: '模型请求失败，正在重试…' })
      break
    case 'compaction/start':
      chat.items.push({ kind: 'notice', id: nextId(), text: '上下文太长，正在压缩…' })
      break
    default:
      break
  }
}

/** 错误说人话。401 这种直接点破,别让用户对着一句英文栈干瞪眼。 */
function errorText(err: any): string {
  const msg = String(err?.message ?? err ?? '出错了')
  if (err?.code === 'AUTH' || err?.status === 401) {
    return `模型拒绝了这次请求：API 密钥无效或已过期。到设置里换一个再试。
（原文：${msg}）`
  }
  return msg
}

export async function initChat() {
  if (wired) return
  wired = true
  await listen<{ stream: string; data: string }>('dsh://frame', (e) => {
    handleFrame(e.payload.data)
  })
  await listen<{ stream: string; state: string; message?: string }>('dsh://stream', (e) => {
    chat.streams[e.payload.stream] = e.payload.state
    if (e.payload.state === 'error' && e.payload.message) chat.error = e.payload.message
    if (e.payload.state === 'open') chat.error = ''
  })
}

/** 两条流都开着才算真连上 —— 只有 host 没有 mux 的话，审批弹窗永远不会出现 */
export const chatReady = computed(() =>
  chat.streams['events.mux'] === 'open' && chat.streams['events.host'] === 'open')

export async function connectChat(url: string) {
  await initChat()
  await invoke('dsh_connect', { url })
}

/** 侧栏要显示的一条会话 */
export type SessionRow = {
  sessionId: string
  title: string
  updatedAt: number
  running: boolean
  cwd?: string
}

export const sessions = reactive<{ rows: SessionRow[]; loading: boolean }>({
  rows: [],
  loading: false,
})

/** 标题在 projections 里,没有就回落到时间 —— 别显示裸的 sessionId,那对人毫无意义 */
function rowTitle(s: any): string {
  const t = s?.projections?.values?.sessionTitle?.title
    ?? s?.projections?.values?.title
  if (typeof t === 'string' && t.trim()) return t.trim()
  return ''
}

export async function loadSessions() {
  if (sessions.loading) return
  sessions.loading = true
  try {
    const v = await invoke<any>('dsh_rpc', { method: 'session.list', payload: {} })
    sessions.rows = (v?.items ?? [])
      // blank = 一轮都没跑过的空会话。DSH 自己的约定就是列表里不显示它们,
      // 否则每点一次「新会话」就多一条永远空着的记录。
      .filter((s: any) => !s?.blank)
      .map((s: any) => ({
        sessionId: String(s.sessionId),
        title: rowTitle(s),
        updatedAt: Number(s.updatedAt ?? 0),
        running: !!s.running,
        cwd: s.cwd,
      }))
      .sort((a: SessionRow, b: SessionRow) => b.updatedAt - a.updatedAt)
  } catch (e) {
    console.error('读会话列表失败:', e)
  } finally {
    sessions.loading = false
  }
}

/**
 * 会话内容搜索。走 DSH 的 session.search —— 它搜的是所有会话里
 * 用户/助手/steering 消息的可见文本,不是我们在本地对标题做子串匹配。
 * 它最多回 20 条且不带游标,`hasMore` 是让客户端提示「换个更具体的词」。
 */
export const sessionSearch = reactive<{
  query: string
  hits: { sessionId: string; snippet: string }[]
  searching: boolean
  hasMore: boolean
}>({ query: '', hits: [], searching: false, hasMore: false })

let searchTimer: number | undefined

export function searchSessions(q: string) {
  sessionSearch.query = q
  window.clearTimeout(searchTimer)
  if (!q.trim()) {
    sessionSearch.hits = []
    sessionSearch.hasMore = false
    return
  }
  // 防抖:每敲一个字就全库搜一遍,会话多了会明显卡
  searchTimer = window.setTimeout(async () => {
    sessionSearch.searching = true
    try {
      const v = await invoke<any>('dsh_rpc', { method: 'session.search', payload: { query: q } })
      sessionSearch.hits = (v?.items ?? []).map((x: any) => ({
        sessionId: String(x.sessionId),
        snippet: String(x.snippet ?? ''),
      }))
      sessionSearch.hasMore = !!v?.hasMore
    } catch (e) {
      console.error('搜会话失败:', e)
    } finally {
      sessionSearch.searching = false
    }
  }, 250)
}

/** 打开一条旧会话:拉历史并按同一套渲染器回放 */
export async function openSession(sessionId: string) {
  chat.sessionId = sessionId
  chat.items = []
  chat.pending = null
  chat.error = ''
  try {
    const v = await invoke<any>('dsh_rpc', {
      method: 'session.history',
      payload: { sessionId, maxMessages: 100 },
    })
    for (const entry of v?.events ?? []) {
      if (entry?.event) applyEvent(entry.event)
    }
    sealAssistant()   // 历史里最后一段不该留着流式光标
  } catch (e) {
    chat.error = String(e)
  }
}

export async function newSession(cwd?: string) {
  chat.items = []
  chat.pending = null
  chat.error = ''
  try {
    // 签名:create({ workspaceId?, cwd?, sessionId?, agentPreset? }) -> { sessionId }
    const v = await invoke<any>('dsh_rpc', {
      method: 'session.create',
      payload: cwd ? { cwd } : {},
    })
    chat.sessionId = String(v?.sessionId ?? '')
    if (!chat.sessionId) chat.error = '创建会话没有返回 sessionId'
  } catch (e) {
    chat.error = String(e)
  }
}

export async function sendPrompt(text: string) {
  if (!text.trim()) return
  if (!chat.sessionId) await newSession()
  if (!chat.sessionId) return

  chat.items.push({ kind: 'user', id: nextId(), text })
  chat.busy = true
  try {
    /*
     * 三个参数一个都不能省:
     *  · content 是分块数组不是字符串 —— 图片以后要以 {type:'image'} 混在同一个数组里
     *  · mode 必填。'queue' = 排到当前轮次后面;'steer' = 插队打断正在跑的那轮
     *  · clientTimeZone 看着可选,其实不给会被 Host 本地拒绝 —— 它的运行时对
     *    每条提示词采样浏览器时区,拿不到非空值就不发,免得旅行/多标签页时
     *    消息带上错误的来源时区
     */
    await invoke('dsh_rpc', {
      method: 'session.prompt',
      payload: {
        sessionId: chat.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  } catch (e) {
    chat.busy = false
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
  }
  // 标题是发出第一条之后才由 Host 生成的,所以这里补一次列表刷新;
  // 稍等一下再拉,给它生成标题的时间
  setTimeout(loadSessions, 2500)
}

/** 打断正在跑的那一轮 */
export async function cancelTurn() {
  if (!chat.sessionId) return
  try {
    await invoke('dsh_rpc', { method: 'session.cancel', payload: { sessionId: chat.sessionId } })
    chat.busy = false
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
  }
}

/** 回应审批 / 提问。不回的话那次工具调用会一直挂着。 */
export async function respondPending(optionId: string) {
  const p = chat.pending
  if (!p) return
  chat.pending = null
  try {
    const value = p.kind === 'approval' ? { decision: optionId } : { answer: optionId }
    await invoke('dsh_respond', { rpcId: p.rpcId, value })
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: `回应失败：${e}` })
  }
}

// ── 凭据 ──────────────────────────────────────────────
//
// 走 DSH 自己的 credentials 接口,不去手改 ~/.dsh/.credentials.yaml:
//  · describe **永远不返回值**,只说「配没配、来自哪一层、能不能改」——
//    我们因此永远不持有用户的密钥,界面上也没法泄露
//  · 受管存储的优先级高于两个 .env 层,所以这里写进去会立刻生效
//  · 但**进程环境变量层是只读的**:启动时如果 shell 里有 DEEPSEEK_API_KEY,
//    它会盖住我们写的值,此时 set 会被拒(writable=false),必须如实告诉用户

export type CredentialView = {
  configured: boolean
  source?: string
  writable: boolean
}

/** 目前只关心这几个;以后接别家模型再往里加 */
export const CREDENTIAL_REFS = [
  { ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { ref: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { ref: 'OPENAI_API_KEY', label: 'OpenAI' },
] as const

export async function describeCredentials(): Promise<Record<string, CredentialView>> {
  const v = await invoke<any>('dsh_rpc', {
    method: 'credentials.describe',
    payload: { refs: CREDENTIAL_REFS.map((c) => c.ref) },
  })
  return v?.credentials ?? {}
}

export async function setCredential(ref: string, value: string) {
  await invoke('dsh_rpc', { method: 'credentials.set', payload: { ref, value } })
}

export async function unsetCredential(ref: string) {
  await invoke('dsh_rpc', { method: 'credentials.unset', payload: { ref } })
}

// ── 模型 ──────────────────────────────────────────────

export type ModelOption = {
  provider: string
  model: string
  label: string
  reasoningOptions: { id: string; label: string }[]
}

export const models = reactive<{
  current: { provider: string; model: string; reasoningEffort?: string } | null
  routable: boolean
  options: ModelOption[]
  loading: boolean
}>({ current: null, routable: true, options: [], loading: false })

export async function loadModels() {
  if (!chat.sessionId || models.loading) return
  models.loading = true
  try {
    const v = await invoke<any>('dsh_rpc', {
      method: 'session.models',
      payload: { sessionId: chat.sessionId },
    })
    models.current = v?.current ?? null
    models.routable = v?.routable !== false
    const out: ModelOption[] = []
    for (const g of v?.groups ?? []) {
      for (const m of g?.models ?? []) {
        out.push({
          provider: String(g.provider ?? m.provider ?? ''),
          model: String(m.id ?? m.model ?? ''),
          label: String(m.name ?? m.id ?? ''),
          reasoningOptions: (m.reasoningOptions ?? m.reasoning_options ?? []).map((r: any) => ({
            id: String(r.id ?? r), label: String(r.name ?? r.label ?? r.id ?? r),
          })),
        })
      }
    }
    models.options = out
  } catch (e) {
    console.error('读模型列表失败:', e)
  } finally {
    models.loading = false
  }
}

export async function selectModel(provider: string, model: string, reasoningEffort?: string) {
  if (!chat.sessionId) return
  try {
    await invoke('dsh_rpc', {
      method: 'session.selectModel',
      payload: { sessionId: chat.sessionId, selection: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } },
    })
    await loadModels()
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
  }
}

/** 当前模型的显示名。没读到就显示占位,别显示空白。 */
export const currentModelLabel = computed(() => {
  const c = models.current
  if (!c) return '—'
  const hit = models.options.find((o) => o.provider === c.provider && o.model === c.model)
  return hit?.label ?? c.model
})

// ── 会话管理 ──────────────────────────────────────────

/**
 * 置顶存在本地,不进 DSH。
 * DSH 的会话模型里没有「置顶」这个概念,硬塞进它的 workspace 会和上游打架;
 * 而且置顶纯粹是这台机器上这个人的偏好,本来就该留在本地。
 */
const PIN_KEY = 'xgtools.dsh.pinned'

function readPins(): string[] {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) ?? '[]') } catch { return [] }
}

export const pinned = reactive<{ ids: string[] }>({ ids: readPins() })

export function togglePin(sessionId: string) {
  pinned.ids = pinned.ids.includes(sessionId)
    ? pinned.ids.filter((x) => x !== sessionId)
    : [sessionId, ...pinned.ids]
  try { localStorage.setItem(PIN_KEY, JSON.stringify(pinned.ids)) } catch { /* 隐私模式下写不了,不影响用 */ }
}

export async function renameSession(sessionId: string, title: string) {
  try {
    await invoke('dsh_rpc', { method: 'session.rename', payload: { sessionId, title } })
    await loadSessions()
  } catch (e) {
    console.error('重命名失败:', e)
    throw e
  }
}

/**
 * 删除会话。
 *
 * DSH 的 API Proxy **没有 session.delete** —— 它提供的是
 * `workspace.archiveSession`(归档),会话日志仍留在磁盘上。
 * 所以这里叫「移除」而不是「删除」,界面文案也不能承诺彻底抹掉。
 */
export async function archiveSession(sessionId: string) {
  try {
    await invoke('dsh_rpc', { method: 'workspace.archiveSession', payload: { sessionId } })
  } catch (e) {
    console.error('归档失败:', e)
    throw e
  }
  if (chat.sessionId === sessionId) {
    chat.sessionId = ''
    chat.items = []
  }
  pinned.ids = pinned.ids.filter((x) => x !== sessionId)
  await loadSessions()
}
