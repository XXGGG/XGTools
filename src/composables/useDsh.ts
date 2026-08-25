/**
 * DSH 边车的前端状态。
 *
 * 一份模块级单例:多个组件(智能体页、设置页、以后的插件商店)看到的必须是同一个边车,
 * 不能各自 invoke 一遍各拿各的。
 *
 * 状态从两处来,缺一不可:
 *   · 主动 `dsh_status()` —— 组件挂载时补一次,否则切页回来会停在初始值;
 *   · 被动 `dsh://state` 事件 —— 启动是异步的,Rust 那边阶段一变就推过来。
 */
import { reactive, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type DshPhase = 'stopped' | 'starting' | 'ready' | 'failed'

export type DshState = {
  phase: DshPhase
  url: string
  message: string
  pid: number | null
}

export type DshPreflight = {
  nodeVersion: string | null
  nodeOk: boolean
  pnpmVersion: string | null
  dshEntry: string | null
}

export const dsh = reactive<{
  state: DshState
  pre: DshPreflight | null
  installing: boolean
  /** 安装输出的最后一行,给进度用 —— 整份日志没必要留在内存里 */
  installLine: string
}>({
  state: { phase: 'stopped', url: '', message: '', pid: null },
  pre: null,
  installing: false,
  installLine: '',
})

/** 装好了没:node 够新 + dsh 入口文件在 */
export const dshUsable = computed(() => !!dsh.pre?.nodeOk && !!dsh.pre?.dshEntry)

let initPromise: Promise<void> | null = null

/**
 * 只初始化一次,但**并发调用要等同一个 promise**,不能提前返回。
 *
 * 踩过的坑:早先写成 `if (wired) return`。Agent.vue 是 App.vue 的子组件,
 * 子组件的 onMounted 先于父组件触发 —— 它抢先把标志位置真并开始 await,
 * 等 App.vue 的 autoStartDsh 跑到时,initDsh() 立刻返回了,而这时 `dsh.pre`
 * 还是 null,dshUsable 为假,边车就永远不会自动启动。
 * 现象是"装好了但开机不自动跑",而且看不出任何报错。
 */
export function initDsh(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await listen<DshState>('dsh://state', (e) => { dsh.state = e.payload })
      await listen<string>('dsh://install-log', (e) => { dsh.installLine = e.payload })
      await refreshDsh()
    })()
  }
  return initPromise
}

export async function refreshDsh() {
  try {
    dsh.pre = await invoke<DshPreflight>('dsh_preflight')
    dsh.state = await invoke<DshState>('dsh_status')
  } catch (e) {
    console.error('读 DSH 状态失败:', e)
  }
}

export async function installDsh() {
  if (dsh.installing) return
  dsh.installing = true
  dsh.installLine = ''
  try {
    await invoke<string>('dsh_install')
    await refreshDsh()
  } catch (e) {
    dsh.state = { phase: 'failed', url: '', message: String(e), pid: null }
  } finally {
    dsh.installing = false
  }
}

export type DshFootprint = {
  installBytes: number
  homePath: string | null
  homeBytes: number
  sessionCount: number
  hasCredentials: boolean
}

export async function dshFootprint(): Promise<DshFootprint | null> {
  try {
    return await invoke<DshFootprint>('dsh_footprint')
  } catch (e) {
    console.error('读 DSH 占用失败:', e)
    return null
  }
}

export async function uninstallDsh(purgeHome: boolean) {
  await invoke('dsh_uninstall', { purgeHome })
  await refreshDsh()
}

/** 字节数变成人话。卸载确认框里必须给真实数字 —— 只说「会清除记忆」用户没法判断轻重。 */
export function humanSize(bytes: number): string {
  if (bytes <= 0) return '0 MB'
  const mb = bytes / 1048576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

export async function startDsh() {
  try {
    dsh.state = await invoke<DshState>('dsh_start')
  } catch (e) {
    dsh.state = { phase: 'failed', url: '', message: String(e), pid: null }
  }
}

export async function stopDsh() {
  try {
    dsh.state = await invoke<DshState>('dsh_stop')
  } catch (e) {
    console.error('停 DSH 失败:', e)
  }
}

/**
 * 应用启动时调用:环境齐了就自动把边车拉起来。
 *
 * 「打开 XGTools 就是打开智能体」—— 所以这里不问用户,直接起。
 * 环境不齐(没 Node / 没装 DSH)就什么都不做,让界面去引导,别在启动路径上弹东西。
 */
export async function autoStartDsh() {
  await initDsh()
  if (dshUsable.value && dsh.state.phase === 'stopped') await startDsh()
}

// ── 可选插件 ──────────────────────────────────────────
//
// 这些是 **DSH 的插件**,不是 XGTools 的功能。装上之后模型多一个能力,
// 我们的界面一行都不用改 —— 这正是「一切皆插件」的好处。

export type PluginState = { package: string; id: string; installed: boolean }

/** 插件的说明由我们写,不从包里读 —— 包的 README 是英文长文,不适合摆在设置页 */
export const PLUGIN_INFO: Record<string, { name: string; desc: string }> = {
  'claude-code': {
    name: 'Claude Code',
    desc: '把本机装好的 Claude Code 当子智能体使唤。走它自己的登录态，不需要额外的 API 密钥。',
  },
  codex: {
    name: 'Codex',
    desc: '把本机装好的 Codex CLI 当子智能体使唤。',
  },
}

export async function listPlugins(): Promise<PluginState[]> {
  try { return await invoke<PluginState[]>('dsh_plugins') }
  catch (e) { console.error('读插件状态失败:', e); return [] }
}

export async function addPlugin(pkg: string) {
  await invoke('dsh_plugin_add', { package: pkg })
}
