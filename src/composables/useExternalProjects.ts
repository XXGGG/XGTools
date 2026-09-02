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
import { homeDir, join } from '@tauri-apps/api/path'

export type ExternalProject = {
  /** 真实的绝对路径 */
  path: string
  /** 显示用的短名(文件夹名) */
  name: string
  /** 哪家的 */
  source: string
  /** XGTools 里已经有指向这个文件夹的项目了 */
  linked: boolean
}

export const external = reactive<{
  items: ExternalProject[]
  loading: boolean
  error: string
}>({ items: [], loading: false, error: '' })

function leafName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/**
 * Claude Code 的项目清单。
 *
 * 目录名是把路径里的 `:`、`\`、空格**还有中文**统统换成 `-` 得到的
 * （`H:\其他计算机\我的 Mac\Documents\Obsidian` → `H-----------Mac-Documents-Obsidian`）——
 * **反解不回来**。所以真实路径要从会话日志里的 `cwd` 字段拿,那是原样记下的。
 */
async function scanClaudeCode(): Promise<ExternalProject[]> {
  const out: ExternalProject[] = []
  const root = await join(await homeDir(), '.claude', 'projects')
  if (!(await exists(root).catch(() => false))) return out

  let dirs: string[] = []
  try {
    dirs = ((await readDir(root)) as any[]).map((e) => String(e?.name ?? '')).filter(Boolean)
  } catch {
    return out
  }

  for (const d of dirs) {
    const dir = await join(root, d)
    let files: string[] = []
    try {
      files = ((await readDir(dir)) as any[])
        .map((e) => String(e?.name ?? ''))
        .filter((n) => n.toLowerCase().endsWith('.jsonl'))
    } catch { continue }
    if (!files.length) continue

    // 只读一份、只读开头 —— 会话日志能有几十兆,整份读进来纯属浪费
    try {
      const head = (await readTextFile(await join(dir, files[0]))).slice(0, 20000)
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
      if (!m) continue
      const path = JSON.parse(`"${m[1]}"`) as string
      if (!path || out.some((x) => x.path === path)) continue
      out.push({ path, name: leafName(path), source: 'Claude Code', linked: false })
    } catch { /* 这一个读不出来不该拖垮整张表 */ }
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
          out.push({ path, name: leafName(path), source: 'Codex', linked: false })
        } catch { /* 同上 */ }
      } else {
        await walk(p, depth + 1)
      }
    }
  }
  await walk(root, 0)
  return out
}

/** 扫一遍。`taken` 是 XGTools 里已经绑过的文件夹,用来标「已经接上了」 */
export async function scanExternalProjects(taken: string[]) {
  if (external.loading) return
  external.loading = true
  external.error = ''
  try {
    const found = [...(await scanClaudeCode()), ...(await scanCodex())]
    const low = new Set(taken.filter(Boolean).map((p) => p.toLowerCase()))
    external.items = found
      .map((p) => ({ ...p, linked: low.has(p.path.toLowerCase()) }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  } catch (e) {
    external.error = String(e)
  } finally {
    external.loading = false
  }
}
