/**
 * 点「设置」直接落到当前页对应的那一栏：在笔记页点就进「笔记」，在翻译页点就进「翻译」。
 * 没有专属设置的页面落到「常规」。页面里自己的设置按钮也走 openSettings。
 */
import { ref } from 'vue'
import { emit } from '@tauri-apps/api/event'

/** 设置页当前停在哪一栏（Settings.vue 的 Tabs 绑的就是它） */
export const settingsTab = ref('general')

const TAB_OF_VIEW: Record<string, string> = {
  Vault: 'vault',
  Translate: 'translate',
}

export const settingsTabFor = (view: string) => TAB_OF_VIEW[view] ?? 'general'

/** 跳到设置页的某一栏（复用命令面板的跳页事件，主窗口在听） */
export async function openSettings(tab: string) {
  settingsTab.value = tab
  await emit('palette-go', { view: 'Settings' })
}
