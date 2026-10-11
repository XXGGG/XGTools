<script setup lang="ts">
/**
 * 文件夹图标制作台(启动台 → 文件夹图标)。
 *
 * 只提供「制作空间」:图标自己从资源管理器里选,摆法、颜色、质感都能调,
 * 最后存成 .ico,或者直接套到某个文件夹上。画图的部分在 lib/folderIcon.ts。
 *
 * 预览里的图标可以直接动手调:拖本体 = 移动,拖右下角的点 = 缩放,
 * 拖上方的圆点 = 旋转(Shift 吸附到 15°);旁边也有滑杆,要精确就用滑杆。
 */
import { ref, computed, watch, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import InfoTip from '@/components/InfoTip.vue'
import { useI18n } from '@/i18n'
import {
  DEFAULT_PARAMS, FOLDER_CENTER, LAYER_Y, FOLDER_COLORS, EDGE_COLORS, ICON_EXTS,
  cloneParams, buildFolderSvg, buildIco, bytesToDataUri,
  type FolderIconParams, type Placement,
} from '@/lib/folderIcon'

const { t } = useI18n()

const LS_KEY = 'xgtools.folderIcon.v1'
const LS_APPLIED = 'xgtools.folderIcon.applied'

/** 在这里套过图标的文件夹(最近 50 个),「刷新系统图标」会把它们都通知一遍 */
function loadApplied(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_APPLIED) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function rememberApplied(dir: string) {
  try {
    const next = [dir, ...loadApplied().filter(d => d !== dir)].slice(0, 50)
    localStorage.setItem(LS_APPLIED, JSON.stringify(next))
  } catch { /* 记不住也不影响用 */ }
}

const p = ref<FolderIconParams>(cloneParams(DEFAULT_PARAMS))
/** 渐变的第二种颜色。关掉渐变再打开,要回到用户上次选的那个,不是每次都弹回粉色 */
const lastColor2 = ref('#FFAFC8')
const iconPath = ref<string | null>(null)
const iconHref = ref<string | null>(null)
const busy = ref(false)
const status = ref<{ ok: boolean; text: string } | null>(null)
let statusTimer: ReturnType<typeof setTimeout> | undefined

// ---------------------------------------------------------------- 记住上次的设置

onMounted(async () => {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      // 老版本只有一个「磨砂」开关,管的是前面板
      if (saved?.p && 'glass' in saved.p) { saved.p.glassFront = saved.p.glass; delete saved.p.glass }
      if (saved?.p) p.value = { ...cloneParams(DEFAULT_PARAMS), ...saved.p, icon: { ...DEFAULT_PARAMS.icon, ...saved.p.icon } }
      if (typeof saved?.lastColor2 === 'string') lastColor2.value = saved.lastColor2
      if (saved?.iconPath) await loadIcon(saved.iconPath, false)
    }
  } catch { /* 读不到就用默认 */ }
})

watch(() => p.value.color2, v => { if (v) lastColor2.value = v })

watch([p, iconPath, lastColor2], () => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ p: p.value, iconPath: iconPath.value, lastColor2: lastColor2.value }))
  } catch { /* 存不上也不影响用 */ }
}, { deep: true })

// ---------------------------------------------------------------- 预览

const svgUrl = computed(
  () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildFolderSvg(p.value, iconHref.value)),
)

const LAYER_KEYS = ['top', 'tuck', 'bottom'] as const
const LAYER_LABEL: Record<Placement, string> = {
  top: 'dock.fiLayerTop', tuck: 'dock.fiLayerTuck', bottom: 'dock.fiLayerBottom',
}
const iconFileName = computed(() => iconPath.value?.split(/[\\/]/).pop() ?? '')

/** 定位只动位置,大小、旋转和别的参数都不碰 */
function centerH() { p.value.icon.x = FOLDER_CENTER.x }
function centerV() { p.value.icon.y = FOLDER_CENTER.y }

/** 换一层时只给个合适的高度,别的不动 */
function setLayer(v: Placement) {
  if (p.value.placement === v) return
  p.value.placement = v
  p.value.icon.y = LAYER_Y[v]
}

// ---------------------------------------------------------------- 选图标

async function loadIcon(path: string, report = true) {
  try {
    const bytes = await readFile(path)
    iconHref.value = bytesToDataUri(bytes, path)
    iconPath.value = path
  } catch (e) {
    iconHref.value = null
    iconPath.value = null
    if (report) flash(false, `${t('dock.fiFailed')}：${e}`)
  }
}

async function pickIcon() {
  const sel = await open({
    multiple: false,
    filters: [{ name: t('dock.fiIcon'), extensions: ICON_EXTS }],
  })
  if (typeof sel === 'string') await loadIcon(sel)
}

function clearIcon() { iconHref.value = null; iconPath.value = null }

// ---------------------------------------------------------------- 导出 / 应用

function flash(ok: boolean, text: string) {
  status.value = { ok, text }
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => { status.value = null }, 5000)
}

async function run(job: () => Promise<string | void>) {
  if (busy.value) return
  busy.value = true
  status.value = { ok: true, text: t('dock.fiWorking') }
  try {
    const msg = await job()
    if (msg !== undefined) flash(true, msg)
    else status.value = null
  } catch (e) {
    flash(false, `${t('dock.fiFailed')}：${e}`)
  } finally {
    busy.value = false
  }
}

function saveIco() {
  return run(async () => {
    const out = await save({ defaultPath: 'folder.ico', filters: [{ name: 'ICO', extensions: ['ico'] }] })
    if (!out) return
    await writeFile(out, await buildIco(p.value, iconHref.value))
    return `${t('dock.fiSaved')}：${out}`
  })
}

function applyToFolder() {
  return run(async () => {
    const dir = await open({ directory: true, multiple: false })
    if (typeof dir !== 'string') return
    const ico = await buildIco(p.value, iconHref.value)
    await invoke('apply_folder_icon', { folder: dir, ico: Array.from(ico) })
    rememberApplied(dir)
    return t('dock.fiApplied')
  })
}

function refreshIcons() {
  return run(async () => {
    const missing = await invoke<string[]>('refresh_icons', { folders: loadApplied() })
    if (missing.length === 0) return t('dock.fiRefreshed')
    const names = missing.map(m => m.split(/[\\/]/).filter(Boolean).pop()).join('、')
    return `${t('dock.fiRefreshed')}。${t('dock.fiMissing')}：${names}`
  })
}

/** 选了文件夹还不动手,先弹确认;确认后才真的还原那一个文件夹 */
const resetOpen = ref(false)
const resetTarget = ref<string | null>(null)
const resetName = computed(() => resetTarget.value?.split(/[\\/]/).filter(Boolean).pop() ?? '')

async function pickResetFolder() {
  const dir = await open({ directory: true, multiple: false })
  if (typeof dir !== 'string') return
  resetTarget.value = dir
  resetOpen.value = true
}

function doReset() {
  const dir = resetTarget.value
  if (!dir) return
  return run(async () => {
    await invoke('reset_folder_icon', { folder: dir })
    return t('dock.fiResetDone')
  })
}

// ---------------------------------------------------------------- 直接在预览里拖

const stage = ref<HTMLElement | null>(null)

interface Drag {
  kind: 'move' | 'size' | 'rot'
  sx: number; sy: number
  ix: number; iy: number
  s0: number; d0: number
  cx: number; cy: number
}
let drag: Drag | null = null

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

function down(kind: Drag['kind'], e: PointerEvent) {
  if (!stage.value) return
  e.preventDefault()
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  const r = stage.value.getBoundingClientRect()
  const cx = r.left + (p.value.icon.x / 256) * r.width
  const cy = r.top + (p.value.icon.y / 256) * r.height
  drag = {
    kind, sx: e.clientX, sy: e.clientY, ix: p.value.icon.x, iy: p.value.icon.y,
    s0: p.value.icon.size, d0: Math.hypot(e.clientX - cx, e.clientY - cy) || 1, cx, cy,
  }
}

function move(e: PointerEvent) {
  if (!drag || !stage.value) return
  const k = 256 / stage.value.getBoundingClientRect().width
  const ic = p.value.icon
  if (drag.kind === 'move') {
    ic.x = clamp(drag.ix + (e.clientX - drag.sx) * k, 0, 256)
    ic.y = clamp(drag.iy + (e.clientY - drag.sy) * k, 0, 256)
  } else if (drag.kind === 'size') {
    const d = Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy)
    ic.size = clamp(Math.round(drag.s0 * (d / drag.d0)), 16, 240)
  } else {
    let a = (Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx) * 180) / Math.PI + 90
    if (a > 180) a -= 360
    if (e.shiftKey) a = Math.round(a / 15) * 15
    else if (Math.abs(a) < 3) a = 0
    ic.rot = Math.round(a)
  }
}

function up() { drag = null }

const boxStyle = computed(() => {
  const { x, y, size, rot } = p.value.icon
  return {
    left: `${((x - size / 2) / 256) * 100}%`,
    top: `${((y - size / 2) / 256) * 100}%`,
    width: `${(size / 256) * 100}%`,
    height: `${(size / 256) * 100}%`,
    transform: `rotate(${rot}deg)`,
  }
})

/** 旋转的预制角度:正、30°、45°、90°、180°(顺时针) */
const ROT_PRESETS = [0, 30, 45, 90, 180] as const

const gradient = computed({
  get: () => p.value.color2 !== null,
  set: (v: boolean) => { p.value.color2 = v ? lastColor2.value : null },
})
</script>

<template>
  <div class="flex-1 min-h-0 overflow-y-auto">
    <div class="max-w-3xl mx-auto w-full flex gap-8 items-start">

      <!-- 左:预览 -->
      <div class="w-[360px] shrink-0 space-y-3">
        <div
          ref="stage"
          class="relative w-[360px] h-[360px] rounded-2xl bg-[#1b1b1f] border border-white/5 select-none overflow-hidden"
        >
          <img :src="svgUrl" class="absolute inset-0 w-full h-full pointer-events-none" draggable="false" />

          <!-- 图标的操作框:拖本体移动 / 右下点缩放 / 上方圆点旋转 -->
          <div
            class="absolute border border-dashed border-sky-400/70 cursor-move touch-none"
            :style="boxStyle"
            @pointerdown="down('move', $event)"
            @pointermove="move"
            @pointerup="up"
            @pointercancel="up"
            @dblclick="pickIcon"
          >
            <span class="absolute left-1/2 -top-7 h-6 w-px -translate-x-1/2 bg-sky-400/60 pointer-events-none" />
            <span
              class="absolute left-1/2 -top-9 size-3.5 -translate-x-1/2 rounded-full bg-sky-400 border-2 border-white cursor-grab touch-none"
              @pointerdown.stop="down('rot', $event)"
              @pointermove="move"
              @pointerup="up"
              @pointercancel="up"
            />
            <span
              class="absolute -right-1.5 -bottom-1.5 size-3.5 rounded-sm bg-sky-400 border-2 border-white cursor-nwse-resize touch-none"
              @pointerdown.stop="down('size', $event)"
              @pointermove="move"
              @pointerup="up"
              @pointercancel="up"
            />
          </div>
        </div>

        <!-- 缩到图标真实大小时的样子 -->
        <div class="flex items-end gap-4 px-1 text-muted-foreground">
          <div class="flex items-center gap-1 text-xs">
            {{ t('dock.fiSmall') }}<InfoTip :text="t('dock.fiDragTip')" />
          </div>
          <img :src="svgUrl" class="size-16" draggable="false" />
          <img :src="svgUrl" class="size-12" draggable="false" />
          <img :src="svgUrl" class="size-8" draggable="false" />
          <img :src="svgUrl" class="size-4" draggable="false" />
        </div>
      </div>

      <!-- 右:调整 -->
      <div class="flex-1 min-w-0 space-y-5">

        <!-- 图标(放在最上面) -->
        <section class="space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {{ t('dock.fiIcon') }}<InfoTip :text="t('dock.fiPickTip')" />
          </div>
          <div class="flex items-center gap-2">
            <Button variant="outline" size="sm" @click="pickIcon">
              <span class="icon-[lucide--image-plus] w-4 h-4" />{{ t('dock.fiPick') }}
            </Button>
            <Button v-if="iconHref" variant="ghost" size="sm" @click="clearIcon">{{ t('dock.fiClear') }}</Button>
            <span v-if="iconPath" class="text-xs text-muted-foreground truncate" :title="iconPath">
              {{ iconFileName }}
            </span>
          </div>
        </section>

        <!-- 定位 + 摆放 + 大小旋转 -->
        <section class="space-y-3">
          <div class="text-xs font-medium text-muted-foreground">{{ t('dock.fiPos') }}</div>
          <div class="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" class="h-7 px-3 text-xs" @click="centerV">
              <span class="icon-[lucide--align-vertical-justify-center] w-3.5 h-3.5" />{{ t('dock.fiCenterV') }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 px-3 text-xs" @click="centerH">
              <span class="icon-[lucide--align-horizontal-justify-center] w-3.5 h-3.5" />{{ t('dock.fiCenterH') }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 px-3 text-xs" @click="centerH(); centerV()">
              <span class="icon-[lucide--focus] w-3.5 h-3.5" />{{ t('dock.fiCenterBoth') }}
            </Button>
          </div>

          <div class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground pt-1">
            {{ t('dock.fiLayer') }}<InfoTip :text="t('dock.fiLayerTip')" />
          </div>
          <div class="inline-flex rounded-lg border p-0.5">
            <button
              v-for="k in LAYER_KEYS" :key="k"
              class="h-7 px-3 rounded-md text-xs transition-colors"
              :class="p.placement === k ? 'bg-accent' : 'text-muted-foreground hover:text-foreground'"
              @click="setLayer(k)"
            >{{ t(LAYER_LABEL[k]) }}</button>
          </div>

          <div class="flex items-center gap-3">
            <span class="w-10 text-xs text-muted-foreground">{{ t('dock.fiSize') }}</span>
            <Slider
              :model-value="[p.icon.size]" :min="16" :max="240" :step="1" class="flex-1"
              @update:model-value="(v) => { p.icon.size = v![0] }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.icon.size) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-10 text-xs text-muted-foreground">{{ t('dock.fiRotate') }}</span>
            <Slider
              :model-value="[p.icon.rot]" :min="-180" :max="180" :step="1" class="flex-1"
              @update:model-value="(v) => { p.icon.rot = v![0] }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.icon.rot) }}°</span>
          </div>
          <div class="flex flex-wrap gap-1.5 pl-[52px]">
            <button
              v-for="r in ROT_PRESETS" :key="r"
              class="h-6 px-2.5 rounded-md border text-xs transition-colors"
              :class="Math.round(p.icon.rot) === r ? 'bg-accent border-primary/60' : 'hover:bg-accent/50'"
              @click="p.icon.rot = r"
            >{{ r === 0 ? t('dock.fiUpright') : r + '°' }}</button>
          </div>
        </section>

        <!-- 颜色 -->
        <section class="space-y-2">
          <div class="text-xs font-medium text-muted-foreground">{{ t('dock.fiColor') }}</div>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in FOLDER_COLORS" :key="c.hex" :title="c.name"
              class="size-6 rounded-full border border-white/20 transition-transform hover:scale-110"
              :class="p.color === c.hex ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''"
              :style="{ background: c.hex }"
              @click="p.color = c.hex"
            />
          </div>
          <div class="flex items-center gap-2 pt-1">
            <Switch v-model="gradient" />
            <span class="text-xs">{{ t('dock.fiGradient') }}</span>
          </div>
          <div v-if="p.color2" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ t('dock.fiColor2') }}</span>
            <button
              v-for="c in FOLDER_COLORS" :key="c.hex" :title="c.name"
              class="size-5 rounded-full border border-white/20 transition-transform hover:scale-110"
              :class="p.color2 === c.hex ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''"
              :style="{ background: c.hex }"
              @click="p.color2 = c.hex"
            />
          </div>
        </section>

        <!-- 质感 -->
        <section class="space-y-3">
          <div class="text-xs font-medium text-muted-foreground">{{ t('dock.fiTexture') }}</div>
          <div class="grid grid-cols-2 gap-x-6 gap-y-2">
            <label class="flex items-center gap-2 text-xs">
              <Switch :model-value="p.glassBack" @update:model-value="(v) => { p.glassBack = v }" />{{ t('dock.fiGlassBack') }}
            </label>
            <label class="flex items-center gap-2 text-xs">
              <Switch :model-value="p.glassFront" @update:model-value="(v) => { p.glassFront = v }" />{{ t('dock.fiGlassFront') }}
            </label>
            <label class="flex items-center gap-2 text-xs">
              <Switch :model-value="p.paper" @update:model-value="(v) => { p.paper = v }" />{{ t('dock.fiPaper') }}
            </label>
            <label class="flex items-center gap-2 text-xs">
              <Switch :model-value="p.neon" @update:model-value="(v) => { p.neon = v }" />{{ t('dock.fiNeon') }}
            </label>
            <label class="flex items-center gap-2 text-xs">
              <Switch :model-value="p.sharp" @update:model-value="(v) => { p.sharp = v }" />{{ t('dock.fiSharp') }}
            </label>
          </div>
          <div v-if="p.glassBack" class="flex items-center gap-3">
            <span class="w-24 text-xs text-muted-foreground">{{ t('dock.fiSeeBack') }}</span>
            <Slider
              :model-value="[Math.round(p.seeBack * 100)]" :min="0" :max="100" :step="1" class="flex-1"
              @update:model-value="(v) => { p.seeBack = v![0] / 100 }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.seeBack * 100) }}</span>
          </div>
          <div v-if="p.glassFront" class="flex items-center gap-3">
            <span class="w-24 text-xs text-muted-foreground">{{ t('dock.fiSeeFront') }}</span>
            <Slider
              :model-value="[Math.round(p.seeFront * 100)]" :min="0" :max="100" :step="1" class="flex-1"
              @update:model-value="(v) => { p.seeFront = v![0] / 100 }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.seeFront * 100) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-16 text-xs text-muted-foreground">{{ t('dock.fiShine') }}</span>
            <Slider
              :model-value="[Math.round(p.shine * 100)]" :min="0" :max="100" :step="1" class="flex-1"
              @update:model-value="(v) => { p.shine = v![0] / 100 }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.shine * 100) }}</span>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-16 text-xs text-muted-foreground">{{ t('dock.fiRim') }}</span>
            <Slider
              :model-value="[Math.round(p.rim * 100)]" :min="0" :max="100" :step="1" class="flex-1"
              @update:model-value="(v) => { p.rim = v![0] / 100 }"
            />
            <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{{ Math.round(p.rim * 100) }}</span>
          </div>
          <div v-if="p.neon" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ t('dock.fiEdgeColor') }}</span>
            <button
              v-for="c in EDGE_COLORS" :key="c.hex" :title="c.name"
              class="size-5 rounded-full border border-white/20 transition-transform hover:scale-110"
              :class="p.edgeColor === c.hex ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''"
              :style="{ background: c.hex }"
              @click="p.edgeColor = c.hex"
            />
          </div>
        </section>

        <!-- 输出 -->
        <section class="space-y-2 pt-1">
          <div class="flex flex-wrap gap-2">
            <Button size="sm" :disabled="busy" @click="saveIco">
              <span class="icon-[lucide--download] w-4 h-4" />{{ t('dock.fiSaveIco') }}
            </Button>
            <div class="flex gap-2">
              <Button size="sm" variant="outline" :disabled="busy" @click="applyToFolder">
                <span class="icon-[lucide--folder-check] w-4 h-4" />{{ t('dock.fiApply') }}
              </Button>
              <Button size="sm" variant="outline" :disabled="busy" :title="t('dock.fiRefresh')" @click="refreshIcons">
                <span class="icon-[lucide--refresh-cw] w-4 h-4" />{{ t('dock.fiRefresh') }}
              </Button>
            </div>
          </div>
          <div class="flex items-center gap-1.5 border-t pt-3 mt-3">
            <Button size="sm" variant="ghost" class="h-7 px-2 text-xs text-muted-foreground" :disabled="busy" @click="pickResetFolder">
              <span class="icon-[lucide--rotate-ccw] w-3.5 h-3.5" />{{ t('dock.fiReset') }}
            </Button>
            <InfoTip :text="t('dock.fiResetTip')" />
          </div>
          <p
            v-if="status"
            class="text-xs break-all"
            :class="status.ok ? 'text-muted-foreground' : 'text-destructive'"
          >{{ status.text }}</p>
        </section>
      </div>
    </div>
    <AlertDialog v-model:open="resetOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('dock.fiResetTitle') }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('dock.fiResetDesc').replace('{name}', resetName) }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('dock.cancel') }}</AlertDialogCancel>
          <AlertDialogAction @click="doReset">{{ t('dock.fiResetDo') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
