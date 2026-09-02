/**
 * 技能库 —— 智能体会用到的一份份「怎么做某件事」的说明。
 *
 * # 技能是什么
 *
 * 一份 markdown,写清楚「碰到这类活该怎么做」。
 *
 * 挂多少个都不费钱:常驻在上下文里的只有每份技能的**名字和一句话说明**
 * (一条二三十个 token),正文只有在模型判断这次活对得上、自己去读的时候才进上下文。
 * 所以真正要花心思的不是「挂几个」,是每条的说明写清楚「什么时候该用我」——
 * 说明写得含糊,模型就挑不准,那才是代价。
 *
 * # 我们只「指向」,绝不复制
 *
 * 技能的原件散在各处:自己写的在 XGSkills(还要同步 GitHub)、Claude Code 有一份、
 * Codex 有一份。**复制过来是个坑** —— 改了源头,复制出来的旧副本还在那儿,
 * 而且你根本不知道手里这份是哪一版。
 *
 * 好在不用复制:DSH 的 `skill-filesystem` 有一个 `customSkillDirs`,
 * 给它一串目录它就去扫。我们要做的只是**把目录名单写给它**,原件一个字不动。
 *
 * # 目录怎么写给 DSH
 *
 * 写进 `~/.dsh/profiles/web/cordis.patch.yml` —— 这份文件 DSH 自己的说明里写着
 * 是「你的补丁层」,按 id 覆盖某个插件的配置。我们只管自己那一段(标记圈起来),
 * 用户在同一份文件里写的别的东西一个字不动。
 *
 * # 目录可以套一层
 *
 * 有两种摆法,都认:
 *  · 平铺   `<根>/技能名/SKILL.md`      —— Claude Code、~/.dsh/skills 是这种
 *  · 分类   `<根>/分类/技能名/SKILL.md`  —— XGSkills 是这种
 *
 * 分类那一层顺便就是技能库里的分组,不用另外再让人手动归类。
 * 但 DSH 只认平铺,所以写给它的名单要把分类目录**逐个展开**(展开的是路径,不是文件)。
 */
import { reactive, computed } from 'vue'
import { readTextFile, writeTextFile, readDir, exists, mkdir } from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export type Skill = {
  /** 目录名(或文件名去掉后缀),也是模型认它的名字 */
  id: string
  name: string
  description: string
  /** 从哪个根扫出来的 */
  rootId: string
  /** 根里面套的那一层分类名。平铺的根就是空串 */
  category: string
  /** SKILL.md 的绝对路径 */
  path: string
}

/**
 * 一个技能目录。
 *
 * `builtin` 的是我们替他找出来的常见位置(存在才列),`enabled` 关掉就不写给 DSH ——
 * **关掉不等于删掉**,原件一个字不动,只是这一阵不想让它参与。
 */
export type SkillRoot = {
  id: string
  path: string
  label: string
  builtin: boolean
  enabled: boolean
  exists: boolean
}

export const skills = reactive<{
  items: Skill[]
  roots: SkillRoot[]
  loading: boolean
  error: string
  /** 名单已经写给 DSH 了吗;写完要重启边车才生效 */
  needsRestart: boolean
}>({ items: [], roots: [], loading: false, error: '', needsRestart: false })

const KEY = 'skillRoots'
let store: LazyStore | null = null
async function db() {
  if (!store) store = new LazyStore('settings.json')
  return store
}

/** DSH 自己的全局目录,永远在名单里,不能关也不用写给它(它本来就扫) */
export const DSH_ROOT_ID = 'dsh'

/**
 * 常见的技能目录,存在才列出来。
 *
 * 为什么替他找:自己弄过哪些技能、放哪儿了,过一阵谁都记不住。
 * 摆出来让他勾,比让他自己去翻路径强得多。
 */
async function builtinCandidates(): Promise<Omit<SkillRoot, 'enabled' | 'exists'>[]> {
  const home = await homeDir()
  return [
    { id: DSH_ROOT_ID, path: await join(home, '.dsh', 'skills'), label: 'XGTools 自己的', builtin: true },
    { id: 'claude', path: await join(home, '.claude', 'skills'), label: 'Claude Code', builtin: true },
    { id: 'codex', path: await join(home, '.codex', 'skills'), label: 'Codex', builtin: true },
    { id: 'agents', path: await join(home, '.agents', 'skills'), label: '通用（.agents）', builtin: true },
  ]
}

/** 全局技能目录:`~/.dsh/skills`。新建技能默认往这儿放 */
export async function globalSkillDir(): Promise<string> {
  return join(await homeDir(), '.dsh', 'skills')
}

// ── 扫盘 ──────────────────────────────────────────────

function parseSkill(md: string, fallbackName: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return { name: fallbackName, description: firstLine(md) }
  const body = m[1]
  const pick = (key: string) => {
    const hit = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi').exec(body)
    return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  return {
    name: pick('name') || fallbackName,
    description: pick('description') || firstLine(md.slice(m[0].length)),
  }
}

function firstLine(md: string): string {
  const line = md.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
  return line ? line.slice(0, 160) : ''
}

/**
 * 目录项。
 *
 * **故意不记 isDirectory**。技能目录里常常是一堆软链接/junction ——
 * 用户把自己写的那份放在 XGSkills 里同步 GitHub,再 junction 回 ~/.claude/skills,
 * 这样改主本就立刻生效。而链接在 `readDir` 眼里 `isDirectory` 是 **false**
 * (它报的是「这是个链接」),照这个字段判断的话,那些技能一个都扫不出来 ——
 * 界面上写着 0,磁盘上明明有八个。踩过。
 *
 * 所以一律不问「你是不是目录」,直接问「你里面有没有 SKILL.md」。
 */
type Entry = { name: string; isMarkdown: boolean }

async function listDir(dir: string): Promise<Entry[]> {
  try {
    if (!(await exists(dir))) return []
    return ((await readDir(dir)) as any[]).map((e) => {
      const name = String(e?.name ?? '')
      return { name, isMarkdown: /\.md$/i.test(name) }
    }).filter((e) => e.name && !e.name.startsWith('.'))
  } catch (e) {
    skills.error = String(e)
    return []
  }
}

/** 一个目录本身是不是一份技能(里面有 SKILL.md) */
async function isSkillDir(dir: string): Promise<boolean> {
  try {
    return await exists(await join(dir, 'SKILL.md'))
  } catch {
    return false
  }
}

async function readSkill(path: string, fallback: string, rootId: string, category: string): Promise<Skill | null> {
  try {
    const meta = parseSkill(await readTextFile(path), fallback)
    return { id: fallback, ...meta, rootId, category, path }
  } catch {
    return null   // 单份读不出来不该让整个列表空掉
  }
}

/**
 * 扫一个根。平铺和「套一层分类」两种摆法都认。
 *
 * 读失败要说出来:读不动和没有东西看起来一模一样(都是空列表),
 * 而原因往往是权限之类的硬毛病。踩过一次 —— 少给 `fs:allow-read-dir`,
 * 界面上干干净净一句「还没有技能」,磁盘上明明躺着两个。
 */
async function scanRoot(root: SkillRoot): Promise<Skill[]> {
  const out: Skill[] = []
  for (const e of await listDir(root.path)) {
    const p = await join(root.path, e.name)
    if (e.isMarkdown) {
      const s = await readSkill(p, e.name.replace(/\.md$/i, ''), root.id, '')
      if (s) out.push(s)
      continue
    }
    if (await isSkillDir(p)) {
      const s = await readSkill(await join(p, 'SKILL.md'), e.name, root.id, '')
      if (s) out.push(s)
      continue
    }
    // 里面没有 SKILL.md,那就当它是一层分类,再往里看一层
    for (const f of await listDir(p)) {
      if (f.isMarkdown) continue
      const q = await join(p, f.name)
      if (!(await isSkillDir(q))) continue
      const s = await readSkill(await join(q, 'SKILL.md'), f.name, root.id, e.name)
      if (s) out.push(s)
    }
  }
  return out
}

/** 这个根里所有装着技能的目录。分类那一层要逐个报给 DSH —— 它只认平铺 */
async function effectiveDirs(root: SkillRoot): Promise<string[]> {
  const dirs: string[] = []
  let hasFlat = false
  for (const e of await listDir(root.path)) {
    if (e.isMarkdown) { hasFlat = true; continue }
    const p = await join(root.path, e.name)
    if (await isSkillDir(p)) { hasFlat = true; continue }
    for (const f of await listDir(p)) {
      if (!f.isMarkdown && (await isSkillDir(await join(p, f.name)))) { dirs.push(p); break }
    }
  }
  if (hasFlat) dirs.unshift(root.path)
  return dirs
}

// ── 加载 ──────────────────────────────────────────────

export async function loadSkills() {
  if (skills.loading) return
  skills.loading = true
  skills.error = ''
  try {
    skillEnv.home = (await homeDir()).replace(/[\\/]+$/, '')
    const saved = (await (await db()).get<{ path: string; label?: string; enabled?: boolean }[]>(KEY)) ?? []
    const savedBy = new Map(saved.map((r) => [r.path, r]))

    const roots: SkillRoot[] = []
    for (const c of await builtinCandidates()) {
      const ok = await exists(c.path).catch(() => false)
      // 没有的内置候选不摆出来 —— 摆一排灰着的路径只会让人以为哪里坏了。
      // 但 DSH 自己那个永远留着,新建技能要往里放
      if (!ok && c.id !== DSH_ROOT_ID) continue
      roots.push({ ...c, exists: ok, enabled: savedBy.get(c.path)?.enabled ?? true })
    }
    for (const r of saved) {
      if (roots.some((x) => x.path === r.path)) continue
      roots.push({
        id: `c${roots.length}`,
        path: r.path,
        label: r.label || r.path.split(/[\\/]/).filter(Boolean).pop() || r.path,
        builtin: false,
        exists: await exists(r.path).catch(() => false),
        enabled: r.enabled ?? true,
      })
    }
    skills.roots = roots

    const found: Skill[] = []
    for (const r of roots) {
      if (!r.exists) continue
      found.push(...(await scanRoot(r)))
    }
    skills.items = found
  } catch (e) {
    skills.error = String(e)
  } finally {
    skills.loading = false
  }
}

async function saveRoots() {
  try {
    const s = await db()
    // 内置的也存一条,为的是记住「关掉了」这件事
    await s.set(KEY, skills.roots.map((r) => ({ path: r.path, label: r.label, enabled: r.enabled })))
    await s.save()
  } catch { /* 存不上下次再说 */ }
}

export async function addSkillRoot(path: string) {
  if (!path || skills.roots.some((r) => r.path === path)) return
  skills.roots = [...skills.roots, {
    id: `c${Date.now().toString(36)}`,
    path,
    label: path.split(/[\\/]/).filter(Boolean).pop() || path,
    builtin: false,
    exists: await exists(path).catch(() => false),
    enabled: true,
  }]
  await saveRoots()
  await applySkillDirs()
  await loadSkills()
}

/** 移掉一个目录。**只是不看它了,原件一个字不动** */
export async function removeSkillRoot(id: string) {
  skills.roots = skills.roots.filter((r) => r.id !== id)
  await saveRoots()
  await applySkillDirs()
  await loadSkills()
}

export async function toggleSkillRoot(id: string) {
  skills.roots = skills.roots.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
  await saveRoots()
  await applySkillDirs()
  await loadSkills()
}

// ── 把目录名单写给 DSH ────────────────────────────────

const MARK_BEGIN = '# xgtools:skill-dirs:begin'
const MARK_END = '# xgtools:skill-dirs:end'

async function patchPath(): Promise<string> {
  return join(await homeDir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
}

/** YAML 里的路径一律用单引号包起来。Windows 路径里的反斜杠在双引号里会被当转义 */
function yamlPath(p: string): string {
  return `'${p.replace(/'/g, "''")}'`
}

/**
 * 把当前的目录名单写进 DSH 的补丁层。
 *
 * 只动标记之间那一截 —— 这份文件是用户自己的补丁层,他可能在里面写了别的东西。
 * 补丁是「按 id 覆盖整段 config」,所以我们这一条要把 customSkillDirs 一次写全。
 *
 * 写完**要重启边车才生效**(配置是启动时读的),所以这里只标记一下,
 * 由界面去问用户要不要现在重启 —— 正聊着一半被我们掐掉重连是很讨厌的。
 */
export async function applySkillDirs() {
  try {
    const dirs: string[] = []
    for (const r of skills.roots) {
      // DSH 自己那个目录它本来就扫,不用再报一遍
      if (!r.enabled || !r.exists || r.id === DSH_ROOT_ID) continue
      for (const d of await effectiveDirs(r)) if (!dirs.includes(d)) dirs.push(d)
    }

    const block = [
      MARK_BEGIN,
      '# 这一段由 XGTools 的技能库维护，手改会被覆盖。',
      '# 它只是把目录指给 DSH，技能原件仍在各自的位置，没有复制。',
      '- id: skill-filesystem',
      '  config:',
      '    customSkillDirs:',
      ...(dirs.length ? dirs.map((d) => `      - ${yamlPath(d)}`) : ['      []']),
      MARK_END,
    ].join('\n')

    const p = await patchPath()
    const old = (await exists(p)) ? await readTextFile(p) : ''
    const a = old.indexOf(MARK_BEGIN)
    const b = old.indexOf(MARK_END)

    let next: string
    if (a >= 0 && b > a) {
      next = old.slice(0, a) + block + old.slice(b + MARK_END.length)
    } else {
      // 空补丁层长这样:`[]`。留着它我们的条目就成了「数组后面又跟一个数组」,
      // 这不是合法 YAML —— 得先把这个占位的空数组去掉
      const base = old.replace(/^\s*\[\s*\]\s*$/m, '').replace(/\s+$/, '')
      next = base ? `${base}\n\n${block}\n` : `${block}\n`
    }
    await writeTextFile(p, next)
    skills.needsRestart = true
  } catch (e) {
    skills.error = String(e)
  }
}

// ── 分组与统计 ────────────────────────────────────────

/** 按「哪个目录 → 哪个分类」分组,给界面画 */
export const skillGroups = computed(() => {
  const rootById = new Map(skills.roots.map((r) => [r.id, r]))
  const out: { root: SkillRoot; cats: { name: string; items: Skill[] }[] }[] = []
  for (const r of skills.roots) {
    const mine = skills.items.filter((s) => s.rootId === r.id)
    if (!mine.length) { out.push({ root: r, cats: [] }); continue }
    const map = new Map<string, Skill[]>()
    for (const s of mine) {
      if (!map.has(s.category)) map.set(s.category, [])
      map.get(s.category)!.push(s)
    }
    const cats = [...map.entries()].map(([name, items]) => ({ name, items }))
    // 没分类的排最前 —— 它们是这个目录的「散装」技能
    cats.sort((x, y) => (x.name ? 1 : 0) - (y.name ? 1 : 0) || x.name.localeCompare(y.name))
    out.push({ root: rootById.get(r.id)!, cats })
  }
  return out
})

export const skillCount = computed(() => skills.items.length)

// ── 让模型知道技能放在哪 ──────────────────────────────
//
// 目标:你在聊天里丢一份 md 给它说「把这个存成技能」,它自己知道写到哪、写成什么样。
// 做法是往**全局规矩**(`~/.dsh/AGENTS.md`)里加一段说明 —— 那份文件每次对话都带着。

const RULE_BEGIN = '<!-- xgtools:skills:begin -->'
const RULE_END = '<!-- xgtools:skills:end -->'

/**
 * 写进规矩的那段说明。
 *
 * **路径用 `~/.dsh/skills`，不写绝对路径。**
 * 绝对路径里带着用户名（C:\Users\某某\...），而这份 AGENTS.md 是会被截图、
 * 被分享、甚至被提交进仓库的 —— 应用没理由往用户的文件里塞一句只在他这台机器上
 * 成立、而且把他名字写进去的话。`~` 模型自己会展开，换台机器也还是对的。
 */
function skillBlock(): string {
  return `${RULE_BEGIN}
## 技能放在哪（XGTools 维护，请勿手改这段）

用户让你「把这个存成技能」「记住这套做法」的时候，按下面来：

- 默认写到：\`~/.dsh/skills\`（波浪号指当前用户的主目录）
- 一个技能 = 一个子目录，里面放一个 \`SKILL.md\`
- \`SKILL.md\` 开头要有 frontmatter：

\`\`\`
---
name: 技能名（小写英文，用连字符分词）
description: 一句话说明这个技能是干嘛的、**什么时候该用它**
---
\`\`\`

frontmatter 下面写正文：什么时候用、具体步骤、注意事项。

description 是最要紧的一行：模型平时只看得见名字和这一句，
靠它决定要不要翻开正文。写含糊了这份技能就等于没有。

只在某个项目里用的技能，写到那个项目文件夹的 \`.dsh/skills/\` 下，规则一样。

写完告诉用户存到哪儿了。
${RULE_END}`
}

export const taught = reactive<{ known: boolean; checked: boolean; busy: boolean }>({
  known: false, checked: false, busy: false,
})

async function agentsPath(): Promise<string> {
  return join(await homeDir(), '.dsh', 'AGENTS.md')
}

export async function checkTaught() {
  try {
    const p = await agentsPath()
    const md = (await exists(p)) ? await readTextFile(p) : ''
    taught.known = md.includes(RULE_BEGIN)
  } catch {
    taught.known = false
  } finally {
    taught.checked = true
  }
}

/** 把说明写进全局规矩。只动标记之间那一截,用户自己写的规矩原样留着 */
export async function teachSkillLocation() {
  taught.busy = true
  try {
    const home = await homeDir()
    const dir = await join(home, '.dsh')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })

    const skillDir = await globalSkillDir()
    if (!(await exists(skillDir))) await mkdir(skillDir, { recursive: true })

    const p = await agentsPath()
    const old = (await exists(p)) ? await readTextFile(p) : ''
    const block = skillBlock()

    let next: string
    const a = old.indexOf(RULE_BEGIN)
    const b = old.indexOf(RULE_END)
    if (a >= 0 && b > a) next = old.slice(0, a) + block + old.slice(b + RULE_END.length)
    else next = old.trim() ? `${old.replace(/\s+$/, '')}\n\n${block}\n` : `${block}\n`

    await writeTextFile(p, next)
    taught.known = true
  } catch (e) {
    skills.error = String(e)
  } finally {
    taught.busy = false
  }
}

/**
 * 把主目录收成 `~`。
 *
 * 界面上要显示路径（不显示就不知道技能存哪儿），但没必要把用户名也一并摆出来
 * —— 这个界面是会被截图发出去的。
 */
export const skillEnv = reactive<{ home: string }>({ home: '' })

export function prettyPath(path: string): string {
  const h = skillEnv.home
  if (!h || !path.toLowerCase().startsWith(h.toLowerCase())) return path
  return '~' + path.slice(h.length)
}

/** 在文件管理器里定位一个目录 */
export async function revealDir(path: string) {
  try {
    if (!(await exists(path))) await mkdir(path, { recursive: true })
    const parts = path.split(/[\\/]/).filter(Boolean)
    const leaf = parts.pop() ?? ''
    await invoke('vault_reveal', { root: path.slice(0, path.length - leaf.length - 1), rel: leaf })
  } catch (e) {
    skills.error = String(e)
  }
}
