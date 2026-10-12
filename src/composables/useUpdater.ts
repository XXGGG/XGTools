/**
 * 自动更新（2026-10-12）。
 *
 * 新版本发在 GitHub Releases，每个 Release 带一份 latest.json（版本号、更新说明、安装包地址和签名）。
 * 这里去 tauri.conf.json 里 plugins.updater.endpoints 那个地址看有没有比自己新的；
 * 有就下载、校验签名（公钥在 tauri.conf.json，私钥只在发版的电脑上）、装好后重启。
 *
 * 模块级状态：主窗口启动时静默查一次，设置页「检查更新」按钮共用同一份结果。
 */
import { ref } from 'vue'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type UpdateState = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'

const state = ref<UpdateState>('idle')
const newVersion = ref('')
const notes = ref('')
const progress = ref(0)
const error = ref('')
/** 提示条被「稍后」关掉了：这次运行里不再弹 */
const dismissed = ref(false)
let pending: Update | null = null

async function checkForUpdate() {
  if (state.value === 'checking' || state.value === 'downloading') return
  state.value = 'checking'
  error.value = ''
  try {
    const u = await check()
    if (u) {
      pending = u
      newVersion.value = u.version
      notes.value = u.body ?? ''
      state.value = 'available'
    } else {
      state.value = 'latest'
    }
  } catch (e) {
    error.value = String(e)
    state.value = 'error'
  }
}

async function installUpdate() {
  if (!pending || state.value === 'downloading') return
  state.value = 'downloading'
  progress.value = 0
  let total = 0
  let got = 0
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data.contentLength ?? 0
      else if (ev.event === 'Progress') {
        got += ev.data.chunkLength
        progress.value = total ? Math.min(1, got / total) : 0
      } else if (ev.event === 'Finished') progress.value = 1
    })
    state.value = 'ready'
    // Windows 上安装器会自己把旧进程关掉；走到这里（其他平台）就手动重启
    await relaunch()
  } catch (e) {
    error.value = String(e)
    state.value = 'error'
  }
}

export function useUpdater() {
  return { state, newVersion, notes, progress, error, dismissed, checkForUpdate, installUpdate }
}
