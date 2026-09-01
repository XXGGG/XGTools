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

/** 提给用户的一个选项。`description` 是给有能力的界面用的补充说明。 */
export type QuestionOption = { label: string; description?: string }

/**
 * 一个提给用户的问题。
 *
 * `intent` 是**呈现意图**:调用方声明「这个问题本质上是哪一类决定」,认得的界面
 * 就按那类决定去画,不认得的照常画成一串选项 —— 两种画法回给模型的答案一模一样。
 * 目前只有 `plan-review`(评审一份计划),`approve` 指名哪个选项代表批准
 * (指名而不是靠顺序,免得界面从选项排序里猜错结论)。
 */
export type QuestionItem = {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}

/**
 * 需要用户拍板的事。挂着不回,那次工具调用就永远卡住。
 *
 * 两类的**回法完全不同**,所以分开建模而不是塞进一个泛化的「选项列表」:
 *  · 审批回 `{ sessionId, approvalId, outcome }`
 *  · 提问回 `{ answers: [{ id, selected: [选项文字] }] }` —— 注意 selected 里是
 *    **选项的文字**,不是下标也不是 id
 */
export type Pending =
  | { kind: 'approval'; rpcId: string; sessionId: string; approvalId: string; toolName: string; reason?: string }
  | { kind: 'question'; rpcId: string; sessionId: string; questions: QuestionItem[] }

export const chat = reactive<{
  sessionId: string
  items: ChatItem[]
  busy: boolean
  pending: Pending | null
  streams: Record<string, string>
  error: string
  /** 正在拉取旧会话的历史。不标出来的话,打开大会话是几秒白屏,像卡死了 */
  loadingHistory: boolean
}>({
  sessionId: '',
  items: [],
  busy: false,
  pending: null,
  streams: {},
  loadingHistory: false,
  error: '',
})

/**
 * 会话的**当前值**,不是消息流。
 *
 * DSH 把这类东西叫「投影」:它们由日志回放折叠而来,所以刷新、换机器、冷启动都能
 * 只凭日志恢复。两条来路,缺一不可:
 *  · 打开会话时 `session.history` 的尾页带一份全量(`projections.values`)
 *  · 之后每变一次推一帧 `session/projection`,只带变了的那一个 key
 */
export const projections = reactive({
  /** 计划模式:active 是已记录的状态,pending 是「选了但还没到生效时机」 */
  plan: { active: false, pending: false },
  /** 这一轮上下文吃了多少 token */
  tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  /** 上下文由哪几块构成(系统提示词 / 工具 schema / 消息) */
  breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
  /** 离压缩还有多远。字段由上游定,原样存着给界面挑 */
  pressure: {} as Record<string, unknown>,
})

/** 换会话时清干净 —— 上一篇的用量和计划状态不能挂在新会话头上 */
function resetProjections() {
  // 空态选过计划模式的,别在建会话的一瞬间把开关闪回去
  projections.plan.active = planWanted ?? false
  projections.plan.pending = false
  projections.tokens = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  projections.breakdown = { systemTokens: 0, toolsTokens: 0, messageTokens: 0 }
  projections.pressure = {}
}

function applyProjection(key: string, value: any) {
  if (value == null) return
  switch (key) {
    case 'plan':
      projections.plan.active = !!value.active
      projections.plan.pending = !!value.pending
      break
    case 'tokenUsage':
      Object.assign(projections.tokens, value)
      break
    case 'contextBreakdown':
      Object.assign(projections.breakdown, value)
      break
    case 'contextPressure':
      projections.pressure = value
      break
    default:
      break   // 别的 key(todos、subagent…)以后要用再接
  }
}

/** 打开会话时把尾页带来的那一份全量投影铺进去 */
function applyProjectionBlock(block: any) {
  const values = block?.values
  if (!values || typeof values !== 'object') return
  for (const [k, v] of Object.entries(values)) applyProjection(k, v)
}

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

  const p = frame.payload ?? {}

  /*
    需要人拍板的两类。**只有这两类才回 rpcId** —— 给通知回 /api/respond
    会拿到 not-pending,无害但纯属白跑。
  */
  if (method === 'approval/requested') {
    chat.pending = {
      kind: 'approval',
      rpcId: frame.rpcId,
      sessionId: String(p.sessionId ?? ''),
      approvalId: String(p.approvalId ?? ''),
      toolName: String(p.toolName ?? '工具'),
      reason: p.reason ? String(p.reason) : undefined,
    }
    return
  }

  if (method === 'question/requested') {
    const qs = (Array.isArray(p.questions) ? p.questions : []).map((q: any): QuestionItem => ({
      id: String(q?.id ?? ''),
      question: String(q?.question ?? ''),
      header: q?.header ? String(q.header) : undefined,
      detail: q?.detail ? String(q.detail) : undefined,
      options: Array.isArray(q?.options)
        ? q.options.map((o: any) => ({ label: String(o?.label ?? ''), description: o?.description ? String(o.description) : undefined }))
        : undefined,
      multiSelect: !!q?.multiSelect,
      intent: q?.intent?.kind === 'plan-review'
        ? { kind: 'plan-review', approve: String(q.intent.approve ?? '') }
        : undefined,
    }))
    if (qs.length) {
      chat.pending = { kind: 'question', rpcId: frame.rpcId, sessionId: String(p.sessionId ?? ''), questions: qs }
    }
    return
  }

  // 别处答了、或者被取消了 —— 我们这边的卡片要跟着收掉,不能一直杵着
  if (method === 'approval/resolved' || method === 'question/resolved') {
    chat.pending = null
    return
  }

  /*
    投影帧:token 用量、plan 状态这些**不是消息**,是会话的当前值。
    每次只推变了的那一个 key,所以这里按 key 覆盖,不整份替换。
  */
  if (method === 'session/projection') {
    applyProjection(String(p.key ?? ''), p.value)
    return
  }

  if (method !== 'session/event') return   // queue / jobs 等暂不渲染

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

    case 'plan/mode':
      // 计划模式是会话事件:命令改的、工具退出改的,都从这里跟上
      projections.plan.active = !!data?.active
      projections.plan.pending = false
      break

    case 'permission/preset':
      // 权限档位是会话事件,谁改的(命令、别的客户端)这里都能跟上
      permission.preset = String(data?.preset ?? '')
      break

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
  /*
    换了个地址重连,上一轮的报错就是历史了。

    不清的话现象很怪:边车自己重启好了、绿灯也亮了,底下却一直挂着
    「连接被拒绝」—— 那句话是边车没了的时候某次请求留下的,
    没人再去擦掉它。用户看到绿灯配红字,只会以为还没好。
  */
  chat.error = ''
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
    /*
      session.list 回的是**所有**会话 —— 包括已经归档的。
      「谁被归档了」记在 workspace.list 的 archivedSessionIds 里,DSH 自己的
      界面就是拿它做减法。我们以前只拉了前一半,于是「移除」点了、RPC 也成功了,
      刷回来的列表还是原样 —— 表现就是**会话怎么都删不掉**。
    */
    const [v, w] = await Promise.all([
      invoke<any>('dsh_rpc', { method: 'session.list', payload: {} }),
      invoke<any>('dsh_rpc', { method: 'workspace.list', payload: {} }),
    ])
    const archived = new Set<string>((w?.archivedSessionIds ?? []).map(String))
    sessions.rows = (v?.items ?? [])
      // blank = 一轮都没跑过的空会话。DSH 自己的约定就是列表里不显示它们,
      // 否则每点一次「新会话」就多一条永远空着的记录。
      .filter((s: any) => !s?.blank)
      .filter((s: any) => !archived.has(String(s?.sessionId)))
      // 子代理跑出来的会话不进主列表 —— 它们是某次任务的内部产物,
      // 混进来会看到一堆自己没发起过的对话
      .filter((s: any) => s?.origin !== 'subagent')
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
  resetProjections()
  chat.loadingHistory = true
  try {
    const v = await invoke<any>('dsh_rpc', {
      method: 'session.history',
      payload: { sessionId, maxMessages: 100 },
    })
    // 中途点开了别的会话:这份回来晚了,别把人家的界面覆盖掉
    if (chat.sessionId !== sessionId) return
    for (const entry of v?.events ?? []) {
      if (entry?.event) applyEvent(entry.event)
    }
    sealAssistant()   // 历史里最后一段不该留着流式光标
    // 计划模式、token 用量这些不在事件里,在尾页的投影块里
    applyProjectionBlock(v?.projections)
    void loadCommands()
  } catch (e) {
    chat.error = String(e)
  } finally {
    if (chat.sessionId === sessionId) chat.loadingHistory = false
  }
}

export async function newSession(cwd?: string) {
  chat.items = []
  chat.pending = null
  chat.error = ''
  resetProjections()
  try {
    // 签名:create({ workspaceId?, cwd?, sessionId?, agentPreset? }) -> { sessionId }
    // workspaceId 和 cwd 互斥,协议规定只能给一个
    const payload: Record<string, unknown> = cwd
      ? { cwd }
      : (workspaces.pendingId ? { workspaceId: workspaces.pendingId } : {})
    if (presets.current) payload.agentPreset = presets.current
    const v = await invoke<any>('dsh_rpc', {
      method: 'session.create',
      payload,
    })
    chat.sessionId = String(v?.sessionId ?? '')
    if (!chat.sessionId) chat.error = '创建会话没有返回 sessionId'
    if (chat.sessionId) {
      void loadCommands()
      void applyPlanWanted()
    }
    // 空态时选过模型的话,现在有会话了,补交上去
    if (chat.sessionId && pendingSelection) {
      const sel = pendingSelection
      pendingSelection = null
      await selectModel(sel.provider, sel.model, sel.reasoningEffort)
    }
  } catch (e) {
    chat.error = String(e)
  }
}

export async function sendPrompt(text: string, images: { mediaType: string; data: string }[] = []) {
  if (!text.trim() && !images.length) return
  if (!chat.sessionId) await newSession()
  if (!chat.sessionId) return

  chat.items.push({
    kind: 'user',
    id: nextId(),
    text: images.length ? `${text}${text ? ' ' : ''}[${images.length} 张图]` : text,
  })
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
        /*
          图片和文字并排放在 content 里,不是消息之外的挂件。
          放在文字**后面**:先说要干什么,再给材料,和人说话的顺序一致。
        */
        content: [
          ...(text.trim() ? [{ type: 'text', text }] : []),
          ...images.map((im) => ({ type: 'image', mediaType: im.mediaType, data: im.data })),
        ],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    })
  } catch (e) {
    chat.busy = false
    /*
      模型不认图片是最常撞的一种:换个会看图的模型就好,
      但原文是英文的 MODEL_DOES_NOT_SUPPORT_IMAGES,得翻出来说。
    */
    const msg = String(e)
    chat.items.push({
      kind: 'notice',
      id: nextId(),
      text: /DOES_NOT_SUPPORT_IMAGES|does not support image/i.test(msg)
        ? '这个模型看不了图片，换一个支持看图的模型再发。'
        : msg,
    })
  }

  /*
    空态选过权限档位的,现在补发。

    **必须排在用户第一句之后。** DSH 拿会话的第一条 prompt 生成标题,
    抢在前面发的话整条会话会被命名成「Read-only mode set」——
    用户问的那句反而不见了。
  */
  if (chat.sessionId && permission.pending) {
    const want = permission.pending
    permission.pending = ''
    await selectPermission(want)
  }

  // 标题是发出第一条之后才由 Host 生成的,所以这里补一次列表刷新;
  // 稍等一下再拉,给它生成标题的时间
  setTimeout(loadSessions, 2500)
}

/**
 * 斜杠命令。
 *
 * **不要写成 `session.prompt` 里发一句 `/plan`。** 那条路是「用户说了句话」,
 * DSH 会拿它去生成会话标题(整条会话叫「Read-only mode set」就是这么来的),
 * 而且它得先经过一轮模型。命令有自己的通道:直接执行、立刻回结果、不进对话。
 *
 * 参数形状是 `{ args: { … } }` —— 这一层信封省不掉,少了它 DSH 回
 * 「Remote payload must contain exactly one plain-object args field」。
 */
export const commands = reactive<{
  list: { name: string; description: string; input?: { hint: string; images?: boolean } }[]
}>({ list: [] })

export async function loadCommands() {
  if (!chat.sessionId) return
  try {
    const v = await invoke<any[]>('dsh_rpc', {
      method: 'commands/list',
      payload: { args: { agentId: chat.sessionId } },
    })
    commands.list = Array.isArray(v) ? v : []
  } catch {
    commands.list = []   // 拿不到命令表不该拦住别的事
  }
}

/** 跑一条命令。回的是它的执行结果,成功失败都在里面 */
export async function runCommand(line: string): Promise<{ kind: string; text: string } | null> {
  if (!chat.sessionId) return null
  try {
    const v = await invoke<any>('dsh_rpc', {
      method: 'commands/execute',
      payload: { args: { agentId: chat.sessionId, line, images: [] } },
    })
    const r = v?.result ?? {}
    return { kind: String(r.kind ?? 'success'), text: String(r.text ?? '') }
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
    return null
  }
}

/**
 * 开关计划模式。
 *
 * 先把界面翻过去(乐观),真实状态随后由 `plan/mode` 事件盖回来 —— 命令要走一趟
 * 后端,不先翻的话按下去半秒没反应,像没点上。
 */
export async function togglePlan() {
  const want = !projections.plan.active
  projections.plan.active = want

  /*
    空态还没有会话,命令没地方发。记着,等会话建出来立刻补上 ——
    和「先选好权限再说第一句」一个道理:用户是先定好怎么配合,再开口的。
  */
  if (!chat.sessionId) {
    planWanted = want
    return
  }

  const r = await runCommand(want ? '/plan' : '/plan off')
  if (!r || r.kind === 'error') projections.plan.active = !want
  else if (r.text) chat.items.push({ kind: 'notice', id: nextId(), text: r.text })
}

/** 空态选过的计划模式,等会话建出来再补发 */
let planWanted: boolean | null = null

async function applyPlanWanted() {
  if (planWanted === null || !chat.sessionId) return
  const want = planWanted
  planWanted = null
  // 命令不是对话内容,不会被拿去起标题,所以建完会话立刻补就行
  const r = await runCommand(want ? '/plan' : '/plan off')
  if (!r || r.kind === 'error') projections.plan.active = !want
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

/** 批准 / 拒绝一次工具调用 */
export async function answerApproval(allow: boolean) {
  const p = chat.pending
  if (p?.kind !== 'approval') return
  chat.pending = null
  await respond(p.rpcId, {
    sessionId: p.sessionId,
    approvalId: p.approvalId,
    outcome: allow ? 'allowed-once' : 'rejected',
  })
}

/**
 * 回答一组问题。
 *
 * `selected` 里放的是**选项的文字**,不是 id 也不是下标 —— 协议就这么定的,
 * 模型那边读到的也是这几个字。自由输入走 `custom`,可以和选项并存。
 */
export async function answerQuestions(answers: { id: string; selected: string[]; custom?: string }[]) {
  const p = chat.pending
  if (p?.kind !== 'question') return
  chat.pending = null
  await respond(p.rpcId, { answers })
}

async function respond(rpcId: string, value: unknown) {
  try {
    await invoke('dsh_respond', { rpcId, value })
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

/**
 * 还没有会话时选中的模型,等会话建出来再补交。
 *
 * 空态页(还没聊过)也有那颗模型按钮 —— 而 session.selectModel 必须有会话。
 * 不记下来的话,用户在空态选的模型会被第一句话建出的会话默默无视。
 */
let pendingSelection: { provider: string; model: string; reasoningEffort?: string } | null = null

export async function loadModels() {
  if (models.loading) return
  models.loading = true
  try {
    /*
      有会话走 session.models(带 current/routable);
      没会话走 llm.models —— 它不要会话,回的是同一份 groups。
      以前这里直接 return,表现就是**刚打开应用模型下拉永远是空的**,
      要先随便聊一句才选得了模型。
    */
    const v = await invoke<any>('dsh_rpc', chat.sessionId
      ? { method: 'session.models', payload: { sessionId: chat.sessionId } }
      : { method: 'llm.models', payload: {} })
    /*
      空态(llm.models 没有 current)按这个顺序找该显示谁:
      刚才手选的 → **部署默认模型**。默认模型存在 DSH 设置的
      agent-default-model 里 —— 原版空态就直接亮着它,我们对标。
    */
    models.current = v?.current ?? pendingSelection ?? (chat.sessionId ? null : await readDefaultModel())
    models.routable = v?.routable !== false
    const out: ModelOption[] = []
    for (const g of v?.groups ?? []) {
      for (const m of g?.models ?? []) {
        out.push({
          // 组的 provider 标识在 id 字段(name 是显示名)。以前猜的 g.provider
          // 根本不存在,空串一路写进「设为默认」,把路由都断了
          provider: String(g.id ?? g.provider ?? m.provider ?? ''),
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

/** 读 DSH 的部署默认模型(settings 的 agent-default-model 段) */
async function readDefaultModel(): Promise<{ provider: string; model: string; reasoningEffort?: string } | null> {
  try {
    const v = await invoke<any>('dsh_rpc', { method: 'settings.describe', payload: {} })
    const ns = (v?.namespaces ?? []).find((n: any) => n?.ns === 'agent-default-model')
    // 协议里这一段叫 value(合成后的生效值,含默认层)
    const val = ns?.value ?? null
    if (val?.model) {
      return {
        provider: String(val.provider ?? ''),
        model: String(val.model),
        ...(val.reasoningEffort ? { reasoningEffort: String(val.reasoningEffort) } : {}),
      }
    }
  } catch { /* 读不到就显示 —,不值得报错 */ }
  return null
}

/**
 * 把某个模型设为**默认**(写进 DSH 设置,和原版的设置页同一个开关)。
 *
 * 和 selectModel 的区别:selectModel 只管当前会话,默认模型管以后每个新会话。
 */
export async function setDefaultModel(provider: string, model: string, reasoningEffort?: string) {
  try {
    await invoke('dsh_rpc', {
      method: 'settings.update',
      payload: {
        ns: 'agent-default-model',
        /*
          没有推理档位就**整个字段不给**,不能写 null ——
          DSH 那边这个 namespace 有 schema,null 过不了校验,整层回退到
          部署默认值。表现是「设了默认模型,新会话却还是老模型」。
        */
        patch: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      },
    })
    if (!chat.sessionId) models.current = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
  }
}

export async function selectModel(provider: string, model: string, reasoningEffort?: string) {
  // 还没有会话:先记着,newSession 成功后补交(见 pendingSelection)
  if (!chat.sessionId) {
    pendingSelection = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    models.current = pendingSelection
    return
  }
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

// ── 模式(agent preset)、工作区、访问权限 ──────────────

/*
  这三样和模型一样,都是「空态先选好、第一句话才生效」的东西:
  模式和工作区是 session.create 的入参,权限是建完会话补发的 /permission 命令。
  各自记一个 pending,newSession 里统一兑现。
*/
export const presets = reactive<{
  options: { id: string; name: string; description: string; isDefault: boolean; broken?: string }[]
  /** 当前会话在用的预设 id;空态时是待用的那一个 */
  current: string
  loading: boolean
}>({ options: [], current: '', loading: false })

export async function loadPresets() {
  if (presets.loading) return
  presets.loading = true
  try {
    const v = await invoke<any>('dsh_rpc', { method: 'agentPreset.list', payload: {} })
    presets.options = (v?.presets ?? [])
      .filter((p: any) => !p?.broken)   // 坏的列出来也选不了,反而像 bug
      .map((p: any) => ({
        id: String(p.id),
        name: String(p.name ?? p.id),
        description: String(p.description ?? ''),
        isDefault: !!p.isDefault,
      }))
    if (!presets.current) {
      presets.current = presets.options.find((p) => p.isDefault)?.id ?? presets.options[0]?.id ?? ''
    }
  } catch (e) {
    console.error('读模式列表失败:', e)
  } finally {
    presets.loading = false
  }
}

export async function selectPreset(id: string) {
  if (!chat.sessionId) {
    presets.current = id
    return
  }
  try {
    // 只对还没跑过的空会话有效 —— 跑过的会话预设已经定了,DSH 会拒
    await invoke('dsh_rpc', { method: 'agentPreset.select', payload: { sessionId: chat.sessionId, agentPreset: id } })
    presets.current = id
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
  }
}

export const workspaces = reactive<{
  items: { workspaceId: string; path: string; title: string }[]
  /** 空态选中的工作区;空串 = 跟 DSH 的默认走 */
  pendingId: string
  loading: boolean
}>({ items: [], pendingId: '', loading: false })

export async function loadWorkspaces() {
  if (workspaces.loading) return
  workspaces.loading = true
  try {
    const v = await invoke<any>('dsh_rpc', { method: 'workspace.list', payload: {} })
    workspaces.items = (v?.items ?? []).map((w: any) => ({
      workspaceId: String(w.workspaceId),
      path: String(w.path ?? ''),
      title: String(w.title ?? w.path ?? ''),
    }))
  } catch (e) {
    console.error('读工作区列表失败:', e)
  } finally {
    workspaces.loading = false
  }
}

/** 选个文件夹当新工作区。走 DSH 的原生目录选择器,和原版一个入口 */
export async function addWorkspace(): Promise<boolean> {
  try {
    const picked = await invoke<any>('dsh_rpc', { method: 'host.pickDirectory', payload: {} })
    if (!picked?.path) return false
    const v = await invoke<any>('dsh_rpc', { method: 'workspace.create', payload: { path: picked.path } })
    await loadWorkspaces()
    if (v?.workspace?.workspaceId) workspaces.pendingId = String(v.workspace.workspaceId)
    return true
  } catch (e) {
    chat.items.push({ kind: 'notice', id: nextId(), text: String(e) })
    return false
  }
}

/**
 * 访问权限档位。写死三档 —— 这是 DSH 部署配置里声明的那三个预设名,
 * 切换走 /permission 命令(原版的「工作区可写」下拉背后就是它)。
 */
export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const permission = reactive<{ preset: string; pending: string }>({
  preset: '',
  pending: '',
})

export async function selectPermission(name: string) {
  if (!chat.sessionId) {
    // 没会话:记着,newSession 建出来后补发命令
    permission.pending = name
    permission.preset = name
    return
  }
  /*
    走命令通道,不再伪装成一句用户发言。
    以前是 session.prompt 发 `/permission x`:那条路会被 DSH 当成对话内容,
    抢在用户第一句前面时整条会话会被命名成「Read-only mode set」。
  */
  const r = await runCommand(`/permission ${name}`)
  if (r && r.kind !== 'error') permission.preset = name
}

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
