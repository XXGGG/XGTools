/**
 * 「规矩」——写给智能体看的一份说明。
 *
 * # 这是什么
 *
 * 每开一个新会话,它都是一张白纸:不知道你是谁、这个文件夹是干嘛的、
 * 你希望它怎么说话、东西该往哪儿放。每次都得重新交代一遍。
 *
 * 规矩就是把这些话**写一次、存下来**,以后每次对话它自动带着。
 * 两份:
 *  · **全局**——对所有项目都生效(「一律说中文」「不确定先问我」)
 *  · **这个文件夹**——只在这个项目里生效(「这是漫剧项目,产出写进 XX 笔记」)
 *
 * # 为什么是文件,不是我们自己的设置项
 *
 * DSH 本来就会读工作区里的 `AGENTS.md`(和 Claude Code、Codex 一个约定),
 * 从库根一路读到当前目录。也就是说这套机制**不用我们发明**,我们只要给它一个
 * 好写的界面。
 *
 * 好处是这份规矩不被 XGTools 绑架:同一个文件夹用别的工具打开,那边也认;
 * 想用笔记页去编辑它也行,它就是一个普通的 md 文件。
 */
import { reactive } from 'vue'
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs'
import { homeDir, join } from '@tauri-apps/api/path'

/** DSH 读全局规矩的地方。`$DSH_HOME/AGENTS.md`,而 DSH_HOME 默认是 ~/.dsh */
async function globalPath(): Promise<string> {
  return join(await homeDir(), '.dsh', 'AGENTS.md')
}

export const rules = reactive<{
  open: boolean
  /** 'global' = 所有项目;'workspace' = 当前这个文件夹 */
  tab: 'global' | 'workspace'
  globalText: string
  workspaceText: string
  /** 当前工作区的绝对路径。空 = 还没选工作区,那一栏就不能写 */
  workspacePath: string
  loading: boolean
  saved: boolean
  error: string
}>({
  open: false,
  tab: 'workspace',
  globalText: '',
  workspaceText: '',
  workspacePath: '',
  loading: false,
  saved: false,
  error: '',
})

/** 读一个文件;不存在就当空的 —— 「还没写过」和「空的」对用户是一回事 */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return (await exists(path)) ? await readTextFile(path) : ''
  } catch {
    return ''
  }
}

export async function openRules(workspacePath: string) {
  rules.workspacePath = workspacePath
  rules.tab = workspacePath ? 'workspace' : 'global'
  rules.open = true
  rules.error = ''
  rules.loading = true
  try {
    rules.globalText = await readOrEmpty(await globalPath())
    rules.workspaceText = workspacePath
      ? await readOrEmpty(await join(workspacePath, 'AGENTS.md'))
      : ''
  } finally {
    rules.loading = false
  }
}

export async function saveRules() {
  rules.error = ''
  try {
    const g = await globalPath()
    // ~/.dsh 一般已经在了(DSH 自己建的),但用户可能从没跑过它
    const home = await homeDir()
    const dir = await join(home, '.dsh')
    if (!(await exists(dir))) await mkdir(dir, { recursive: true })
    await writeTextFile(g, rules.globalText)

    if (rules.workspacePath) {
      await writeTextFile(await join(rules.workspacePath, 'AGENTS.md'), rules.workspaceText)
    }
    rules.saved = true
    setTimeout(() => { rules.saved = false }, 1600)
  } catch (e) {
    rules.error = String(e)
  }
}

/**
 * 空白时给的例子。
 *
 * 不是模板套用,是**给个起点** —— 面对一个空框子最难的是第一句话写什么。
 * 例子用大白话写,让人一眼看出「原来这里可以写这种东西」。
 */
export const RULE_EXAMPLES: Record<'global' | 'workspace', string> = {
  global: `一律用中文回答。

不确定的事先问我，别自己编。

改我的文件之前先说要改什么，我同意了再动手。`,
  workspace: `这个文件夹是我的 AI 漫剧项目。

你在这儿的角色：帮我整理提示词、查资料、写分镜。

产出直接写进这个文件夹里的 md 笔记，不要只在对话里说。

我不写代码，别给我贴代码片段。`,
}
