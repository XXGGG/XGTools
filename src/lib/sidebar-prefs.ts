/**
 * 侧栏功能页的清单与「存档 × 代码清单」对账逻辑。
 *
 * 单独拆出来是因为这是唯一纯逻辑、可断言的部分:存档里可能有代码里已删掉的页,
 * 代码里也可能有存档之后新增的页,两边必须对得上,否则加一个工具页就会因为旧存档而不显示。
 */

export type MenuGroup = 'tool' | 'config'
/** label 是 i18n 的键(见 i18n/zh.ts 的 nav 段),不是可以直接显示的文字 */
export type MenuItem = { id: string; labelKey: string; icon: string; group: MenuGroup }
export type SidebarPrefs = { order: string[]; hidden: string[] }

/**
 * 侧栏功能页的唯一真相源。加工具页只改这里。
 *
 * 「习惯打卡」(views/Habits.vue + components/todo/)代码保留但不接入口 —— 是刻意隐藏,不是漏了。
 * 要放回来:在这里加回 { id: 'Habits', icon: 'icon-[lucide--flame]' },
 * 并在 App.vue 的视图链里加回 <HabitsView v-else-if="currentView === 'Habits'" />。
 */
export const MENU_ITEMS: MenuItem[] = [
  // 上卡片:平时会打开来用的工具
  { id: 'Agent', labelKey: 'nav.agent', icon: 'icon-[ri--deepseek-line]', group: 'tool' },
  { id: 'Vault', labelKey: 'nav.vault', icon: 'icon-[arcticons--obsidian]', group: 'tool' },
  { id: 'Timer', labelKey: 'nav.timer', icon: 'icon-[lucide--timer]', group: 'tool' },
  { id: 'Translate', labelKey: 'nav.translate', icon: 'icon-[lucide--languages]', group: 'tool' },
  { id: 'Convert', labelKey: 'nav.convert', icon: 'icon-[lucide--refresh-ccw]', group: 'tool' },
  // 下卡片:后台功能的配置页,和最下面的应用设置挨在一起
  { id: 'Dock', labelKey: 'nav.dock', icon: 'icon-[lucide--layout-grid]', group: 'config' },
  { id: 'KeyboardPet', labelKey: 'nav.keyboard', icon: 'icon-[lucide--keyboard]', group: 'config' },
  { id: 'Screenshot', labelKey: 'nav.screenshot', icon: 'icon-[lucide--focus]', group: 'config' },
]

/**
 * 按分组切开,供侧栏渲染成上下两张卡片。已隐藏的项在上游已被 reconcile 过滤掉。
 * overrides 是用户在设置页跨组拖动后的结果(id → 组名),没有覆盖的就用代码里的默认分组。
 */
export function splitGroups(items: MenuItem[], overrides: Record<string, string> = {}) {
  const groupOf = (m: MenuItem): MenuGroup => {
    const o = overrides[m.id]
    return o === 'tool' || o === 'config' ? o : m.group
  }
  return {
    tools: items.filter((m) => groupOf(m) === 'tool'),
    configs: items.filter((m) => groupOf(m) === 'config'),
  }
}

/**
 * 按存档顺序排列全部项(不过滤隐藏)。
 * 存档里有的按存档序;存档里有但代码已删除的忽略;代码新增的插到它在代码里的位置上。
 *
 * 「插到代码位置」而不是「追加到末尾」:老存档里没有的新页,追加就一定排在最后,
 * 而新页未必是最不重要的那个 —— 加在 MENU_ITEMS 第一位的页,在老用户机器上会掉到底部。
 * 规则:找它在代码清单里前面最近的、已经排进结果的兄弟,插在那个兄弟后面;
 * 一个都找不到(它就是代码里的第一个)就插到最前面。用户自己拖过的顺序不受影响。
 */
export function orderedAll(all: MenuItem[], prefs: SidebarPrefs | null): MenuItem[] {
  if (!prefs?.order?.length) return [...all]
  const byId = new Map(all.map((m) => [m.id, m]))
  const out: MenuItem[] = []
  for (const id of prefs.order) {
    const m = byId.get(id)
    if (m) { out.push(m); byId.delete(id) }
  }
  // byId 里剩下的就是存档里没有的新页。按代码顺序逐个安置,
  // 先安置的会成为后面那个的锚点,所以同时新增多页也能保持它们在代码里的相对次序。
  for (let i = 0; i < all.length; i++) {
    const m = all[i]
    if (!byId.has(m.id)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((x) => x.id === all[j].id)
      if (k >= 0) { at = k + 1; break }
    }
    out.splice(at, 0, m)
    byId.delete(m.id)
  }
  return out
}

/**
 * 侧栏实际显示的项。
 * 允许全部关掉 —— 设置入口是常驻的(不在这个清单里),关光了也进得去,所以不需要兜底。
 */
export function reconcile(all: MenuItem[], prefs: SidebarPrefs | null): MenuItem[] {
  const hidden = new Set(prefs?.hidden ?? [])
  return orderedAll(all, prefs).filter((m) => !hidden.has(m.id))
}
