/**
 * 别家 AI 的项目在哪儿 —— 扫出来,好把它们接进 XGTools。
 *
 * # 为什么是「同步」而不是「导入」
 *
 * 导入 = 抄一份过来,从此两份各走各的,改了这边那边不知道。
 * 同步 = **指向同一个文件夹**。一个项目本来就是「一个文件夹 + 一份规矩 + 一套技能」,
 * 这三样都在磁盘上,两边指着同一处就是同一个项目 —— 不需要复制任何东西。
 *
 * # 哪些东西真的会两边一致
 *
 * · **文件** —— 同一个文件夹,本来就是同一份
 * · **规矩/记忆** —— DSH 从项目根一路往下读 `AGENTS.md` **和** `CLAUDE.md`,
 *   所以 Claude Code 那边写的 CLAUDE.md,这边自动就带着;反过来也一样
 * · **技能** —— 项目文件夹里的 `.dsh/skills`、`.claude/skills` 都能指过去(见技能库)
 *
 * # 哪一样做不到:**聊天记录本身**
 *
 * 三家的会话日志格式完全不是一回事:DSH 是 zstd 压过的事件流加投影,
 * Claude Code 是一行行 jsonl(消息、hook、附件混在一起),Codex 又是另一套。
 * 要做到「这边聊一半,切过去接着聊」,等于给每一对格式写一个双向实时转换器 ——
 * 而且任何一边升级格式就断,断的方式还是**默默给出一段错的历史**。
 *
 * 所以这里不碰会话:两边各留各的历史,共享的是文件、规矩和技能。
 * 真正要「两边都记得」的东西,写进 md(CLAUDE.md / AGENTS.md 或项目里的笔记)——
 * 那本来就是这类工具存记忆的地方。
 */
import { reactive } from 'vue'
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs'
import { invoke } from '@tauri-apps/api/core'
import { homeDir, join } from '@tauri-apps/api/path'

/**
 * 别家的一次会话。**一个会话就是一个项目。**
 *
 * 同一个文件夹里可以同时进行好几摊不相干的活 —— `c:\XGCode` 底下既在改 XGTools，
 * 又在弄视频生成，还在管服务器安全。它们共用一个工作区，但不是同一个项目。
 */
export type ExternalSession = {
  /** 别家的会话 id。用来认「这个会话已经接过来了」 */
  id: string
  title: string
  cwd: string
  /** 最后动过的时间（毫秒） */
  mtime: number
  /** 自己改过名字的 —— 那是他真在意的活 */
  named: boolean
  linked: boolean
}

export type ExternalProject = {
  /** 真实的绝对路径 */
  path: string
  /** 显示用的短名(文件夹名) */
  name: string
  /** 哪家的 */
  source: string
  /** XGTools 里已经有指向这个文件夹的项目了 */
  linked: boolean
  /** 会话日志还在 —— 说明最近还在用。排前面 */
  recent: boolean
}

export const external = reactive<{
  /** 会话 —— 主角 */
  sessions: ExternalSession[]
  /** 只有文件夹、没有会话记录的。日志过期清掉之后就只剩这个了 */
  items: ExternalProject[]
  loading: boolean
  error: string
}>({ sessions: [], items: [], loading: false, error: '' })

function leafName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/**
 * 路径拿来比对用的样子：分隔符统一、去掉结尾的斜杠、全小写。
 *
 * 同一个文件夹在 Claude Code 的配置里会以好几种写法出现 ——
 * `C:/XGCode/XGWeb`、`C:\XGCode\XGWeb`、`c:/XGCode/XGBlog` 都指着同一处。
 * 不归一化就会在列表里重复出现三四遍。
 */
function normKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * Claude Code 的项目清单。**两个来源合起来看。**
 *
 * # 为什么不能只看会话日志
 *
 * 原来只翻 `~/.claude/projects/*` 里的会话日志，从里面的 `cwd` 取真实路径。
 * 问题是**日志是会过期清掉的**：这台机器上 Claude Code 一共在 24 个文件夹里
 * 干过活，而还留着日志的只有 3 个 —— 于是同步对话框里只列出 3 个，
 * 用的人看到的是「我的项目怎么没了」。
 *
 * `~/.claude.json` 的 `projects` 那一段是**配置**，不会随日志一起清，
 * 里面记着每个待过的文件夹。所以两边都读：
 *  · 会话日志 —— 给出真实的 `cwd` 原样大小写，而且说明「最近还在用」
 *  · 配置文件 —— 给出全部待过的文件夹，哪怕日志早清了
 *
 * # 目录名为什么不能反解
 *
 * `~/.claude/projects` 下的目录名是把路径里的 `:`、`\`、空格**还有中文**
 * 统统换成 `-` 得到的（`H:\其他计算机\我的 Mac\Documents\Obsidian`
 * → `H-----------Mac-Documents-Obsidian`）—— 反解不回来。所以真实路径只能
 * 从日志里的 `cwd` 或者配置文件的键名拿。
 */
async function scanClaudeCode(): Promise<ExternalProject[]> {
  const found = new Map<string, ExternalProject>()
  const home = await homeDir()

  const add = (path: string, recent: boolean) => {
    if (!path) return
    const key = normKey(path)
    // 家目录本身不算项目 —— 在这儿开过一次 Claude Code 不代表它是个项目，
    // 而它一列出来就排在最上面挡着真正要找的东西。它下面的子文件夹照常算
    if (key === normKey(home)) return
    const old = found.get(key)
    // 日志里那份是真实 cwd(大小写原样)，比配置里的键名可靠，优先留它
    if (old && (old.recent || !recent)) return
    found.set(key, { path, name: leafName(path), source: 'Claude Code', linked: false, recent })
  }

  // ── 来源一：还留着的会话日志 ──
  const root = await join(home, '.claude', 'projects')
  if (await exists(root).catch(() => false)) {
    let dirs: string[] = []
    try {
      dirs = ((await readDir(root)) as any[]).map((e) => String(e?.name ?? '')).filter(Boolean)
    } catch { dirs = [] }

    for (const d of dirs) {
      const dir = await join(root, d)
      let files: string[] = []
      try {
        files = ((await readDir(dir)) as any[])
          .map((e) => String(e?.name ?? ''))
          .filter((n) => n.toLowerCase().endsWith('.jsonl'))
      } catch { continue }

      /*
        一个目录里挨个试，试到读出 cwd 为止。

        原来只读 `files[0]`：那一份要是开头两万字里正好没有 cwd
        （比如头一条就是一大段贴进来的东西），整个项目就被丢掉了。
      */
      for (const f of files.slice(0, 5)) {
        try {
          const head = (await readTextFile(await join(dir, f))).slice(0, 20000)
          const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
          if (!m) continue
          add(JSON.parse(`"${m[1]}"`) as string, true)
          break
        } catch { /* 这一份读不出来就试下一份 */ }
      }
    }
  }

  // ── 来源二：配置里记着的所有文件夹 ──
  try {
    const cfg = JSON.parse(await readTextFile(await join(home, '.claude.json')))
    for (const p of Object.keys(cfg?.projects ?? {})) add(p, false)
  } catch { /* 没有这个文件就算了,来源一还在 */ }

  /*
    文件夹已经不在了的不列出来 —— 配置里那份只增不减，这台机器上二十四个
    里有十六个早删了。列出来点一下只会得到一个空项目。
  */
  const out: ExternalProject[] = []
  for (const p of found.values()) {
    if (await exists(p.path).catch(() => false)) out.push(p)
  }
  return out
}

/**
 * Codex 的项目清单。
 *
 * 这台机器上没装,所以只按同样的路子留着位置:有 `~/.codex/sessions` 就去翻,
 * 从里面找记着工作目录的那个字段。装了之后不用改代码就能列出来;
 * 没装就一条都不出现 —— 摆一个空的「Codex」分组只会让人以为哪里坏了。
 */
async function scanCodex(): Promise<ExternalProject[]> {
  const out: ExternalProject[] = []
  const root = await join(await homeDir(), '.codex', 'sessions')
  if (!(await exists(root).catch(() => false))) return out

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return
    let entries: { name: string; isMd: boolean }[] = []
    try {
      entries = ((await readDir(dir)) as any[]).map((e) => {
        const name = String(e?.name ?? '')
        return { name, isMd: /\.(jsonl|json)$/i.test(name) }
      }).filter((e) => e.name && !e.name.startsWith('.'))
    } catch { return }

    for (const e of entries) {
      const p = await join(dir, e.name)
      if (e.isMd) {
        try {
          const head = (await readTextFile(p)).slice(0, 20000)
          const m = /"(?:cwd|workdir|workspace)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
          if (!m) continue
          const path = JSON.parse(`"${m[1]}"`) as string
          if (!path || out.some((x) => x.path === path)) continue
          out.push({ path, name: leafName(path), source: 'Codex', linked: false, recent: true })
        } catch { /* 同上 */ }
      } else {
        await walk(p, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return out
}

/**
 * 扫一遍。
 *
 * `takenFolders` 是已经绑过的文件夹，`takenOrigins` 是已经接过来的会话 id。
 * **会话按 id 判重，不按文件夹** —— 否则同一个工作区里的第二摊活就接不进来了。
 */
export async function scanExternalProjects(takenFolders: string[], takenOrigins: string[] = []) {
  if (external.loading) return
  external.loading = true
  external.error = ''
  try {
    const origins = new Set(takenOrigins.filter(Boolean))
    try {
      const raw = await invoke<ExternalSession[]>('scan_claude_sessions')
      external.sessions = raw.map((x) => ({ ...x, linked: origins.has(x.id) }))
    } catch (e) {
      // 会话读不出来不该连累文件夹那一半
      external.sessions = []
      external.error = String(e)
    }

    const found = [...(await scanClaudeCode()), ...(await scanCodex())]
    const low = new Set(takenFolders.filter(Boolean).map(normKey))
    /*
      会话已经覆盖到的文件夹不再单列。

      会话那一栏里已经把 `c:\XGCode` 列了十来次（十来摊活），
      底下再来一条光秃秃的「XGCode」只会让人愣一下：这跟上面那些什么关系？
    */
    const bySession = new Set(external.sessions.map((x) => normKey(x.cwd)))
    external.items = found
      .filter((p) => !bySession.has(normKey(p.path)))
      .map((p) => ({ ...p, linked: low.has(normKey(p.path)) }))
      // 最近还在用的排前面 —— 那才是他这会儿想接过来的
      .sort((a, b) =>
        Number(b.recent) - Number(a.recent)
        || a.source.localeCompare(b.source)
        || a.name.localeCompare(b.name))
  } catch (e) {
    external.error = String(e)
  } finally {
    external.loading = false
  }
}
