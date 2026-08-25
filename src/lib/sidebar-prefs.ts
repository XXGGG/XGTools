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
 * 存档里有的按存档序;代码新增的追加到末尾;存档里有但代码已删除的忽略。
 */
export function orderedAll(all: MenuItem[], prefs: SidebarPrefs | null): MenuItem[] {
  if (!prefs?.order?.length) return [...all]
  const byId = new Map(all.map((m) => [m.id, m]))
  const out: MenuItem[] = []
  for (const id of prefs.order) {
    const m = byId.get(id)
    if (m) { out.push(m); byId.delete(id) }
  }
  for (const m of all) if (byId.has(m.id)) out.push(m)
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
