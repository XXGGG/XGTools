/**
 * Skills 页的数据（模块级单例：离开页面再回来不用重扫）。
 *
 * 扫描要读用户本机的 skill 文件夹和对话记录，所以**默认不扫**（2026-10-28 用户定的）：
 * 第一次进页面只给一个「扫描」按钮，用户按过一次就记住，以后每次开软件自动刷新一次；
 * 页面上能随时把自动扫描关掉。开关和自选文件夹都只存在本机 localStorage。
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export type SkillAgent = { id: string; name: string; dir: string; exists: boolean }
export type Skill = {
  name: string
  description: string
  path: string
  enabled_in: string[]
  copy_in: string[]
  linked_in: string[]
  folder: string
  files: string[]
}
export type SkillFolder = { path: string; exists: boolean; count: number }
export type SkillUsage = { count: number; last: string }

const FOLDERS_KEY = 'xg.skills.folders'
const AUTO_KEY = 'xg.skills.autoScan'

function loadFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const folderPaths = ref<string[]>(loadFolders())
export const autoScan = ref(localStorage.getItem(AUTO_KEY) === '1')
/** 这次开软件以来扫过没有。没扫过时页面显示「扫描」按钮，而不是一张空目录 */
export const scanned = ref(false)

export const agents = ref<SkillAgent[]>([])
export const folders = ref<SkillFolder[]>([])
export const skills = ref<Skill[]>([])
export const usage = ref<Record<string, Record<string, SkillUsage>>>({})
export const scanning = ref(false)
export const counting = ref(false)
export const error = ref('')

export async function scanSkills() {
  scanning.value = true
  error.value = ''
  try {
    const r = await invoke<{ agents: SkillAgent[]; folders: SkillFolder[]; skills: Skill[] }>('skills_scan', { folders: folderPaths.value })
    agents.value = r.agents
    folders.value = r.folders
    skills.value = r.skills
    scanned.value = true
  } catch (e) {
    error.value = String(e)
  } finally {
    scanning.value = false
  }
}

export async function countSkillUsage() {
  counting.value = true
  try {
    usage.value = await invoke('skills_usage')
  } catch (e) {
    error.value = String(e)
  } finally {
    counting.value = false
  }
}

export function refreshSkills() {
  return Promise.all([scanSkills(), countSkillUsage()])
}

export function setAutoScan(on: boolean) {
  autoScan.value = on
  localStorage.setItem(AUTO_KEY, on ? '1' : '0')
}

/** 软件启动时调一次：开着自动扫描就在后台刷新，不开就什么都不做 */
export function autoRefreshSkills() {
  if (autoScan.value && !scanned.value && !scanning.value) void refreshSkills()
}

export function saveFolders(list: string[]) {
  folderPaths.value = list
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(list))
}
