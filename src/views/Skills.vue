<script setup lang="ts">
/**
 * Skills 页：本机装了哪些 AI skill、装在哪个 AI 里、用过几次。只看不改。
 *
 * 版式照笔记页（2026-10-28 用户要的）：左边目录，按「在哪个文件夹」归类 ——
 * 各家 AI 自己的 skill 文件夹（谁的电脑上都有），加上用户自己添加的文件夹（比如放 skill 源码的仓库）；
 * 目录里只写名字，归属 / 链接 / 是否启用用小标签表示。中间用笔记的编辑器只读显示 SKILL.md。
 *
 * 自选文件夹默认一个都没有；默认也不扫描，按过一次「扫描」才自动（数据和开关见 composables/useSkills）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { settings } from '@/composables/useAppSettings'
import {
  agents, folders, skills, usage, scanning, counting, error, scanned, autoScan, folderPaths,
  scanSkills, refreshSkills, autoRefreshSkills, setAutoScan, saveFolders,
  type Skill as SkillT, type SkillUsage,
} from '@/composables/useSkills'
import { useI18n } from '@/i18n'

const { t } = useI18n()

type Skill = SkillT
type Usage = SkillUsage

/** 第一次按「扫描」= 同意以后自动扫：记住开关，马上扫一遍 */
function startScan() {
  setAutoScan(true)
  refresh()
}
function refresh() {
  void refreshSkills().then(() => {
    if (selected.value && !skills.value.some((s) => s.path === selected.value)) selected.value = ''
  })
  if (selected.value) loadContent(selected.value)
}
onMounted(autoRefreshSkills)

async function addFolder() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ directory: true, multiple: false })
  if (typeof picked !== 'string' || folderPaths.value.includes(picked)) return
  saveFolders([...folderPaths.value, picked])
  if (scanned.value) scanSkills()
}
function removeFolder(p: string) {
  saveFolders(folderPaths.value.filter((x) => x !== p))
  scanSkills()
}

/** 某个 skill 在某个 AI 里用过几次。Claude 的记录里插件 skill 带前缀（superpowers:brainstorming），Codex 记的是文件夹名 */
function usageOf(s: Skill, agent: string): Usage | null {
  const m = usage.value[agent]
  if (!m) return null
  const dir = s.path.split(/[\\/]/).pop() || ''
  let n = 0
  let last = ''
  for (const [k, u] of Object.entries(m)) {
    const bare = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k
    if (bare !== s.name && bare !== dir) continue
    n += u.count
    if (u.last > last) last = u.last
  }
  return n ? { count: n, last } : null
}

function ago(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(+d)) return ''
  const days = Math.floor((Date.now() - +d) / 86400000)
  if (days <= 0) return t('skills.today')
  if (days === 1) return t('skills.yesterday')
  if (days < 60) return t('skills.daysAgo', { n: days })
  return d.toLocaleDateString()
}

/** 标签上用的短名字 */
const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', agents: '.agents' }
const short = (id: string) => SHORT[id] ?? id

// ───── 左边目录：每个文件夹一组 ─────
type Group = { key: string; title: string; hint: string; agent: string; folder: string; missing: boolean; items: Skill[] }
const query = ref('')
const groups = computed<Group[]>(() => {
  const q = query.value.trim().toLowerCase()
  const hit = (s: Skill) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  const out: Group[] = []
  for (const a of agents.value) {
    if (!a.exists) continue
    out.push({
      key: 'a:' + a.id, title: a.name, hint: a.dir, agent: a.id, folder: '', missing: false,
      items: skills.value.filter((s) => s.enabled_in.includes(a.id) && hit(s)),
    })
  }
  for (const f of folders.value) {
    out.push({
      key: 'f:' + f.path, title: f.path.split(/[\\/]/).filter(Boolean).pop() || f.path, hint: f.path,
      agent: '', folder: f.path, missing: !f.exists,
      items: skills.value.filter((s) => s.folder === f.path && hit(s)),
    })
  }
  return out
})
const collapsed = reactive(new Set<string>())
function toggleGroup(k: string) {
  if (collapsed.has(k)) collapsed.delete(k)
  else collapsed.add(k)
}

/**
 * 各家 AI 的主题色（2026-10-28 用户要标签用各自的颜色）：Claude 是 Anthropic 那个陶土橙，
 * Codex 跟 OpenAI 一样黑白（跟着前景色走，深浅色都看得清），.agents 没有官方色，给个紫。
 */
const AGENT_CLS: Record<string, string> = {
  claude: 'bg-[#D97757]/15 text-[#C2603F] dark:text-[#E8916F]',
  codex: 'bg-foreground/10 text-foreground/80',
  agents: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
}
const agentCls = (id: string) => AGENT_CLS[id] ?? 'bg-muted text-muted-foreground'

/**
 * 这一行的归属标签：装在哪些 AI 里（实心底）/ 那个 AI 里装的是同名的另一份（同色虚线框）/ 哪个 AI 都没装（灰）
 */
function tagsOf(s: Skill) {
  const tags: { text: string; cls: string; tip: string }[] = []
  for (const a of s.enabled_in) {
    tags.push({ text: short(a), cls: agentCls(a), tip: t('skills.inAi', { ai: short(a) }) })
  }
  for (const a of s.copy_in) {
    tags.push({ text: short(a), cls: agentCls(a) + ' !bg-transparent border border-dashed border-current', tip: t('skills.copyTip') })
  }
  if (!s.enabled_in.length && !s.copy_in.length) tags.push({ text: t('skills.off'), cls: 'bg-muted text-muted-foreground', tip: t('skills.offTip') })
  return tags
}

/** 所有 AI 加起来用过几次 */
function totalUses(s: Skill) {
  return agents.value.reduce((n, a) => n + (usageOf(s, a.id)?.count ?? 0), 0)
}
/** 次数越多颜色越亮：没用过灰，偶尔用蓝，常用绿，天天用橙 */
function usesCls(n: number) {
  if (!n) return 'bg-muted/60 text-muted-foreground'
  if (n < 5) return 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
  if (n < 20) return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
  return 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
}
function usesTip(s: Skill) {
  const parts = agents.value
    .map((a) => ({ a, u: usageOf(s, a.id) }))
    .filter((x) => x.u)
    .map((x) => `${x.a.name}：${t('skills.uses', { n: x.u!.count })} · ${ago(x.u!.last)}`)
  return parts.length ? parts.join('\n') : t('skills.neverUsed')
}
const isLinked = (g: Group, s: Skill) => !!g.agent && s.linked_in.includes(g.agent)

// ───── 中间：SKILL.md ─────
const selected = ref('')
const selectedKey = ref('')
const current = computed(() => skills.value.find((s) => s.path === selected.value) ?? null)
const content = ref('')
async function loadContent(path: string) {
  try {
    content.value = withoutFrontmatter(await invoke<string>('skills_read', { dir: path }))
  } catch (e) {
    content.value = String(e)
  }
}

/**
 * SKILL.md 开头 --- 之间那段是给 AI 看的文件头（名字 + 什么时候该用它）。
 * 原样交给笔记编辑器会被渲染成一条横线加一大段粗字（2026-10-28 用户问「中间那一大段是什么」），
 * 所以拿掉，只把「什么时候用」那句放成正文最前面的一段引用。
 */
function withoutFrontmatter(md: string) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md)
  if (!m) return md
  const body = md.slice(m[0].length).replace(/^\s+/, '')
  const desc = current.value?.description.trim()
  return desc ? `> ${desc}\n\n${body}` : body
}
watch(selected, (p) => {
  if (p) loadContent(p)
  else content.value = ''
})
function pick(g: Group, s: Skill) {
  selectedKey.value = g.key + '|' + s.path
  selected.value = s.path
}

/** 正文里的相对图片路径换成本地文件地址（skill 里偶尔带示例图） */
function resolveAsset(src: string) {
  if (/^(https?:|data:|asset:)/.test(src) || !current.value) return src
  return convertFileSrc(current.value.path.replace(/\\/g, '/') + '/' + src)
}
function openPath(p: string) {
  invoke('shell_open_path', { path: p })
}
function openLink(u: string) {
  void openExternal(u)
}
</script>

<template>
  <div class="absolute inset-0 flex pl-[4.875rem] flat:pl-0">
    <!-- ═══════ 左：目录 ═══════ -->
    <div class="shrink-0 flex flex-col pl-1 pr-2.5 w-[270px]">
      <aside class="flex-1 min-h-0 flex flex-col overflow-hidden">
        <!-- 顶上一行：搜索框 + 刷新 + 添加文件夹，和右上角三颗控制点同一条中线 -->
        <div class="h-[calc(var(--bar-h)+10px)] shrink-0 flex items-center gap-0.5 px-1">
          <div class="relative flex-1 min-w-0">
            <span class="icon-[lucide--search] w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input v-model="query" :placeholder="t('skills.search')"
              class="w-full h-8 pl-8 pr-2 rounded-lg bg-transparent border border-transparent text-[13px]
                     placeholder:text-muted-foreground/60 hover:bg-muted/50 focus:bg-background focus:border-border focus:outline-none" />
          </div>
          <button v-if="scanned" class="bar-btn" :title="t('skills.refresh')" @click="refresh">
            <span class="icon-[lucide--refresh-cw] w-4 h-4" :class="{ 'animate-spin': scanning || counting }" />
          </button>
          <button v-if="scanned" class="bar-btn" :class="autoScan ? '!text-foreground' : ''"
            :title="autoScan ? t('skills.autoOn') : t('skills.autoOff')" @click="setAutoScan(!autoScan)">
            <span class="w-4 h-4" :class="autoScan ? 'icon-[lucide--radar]' : 'icon-[lucide--circle-off]'" />
          </button>
          <button class="bar-btn" :title="t('skills.addFolder')" @click="addFolder">
            <span class="icon-[lucide--folder-plus] w-4 h-4" />
          </button>
        </div>

        <p v-if="error" class="px-3 pb-2 text-xs text-red-500 break-all">{{ error }}</p>

        <div v-if="!scanned" class="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <span class="icon-[lucide--blocks] w-10 h-10 text-muted-foreground/60" />
          <p class="text-[13px] text-muted-foreground leading-relaxed">{{ t('skills.notScanned') }}</p>
          <button class="h-9 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5"
            :disabled="scanning" @click="startScan">
            <span class="icon-[lucide--scan-search] w-4 h-4" :class="{ 'animate-pulse': scanning }" />{{ t('skills.scan') }}
          </button>
        </div>
        <div v-else class="fade-y flex-1 min-h-0 overflow-y-auto px-0.5 pb-2.5">
          <template v-for="(g, gi) in groups" :key="g.key">
            <!-- 文件夹这一行 -->
            <!--
              往下滚时文件夹这一行吸在最上面（2026-10-28 用户要的），一眼知道现在看的是哪个文件夹。
              要有底色，不然下面滚上来的行会从它底下透出来；用内联样式是为了不被开云母 / 亚克力时
              把 .bg-background 刷透明的那条全局规则改掉
            -->
            <div class="group/row sticky top-0 z-10 w-full flex items-center gap-1.5 rounded-md py-2 pl-2 pr-1 hover:bg-muted/50 cursor-default"
              :class="gi ? 'mt-1' : ''"
              :style="{ background: 'color-mix(in srgb, var(--background) 94%, transparent)' }"
              :title="g.hint" @click="toggleGroup(g.key)">
              <span class="w-4 h-4 shrink-0 text-muted-foreground"
                :class="collapsed.has(g.key) ? 'icon-[lucide--folder]' : 'icon-[lucide--folder-open]'" />
              <span class="text-[15px] font-semibold truncate" :class="g.missing ? 'text-red-400' : ''">{{ g.title }}</span>
              <span class="text-xs text-muted-foreground tabular-nums">{{ g.missing ? t('skills.missing') : g.items.length }}</span>
              <button v-if="g.folder" class="ml-auto size-6 rounded flex items-center justify-center text-muted-foreground
                       opacity-0 group-hover/row:opacity-100 hover:text-foreground hover:bg-muted"
                :title="t('skills.removeFolder')" @click.stop="removeFolder(g.folder)">
                <span class="icon-[lucide--x] w-3.5 h-3.5" />
              </button>
            </div>
            <!-- 这个文件夹里的 skill：只写名字，归属和状态用标签 -->
            <template v-if="!collapsed.has(g.key)">
              <!--
                一行一个 skill（2026-10-28 用户画的格式）：
                左边图标（链接装进来的换成链接图标）｜中间上面名字、下面归属标签｜右边用过几次（有颜色的数字）
              -->
              <button v-for="s in g.items" :key="g.key + s.path" @click="pick(g, s)"
                class="w-full flex items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors pl-[22px]"
                :class="selectedKey === g.key + '|' + s.path ? 'bg-muted' : 'hover:bg-muted/50 active:bg-muted'">
                <span class="w-[22px] h-[22px] shrink-0"
                  :class="isLinked(g, s) ? 'icon-[lucide--link]' : 'icon-[lucide--file-text]'"
                  :style="{ color: settings.vaultAccent }"
                  :title="isLinked(g, s) ? t('skills.linkTip') : undefined" />
                <span class="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span class="text-[15px] leading-tight truncate">{{ s.name }}</span>
                  <span class="flex items-center gap-1 min-w-0 overflow-hidden">
                    <span v-for="tg in tagsOf(s)" :key="tg.text + tg.cls" class="tag" :class="tg.cls" :title="tg.tip">{{ tg.text }}</span>
                  </span>
                </span>
                <span class="shrink-0 min-w-6 h-6 px-1.5 rounded-md text-xs font-medium tabular-nums flex items-center justify-center"
                  :class="usesCls(totalUses(s))" :title="usesTip(s)">{{ counting && !totalUses(s) ? '…' : totalUses(s) }}</span>
              </button>
            </template>
          </template>

        </div>
      </aside>
    </div>

    <!-- ═══════ 中：SKILL.md ═══════ -->
    <div class="flex-1 min-w-0 flex flex-col pr-2.5 pb-2.5 flat:p-0">
      <!-- 顶上一行：名字 + 每个 AI 用过几次 + 打开文件夹（右边给窗口控制点让位） -->
      <div class="h-[calc(var(--bar-h)+10px)] shrink-0 flex items-center gap-3 pl-2 mr-[calc(var(--ctrl-zone)-10px)] min-w-0">
        <template v-if="current">
          <span class="text-sm font-medium truncate">{{ current.name }}</span>
          <span v-for="a in agents.filter((x) => x.id !== 'agents')" :key="a.id" class="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
            {{ a.name }}：
            <template v-if="usageOf(current, a.id)">
              {{ t('skills.uses', { n: usageOf(current, a.id)!.count }) }} · {{ ago(usageOf(current, a.id)!.last) }}
            </template>
            <template v-else>{{ counting ? '…' : t('skills.neverUsed') }}</template>
          </span>
          <button class="ml-auto bar-btn" :title="t('skills.openFolder') + '\n' + current.path" @click="openPath(current.path)">
            <span class="icon-[lucide--folder-open] w-4 h-4" />
          </button>
        </template>
      </div>

      <div class="flex-1 min-h-0 rounded-[14px] float-card bg-card border border-border overflow-hidden flex flex-col flat:rounded-none flat:border-0">
        <div v-if="!current" class="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {{ t('skills.pick') }}
        </div>
        <MarkdownEditor v-else :key="current.path" :model-value="content" read-only
          :scroll-key="'skill:' + current.path"
          :accent="settings.vaultAccent" :resolve-asset="resolveAsset"
          :font="settings.vaultFont" :font-size="settings.vaultFontSize"
          :color-headings="settings.vaultColorHeadings" mark-mode="clean"
          :on-open-link="openLink" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.bar-btn:hover { background: color-mix(in oklab, var(--muted) 60%, transparent); color: var(--foreground); }

.tag {
  height: 1.125rem;
  padding: 0 0.3rem;
  border-radius: 0.25rem;
  font-size: 10.5px;
  line-height: 1.125rem;
  white-space: nowrap;
}
</style>
