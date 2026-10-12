<script setup lang="ts">
/*
  提示词：ComfyUI / Illustrious 出图用的 Danbooru 标签构建器。从 XGWeb 的 /prompt 页搬过来的。

  和 XGWeb 那份的区别只在「壳」上：
  - 词库、修饰、权重、去重、预设这些逻辑原样搬；词库在 lib/prompt/promptData.ts
  - 存档从浏览器 localStorage 换成 Tauri store（prompt.json），见 lib/prompt/storedRef.ts
  - 库外词的在线翻译不再走 XGWeb 的 /api/proxy，改走 XGTools 自己的翻译引擎链（翻译设置里排的那条）
  - 布局换成本应用的浮空卡片：左分类、中词库、右已选 + 输出
*/
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useElementSize, useEventListener } from '@vueuse/core'
import type { PromptCategory, PromptSubCategory, PromptTag } from '@/lib/prompt/promptData'
import { defaultPromptData } from '@/lib/prompt/promptData'
import { dedupeTags, tagKey } from '@/lib/prompt/dedupe'
import { storedRef } from '@/lib/prompt/storedRef'
import { PROMPT_SYNONYMS } from '@/lib/prompt/promptSynonyms'
import AnimaPanel from '@/components/prompt/AnimaPanel.vue'
import { translateBlocks } from '@/lib/translateChain'
import { zen } from '@/composables/useZen'
import { useI18n } from '@/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const { t } = useI18n()
const zenMode = computed(() => zen.on)

// 存档（prompt.json）。读完之后再做去重 / 补翻译
const nsfwStore = storedRef<NsfwMode>('nsfw_mode', 'all')
const selectedStore = storedRef<SelectedTag[]>('selected', [])
const lineWrapStore = storedRef('line_wrap', false)
// 词块上显示哪种文字：中文 / 英文可以同时亮，但至少留一个（两个都亮时：词库中文在前，右边已选英文在前）
const showZh = storedRef('show_zh', true).data
const showEn = storedRef('show_en', true).data
function toggleLang(which: 'zh' | 'en') {
  const me = which === 'zh' ? showZh : showEn
  const other = which === 'zh' ? showEn : showZh
  if (me.value && !other.value) return // 只剩这一个了，不让关
  me.value = !me.value
}
const storeReady = Promise.all([nsfwStore.ready, selectedStore.ready, lineWrapStore.ready])


// NSFW 模式：'all' 显示全部（含NSFW）, 'nsfw-only' 仅显示NSFW
// 三档：全部 / 隐藏 NSFW / 只看 NSFW（老存档里的值和以前一样，不用迁移）
type NsfwMode = 'all' | 'hide' | 'nsfw-only'
const NSFW_MODES: NsfwMode[] = ['all', 'hide', 'nsfw-only']
const NSFW_ICON: Record<NsfwMode, string> = {
  'all': 'icon-[lucide--layers]',
  'hide': 'icon-[lucide--eye-off]',
  'nsfw-only': 'icon-[lucide--flame]',
}
const nsfwMode = nsfwStore.data

// 已选提示词列表（带分类信息）
type ModGroup = 'degree' | 'color' | 'material' | 'hand' | 'leg' | 'wear' | 'count'
interface ModItem { label: string, value: string }
interface SelectedTag extends PromptTag {
  /** 来源大类名 */
  catName?: string
  /** 是否禁用（不输出到 textarea） */
  disabled?: boolean
  /** 权重（Ctrl+↑/↓ 调；1 或空=不加权） */
  weight?: number
  /** 修饰前缀：颜色/材质/手数/程度（如 white towel） */
  mods?: Partial<Record<ModGroup, ModItem>>
  /** 从 Anima 页「嵌入标签」进来的一整句英文：输出时用括号包起来，单独排在最后一层 */
  sentence?: boolean
}
const selectedTags = selectedStore.data

// prompt 数据
const promptData = ref<PromptCategory[]>(defaultPromptData)

// 每个词库标签在页面里的位置（大类→子类→标签序号），用于「输出按页面顺序排」
const tagPosition = computed(() => {
  const map = new Map<string, number>()
  promptData.value.forEach((cat, ci) => cat.subcategories.forEach((sub, si) => sub.tags.forEach((tg, ti) => {
    const key = tg.value.toLowerCase()
    if (!map.has(key))
      map.set(key, ci * 1_000_000 + si * 1_000 + ti)
  })))
  return map
})
function tagPos(tag: SelectedTag): number {
  return tagPosition.value.get(tag.value.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
}

// 是否按颜色换行输出（默认一行到底）
const lineWrap = lineWrapStore.data
// 当前鼠标悬停的徽章（供 Ctrl+↑/↓ 调权重）
const hoveredTagValue = ref<string | null>(null)

// 输出格式化：先套修饰前缀，再套权重括号；库内词身份不变（颜色不变粉）
function formatVal(tag: SelectedTag): string {
  const v = modifiedValue(tag)
  if (tag.sentence)
    return `(${v})`
  if (tag.weight && Math.abs(tag.weight - 1) > 1e-9)
    return `(${v}:${tag.weight.toFixed(2)})`
  return v
}

// ===== 括号 / 权重解析 =====
// 目标：① 绝不产生 ((x:1.5):0.9) 这种嵌套——多层括号合并成一个权重；
//      ② (a,b:1.1) 这种「一个括号里多个词」当作一个标签，括号内每段都能各自翻译。

/** 括号是否配对（用来确认剥掉的是真正的最外层括号，而不是 "(a) 和 (b)" 这种） */
function isBalanced(s: string): boolean {
  let d = 0
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{')
      d++
    else if (ch === ')' || ch === ']' || ch === '}') {
      d--
      if (d < 0)
        return false
    }
  }
  return d === 0
}

/** 按顶层逗号/换行切分：括号、方括号、<lora:...> 里面的逗号不算分隔符 */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<')
      depth++
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>')
      depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === '\n') && depth === 0) {
      if (cur.trim())
        out.push(cur.trim())
      cur = ''
    }
    else { cur += ch }
  }
  if (cur.trim())
    out.push(cur.trim())
  return out
}

/**
 * 剥掉外层权重括号，多层相乘合并成一个权重。
 * (x:1.5) → 1.5 ｜ ((x:1.5):0.9) → 1.35 ｜ (x) → 1.1 ｜ [x] → 1/1.1
 */
function unwrapWeight(raw: string): { inner: string, weight: number } {
  let s = raw.trim()
  let w = 1
  for (let i = 0; i < 8; i++) {
    const round = s.match(/^\((.*)\)$/s)
    const square = s.match(/^\[(.*)\]$/s)
    if (round && isBalanced(round[1])) {
      let body = round[1]
      const wm = body.match(/^([\s\S]*):\s*(\d+(?:\.\d+)?)\s*$/)
      if (wm && isBalanced(wm[1])) {
        body = wm[1]
        w *= Number.parseFloat(wm[2])
      }
      else { w *= 1.1 }
      s = body.trim()
      continue
    }
    if (square && isBalanced(square[1])) {
      s = square[1].trim()
      w /= 1.1
      continue
    }
    break
  }
  return { inner: s, weight: Math.round(w * 100) / 100 }
}

/** 把一段输入规整成一个 SelectedTag（库内词保留身份/颜色；括号内多段各自查库） */
function normalizeTagInput(raw: string, allTags: PromptTag[]): SelectedTag {
  if (isLoraTag(raw))
    return { label: raw, value: raw }

  const { inner, weight } = unwrapWeight(raw)
  const counted = countFromValue(inner)
  if (counted) {
    const tag: SelectedTag = { ...counted.base, catName: findTagCategory(counted.base), mods: { count: counted.item } }
    if (Math.abs(weight - 1) > 1e-9)
      tag.weight = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight))
    return tag
  }
  const parts = splitTopLevel(inner)
  const hits = parts.map(p => allTags.find(t => t.value.toLowerCase() === p.toLowerCase()) || null)
  const value = parts.join(', ')
  const allHit = hits.every(Boolean)
  const tag: SelectedTag = {
    // 全部命中词库才拼中文；有未命中的先留原文，交给 translateUnknownTags 翻
    label: allHit ? hits.map(h => h!.label).join(', ') : value,
    value,
  }
  if (allHit) {
    // 单个词沿用其分类（颜色/修饰系统靠它）；组合词用第一段的分类，至少颜色对
    tag.catName = findTagCategory(hits[0]!)
    if (hits.some(h => h!.nsfw))
      tag.nsfw = true
  }
  if (Math.abs(weight - 1) > 1e-9)
    tag.weight = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight))
  return tag
}

// 权重调节：鼠标悬停某徽章 Ctrl+↑/↓ 加减 0.05，范围 0.1~2.0；库内词身份不变（颜色不变粉）
const WEIGHT_MIN = 0.1
const WEIGHT_MAX = 2
const WEIGHT_STEP = 0.05
function adjustWeight(value: string, delta: number) {
  const idx = selectedTags.value.findIndex(t => t.value === value)
  if (idx < 0)
    return
  const cur = selectedTags.value[idx].weight ?? 1
  let next = Math.round((cur + delta) * 100) / 100
  next = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, next))
  const weight = Math.abs(next - 1) < 1e-9 ? undefined : next
  selectedTags.value[idx] = { ...selectedTags.value[idx], weight }
}
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if (!e.ctrlKey || !hoveredTagValue.value)
    return
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    adjustWeight(hoveredTagValue.value, WEIGHT_STEP)
  }
  else if (e.key === 'ArrowDown') {
    e.preventDefault()
    adjustWeight(hoveredTagValue.value, -WEIGHT_STEP)
  }
})

// ===== 修饰词（颜色/材质/手数/腿/程度）：给"可修饰的词"加前缀，如 white towel =====
const MODIFIERS: Record<Exclude<ModGroup, 'count'>, ModItem[]> = {
  color: [
    { label: '白', value: 'white' }, { label: '黑', value: 'black' }, { label: '红', value: 'red' },
    { label: '蓝', value: 'blue' }, { label: '绿', value: 'green' }, { label: '黄', value: 'yellow' },
    { label: '粉', value: 'pink' }, { label: '紫', value: 'purple' }, { label: '橙', value: 'orange' },
    { label: '棕', value: 'brown' }, { label: '灰', value: 'grey' }, { label: '金', value: 'gold' },
    { label: '银', value: 'silver' },
  ],
  material: [
    { label: '木', value: 'wooden' }, { label: '金属', value: 'metal' }, { label: '皮革', value: 'leather' },
    { label: '瓷', value: 'porcelain' }, { label: '玻璃', value: 'glass' }, { label: '丝绸', value: 'silk' },
    { label: '蕾丝', value: 'lace' }, { label: '乳胶', value: 'latex' }, { label: '棉', value: 'cotton' },
    { label: '牛仔', value: 'denim' }, { label: '毛皮', value: 'fur' },
  ],
  hand: [
    { label: '单手', value: 'one hand' }, { label: '双手', value: 'both hands' },
    { label: '左手', value: 'left hand' }, { label: '右手', value: 'right hand' },
  ],
  leg: [
    { label: '单腿', value: 'one leg' }, { label: '双腿', value: 'both legs' },
    { label: '左腿', value: 'left leg' }, { label: '右腿', value: 'right leg' },
  ],
  wear: [
    { label: '未穿', value: 'unworn' },
  ],
  degree: [
    { label: '轻微', value: 'slightly' }, { label: '非常', value: 'very' },
  ],
}
const MOD_ORDER: ModGroup[] = ['wear', 'degree', 'color', 'material', 'hand', 'leg']
const MOD_GROUP_LABEL: Record<ModGroup, string> = { wear: '状态', color: '颜色', material: '材质', hand: '手数', leg: '腿', degree: '程度', count: '人数' }

// ===== 人数：词库里只放 1girl / 1boy，2 个、3 个……在已选标签上右键改 =====
// 和颜色/材质不一样，人数不是加前缀，而是整个换成对应的 Danbooru 标签（2girls、6+boys、multiple girls…）
const COUNT_ITEMS: Record<string, ModItem[]> = {
  '1girl': [
    { label: '2个女孩', value: '2girls' }, { label: '3个女孩', value: '3girls' }, { label: '4个女孩', value: '4girls' },
    { label: '5个女孩', value: '5girls' }, { label: '6个以上女孩', value: '6+girls' }, { label: '多个女孩', value: 'multiple girls' },
  ],
  '1boy': [
    { label: '2个男孩', value: '2boys' }, { label: '3个男孩', value: '3boys' }, { label: '4个男孩', value: '4boys' },
    { label: '5个男孩', value: '5boys' }, { label: '6个以上男孩', value: '6+boys' }, { label: '多个男孩', value: 'multiple boys' },
  ],
}
/** 右键菜单里某一组的选项：人数按女孩/男孩给不同的列表，其余组是固定的 */
function modItems(g: ModGroup, tag: SelectedTag | null): ModItem[] {
  if (g === 'count') return (tag && COUNT_ITEMS[tag.value]) || []
  return MODIFIERS[g]
}
/** 粘贴进来的 2girls / multiple boys 这类，认成「1girl/1boy + 人数」，颜色和右键都还在 */
function countFromValue(v: string): { base: PromptTag, item: ModItem } | null {
  const lower = v.trim().toLowerCase()
  for (const [base, items] of Object.entries(COUNT_ITEMS)) {
    const item = items.find(it => it.value === lower)
    if (item) {
      const tag = defaultPromptData.flatMap(c => c.subcategories.flatMap(s => s.tags)).find(t => t.value === base)
      if (tag) return { base: tag, item }
    }
  }
  return null
}

// value → 子类名：判断"动作"里的词是手部动作(给手数)还是腿部动作(给腿)
const SUB_OF_VALUE = new Map<string, string>()
for (const cat of defaultPromptData)
  for (const sub of cat.subcategories)
    for (const t of sub.tags)
      SUB_OF_VALUE.set(t.value, sub.name)
const ACTION_HAND_SUBS = new Set(['手·手臂', '手·手势', '手·放身上', '手·脸/头发', '手·遮挡', '手·持物', '手·拨扯衣物', '手·抓握他人', '互动', '性行为·手口'])
const ACTION_LEG_SUBS = new Set(['腿·姿态', '脚·脚趾脚底'])

// 可修饰的词 + 显示哪些组：衣物/道具→颜色·材质；动作里手部动作→手数、腿部动作→腿；都可加程度
// (站姿/坐姿/躺趴/视线/运动/体位等既非手也非腿，不给修饰、不显角标)
function modGroupsFor(tag: SelectedTag | null): ModGroup[] {
  if (!tag)
    return []
  if (COUNT_ITEMS[tag.value])
    return ['count']
  // 衣物多一个「未穿」：脱下来放着的衣服，Danbooru 写法就是 unworn + 衣服名
  if (tag.catName === '衣物')
    return ['wear', 'color', 'material', 'degree']
  if (tag.catName === '道具')
    return ['color', 'material', 'degree']
  if (tag.catName === '动作') {
    const sub = SUB_OF_VALUE.get(tag.value)
    if (sub && ACTION_HAND_SUBS.has(sub))
      return ['hand', 'degree']
    if (sub && ACTION_LEG_SUBS.has(sub))
      return ['leg', 'degree']
    return []
  }
  return []
}
function isModifiable(tag: SelectedTag): boolean {
  return modGroupsFor(tag).length > 0
}
function modifiedValue(tag: SelectedTag): string {
  if (!tag.mods)
    return tag.value
  if (tag.mods.count)
    return tag.mods.count.value
  const pre = MOD_ORDER.map(g => tag.mods![g]?.value).filter(Boolean).join(' ')
  return pre ? `${pre} ${tag.value}` : tag.value
}
function modifiedLabel(tag: SelectedTag): string {
  if (!tag.mods)
    return tag.label
  if (tag.mods.count)
    return tag.mods.count.label
  const pre = MOD_ORDER.map(g => tag.mods![g]?.label).filter(Boolean).join('')
  return pre ? `${pre}${tag.label}` : tag.label
}
// 加/去修饰（再点同一个=取消）
function applyMod(value: string, group: ModGroup, item: ModItem) {
  const idx = selectedTags.value.findIndex(t => t.value === value)
  if (idx < 0)
    return
  const t = selectedTags.value[idx]
  const mods: Partial<Record<ModGroup, ModItem>> = { ...(t.mods || {}) }
  if (mods[group]?.value === item.value)
    delete mods[group]
  else
    mods[group] = item
  selectedTags.value[idx] = { ...t, mods: Object.keys(mods).length ? mods : undefined }
}

// 过滤子分类中的 NSFW 标签
// 过滤结果按大类缓存：模板里每次重渲染都要调好几遍，2000 多个词每次现算会拖慢滚动
const filteredSubsMap = computed(() => new Map(promptData.value.map(cat => [cat.name, computeFilteredSubs(cat)])))
function getFilteredSubs(cat: PromptCategory): PromptSubCategory[] {
  return filteredSubsMap.value.get(cat.name) ?? []
}
function computeFilteredSubs(cat: PromptCategory): PromptSubCategory[] {
  if (nsfwMode.value === 'all')
    return cat.subcategories
  // 隐藏 NSFW / 仅 NSFW（搜索不过滤，只定位，见下面的 searchMatches）
  return cat.subcategories.map(sub => ({
    ...sub,
    tags: sub.tags.filter(t => (nsfwMode.value === 'nsfw-only') === !!t.nsfw),
  })).filter(sub => sub.tags.length > 0)
}

// ===== 模糊搜索 =====
// 中文 / 英文都能搜，多个词用空格隔开 = 都要命中。
// 中文按「字按顺序出现」算命中（「揉胸」能搜到「揉胸(揉对方胸)」，「双马」能搜到「双马尾辫」）；
// 英文除了包含，还容许拼错一个字母（「blondee」也能找到 blonde hair），下划线写法和空格写法通用。
const searchQuery = ref('')
// Ctrl+F：焦点给到底部搜索框（并选中已有内容，直接打字就是新搜索）
const searchInput = ref<HTMLInputElement>()
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    searchInput.value?.focus()
    searchInput.value?.select()
  }
})
const searchTokens = computed(() =>
  searchQuery.value.toLowerCase().replace(/_/g, ' ').split(/[\s,，]+/).filter(Boolean))
const CJK = /[㐀-鿿]/
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (const ch of hay) {
    if (ch === needle[i]) i++
    if (i === needle.length) return true
  }
  return false
}
// 编辑距离是否 ≤ 1（只关心够不够近，不用算出具体值）
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0, j = 0, edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}
function matchToken(tok: string, label: string, value: string): boolean {
  if (label.includes(tok) || value.includes(tok)) return true
  if (CJK.test(tok)) return tok.length > 1 && isSubsequence(tok, label)
  if (tok.length < 4) return false
  return value.split(/[\s()]+/).some(w => w.length >= 3 && withinOneEdit(tok, w))
}
// 同义词（lib/prompt/promptSynonyms.ts）：英文 Danbooru 别名 + 手写的中文说法，搜「平视」「鸟瞰」「捏胸」也能找到
function matchTag(tag: PromptTag, tokens: string[]): boolean {
  const syn = (PROMPT_SYNONYMS[tag.value] ?? []).join(' ').toLowerCase()
  const label = `${tag.label.toLowerCase()} ${syn}`
  const value = `${tag.value.toLowerCase().replace(/_/g, ' ')} ${syn}`
  return tokens.every(tok => matchToken(tok, label, value))
}
// 搜索像浏览器的查找：不隐藏别的词，所有命中的词描一圈，当前那个滚到中间并闪；回车下一个、Shift+回车上一个
const searchMatches = computed(() => {
  const q = searchTokens.value
  if (!q.length) return [] as string[]
  const out: string[] = []
  for (const cat of promptData.value)
    for (const sub of getFilteredSubs(cat))
      for (const tag of splitNsfw(sub.tags).flat()) if (matchTag(tag, q)) out.push(tag.value)
  return out
})
const searchHits = computed(() => (searchTokens.value.length ? searchMatches.value.length : -1))
const hitSet = computed(() => new Set(searchMatches.value))
const hitIdx = ref(0)
const currentHit = computed(() => searchMatches.value[hitIdx.value] ?? '')
// 词块 v-memo 认它：命中集合或当前项变了才重画
const hitSig = computed(() => `${searchQuery.value}|${currentHit.value}`)
function goHit(step: number) {
  const n = searchMatches.value.length
  if (!n) return
  hitIdx.value = (hitIdx.value + step + n) % n
  nextTick(() => {
    const el = scrollContainer.value?.querySelector<HTMLElement>(`[data-v="${CSS.escape(currentHit.value)}"]`)
    if (!el) return
    glideTo(el, () => {
      el.classList.remove('chip-flash')
      void el.offsetWidth
      el.classList.add('chip-flash')
      el.addEventListener('animationend', () => el.classList.remove('chip-flash'), { once: true })
    })
  })
}
// 打字停一下再定位，免得每敲一个字就滚一次
let searchTimer = 0
watch(searchQuery, () => {
  clearTimeout(searchTimer)
  hitIdx.value = 0
  searchTimer = window.setTimeout(() => goHit(0), 180)
})

// 生成锚点 ID
function sectionId(catIdx: number, subIdx: number): string {
  return `section-${catIdx}-${subIdx}`
}

function categoryId(catIdx: number): string {
  return `cat-${catIdx}`
}

// 侧边栏点击跳转 + 闪烁高亮
// 点大纲跳过去：自己做滚动动画（比浏览器自带的 smooth 快），目标小节尽量停在可视区正中；
// 到位之后才闪，以前是一开始滚就闪，离得远的话还没滚到就闪完了
let jumpTimer = 0
let jumping = false
function flash(target: Element) {
  target.classList.remove('section-flash')
  void (target as HTMLElement).offsetWidth
  target.classList.add('section-flash')
  target.addEventListener('animationend', () => target.classList.remove('section-flash'), { once: true })
}
function centerTop(box: HTMLElement, target: HTMLElement): number {
  const r = target.getBoundingClientRect()
  const br = box.getBoundingClientRect()
  // 比可视区还高的小节就让它顶头，不然开头会被切掉
  const offset = r.height < br.height ? (br.height - r.height) / 2 : 16
  const top = box.scrollTop + (r.top - br.top) - offset
  return Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight))
}
// 把某个元素平滑滚到可视区中间，到位后回调（大纲跳转、搜索定位共用）
let glideRaf = 0
function glideTo(target: HTMLElement, onArrive: () => void) {
  const box = scrollContainer.value
  if (!box) return
  cancelAnimationFrame(glideRaf)
  jumping = true
  clearTimeout(jumpTimer)
  const from = box.scrollTop
  const to = centerTop(box, target)
  const dist = Math.abs(to - from)
  const duration = Math.min(420, 160 + dist / 12) // 近的一下就到，远的也不超过 0.42 秒
  const start = performance.now()
  const ease = (x: number) => 1 - Math.pow(1 - x, 3)
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / duration)
    box.scrollTop = from + (to - from) * ease(p)
    if (p < 1) { glideRaf = requestAnimationFrame(step); return }
    // 屏幕外的小节是先估高度的（content-visibility），滚过去时真实高度出来会挪一点，到位后再校正一次
    box.scrollTop = centerTop(box, target)
    onArrive()
    jumpTimer = window.setTimeout(() => { jumping = false }, 120)
  }
  glideRaf = requestAnimationFrame(step)
}
function scrollToSection(catIdx: number, subIdx?: number) {
  const id = subIdx !== undefined ? sectionId(catIdx, subIdx) : categoryId(catIdx)
  const el = document.getElementById(id)
  if (!el) return
  activeSectionId.value = id // 立即高亮点击项；滚动过程中不让滚动监听改掉它
  const target = (subIdx !== undefined ? el : el.nextElementSibling) as HTMLElement | null
  const flashTarget = target && target.classList.contains('tag-section') ? target : el
  glideTo(flashTarget, () => { if (flashTarget.classList.contains('tag-section')) flash(flashTarget) })
}

// textarea 文本
const promptText = computed({
  get() {
    // 顺序跟「上面的徽章」一致（按颜色分组 + 组内按页面顺序）
    const groups = groupedSelectedTags.value
      .map(g => g.filter(t => !t.disabled).map(formatVal))
      .filter(g => g.length > 0)
    if (lineWrap.value)
      return groups.map(g => g.join(', ')).join('\n')
    return groups.flat().join(', ')
  },
  set(val: string) {
    // 中文逗号自动转英文逗号
    const normalized = val.replace(/，/g, ',')
    // 按顶层逗号切分：括号内的逗号不拆，(a,b:1.1) 会整体留成一个标签
    const values = splitTopLevel(normalized)
    const allTags = promptData.value.flatMap(c => c.subcategories.flatMap(s => s.tags))
    const newSelected: SelectedTag[] = dedupeTags(values.map(v => normalizeTagInput(v, allTags)), dedupeKey)
    selectedTags.value = newSelected
    // 翻译未匹配的标签
    translateUnknownTags(newSelected)
  },
})

// 翻译未匹配的标签（textarea 输入时调用）
async function translateUnknownTags(tags: SelectedTag[]) {
  const allTags = promptData.value.flatMap(c => c.subcategories.flatMap(s => s.tags))

  // 需要配中文的：label 还是英文原文，或组合词的片段数跟 label 对不上（说明没配好）
  const needsLabel = (t: SelectedTag) => {
    if (isLoraTag(t.value))
      return false
    if (!t.label || t.label === t.value)
      return true
    return splitTopLevel(t.value).length !== splitTopLevel(t.label).length
  }
  const todo = tags.filter(needsLabel)
  if (todo.length === 0)
    return

  // 逐个标签拆成片段：库里有的直接拿中文，没有的收集起来批量走在线翻译
  interface Job { value: string, parts: string[], labels: (string | null)[] }
  const jobs: Job[] = []
  const missing: { job: Job, idx: number }[] = []
  for (const t of todo) {
    const parts = splitTopLevel(t.value)
    const labels = parts.map(p => allTags.find(x => x.value.toLowerCase() === p.toLowerCase())?.label ?? null)
    const job: Job = { value: t.value, parts, labels }
    jobs.push(job)
    labels.forEach((l, i) => { if (l === null) missing.push({ job, idx: i }) })
  }

  const applyJob = (job: Job) => {
    const i = selectedTags.value.findIndex(t => t.value === job.value)
    if (i >= 0)
      selectedTags.value[i] = { ...selectedTags.value[i], label: job.labels.map((l, k) => l ?? job.parts[k]).join(', ') }
  }

  // 全部命中词库的先落地（离线、瞬时）
  jobs.filter(j => !j.labels.includes(null)).forEach(applyJob)
  if (missing.length === 0)
    return

  isTranslating.value = true
  try {
    const texts = missing.map(m => m.job.parts[m.idx])
    const translated = await translateBatch(texts)
    missing.forEach((m, i) => { m.job.labels[m.idx] = translated[i] || texts[i] })
    jobs.filter(j => j.labels.includes(null) === false).forEach(applyJob)
  }
  finally {
    isTranslating.value = false
  }
}

// 页面加载时把已选词重新对齐：库内词立刻显示中文(离线瞬时)，其余尝试在线翻译。
// 修复"从本地/云端恢复的英文标签不随词库更新、加载时不翻译"的问题。
// ===== 自动去重：同一个词（忽略大小写与多余空格）只留第一个 =====
// key 用「修饰后的值」，所以「白浴巾」和「浴巾」算两个不同的词，不会被误删。
function dedupeKey(tag: SelectedTag): string {
  return tagKey(modifiedValue(tag))
}
function dedupeSelected() {
  const deduped = dedupeTags(selectedTags.value, dedupeKey)
  if (deduped.length !== selectedTags.value.length)
    selectedTags.value = deduped
}
// 任何来源（粘贴、点词库、加自定义、载入预设、云端恢复）新增的重复都会被清掉
watch(selectedTags, dedupeSelected, { deep: true })
// 进页面（读完存档后）先把历史遗留的重复清一次，再给没中文的词补翻译
onMounted(async () => {
  await storeReady
  // 词库分类会调整（词可能换了大类），存档里的词按当前词库重新认一次大类，颜色和修饰才对得上
  selectedTags.value = selectedTags.value.map((t) => {
    // 以前单独存的 2girls / 3boys 这类，词库里已经没有了，换成「1girl/1boy + 人数」
    const counted = !t.mods && countFromValue(t.value)
    if (counted) return { ...counted.base, catName: findTagCategory(counted.base), mods: { count: counted.item }, weight: t.weight, disabled: t.disabled }
    const c = findTagCategory(t)
    return c && c !== t.catName ? { ...t, catName: c } : t
  })
  dedupeSelected()
  translateUnknownTags(selectedTags.value)
})

// 查找标签所属大类
function findTagCategory(tag: PromptTag): string | undefined {
  for (const cat of promptData.value) {
    for (const sub of cat.subcategories) {
      if (sub.tags.some(t => t.value === tag.value))
        return cat.name
    }
  }
  return undefined
}

// 检查标签是否已选
// 已选词做成集合：每个词块判断「选没选」从逐个比对变成一次查表
const selectedKeySet = computed(() => new Set(selectedTags.value.map(t => tagKey(t.value))))
// 已选内容的指纹：中间词库每一节用 v-memo 认它，没变就不重渲染（滚动时左边高亮在变，词库不用跟着重画）
const selectedSig = computed(() => [...selectedKeySet.value].join('|'))
// 一节里的词拆成「普通 / NSFW」两组（各自保持原来的顺序）；只有一种时就是一组
function splitNsfw(tags: PromptTag[]): PromptTag[][] {
  const normal = tags.filter(t => !t.nsfw)
  const nsfw = tags.filter(t => t.nsfw)
  return normal.length && nsfw.length ? [normal, nsfw] : [tags]
}
function isSelected(tag: PromptTag): boolean {
  return selectedKeySet.value.has(tagKey(tag.value))
}

// 子分类中已选的标签数量
function selectedCountInSub(sub: PromptSubCategory): number {
  return sub.tags.filter(t => isSelected(t)).length
}

// 判断冲突
function hasConflict(sub: PromptSubCategory): boolean {
  if (!sub.conflict)
    return false
  return selectedCountInSub(sub) > 1
}

// 冲突 CSS 类
function getConflictClass(tag: PromptTag, sub: PromptSubCategory): string {
  if (!isSelected(tag))
    return ''
  if (!sub.conflict)
    return ''
  if (selectedCountInSub(sub) <= 1)
    return ''
  if (sub.conflict === 'exclusive')
    return 'chip-conflict-exclusive'
  return 'chip-conflict-warn'
}

// 切换标签
function toggleTag(tag: PromptTag) {
  const idx = selectedTags.value.findIndex(t => tagKey(t.value) === tagKey(tag.value))
  if (idx >= 0) {
    selectedTags.value.splice(idx, 1)
  }
  else {
    const catName = findTagCategory(tag)
    selectedTags.value.push({ ...tag, catName })
  }
}

// 切换徽章启用/禁用
function toggleBadgeDisabled(tag: SelectedTag) {
  const idx = selectedTags.value.findIndex(t => t.value === tag.value)
  if (idx >= 0)
    selectedTags.value[idx].disabled = !selectedTags.value[idx].disabled
}

// 右键菜单状态
const contextMenu = ref<{ show: boolean, x: number, y: number, tag: SelectedTag | null }>({
  show: false,
  x: 0,
  y: 0,
  tag: null,
})

function onBadgeContextMenu(e: MouseEvent, tag: SelectedTag) {
  e.preventDefault()
  contextMenu.value = { show: true, x: e.clientX, y: e.clientY, tag }
}

function closeContextMenu() {
  contextMenu.value.show = false
}
// 右键菜单里当前词的「实时」引用（applyMod 换了对象后仍能反映已选修饰）
const ctxTag = computed(() => selectedTags.value.find(t => t.value === contextMenu.value.tag?.value) || null)

async function ctxCopyEnglish() {
  if (contextMenu.value.tag)
    await navigator.clipboard.writeText(contextMenu.value.tag.value)
  closeContextMenu()
}

async function ctxCopyChinese() {
  if (contextMenu.value.tag)
    await navigator.clipboard.writeText(contextMenu.value.tag.label)
  closeContextMenu()
}

function ctxRemove() {
  if (contextMenu.value.tag) {
    const idx = selectedTags.value.findIndex(t => t.value === contextMenu.value.tag!.value)
    if (idx >= 0)
      selectedTags.value.splice(idx, 1)
  }
  closeContextMenu()
}

// 清空所有
function clearAll() {
  selectedTags.value = []
}
// 只清掉划掉（停用）的词
const hasDisabledTags = computed(() => selectedTags.value.some(t => t.disabled))
function clearDisabled() {
  selectedTags.value = selectedTags.value.filter(t => !t.disabled)
}

// ===== 预设（2026-10-12）=====
// 内置只给一组「纯质量词」，不带人物/角度/场景；其余是用户自己把当前已选存下来的。
// 点预设 = 把那组标签「加」进已选（已有的跳过），不清掉现有的 —— 质量词预设就是拿来往已有画面上叠的。
interface PromptPreset { id: string, name: string, tags: SelectedTag[] }
/*
  Anima 质量词：Anima 的质量体系跟 Illustrious 一样（masterpiece / best quality）再叠评分 score_N，
  score_7 是作者推荐的中间档（太高反而偏某种画风）；newest 让它偏新的画风、少点老番味。
  不放 8k/HDR/ultra-detailed 这类 Danbooru 里不存在的词，Anima 的编码器只认 Danbooru 标签和自然语言。
*/
const BUILTIN_PRESETS: { id: string, nameKey: string, values: string[] }[] = [
  { id: 'anima-quality', nameKey: 'prompt.presetAnimaQuality', values: ['masterpiece', 'best quality', 'score_7', 'newest'] },
  // 无人场景图：质量词 + no humans（明确不要人）+ scenery（让画面以风景为主体），角度和具体景物留给用户自己选
  { id: 'anima-scenery', nameKey: 'prompt.presetAnimaScenery', values: ['masterpiece', 'best quality', 'score_7', 'newest', 'no humans', 'scenery'] },
]
const presetStore = storedRef<PromptPreset[]>('presets', [])
const userPresets = presetStore.data
const presetOpen = ref(false)
const presetName = ref('')
const presetDeleting = ref<string | null>(null)
function builtinTags(values: string[]): SelectedTag[] {
  return values.map(v => normalizeTagInput(v, allLibraryTags.value))
}
function applyPreset(tags: SelectedTag[]) {
  for (const tag of tags) {
    if (selectedTags.value.some(t => dedupeKey(t) === dedupeKey(tag)))
      continue
    selectedTags.value.push(JSON.parse(JSON.stringify(tag)))
  }
  presetOpen.value = false
}
function savePreset() {
  const name = presetName.value.trim()
  if (!name || selectedTags.value.length === 0)
    return
  const tags: SelectedTag[] = JSON.parse(JSON.stringify(selectedTags.value))
  const same = userPresets.value.find(p => p.name === name)
  if (same) same.tags = tags // 同名就覆盖，省得列表里出现两个一样的名字
  else userPresets.value.push({ id: `${Date.now()}`, name, tags })
  presetName.value = ''
}
// 删除点两下：第一下变红提示「再点一次」，防手滑
function deletePreset(id: string) {
  if (presetDeleting.value !== id) {
    presetDeleting.value = id
    return
  }
  userPresets.value = userPresets.value.filter(p => p.id !== id)
  presetDeleting.value = null
}
watch(presetOpen, () => { presetDeleting.value = null })

// 复制到剪贴板
const copied = ref(false)
async function copyToClipboard() {
  try {
    await navigator.clipboard.writeText(promptText.value)
    copied.value = true
    setTimeout(() => copied.value = false, 2000)
  }
  catch (e) {
    console.error('复制失败:', e)
  }
}

// 复制中文：对应上面每个词的中文标签（含修饰前缀），格式与英文一致（一行/换行同步、逗号分隔）
const promptTextZh = computed(() => {
  const labelOf = (t: SelectedTag) => isLoraTag(t.value) ? modifiedValue(t) : modifiedLabel(t)
  const groups = groupedSelectedTags.value
    .map(g => g.filter(t => !t.disabled).map(labelOf))
    .filter(g => g.length > 0)
  if (lineWrap.value)
    return groups.map(g => g.join(', ')).join('\n')
  return groups.flat().join(', ')
})
const copiedZh = ref(false)
async function copyPromptZh() {
  try {
    await navigator.clipboard.writeText(promptTextZh.value)
    copiedZh.value = true
    setTimeout(() => copiedZh.value = false, 2000)
  }
  catch (e) {
    console.error('复制失败:', e)
  }
}

// 当前活跃侧边栏项
const activeSectionId = ref('cat-0')
const scrollContainer = ref<HTMLElement>()

// 滚动时每帧最多算一次（以前每个滚动事件都把一百多个锚点的位置全量读一遍）
let scrollRaf = 0
function onContentScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateActiveSection() })
}
function updateActiveSection() {
  if (!scrollContainer.value || jumping)
    return
  const scrollTop = scrollContainer.value.scrollTop + 48
  const sections = scrollContainer.value.querySelectorAll('[data-anchor]')
  let current = ''
  sections.forEach((el) => {
    const htmlEl = el as HTMLElement
    if (htmlEl.offsetTop <= scrollTop) {
      current = htmlEl.dataset.anchor || ''
    }
  })
  if (current)
    activeSectionId.value = current
}

// ===== 翻译功能 =====
// 库外词走 XGTools 的翻译引擎链（翻译设置里排的顺序，谁成功用谁）；全挂了就原样留英文，不打断操作
const customInput = ref('')
const isTranslating = ref(false)

// 解析带权重的括号标签，如 (wet clothes:0.4) → { inner: 'wet clothes', prefix: '(', suffix: ':0.4)' }
function parseWeightedTag(text: string): { inner: string, prefix: string, suffix: string } | null {
  const m = text.match(/^([({[]*)([\w\s-]+)(?::([\d.]+))?([)}\]]*)$/)
  if (m && (m[1] || m[3] || m[4])) {
    return { inner: m[2].trim(), prefix: m[1], suffix: (m[3] ? `:${m[3]}` : '') + m[4] }
  }
  return null
}

const translateCache = new Map<string, string>()
async function translateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return []
  const todo = [...new Set(texts.filter(s => !translateCache.has(s)))]
  if (todo.length) {
    try {
      const r = await translateBlocks(todo, 'zh')
      todo.forEach((s, i) => { if (r.texts[i]) translateCache.set(s, r.texts[i]) })
    }
    catch (e) {
      console.warn('提示词在线翻译失败，先留英文:', e)
    }
  }
  return texts.map(s => translateCache.get(s) || s)
}

async function addCustomTags() {
  const input = customInput.value.trim()
  if (!input)
    return

  isTranslating.value = true
  try {
    // 按顶层逗号切分（括号内的逗号不拆），再逐个规整成标签
    const allTags = promptData.value.flatMap(c => c.subcategories.flatMap(s => s.tags))
    const added: SelectedTag[] = []
    for (const v of splitTopLevel(input.replace(/，/g, ','))) {
      const tag = normalizeTagInput(v, allTags)
      if (selectedTags.value.some(t => dedupeKey(t) === dedupeKey(tag)))
        continue
      selectedTags.value.push(tag)
      added.push(tag)
    }
    // 没配到中文的（含组合词里的个别片段）统一交给它翻
    await translateUnknownTags(added)

    customInput.value = ''
  }
  finally {
    isTranslating.value = false
  }
}

// ===== 分层 + 配色（2026-10-11）=====
// 右边已选标签按「层」从上到下排，层与层之间一条虚线；左边词库、大纲用同一套颜色。
// 同一个大类用同一色系、深浅区分：人物=粉/珊瑚/洋红，衣服=青三档，动作=黄绿几档。
// NSFW 不占颜色，只加黄色虚线框（颜色还是它所在那层的），所以「中胸」和「大胸」会挨在身材层里。
const LAYERS = ['info', 'comp', 'scene', 'head', 'expr', 'body', 'cloth', 'cstate', 'acc',
  'act-body', 'act-head', 'act-hand', 'act-leg', 'act-sex', 'prop', 'other', 'sentence', 'lora'] as const
type Layer = typeof LAYERS[number]
const LAYER_ORDER = new Map<string, number>(LAYERS.map((l, i) => [l, i]))
const CLOTH_STATE_SUBS = new Set(['掀/拉/脱', '穿着状态', '袖/领/面料'])
const ACT_SEX_SUBS = new Set(['互动', '性行为·手口', '性行为·插入', '性行为·多人/画面', '情趣玩具', '体位', '异物插入', '射精/体液'])
function catLayer(catName: string): Layer {
  switch (catName) {
    case '信息': return 'info'
    case '构图': return 'comp'
    case '场景': return 'scene'
    case '角色/职业': case '人物特性': case '人物外观': return 'head'
    case '人物表情': return 'expr'
    case '人物身材': return 'body'
    case '衣物': return 'cloth'
    case '动作': return 'act-body'
    case '道具': return 'prop'
    default: return 'other'
  }
}
function subLayer(catName: string, subName: string | undefined): Layer {
  if (catName === '衣物' && subName) {
    if (CLOTH_STATE_SUBS.has(subName)) return 'cstate'
    if (subName.startsWith('配饰')) return 'acc'
  }
  if (catName === '动作' && subName) {
    if (subName === '视线') return 'act-head'
    if (subName.startsWith('手·')) return 'act-hand'
    if (subName.startsWith('腿·') || subName.startsWith('脚·')) return 'act-leg'
    if (ACT_SEX_SUBS.has(subName)) return 'act-sex'
  }
  return catLayer(catName)
}
function layerOf(tag: SelectedTag): Layer {
  if (isLoraTag(tag.value)) return 'lora'
  if (tag.sentence) return 'sentence'
  if (!tag.catName) return 'other'
  return subLayer(tag.catName, SUB_OF_VALUE.get(tag.value))
}

// 判断是否为纯翻译标签（不在词库中的）
function isTranslatedTag(tag: SelectedTag): boolean {
  if (tag.catName || tag.label === tag.value)
    return false
  // 检查内部内容是否在词库中
  const allTags = promptData.value.flatMap(c => c.subcategories.flatMap(s => s.tags))
  const parsed = parseWeightedTag(tag.value)
  const inner = parsed ? parsed.inner : tag.value
  return !allTags.some(t => t.value.toLowerCase() === inner.toLowerCase())
}

// 判断是否为 LoRA 标签
function isLoraTag(value: string): boolean {
  return value.includes('<lora:') || value.includes('<lyco:')
}

const groupedSelectedTags = computed(() => {
  const sorted = [...selectedTags.value].sort((a, b) => {
    const oa = LAYER_ORDER.get(layerOf(a)) ?? 99
    const ob = LAYER_ORDER.get(layerOf(b)) ?? 99
    if (oa !== ob)
      return oa - ob
    return tagPos(a) - tagPos(b)
  })
  // 按层分组：每层一行，层与层之间画虚线
  const groups: SelectedTag[][] = []
  let last = ''
  for (const tag of sorted) {
    const l = layerOf(tag)
    if (l !== last) {
      groups.push([])
      last = l
    }
    groups[groups.length - 1].push(tag)
  }
  return groups
})

// 右侧面板开关

// 右栏模式：标签 / Anima
// 自然语言浮窗（中文 → 英文句子 / 标签）开没开；Esc 关
const nlOpen = ref(false)
useEventListener(window, 'keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && nlOpen.value) nlOpen.value = false })
const allLibraryTags = computed(() => promptData.value.flatMap(c => c.subcategories.flatMap(s => s.tags)))
// 发给 Anima 打磨的已选词：跟输出框一致（套好修饰和权重、跳过停用的）
// 右栏底部浮空底板的实际高度：已选标签滚动区按它留出底部空白
const rpBottomEl = ref<HTMLElement>()
const { height: rpBottomH } = useElementSize(rpBottomEl, undefined, { box: 'border-box' })
// Anima 页「嵌入标签」：句子作为一个普通标签进已选列表，能停用、能删；再点一次就拿掉
const embeddedSentences = computed(() => selectedTags.value.filter(t => t.sentence).map(t => t.value))
function toggleSentence({ en, zh }: { en: string, zh: string }) {
  const i = selectedTags.value.findIndex(t => t.sentence && t.value === en)
  if (i >= 0) selectedTags.value.splice(i, 1)
  else selectedTags.value.push({ label: zh || en, value: en, sentence: true })
}
const pickedForAnima = computed(() => selectedTags.value.filter(t => !t.disabled).map(formatVal))
</script>

<template>
  <!--
    2026-10-11 用户要的「去掉面板、一体化」：这一页不再用一张张浮空卡片，三栏直接铺在窗口上，
    栏与栏之间只用一条细线隔开。先只改这一页试效果，别的页面不动。
    左：分类大纲（一整条，顶上不放搜索）｜中：词库，搜索栏固定在底部｜右：顶部「标签 / Anima」两个页签
  -->
  <div class="absolute inset-0 flex" :class="zenMode ? 'pl-2.5' : 'pl-[4.875rem] flat:pl-0'">

    <!-- ═══════ 左：分类大纲 ═══════ -->
    <!-- 上下两头做渐隐：滚动时内容是慢慢淡出去的，不会在边上被一刀切断 -->
    <aside class="fade-y w-[200px] shrink-0 overflow-y-auto pt-2 pb-2">
      <nav class="sidebar-nav">
        <template v-for="(cat, catIdx) in promptData" :key="cat.name">
          <div v-if="getFilteredSubs(cat).length > 0" class="nav-group ly" :class="`ly-${catLayer(cat.name)}`">
            <button class="nav-cat" :class="{ 'nav-active': activeSectionId === categoryId(catIdx) }"
              @click="scrollToSection(catIdx)">
              <span :class="cat.icon" class="size-[16px] nav-cat-icon" />
              <span>{{ cat.name }}</span>
            </button>
            <button v-for="(sub, subIdx) in getFilteredSubs(cat)" :key="sub.name" class="nav-sub"
              :class="{ 'nav-active': activeSectionId === sectionId(catIdx, subIdx), 'nav-sub-conflict': hasConflict(sub) }"
              @click="scrollToSection(catIdx, subIdx)">
              <span class="nav-sub-text">{{ sub.name }}</span>
              <span v-if="selectedCountInSub(sub) > 0" class="nav-sub-count" :class="{ 'count-conflict': hasConflict(sub) }">
                {{ selectedCountInSub(sub) }}
              </span>
            </button>
          </div>
        </template>
      </nav>
    </aside>

    <!-- ═══════ 中：词库 + 底部搜索栏 ═══════ -->
    <div class="flex-1 min-w-0 flex flex-col relative">
      <div ref="scrollContainer" class="fade-y fade-y-tall flex-1 min-h-0 content-scroll pb-16" @scroll="onContentScroll">
        <div class="content-body">
          <template v-for="(cat, catIdx) in promptData" :key="cat.name">
            <template v-if="getFilteredSubs(cat).length > 0">
              <div :id="categoryId(catIdx)" :data-anchor="categoryId(catIdx)" class="cat-header">
                <span :class="cat.icon" class="size-5 cat-header-icon" />
                <h2 class="cat-header-text">{{ cat.name }}</h2>
              </div>

              <section v-for="(sub, subIdx) in getFilteredSubs(cat)" :id="sectionId(catIdx, subIdx)" :key="sub.name"
                v-memo="[sub, selectedSig, showZh, showEn, hitSig]"
                :data-anchor="sectionId(catIdx, subIdx)" class="tag-section">
                <div class="section-head">
                  <h3 class="section-title">{{ sub.name }}</h3>
                  <span v-if="sub.conflict && hasConflict(sub)" class="conflict-hint"
                    :class="sub.conflict === 'exclusive' ? 'conflict-exclusive' : 'conflict-warn'">
                    <span :class="sub.conflict === 'exclusive' ? 'icon-[lucide--triangle-alert]' : 'icon-[lucide--info]'" class="size-3.5" />
                    {{ sub.conflict === 'exclusive' ? t('prompt.conflictExclusive') : t('prompt.conflictWarn') }}
                  </span>
                </div>
                <!-- 一节里既有普通词又有 NSFW 词时：普通词在上，虚线隔开，NSFW 词在下 -->
                <div class="tag-grid">
                  <template v-for="(group, gi) in splitNsfw(sub.tags)" :key="gi">
                  <div v-if="gi > 0" class="nsfw-divider" />
                  <button v-for="tag in group" :key="tag.value" class="chip" :data-v="tag.value"
                    :class="[
                      'ly', `ly-${subLayer(cat.name, sub.name)}`,
                      isSelected(tag) ? 'chip-on' : '',
                      tag.nsfw ? 'chip-nsfw' : '',
                      hitSet.has(tag.value) ? (tag.value === currentHit ? 'chip-hit chip-hit-cur' : 'chip-hit') : '',
                      getConflictClass(tag, sub),
                    ]"
                    @click="toggleTag(tag)">
                    <!-- 词库里中文在前、英文在后（右边已选标签才是英文在前） -->
                    <span v-if="showZh" class="chip-main">{{ tag.label }}</span>
                    <span v-if="showEn" :class="showZh ? 'chip-sub' : 'chip-main'">{{ tag.value }}</span>
                  </button>
                  </template>
                </div>
              </section>
            </template>
          </template>
        </div>
      </div>

      <!-- 浮空搜索条：圆角小横条浮在词库底部，不贴底；搜索 + 命中数 + NSFW 三档 -->
      <!-- 高度、圆角和右栏底部按钮一样（h-10 / rounded-md）；离底 8px，和右栏那块浮空底板的下沿齐平 -->
      <div class="search-pill absolute left-1/2 -translate-x-1/2 bottom-2 w-[min(560px,calc(100%-32px))] h-10
                  flex items-center gap-2 pl-3.5 pr-1 rounded-md border">
        <span class="icon-[lucide--search] w-4 h-4 shrink-0 text-muted-foreground" />
        <input ref="searchInput" v-model="searchQuery" :placeholder="t('prompt.searchPlaceholder')"
          class="flex-1 min-w-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground/70"
          @keydown.esc="searchQuery = ''" @keydown.enter.prevent="goHit($event.shiftKey ? -1 : 1)" />
        <template v-if="searchHits >= 0">
          <span class="shrink-0 text-[12px] text-muted-foreground tabular-nums">{{ searchHits ? `${hitIdx + 1} / ${searchHits}` : t('prompt.noMatch') }}</span>
          <button class="pill-btn w-6! disabled:opacity-30" :disabled="!searchHits" :title="t('prompt.prevHit')" @click="goHit(-1)"><span class="icon-[lucide--chevron-up] w-4 h-4" /></button>
          <button class="pill-btn w-6! disabled:opacity-30" :disabled="!searchHits" :title="t('prompt.nextHit')" @click="goHit(1)"><span class="icon-[lucide--chevron-down] w-4 h-4" /></button>
        </template>
        <button v-if="searchQuery" class="shrink-0 text-muted-foreground hover:text-foreground" :title="t('prompt.clearSearch')"
          @click="searchQuery = ''">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
        <!-- 显示中文 / 显示英文：可以同时亮，至少亮一个；词库和右边已选都跟着变，输出框永远是英文 -->
        <button class="pill-btn lang-btn" :class="{ 'is-on': showEn }" :title="t('prompt.showEn')" @click="toggleLang('en')">EN</button>
        <button class="pill-btn lang-btn" :class="{ 'is-on': showZh }" :title="t('prompt.showZh')" @click="toggleLang('zh')">中</button>
        <!-- NSFW 一个图标按钮来回切三档：全部 → 隐藏 → 仅 NSFW -->
        <button class="pill-btn" :class="nsfwMode === 'all' ? '' : nsfwMode === 'hide' ? 'is-on' : 'is-on tool-active-nsfw'"
          :title="t(`prompt.nsfw_${nsfwMode.replace('-', '_')}`)"
          @click="nsfwMode = NSFW_MODES[(NSFW_MODES.indexOf(nsfwMode) + 1) % NSFW_MODES.length]">
          <span class="w-4 h-4" :class="NSFW_ICON[nsfwMode]" />
        </button>
      </div>
    </div>

    <!-- ═══════ 右：已选标签 + 输出（2026-10-11 去掉了顶部「标签 / Anima」页签，自然语言改成底部按钮打开的浮窗） ═══════ -->
    <div class="w-[44%] min-w-[380px] max-w-[720px] shrink-0 flex flex-col">
      <!-- 顶上空出顶栏那么高：同时是窗口拖拽带，右边的红黄绿也不会压到第一行标签 -->
      <div class="h-[var(--bar-h)] shrink-0 flat:h-[var(--flat-bar-h)]" />

      <div class="flex-1 min-h-0 relative overflow-hidden">
        <!-- 自然语言浮窗：盖住已选标签和输出框，只把最下面那排按钮露出来 -->
        <div v-if="nlOpen" class="nl-window absolute left-2 right-2 bottom-[64px] max-h-[calc(100%-72px)] z-20 rounded-xl border overflow-hidden flex flex-col">
          <AnimaPanel :library="allLibraryTags" :picked-tags="pickedForAnima" :embedded="embeddedSentences"
            @toggle-sentence="toggleSentence" @close="nlOpen = false" />
        </div>
        <!-- 已选标签（大徽章，点一下停用/启用，右键更多）：铺满整栏，底部让出浮空底板的高度，滚到底时能从底板后面露出来 -->
        <div class="rp-tags-scroll fade-y absolute inset-0 overflow-y-auto" :style="{ paddingBottom: `${rpBottomH + 12}px` }">
          <div v-if="selectedTags.length === 0" class="rp-empty">
            <span class="icon-[lucide--tags] size-10 rp-empty-icon" />
            <span>{{ t('prompt.emptyTitle') }}</span>
            <span class="rp-empty-sub">{{ t('prompt.emptySub') }}</span>
          </div>
          <div v-else class="rp-tags-grid">
            <template v-for="(group, gIdx) in groupedSelectedTags" :key="gIdx">
              <div v-if="gIdx > 0" class="rp-group-break" />
              <Badge v-for="tag in group" :key="tag.value" variant="outline" class="rp-badge cursor-pointer"
                :class="['ly', `ly-${layerOf(tag)}`, { 'rp-badge-disabled': tag.disabled, 'rp-badge-nsfw': tag.nsfw }]"
                @click="toggleBadgeDisabled(tag)"
                @contextmenu="onBadgeContextMenu($event, tag)"
                @mouseenter="hoveredTagValue = tag.value"
                @mouseleave="hoveredTagValue = null">
                <span v-if="isModifiable(tag)" class="rp-badge-mark" />
                <!-- 只看中文时英文里的 (词:1.40) 看不到了，权重改用右上角小角标显示 -->
                <span v-if="tag.weight && !showEn" class="rp-badge-weight">×{{ +tag.weight.toFixed(2) }}</span>
                <span v-if="showEn || isLoraTag(tag.value)" class="rp-badge-value">{{ formatVal(tag) }}</span>
                <span v-if="showZh && !isLoraTag(tag.value)" class="rp-badge-label" :class="{ 'rp-badge-translated': isTranslatedTag(tag), 'rp-badge-label-solo': !showEn }">{{ modifiedLabel(tag) }}</span>
              </Badge>
            </template>
          </div>
        </div>

        <!-- 底部：输出框 + 自定义输入 + 操作 -->
        <!-- 底部输出区：半透明磨砂底板浮在已选标签上面（和笔记页顶部标题栏一个做法） -->
        <div ref="rpBottomEl" class="rp-bottom absolute left-2 right-2 bottom-2 z-10
                  rounded-xl border border-border/40 bg-card/80 backdrop-blur-3xl shadow-[0_6px_24px_rgb(0_0_0/0.18)]">
          <div class="rp-output">
            <Textarea :model-value="promptText" class="rp-textarea" :placeholder="t('prompt.outputPlaceholder')"
              @update:model-value="promptText = String($event)" />
          </div>

          <div class="rp-custom">
            <div class="rp-custom-row">
              <Input v-model="customInput" class="rp-custom-input" :placeholder="t('prompt.customPlaceholder')"
                @keydown.enter.prevent="addCustomTags" />
              <Button variant="outline" size="icon" class="rp-custom-add" :disabled="isTranslating || !customInput.trim()"
                @click="addCustomTags">
                <span v-if="isTranslating" class="icon-[lucide--loader-circle] size-4 animate-spin" />
                <span v-else class="icon-[lucide--plus] size-4" />
              </Button>
            </div>
          </div>

          <div class="rp-actions">
            <Button variant="outline" size="lg" :class="copied ? 'rp-btn-copied' : 'rp-btn-copy'"
              :disabled="selectedTags.length === 0 && !copied" :title="t('prompt.copy')" @click="copyToClipboard">
              <span :class="copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'" class="size-3.5" />
              <!-- 主按钮，窄了也保留文字 -->
              <span>{{ copied ? t('prompt.copied') : t('prompt.copy') }}</span>
            </Button>
            <Button variant="outline" size="lg" :class="copiedZh ? 'rp-btn-copied' : 'rp-btn-copy-zh'"
              :disabled="selectedTags.length === 0 && !copiedZh" :title="t('prompt.copyChinese')" @click="copyPromptZh">
              <span :class="copiedZh ? 'icon-[lucide--check]' : 'icon-[lucide--clipboard-type]'" class="size-3.5" />
              <span class="rp-btn-text">{{ copiedZh ? t('prompt.copied') : t('prompt.copyChinese') }}</span>
            </Button>
            <Button variant="outline" size="lg" class="rp-btn-wrap" :class="{ 'rp-btn-wrap-on': lineWrap }"
              :disabled="selectedTags.length === 0" :title="lineWrap ? t('prompt.wrapOn') : t('prompt.wrapOff')"
              @click="lineWrap = !lineWrap">
              <span class="icon-[lucide--wrap-text] size-3.5" />
              <span class="rp-btn-text">{{ lineWrap ? t('prompt.wrapLabelOn') : t('prompt.wrapLabelOff') }}</span>
            </Button>
            <Button variant="outline" size="lg" class="rp-btn-wrap" :class="{ 'rp-btn-wrap-on': nlOpen }" :title="t('prompt.nlButton')" @click="nlOpen = !nlOpen">
              <span class="icon-[lucide--languages] size-3.5" />
              <span class="rp-btn-text">{{ t('prompt.nlButton') }}</span>
            </Button>
            <!-- 预设：内置一组 Anima 质量词 + 自己存的；点了往已选里加 -->
            <Popover v-model:open="presetOpen">
              <PopoverTrigger as-child>
                <Button variant="outline" size="lg" class="rp-btn-wrap" :class="{ 'rp-btn-wrap-on': presetOpen }" :title="t('prompt.presetButton')">
                  <span class="icon-[lucide--bookmark] size-3.5" />
                  <span class="rp-btn-text">{{ t('prompt.presetButton') }}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" :side-offset="8" class="preset-pop w-80 p-2">
                <div class="preset-head">{{ t('prompt.presetBuiltin') }}</div>
                <button v-for="p in BUILTIN_PRESETS" :key="p.id" class="preset-item" :title="t('prompt.presetApplyTip')"
                  @click="applyPreset(builtinTags(p.values))">
                  <span class="icon-[lucide--sparkles] size-3.5 shrink-0 text-muted-foreground" />
                  <span class="flex-1 min-w-0">
                    <span class="block text-[13px]">{{ t(p.nameKey) }}</span>
                    <span class="block text-[11.5px] text-muted-foreground truncate font-mono">{{ p.values.join(', ') }}</span>
                  </span>
                </button>

                <div class="preset-head mt-1">{{ t('prompt.presetMine') }}</div>
                <p v-if="!userPresets.length" class="px-2 pb-1.5 text-[12px] text-muted-foreground/70">{{ t('prompt.presetEmpty') }}</p>
                <div v-else class="max-h-60 overflow-y-auto">
                  <div v-for="p in userPresets" :key="p.id" class="preset-item group" :title="t('prompt.presetApplyTip')"
                    @click="applyPreset(p.tags)">
                    <span class="icon-[lucide--bookmark] size-3.5 shrink-0 text-muted-foreground" />
                    <span class="flex-1 min-w-0">
                      <span class="block text-[13px] truncate">{{ p.name }}</span>
                      <span class="block text-[11.5px] text-muted-foreground truncate">{{ t('prompt.presetCount', { n: p.tags.length }) }} · {{ p.tags.map(x => x.value).join(', ') }}</span>
                    </span>
                    <button class="preset-del" :class="{ 'is-armed': presetDeleting === p.id }"
                      :title="presetDeleting === p.id ? t('prompt.presetDeleteConfirm') : t('prompt.presetDelete')"
                      @click.stop="deletePreset(p.id)">
                      <span class="size-3.5" :class="presetDeleting === p.id ? 'icon-[lucide--trash-2]' : 'icon-[lucide--x]'" />
                    </button>
                  </div>
                </div>

                <div class="flex gap-1.5 pt-2 mt-1 border-t">
                  <Input v-model="presetName" class="h-8 text-[13px]" :placeholder="t('prompt.presetNamePlaceholder')"
                    @keydown.enter.prevent="savePreset" />
                  <Button size="sm" class="h-8 shrink-0" :disabled="!presetName.trim() || selectedTags.length === 0" @click="savePreset">
                    {{ t('prompt.presetSave') }}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <span class="flex-1" />
            <!-- 只清掉划掉（停用）的词，留着正在用的 -->
            <Button variant="outline" size="lg" class="rp-btn-clear" :disabled="!hasDisabledTags" :title="t('prompt.clearDisabled')" @click="clearDisabled">
              <span class="icon-[lucide--eraser] size-3.5" />
              <span class="rp-btn-text">{{ t('prompt.clearDisabledLabel') }}</span>
            </Button>
            <Button variant="outline" size="lg" class="rp-btn-clear" :disabled="selectedTags.length === 0" :title="t('prompt.clear')" @click="clearAll">
              <span class="icon-[lucide--trash-2] size-3.5" />
              <span class="rp-btn-text">{{ t('prompt.clear') }}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div v-if="contextMenu.show" class="ctx-overlay" @click="closeContextMenu" @contextmenu.prevent="closeContextMenu" />
      <div v-if="contextMenu.show" class="ctx-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }">
        <button class="ctx-item" @click="ctxCopyEnglish">
          <span class="icon-[lucide--copy] size-3.5" />
          {{ t('prompt.copyEnglish') }}
        </button>
        <button class="ctx-item" @click="ctxCopyChinese">
          <span class="icon-[lucide--copy] size-3.5" />
          {{ t('prompt.copyChinese') }}
        </button>
        <template v-if="ctxTag && isModifiable(ctxTag)">
          <div class="ctx-sep" />
          <div v-for="g in modGroupsFor(ctxTag)" :key="g" class="ctx-mod-row">
            <span class="ctx-mod-title">{{ MOD_GROUP_LABEL[g] }}</span>
            <div class="ctx-mod-chips">
              <button v-for="it in modItems(g, ctxTag)" :key="it.value" class="ctx-mod-chip"
                :class="{ 'ctx-mod-on': ctxTag?.mods?.[g]?.value === it.value }"
                @click="applyMod(ctxTag!.value, g, it)">{{ it.label }}</button>
            </div>
          </div>
        </template>
        <div class="ctx-sep" />
        <button class="ctx-item ctx-item-danger" @click="ctxRemove">
          <span class="icon-[lucide--trash-2] size-3.5" />
          {{ t('prompt.remove') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ===== 分层配色（2026-10-11）=====
   每一层一组 --h 色相 / --s 饱和 / --l 浅色主题亮度 / --ld 深色主题亮度，下面的规则统一用 --c。
   想调某层颜色只改这里那一行。 */
.ly { --c: hsl(var(--h) var(--s) var(--l)); }
.dark .ly { --c: hsl(var(--h) var(--s) var(--ld)); }
.ly-info     { --h: 270; --s: 60%; --l: 50%; --ld: 72%; } /* 质量·信息：紫 */
.ly-comp     { --h: 152; --s: 50%; --l: 36%; --ld: 62%; } /* 构图·视角：绿 */
.ly-scene    { --h: 210; --s: 65%; --l: 45%; --ld: 70%; } /* 环境·背景：蓝 */
.ly-head     { --h: 330; --s: 70%; --l: 48%; --ld: 76%; } /* 人物·头部：粉 */
.ly-expr     { --h: 12;  --s: 75%; --l: 48%; --ld: 72%; } /* 人物·表情：珊瑚 */
.ly-body     { --h: 300; --s: 50%; --l: 45%; --ld: 72%; } /* 人物·身材：洋红 */
.ly-cloth    { --h: 176; --s: 60%; --l: 32%; --ld: 56%; } /* 服装：青（深） */
.ly-cstate   { --h: 176; --s: 50%; --l: 38%; --ld: 70%; } /* 衣服状态：青（中） */
.ly-acc      { --h: 190; --s: 60%; --l: 38%; --ld: 80%; } /* 饰品：青（浅） */
.ly-act-body { --h: 78;  --s: 60%; --l: 34%; --ld: 58%; } /* 动作·全身：黄绿（深） */
.ly-act-head { --h: 78;  --s: 55%; --l: 38%; --ld: 76%; } /* 动作·头：黄绿（浅） */
.ly-act-hand { --h: 92;  --s: 50%; --l: 34%; --ld: 66%; } /* 动作·手 */
.ly-act-leg  { --h: 108; --s: 45%; --l: 34%; --ld: 64%; } /* 动作·腿脚 */
.ly-act-sex  { --h: 62;  --s: 55%; --l: 32%; --ld: 54%; } /* 互动/性行为/体位：橄榄 */
.ly-prop     { --h: 30;  --s: 85%; --l: 44%; --ld: 66%; } /* 道具：橙 */
.ly-other    { --h: 0;   --s: 0%;  --l: 40%; --ld: 86%; } /* 库外词：白/灰 */
.ly-sentence { --h: 200; --s: 15%; --l: 40%; --ld: 82%; } /* 自然语言浮窗：磨砂半透明，压在已选标签上面 */
.nl-window {
  background: color-mix(in oklab, var(--card) 82%, transparent);
  border-color: color-mix(in oklab, var(--border) 60%, transparent);
  backdrop-filter: blur(24px) saturate(1.2);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.35);
}
/* 权重角标（只显示中文时用） */
.rp-badge-weight {
  position: absolute;
  top: -7px;
  right: -6px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 999px;
  background: var(--c, var(--foreground));
  color: var(--background);
  pointer-events: none;
}
/* 嵌入的整句：浅灰蓝 */
.ly-lora     { --h: 0;   --s: 0%;  --l: 40%; --ld: 92%; } /* LoRA：白 */

/* 搜索命中：所有命中的词描一圈虚线；当前那个闪几下 */
.chip.chip-hit { outline: 2px dashed color-mix(in oklab, var(--foreground) 45%, transparent); outline-offset: 2px; }
.chip.chip-hit-cur { outline-color: var(--foreground); }
.chip-flash { animation: chipFlash 1.4s ease-out; }
@keyframes chipFlash {
  0%, 30%, 60% { outline-color: var(--foreground); outline-offset: 2px; }
  15%, 45%, 75% { outline-color: transparent; outline-offset: 5px; }
  100% { outline-color: var(--foreground); outline-offset: 2px; }
}

/* 左边大纲的分组框 */
.nav-group.ly {
  border-color: color-mix(in oklab, var(--c) 30%, transparent);
  background: color-mix(in oklab, var(--c) 6%, transparent);
}

/* 中间词块 */
.chip.ly { border-color: color-mix(in oklab, var(--c) 28%, transparent); color: var(--c); }
.chip.ly:hover { background: color-mix(in oklab, var(--c) 8%, transparent); }
.chip.ly.chip-on { border-color: color-mix(in oklab, var(--c) 60%, transparent); background: color-mix(in oklab, var(--c) 15%, transparent); }
.chip.ly.chip-on:hover { background: color-mix(in oklab, var(--c) 22%, transparent); }
/* NSFW：只换成黄色虚线框，字还是这层的颜色（选中了也保持虚线，一眼看出是 NSFW） */
.chip.ly.chip-nsfw { border-style: dashed; border-color: hsl(45 95% 50% / 0.6); }
.dark .chip.ly.chip-nsfw { border-color: hsl(48 95% 58% / 0.55); }
.chip.ly.chip-nsfw.chip-on { border-color: hsl(45 95% 50% / 0.95); }
.dark .chip.ly.chip-nsfw.chip-on { border-color: hsl(48 95% 60% / 0.9); }

/* 右边已选标签 */
.rp-badge.ly {
  border-color: color-mix(in oklab, var(--c) 32%, transparent) !important;
  background: color-mix(in oklab, var(--c) 7%, transparent) !important;
}
.rp-badge.ly .rp-badge-value { color: color-mix(in oklab, var(--c) 62%, transparent); }
.rp-badge.ly .rp-badge-label { color: var(--c); }
.rp-badge.ly.rp-badge-nsfw { border-style: dashed !important; border-color: hsl(45 95% 50% / 0.85) !important; }
.dark .rp-badge.ly.rp-badge-nsfw { border-color: hsl(48 95% 60% / 0.8) !important; }
/* LoRA：白色，前面一个小「LoRA」角标 */
.rp-badge.ly-lora::before {
  content: 'LoRA';
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 4px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--c) 18%, transparent);
  color: var(--c);
}
/* 库外词（粘贴进来、自动翻译的）：中文用斜体 */
.rp-badge-translated { font-style: italic; }

/* 上下渐隐：滚动内容在两头淡出（用遮罩，不受背景色影响） */
.fade-y {
  --fade: 18px;
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--fade), #000 calc(100% - var(--fade)), transparent 100%);
}
/* 中栏底部浮着搜索条，尾巴淡得长一点，内容是在搜索条后面慢慢消失的 */
.fade-y-tall {
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--fade), #000 calc(100% - 72px), transparent 100%);
}
.pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 5px;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.lang-btn {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.5;
}
.lang-btn.is-on { opacity: 1; }
.pill-btn:hover { background: color-mix(in srgb, var(--foreground) 8%, transparent); color: var(--foreground); }
.pill-btn.is-on { background: color-mix(in srgb, var(--foreground) 10%, transparent); color: var(--foreground); }
/* 浮空搜索条：磨砂半透明，和字体库底部试字条一个路子 */
.search-pill {
  background: color-mix(in oklab, var(--card) 78%, transparent);
  border-color: color-mix(in oklab, var(--border) 80%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
  z-index: 5;
}
.nsfw-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--muted) 70%, transparent);
}
.nsfw-item {
  font-size: 11.5px;
  padding: 2px 8px;
  border-radius: 6px;
  color: var(--muted-foreground);
  white-space: nowrap;
  transition: background-color 120ms, color 120ms;
}
.nsfw-item:hover { color: var(--foreground); }
.nsfw-on { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
/* 右栏顶部页签：文字 + 选中时底下一条线，不要胶囊外壳 */
.rp-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding-top: 10px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--muted-foreground);
  transition: color 120ms;
}
.rp-tab:hover { color: var(--foreground); }
.rp-tab-on { color: var(--foreground); }
.rp-tab-on::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--foreground);
}
.rp-tab-count {
  font-size: 11px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--muted) 80%, transparent);
  color: var(--muted-foreground);
}
/* 右栏模式切换 */
.mode-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 9px;
  background: color-mix(in oklab, var(--muted) 80%, transparent);
}
.mode-item {
  font-size: 12.5px;
  padding: 4px 12px;
  border-radius: 7px;
  color: var(--muted-foreground);
  transition: background-color 120ms, color 120ms;
}
.mode-item:hover { color: var(--foreground); }
.mode-on {
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
/* 页面工具行里的图标按钮，和字体库 / 音频试听同一套（扁平版的缩小写在 style.css） */
.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 0.75rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.tool-btn:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}
.tool-btn.is-on {
  background: color-mix(in srgb, var(--foreground) 10%, transparent);
}


.sidebar-nav {
  padding: 4px 8px 16px;
}

/* 大类分组框：按分类颜色描边 + 浅底（跟右侧徽章同色系） */
.nav-group {
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 5px;
  margin-top: 7px;
}
.nav-group .nav-cat {
  margin-top: 0;
}
.nav-cat {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  margin-top: 6px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  color: color-mix(in oklab, var(--foreground) 70%, transparent);
  cursor: pointer;
  background: none;
  border: none;
  transition: all 0.12s;
  text-align: left;
}

.nav-cat:first-child {
  margin-top: 0;
}

.nav-cat:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
}

.nav-cat.nav-active {
  color: var(--primary);
}

.nav-cat-icon {
  opacity: 0.65;
  flex-shrink: 0;
}

.nav-cat.nav-active .nav-cat-icon {
  opacity: 1;
}

.nav-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px 5px 34px;
  border-radius: 5px;
  font-size: 12.5px;
  font-weight: 450;
  color: color-mix(in oklab, var(--muted-foreground) 75%, transparent);
  cursor: pointer;
  background: none;
  border: none;
  transition: all 0.12s;
  text-align: left;
}

.nav-sub:hover {
  color: color-mix(in oklab, var(--foreground) 85%, transparent);
  background: color-mix(in oklab, var(--muted) 40%, transparent);
}

.nav-sub.nav-active {
  color: var(--primary);
  font-weight: 550;
}

.nav-sub-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-sub-count {
  font-size: 11px;
  font-weight: 600;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: color-mix(in oklab, var(--primary) 12%, transparent);
  color: var(--primary);
  padding: 0 5px;
  flex-shrink: 0;
}

.nav-sub-count.count-conflict {
  background: hsl(45 100% 50% / 0.15);
  color: hsl(45 100% 42%);
}

.dark .nav-sub-count.count-conflict {
  background: hsl(48 100% 55% / 0.15);
  color: hsl(48 100% 65%);
}


.tool-active-nsfw {
  color: hsl(48 100% 50%);
}

.dark .tool-active-nsfw {
  color: hsl(48 100% 65%);
}

.tool-active-nsfw:hover {
  background: hsl(48 100% 50% / 0.1);
}

.content-scroll {
  flex: 1;
  overflow-y: auto;
}

.content-scroll::-webkit-scrollbar {
  width: 6px;
}

.content-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.content-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--muted-foreground) 15%, transparent);
  border-radius: 3px;
}

.content-scroll::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklab, var(--muted-foreground) 25%, transparent);
}

.content-body {
  padding: 20px 28px 60px;
  max-width: 1000px;
}

.cat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 0 8px;
  scroll-margin-top: 44px;
}

.cat-header:first-child {
  padding-top: 4px;
}

.cat-header-icon {
  color: var(--primary);
  opacity: 0.7;
}

.cat-header-text {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--foreground);
}

.tag-section {
  /* 屏幕外的分节先不排版、不绘制，滚到附近才画；2000 多个词块一次全画是滚动发卡的大头 */
  content-visibility: auto;
  contain-intrinsic-size: auto 220px;
  margin-bottom: 20px;
  scroll-margin-top: 44px;
  border-radius: 10px;
  border: 1px solid transparent;
  padding: 8px;
  margin-left: -8px;
  margin-right: -8px;
}

/* 闪烁高亮动画 */
.section-flash {
  animation: sectionFlash 3s ease-out;
}

@keyframes sectionFlash {
  0%, 18%, 36% {
    border-color: color-mix(in oklab, var(--foreground) 25%, transparent);
    border-style: dashed;
    background: color-mix(in oklab, var(--foreground) 4%, transparent);
  }
  9%, 27%, 45% {
    border-color: color-mix(in oklab, var(--foreground) 12%, transparent);
    border-style: dashed;
    background: color-mix(in oklab, var(--foreground) 1.5%, transparent);
  }
  60% {
    border-color: color-mix(in oklab, var(--foreground) 8%, transparent);
    border-style: dashed;
    background: color-mix(in oklab, var(--foreground) 1%, transparent);
  }
  100% {
    border-color: transparent;
    background: transparent;
  }
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  min-height: 24px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: color-mix(in oklab, var(--muted-foreground) 50%, transparent);
}

.conflict-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}

.conflict-warn {
  background: hsl(45 100% 50% / 0.1);
  color: hsl(45 100% 38%);
}

.dark .conflict-warn {
  background: hsl(48 100% 55% / 0.1);
  color: hsl(48 100% 65%);
}

.conflict-exclusive {
  background: hsl(0 80% 55% / 0.1);
  color: hsl(0 80% 50%);
}

.dark .conflict-exclusive {
  background: hsl(0 80% 60% / 0.1);
  color: hsl(0 80% 65%);
}

.tag-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
/* 普通词和 NSFW 词之间那条虚线：占满一整行，把两组分到上下 */
.nsfw-divider {
  flex-basis: 100%;
  height: 0;
  margin: 4px 0;
  border-top: 1px dashed color-mix(in oklab, var(--muted-foreground) 35%, transparent);
}

/* ===== 标签芯片 ===== */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 13.5px;
  border: 1px dashed var(--border);
  background: transparent;
  color: color-mix(in oklab, var(--foreground) 80%, transparent);
  cursor: pointer;
  transition: all 0.12s ease;
  user-select: none;
}

.chip:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}

.chip:active {
  transform: scale(0.97);
}

/* 选中通用 — 实线 + 加粗 */
.chip-on {
  border-style: solid;
  font-weight: 700;
}

.chip-conflict-warn {
  border-color: hsl(175 70% 45% / 0.5);
  background: hsl(175 70% 45% / 0.08);
  color: hsl(175 70% 35%);
}

.dark .chip-conflict-warn {
  border-color: hsl(175 70% 55% / 0.45);
  background: hsl(175 70% 55% / 0.08);
  color: hsl(175 70% 65%);
}

.chip-conflict-warn:hover {
  background: hsl(175 70% 45% / 0.14);
}

.chip-conflict-exclusive {
  border-color: hsl(15 90% 55% / 0.5);
  background: hsl(15 90% 55% / 0.08);
  color: hsl(15 90% 45%);
}

.dark .chip-conflict-exclusive {
  border-color: hsl(15 90% 60% / 0.45);
  background: hsl(15 90% 60% / 0.08);
  color: hsl(15 90% 70%);
}

.chip-conflict-exclusive:hover {
  background: hsl(15 90% 55% / 0.14);
}

/* 词块里排在前面的那种文字是主文字，后面的是淡一点的副文字 */
.chip-main {
  font-weight: 500;
}

.chip-sub {
  font-size: 12px;
  opacity: 0.4;
  font-weight: 400;
}

/* ===== 已选标签（大徽章网格）===== */
.rp-tags-scroll {
  min-height: 0;
}

.rp-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 8px;
  font-size: 13px;
  color: color-mix(in oklab, var(--muted-foreground) 40%, transparent);
}

.rp-empty-icon {
  opacity: 0.25;
  margin-bottom: 6px;
}

.rp-empty-sub {
  font-size: 11.5px;
  opacity: 0.1;
}

.rp-tags-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px;
  align-content: flex-start;
}

/* 颜色组之间的换行 */
.rp-group-break {
  width: 100%;
  height: 0;
  flex-basis: 100%;
}

/* 徽章基础（覆盖 shadcn Badge outline 样式） */
.rp-badge {
  position: relative;
  overflow: visible; /* shadcn Badge 自带 overflow-hidden，会把右上角的权重角标切掉 */
  gap: 8px;
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  transition: all 0.12s;
  max-width: 100%;
  /* 超长的组合标签：英文与中文各自换行，必要时中文另起一行 */
  flex-wrap: wrap;
  height: auto;
}

.rp-badge:hover {
  opacity: 0.6;
}

/* 禁用状态 */
.rp-badge-disabled {
  opacity: 0.4;
  text-decoration: line-through;
}
.rp-badge-disabled:hover {
  opacity: 0.55;
}

.rp-badge-value {
  font-size: 15.5px;
  font-weight: 600;
  color: color-mix(in oklab, var(--foreground) 50%, transparent);
  font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
  /* 长词（尤其括号里塞了好几个词的组合标签）要能换行，否则撑出徽章被截断 */
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}

/* 只显示中文时，中文就是主文字，字号跟英文主文字一样 */
.rp-badge-label.rp-badge-label-solo {
  font-size: 15px;
  font-weight: 600;
}
.rp-badge-label {
  font-size: 14px;
  color: color-mix(in oklab, var(--muted-foreground) 90%, transparent);
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}

/* ===== 底部区域 ===== */
.rp-bottom {
  flex-shrink: 0;
}
.rp-bottom .rp-actions { padding-bottom: 8px; }

.rp-output {
  padding: 10px 14px 6px;
}

.rp-textarea {
  min-height: 128px;
  font-size: 12px;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
  resize: none;
  line-height: 1.6;
  /* 稍微透一点，能隐约看到后面的标签（2026-10-12 用户要的「透一点点」） */
  background: color-mix(in oklab, var(--background) 82%, transparent);
  border-color: color-mix(in oklab, var(--border) 50%, transparent);
  border-radius: 8px;
  overflow-y: auto;
  scrollbar-width: none;
}

.rp-textarea::-webkit-scrollbar {
  display: none;
}

.rp-textarea:focus {
  border-color: color-mix(in oklab, var(--border) 50%, transparent);
  outline: none;
  box-shadow: none;

}

.rp-textarea:focus-visible {
  outline: none;

  box-shadow: none;
}

.rp-custom {
  padding: 0 14px 8px;
}

.rp-custom-row {
  display: flex;
  gap: 4px;
}

.rp-custom-input {
  flex: 1;
  height: 32px;
  font-size: 12px;
}

.rp-custom-add {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
}

/* ===== 操作栏 ===== */
.rp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  padding: 6px 14px 10px;
  /* 按钮一排放不下就只留图标（文字收进 title 悬停提示），清空按钮不会被挤出去 */
  container-type: inline-size;
}
@container (max-width: 760px) {
  .rp-btn-text { display: none; }
  .rp-actions > * { padding-inline: 0.75rem; }
}

.rp-actions-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rp-actions-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 复制按钮 — 蓝色调 */
.rp-btn-copy {
  border-color: hsl(210 70% 55% / 0.35) !important;
  color: hsl(210 65% 45%) !important;
  background: hsl(210 70% 55% / 0.06) !important;
}
.rp-btn-copy:hover {
  background: hsl(210 70% 55% / 0.14) !important;
  border-color: hsl(210 70% 55% / 0.5) !important;
}
.dark .rp-btn-copy {
  color: hsl(210 70% 70%) !important;
  border-color: hsl(210 70% 60% / 0.3) !important;
  background: hsl(210 70% 60% / 0.06) !important;
}
.dark .rp-btn-copy:hover {
  background: hsl(210 70% 60% / 0.14) !important;
  border-color: hsl(210 70% 60% / 0.45) !important;
}

/* 复制中文 — 紫色调，跟复制英文区分开（只剩图标时也认得出） */
.rp-btn-copy-zh {
  border-color: hsl(265 60% 60% / 0.35) !important;
  color: hsl(265 55% 50%) !important;
  background: hsl(265 60% 60% / 0.06) !important;
}
.rp-btn-copy-zh:hover {
  background: hsl(265 60% 60% / 0.14) !important;
  border-color: hsl(265 60% 60% / 0.5) !important;
}
.dark .rp-btn-copy-zh {
  color: hsl(265 70% 76%) !important;
  border-color: hsl(265 60% 65% / 0.3) !important;
  background: hsl(265 60% 65% / 0.06) !important;
}
.dark .rp-btn-copy-zh:hover {
  background: hsl(265 60% 65% / 0.14) !important;
  border-color: hsl(265 60% 65% / 0.45) !important;
}

/* 预设弹层 */
.preset-head {
  padding: 4px 8px 2px;
  font-size: 11.5px;
  color: var(--muted-foreground);
}
.preset-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
}
.preset-item:hover { background: var(--accent); }
.preset-del {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted-foreground);
  opacity: 0;
}
.preset-item:hover .preset-del, .preset-del.is-armed { opacity: 1; }
.preset-del:hover { background: var(--background); color: var(--foreground); }
.preset-del.is-armed { color: var(--destructive); }

/* 已复制状态 — 绿色调 */
.rp-btn-copied {
  border-color: hsl(142 60% 45% / 0.35) !important;
  color: hsl(142 71% 35%) !important;
  background: hsl(142 60% 45% / 0.08) !important;
}
.dark .rp-btn-copied {
  color: hsl(142 65% 60%) !important;
  border-color: hsl(142 60% 50% / 0.3) !important;
  background: hsl(142 60% 50% / 0.06) !important;
}

/* 清空按钮 — 红色调 */
.rp-btn-clear {
  border-color: hsl(0 65% 55% / 0.3) !important;
  color: hsl(0 60% 45%) !important;
  background: hsl(0 65% 55% / 0.05) !important;
}
.rp-btn-clear:hover {
  background: hsl(0 65% 55% / 0.12) !important;
  border-color: hsl(0 65% 55% / 0.45) !important;
}
.dark .rp-btn-clear {
  color: hsl(0 65% 68%) !important;
  border-color: hsl(0 65% 60% / 0.25) !important;
  background: hsl(0 65% 60% / 0.05) !important;
}
.dark .rp-btn-clear:hover {
  background: hsl(0 65% 60% / 0.12) !important;
  border-color: hsl(0 65% 60% / 0.4) !important;
}

.rp-count {
  font-size: 11px;
  font-weight: 500;
  color: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
  margin-left: 2px;
}

/* 换行开关 */
.rp-btn-wrap {
  gap: 4px;
}
.rp-btn-wrap-on {
  border-color: hsl(168 58% 39% / 0.5) !important;
  background: hsl(168 58% 39% / 0.12) !important;
  color: hsl(168 58% 39%) !important;
}
.dark .rp-btn-wrap-on {
  border-color: hsl(168 55% 55% / 0.5) !important;
  background: hsl(168 55% 55% / 0.14) !important;
  color: hsl(168 55% 62%) !important;
}

/* 可修饰标记：右上角小圆点（不出界） + 修饰目标高亮圈 */
/* 可修饰（右键能加颜色/材质/手数…）的小圆点：放右下角，右上角留给权重角标 */
.rp-badge-mark {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: hsl(168 58% 45% / 0.75);
  pointer-events: none;
}
.rp-badge-target {
  outline: 2px solid hsl(168 58% 45% / 0.7);
  outline-offset: 1px;
}

/* 右键菜单里的修饰芯片 */
.ctx-mod-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 10px;
}
.ctx-mod-title {
  font-size: 11px;
  color: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  flex-shrink: 0;
  width: 30px;
  padding-top: 3px;
}
.ctx-mod-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.ctx-mod-chip {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  color: color-mix(in oklab, var(--foreground) 80%, transparent);
}
.ctx-mod-chip:hover {
  background: var(--accent);
}
.ctx-mod-on {
  background: hsl(168 58% 39% / 0.15) !important;
  border-color: hsl(168 58% 45% / 0.6) !important;
  color: hsl(168 58% 42%) !important;
}
.dark .ctx-mod-on {
  color: hsl(168 55% 62%) !important;
}

/* 预设按钮 */
.rp-preset-btn {
  gap: 4px;
}

/* 预设删除按钮 */
.rp-preset-del {
  width: 20px;
  height: 20px;
  opacity: 0;
  flex-shrink: 0;
}

.group:hover .rp-preset-del {
  opacity: 1;
}

/* 预设保存区 */
.rp-preset-save {
  display: flex;
  gap: 4px;
  padding: 8px;
}

.rp-preset-save-input {
  flex: 1;
  height: 28px;
  font-size: 12px;
}

/* ===== 右键菜单 ===== */
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
}

.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 140px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--popover);
  box-shadow: 0 4px 16px hsl(0 0% 0% / 0.12);
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: none;
  font-size: 12.5px;
  color: color-mix(in oklab, var(--foreground) 80%, transparent);
  cursor: pointer;
  transition: background 0.1s;
}

.ctx-item:hover {
  background: var(--accent);
  color: var(--foreground);
}

.ctx-item-danger {
  color: hsl(0 65% 55%);
}
.ctx-item-danger:hover {
  background: hsl(0 65% 55% / 0.1);
  color: hsl(0 65% 50%);
}
.dark .ctx-item-danger {
  color: hsl(0 65% 68%);
}
.dark .ctx-item-danger:hover {
  background: hsl(0 65% 60% / 0.12);
  color: hsl(0 65% 70%);
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: color-mix(in oklab, var(--border) 50%, transparent);
}
</style>
