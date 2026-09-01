/**
 * 项目 —— 工作台的骨架。
 *
 * # 一个项目是什么
 *
 * 一件正在做的事,外加它需要的全部环境:一个文件夹、一串对话、一份规矩。
 * 「财务管理」「AI漫剧」「提示词助手」各是一个项目。
 *
 * # 为什么要有它(而不是只有会话列表)
 *
 * 笔记页面对的是**整个笔记库**;而干活的时候面对的是**一件事**。
 * 一大堆笔记里翻某个文件夹里的某个文件,是一件很烦的事 ——
 * 项目就是把范围先圈小:进了「财务」,眼前只有财务的文件、财务的对话、
 * 财务的规矩,不用再挑。
 *
 * # 存在哪
 *
 * 和别的设置一起放在应用自己的 settings.json 里(`projects` 这一项)。
 * **不写进用户的笔记库** —— 项目是 XGTools 的东西,不该往人家的知识库里塞文件;
 * 而项目真正的内容(文件、规矩)本来就在文件夹里,换台机器把文件夹拿过去,
 * 重新建一个同名项目指过去就接上了。
 */
import { reactive, computed } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'

export type Project = {
  id: string
  name: string
  /** 大类:AIGC / 财务 / 笔记 / 学习……用户自己起名,空串表示没归类 */
  category: string
  /** 一个 emoji,列表里认人用。不强制 */
  icon: string
  /** 绑定的文件夹绝对路径。空 = 还没选,进去之后先让他选 */
  folder: string
  /** 正文栏在中间还是右边;不设就跟随全局 */
  layout?: 'doc-center' | 'chat-center'
  createdAt: number
}

const KEY = 'projects'
let store: LazyStore | null = null

export const projects = reactive<{
  items: Project[]
  /** 当前进到哪个项目里了。空 = 还在「聊天」那一栏,没进任何项目 */
  currentId: string
  /** 大类的折叠状态,按名字记 */
  collapsed: Record<string, boolean>
  ready: boolean
}>({ items: [], currentId: '', collapsed: {}, ready: false })

export const currentProject = computed(() =>
  projects.items.find((p) => p.id === projects.currentId) ?? null)

/** 按大类分组,给左栏那棵树用。没归类的排最后,标成「未分类」 */
export const grouped = computed(() => {
  const map = new Map<string, Project[]>()
  for (const p of projects.items) {
    const k = p.category || ''
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(p)
  }
  const rows = [...map.entries()].map(([category, items]) => ({ category, items }))
  rows.sort((a, b) => (a.category ? 0 : 1) - (b.category ? 0 : 1) || a.category.localeCompare(b.category))
  return rows
})

/** 现有的大类名,新建项目时给他挑 */
export const categories = computed(() =>
  [...new Set(projects.items.map((p) => p.category).filter(Boolean))].sort())

async function db() {
  if (!store) store = new LazyStore('settings.json')
  return store
}

export async function loadProjects() {
  if (projects.ready) return
  try {
    const raw = await (await db()).get<Project[]>(KEY)
    projects.items = Array.isArray(raw) ? raw : []
  } catch {
    projects.items = []   // 读不出来就当没有,别拦住页面
  } finally {
    projects.ready = true
  }
}

async function save() {
  try {
    const s = await db()
    await s.set(KEY, [...projects.items])
    await s.save()
  } catch { /* 存不上下次再说,别打断手上的操作 */ }
}

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

export function toggleCategory(name: string) {
  projects.collapsed = { ...projects.collapsed, [name]: !projects.collapsed[name] }
}
