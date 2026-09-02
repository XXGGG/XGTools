/**
 * 项目 —— 工作台的骨架。**两层,不是三层。**
 *
 * ```
 * 项目类 (AI提示词)          ← 归类用的壳,不带配置
 *   └ 项目 (MiniMax H3)      ← 一个文件夹 + 一次对话。干活就在这一层
 * ```
 *
 * # 一个项目就是一次对话
 *
 * 不是「项目里再管一堆会话」—— 那是第三层,加进来只会让人多点两下才摸到内容。
 * 进了项目,左边是它的文件,右边就是跟它的那一轮对话,没有中间站。
 *
 * # 项目类为什么不带配置
 *
 * 想过给类挂 Skills,但 DSH 只认两个地方:全局 `~/.dsh/skills` 和项目文件夹里的
 * `.dsh/skills`,**没有「类」这一层**。要做只能由我们往类下每个项目文件夹里复制一份 ——
 * 复制出来的东西和源头不同步,改了源头旧副本还在,是个必踩的坑。
 * 所以类就老老实实只做归类,Skills 要么全局(技能库统一管)、要么项目自己那份。
 *
 * # 存在哪
 *
 * 和别的设置一起放在应用自己的 settings.json 里,**不写进用户的笔记库** ——
 * 项目是 XGTools 的东西,不该往人家知识库里塞文件;而项目真正的内容(文件、规矩)
 * 本来就在文件夹里,换台机器把文件夹拿过去重新指一下就接上了。
 */
import { reactive, computed } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'

/** 项目类:AIGC / 财务 / 学习……用户自己起名。只用来归类 */
export type ProjectCategory = {
  id: string
  name: string
  icon: string
  createdAt: number
}

export type Project = {
  id: string
  categoryId: string
  name: string
  icon: string
  /** 绑定的文件夹绝对路径。空 = 还没选,进去之后先让他选 */
  folder: string
  /** 这个项目对应的那次对话。空 = 还没开始聊,进去时现开一个 */
  sessionId: string
  /** 正文栏在中间还是右边;不设就跟随全局 */
  layout?: 'doc-center' | 'chat-center'
  createdAt: number
}

const CAT_KEY = 'projectCategories'
const KEY = 'projects'
let store: LazyStore | null = null

export const projects = reactive<{
  cats: ProjectCategory[]
  items: Project[]
  /** 现在进到哪个项目里了。空 = 还在列表上 */
  currentId: string
  /** 项目类的折叠状态,按 id 记 */
  collapsed: Record<string, boolean>
  ready: boolean
}>({ cats: [], items: [], currentId: '', collapsed: {}, ready: false })

export const currentProject = computed(() =>
  projects.items.find((p) => p.id === projects.currentId) ?? null)

export const currentCategory = computed(() => {
  const p = currentProject.value
  return p ? projects.cats.find((c) => c.id === p.categoryId) ?? null : null
})

/** 按类分组,给左栏那棵树用。没有类的项目挂在「未分类」下 */
export const grouped = computed(() => {
  const rows = projects.cats.map((c) => ({
    cat: c,
    items: projects.items.filter((p) => p.categoryId === c.id),
  }))
  const orphans = projects.items.filter((p) => !projects.cats.some((c) => c.id === p.categoryId))
  if (orphans.length) {
    rows.push({ cat: { id: '', name: '未分类', icon: '📁', createdAt: 0 }, items: orphans })
  }
  return rows
})

async function db() {
  if (!store) store = new LazyStore('settings.json')
  return store
}

/**
 * 从老结构迁过来。
 *
 * 老的是「项目带一个 category 字符串 + 一张 会话→项目 的映射表」。
 * 迁移规则:每个不重样的 category 变成一个项目类;老的项目原样保留,
 * 挂到对应的类下面;老映射表里那个项目的第一条会话,就成了这个项目的对话。
 *
 * **一次性的,迁完就不再看老键**。迁移只往新键写,老键留着不动 ——
 * 万一迁错了,老数据还在,不至于把人家的项目弄丢。
 */
function migrate(rawProjects: any[], rawSessionOf: Record<string, string>) {
  const cats: ProjectCategory[] = []
  const items: Project[] = []
  const catIdOf = new Map<string, string>()

  for (const p of rawProjects) {
    const catName = String(p?.category ?? '').trim()
    let catId = catIdOf.get(catName) ?? ''
    if (catName && !catId) {
      catId = `k${cats.length}${Date.now().toString(36)}`
      catIdOf.set(catName, catId)
      cats.push({ id: catId, name: catName, icon: '📁', createdAt: Date.now() })
    }
    const sid = Object.entries(rawSessionOf).find(([, pid]) => pid === p?.id)?.[0] ?? ''
    items.push({
      id: String(p?.id ?? `p${items.length}`),
      categoryId: catId,
      name: String(p?.name ?? '未命名'),
      icon: String(p?.icon ?? '📁'),
      folder: String(p?.folder ?? ''),
      sessionId: sid,
      layout: p?.layout,
      createdAt: Number(p?.createdAt) || Date.now(),
    })
  }
  return { cats, items }
}

export async function loadProjects() {
  if (projects.ready) return
  try {
    const s = await db()
    const cats = await s.get<ProjectCategory[]>(CAT_KEY)
    const raw = (await s.get<any[]>(KEY)) ?? []

    if (Array.isArray(cats)) {
      // 已经是新结构
      projects.cats = cats
      projects.items = raw.map((p) => ({
        id: String(p?.id ?? ''),
        categoryId: String(p?.categoryId ?? ''),
        name: String(p?.name ?? '未命名'),
        icon: String(p?.icon ?? '📁'),
        folder: String(p?.folder ?? ''),
        sessionId: String(p?.sessionId ?? ''),
        layout: p?.layout,
        createdAt: Number(p?.createdAt) || Date.now(),
      })).filter((p) => p.id)
    } else {
      const sessionOf = (await s.get<Record<string, string>>('projectSessions')) ?? {}
      const m = migrate(raw, sessionOf)
      projects.cats = m.cats
      projects.items = m.items
      await save()
    }
  } catch {
    projects.cats = []
    projects.items = []   // 读不出来就当没有,别拦住页面
  } finally {
    projects.ready = true
  }
}

async function save() {
  try {
    const s = await db()
    await s.set(CAT_KEY, [...projects.cats])
    await s.set(KEY, [...projects.items])
    await s.save()
  } catch { /* 存不上下次再说,别打断手上的操作 */ }
}

// ── 项目类 ────────────────────────────────────────────

export async function addCategory(name: string, icon = '📁') {
  const n = name.trim()
  if (!n) return null
  const hit = projects.cats.find((c) => c.name === n)
  if (hit) return hit
  const cat: ProjectCategory = { id: `k${Date.now().toString(36)}`, name: n, icon, createdAt: Date.now() }
  projects.cats = [...projects.cats, cat]
  await save()
  return cat
}

/** 改名。图标一起改 —— 名字和图标一起构成「这是哪一类」,只让改一半没道理 */
export async function renameCategory(id: string, name: string, icon?: string) {
  const n = name.trim()
  if (!n) return
  projects.cats = projects.cats.map((c) =>
    (c.id === id ? { ...c, name: n, icon: icon || c.icon } : c))
  await save()
}

/** 删一个类。**里面的项目不跟着消失**,掉到「未分类」去 —— 删的是这个壳 */
export async function removeCategory(id: string) {
  projects.cats = projects.cats.filter((c) => c.id !== id)
  projects.items = projects.items.map((p) => (p.categoryId === id ? { ...p, categoryId: '' } : p))
  await save()
}

export function toggleCategory(id: string) {
  projects.collapsed = { ...projects.collapsed, [id]: !projects.collapsed[id] }
}

// ── 项目 ──────────────────────────────────────────────

export async function addProject(p: Omit<Project, 'id' | 'createdAt'>) {
  const item: Project = { ...p, id: `p${Date.now().toString(36)}`, createdAt: Date.now() }
  projects.items = [...projects.items, item]
  await save()
  return item
}

export async function updateProject(id: string, patch: Partial<Project>) {
  projects.items = projects.items.map((p) => (p.id === id ? { ...p, ...patch } : p))
  await save()
}

export async function removeProject(id: string) {
  projects.items = projects.items.filter((p) => p.id !== id)
  if (projects.currentId === id) projects.currentId = ''
  await save()
}

/** 这次对话是哪个项目的。不是任何项目的就返回 null */
export function projectOfSession(sessionId: string): Project | null {
  if (!sessionId) return null
  return projects.items.find((p) => p.sessionId === sessionId) ?? null
}
