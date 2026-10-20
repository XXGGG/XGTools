<script setup lang="ts">
/**
 * 字体库 mini 置顶小窗（2026-10-12）。
 *
 * 在 PS、达芬奇里试字用：窄窄一条立在屏幕边上，置顶，点一款字就套用到「套用到」选的那个软件，
 * 也能整行拖出去。只列已经装好的字，底部像手机底栏那样切 游戏 / 影视 / PS / 收藏。
 *
 * 样子跟主窗口一致：主题、材质都从设置里读（这扇窗只读设置，不回写，见 useAppSettings）。
 * 窗口只有「置顶切换」和「关闭」两个按钮，没有最大化、最小化。主窗口字体库顶栏也能开关它。
 */
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { startDrag } from '@crabnebula/tauri-plugin-drag'
import {
  settings, loadSettings, reloadSettings, disableSettingsPersist, patchSetting,
  applyWindowEffect, applyVibrancyVars, applyTheme, watchSystemTheme,
} from '@/composables/useAppSettings'
import { useI18n } from '@/i18n'
import { localFamily, repFace } from '@/lib/fontFaces'
import { SAMPLE } from '@/lib/fontSamples'
import { TIER_COLOR, USE_GROUPS, type Family, type Pack } from '@/lib/fontTypes'
import ApplyTargets from '@/components/fonts/ApplyTargets.vue'

const { t } = useI18n()
const win = getCurrentWebviewWindow()

type Tab = 'game' | 'video' | 'ps' | 'fav'
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'fav', icon: 'icon-[tabler--star-filled]', label: 'fonts.catFav' },
  { id: 'game', icon: 'icon-[lucide--gamepad-2]', label: 'fonts.groupGame' },
  { id: 'video', icon: 'icon-[lucide--clapperboard]', label: 'fonts.miniVideo' },
  { id: 'ps', icon: 'icon-[lucide--image]', label: 'fonts.groupPs' },
]
const tab = ref<Tab>('fav')

const families = ref<Family[]>([])
const packs = ref<Pack[]>([])
const loaded = ref(false)

async function scan() {
  try {
    const [f, p] = await Promise.all([invoke<Family[]>('font_scan'), invoke<Pack[]>('font_catalog')])
    families.value = f
    packs.value = p
  } finally {
    loaded.value = true
  }
}

const famByEn = computed(() => new Map(families.value.map((f) => [f.nameEn.toLowerCase(), f])))
function localOf(p: Pack): Family | null {
  for (const n of p.families) {
    const f = famByEn.value.get(n.toLowerCase())
    if (f) return f
  }
  return families.value.find((f) => f.catalog === p.id) ?? null
}

type Row = { id: string; name: string; fam: Family; px: number; latin: boolean; kana: boolean; safe: boolean }
function row(fam: Family, id: string, p?: Pack): Row {
  const px = p?.px.length ? p.px[p.px.length - 1] : 0
  const cjk = fam.sc || fam.tc
  return { id, name: fam.name, fam, px, latin: !cjk && !fam.kana, kana: !cjk && fam.kana, safe: fam.verdict.tier === 'open' }
}

/** 这一页列哪些：推荐里属于这个用途、而且本机已经装了的；收藏页按收藏的顺序 */
const rows = computed<Row[]>(() => {
  if (tab.value === 'fav') {
    return settings.fontFavorites.flatMap((id) => {
      if (id.startsWith('f:')) {
        const f = families.value.find((x) => 'f:' + x.key === id)
        return f && !f.disabled ? [row(f, id)] : []
      }
      const p = packs.value.find((x) => 'p:' + x.id === id)
      const f = p && localOf(p)
      return p && f ? [row(f, id, p)] : []
    })
  }
  const uses = USE_GROUPS.find((g) => g.id === tab.value)?.uses ?? []
  const seen = new Set<string>()
  return packs.value.flatMap((p) => {
    if (!p.uses.some((u) => uses.some((x) => u === x || u.startsWith(x + '-')))) return []
    const f = localOf(p)
    if (!f || f.disabled || seen.has(f.key)) return []
    seen.add(f.key)
    return [row(f, 'p:' + p.id, p)]
  })
})

/** 每一族画样张用的 font-family，滚到哪画到哪就够了，小窗里字体不多，直接全取 */
const css = ref<Record<string, string | null>>({})
async function resolveAll() {
  for (const r of rows.value) {
    if (r.fam.key in css.value) continue
    css.value = { ...css.value, [r.fam.key]: await localFamily(r.fam) }
  }
}

function textOf(r: Row) {
  const custom = settings.fontSample.trim()
  if (custom) return custom
  if (r.latin) return SAMPLE.latin
  if (r.kana) return SAMPLE.kana
  return SAMPLE.zh
}
const SIZE = 26
function sizeOf(r: Row) {
  return r.px ? Math.max(r.px, Math.round(SIZE / r.px) * r.px) : SIZE
}

// ── 套用 / 拖出 ──

const notice = ref<{ text: string; bad: boolean } | null>(null)
let noticeTimer = 0
function flash(text: string, bad = false) {
  notice.value = { text, bad }
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = null), bad ? 6000 : 3000)
}

const selected = ref<string | null>(null)
const busy = ref(false)

async function pick(r: Row) {
  selected.value = r.id
  const target = settings.fontApplyTarget
  if (!target || busy.value) return
  const fam = r.fam
  const face = fam.faces.find((f) => !f.disabled && f.weight === 400 && !f.italic) ?? repFace(fam)
  busy.value = true
  try {
    const msg = await invoke<string>('font_apply', {
      target,
      font: { family: fam.nameEn || face.legacyFamily || fam.name, familyLocal: fam.name, postscript: face.postscript, style: face.style || 'Regular' },
    })
    flash(msg)
  } catch (e) {
    const err = String(e)
    if (err === 'PHOTOCRAFT_NOT_LINKED') flash(t('fonts.applyPhotocraftLink'), true)
    else if (err === 'AFFINITY_NOT_LINKED') flash(t('fonts.applyAffinityLink'), true)
    else flash(err, true)
  } finally {
    busy.value = false
  }
}
// 收藏：这扇窗不回写整份设置，只改收藏这一个键（主窗口回到前台时也会读到）
const favs = computed(() => new Set(settings.fontFavorites))
function toggleFav(id: string) {
  const s = new Set(settings.fontFavorites)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  void patchSetting('fontFavorites', [...s])
}

function setTarget(id: string) {
  // 这扇窗不回写整份设置，只改这一个键（主窗口那边下次读到的也是这个）
  void patchSetting('fontApplyTarget', (settings.fontApplyTarget === id ? '' : id) as typeof settings.fontApplyTarget)
}

/** 拖动时跟着光标的小图标：主题色方块里一个 Aa（跟主窗口字体库一样） */
let iconUrl = ''
function dragIcon() {
  if (iconUrl) return iconUrl
  const c = document.createElement('canvas')
  c.width = c.height = 72
  const g = c.getContext('2d')!
  g.fillStyle = settings.vaultAccent
  g.beginPath()
  g.roundRect(6, 14, 52, 52, 14)
  g.fill()
  g.fillStyle = '#fff'
  g.font = 'bold 24px Georgia, serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('Aa', 32, 41)
  return (iconUrl = c.toDataURL('image/png'))
}

let downAt: { x: number; y: number; r: Row } | null = null
function onDown(e: PointerEvent, r: Row) {
  if (e.button === 0) downAt = { x: e.clientX, y: e.clientY, r }
}
async function onMove(e: PointerEvent) {
  if (!downAt || !(e.buttons & 1)) { downAt = null; return }
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) return
  const r = downAt.r
  downAt = null
  try {
    await startDrag({ item: [repFace(r.fam).path], icon: dragIcon() })
  } catch (err) {
    flash(String(err), true)
  }
}

// ── 窗口 ──

const pinned = ref(true)
async function togglePin() {
  pinned.value = !pinned.value
  await win.setAlwaysOnTop(pinned.value)
}

async function applyLook() {
  const on = settings.blurKind !== 'none'
  applyVibrancyVars()
  applyTheme()
  document.body.classList.toggle('vibrancy', on)
  try {
    await applyWindowEffect(settings.blurKind, 'font_mini')
    await invoke('set_window_corners', { label: 'font_mini', round: true })
  } catch (e) {
    console.error('[font-mini] 上材质失败', e)
  }
}

onMounted(async () => {
  disableSettingsPersist()
  try {
    await loadSettings()
    watchSystemTheme()
    await applyLook()
  } catch (e) {
    console.error('[font-mini] 读设置失败', e)
  }
  await scan()
  void resolveAll()
  // 回到这扇窗时重读一遍：主窗口里可能刚收藏了字、换了主题或「套用到」
  await win.onFocusChanged(({ payload }) => {
    if (payload) void reloadSettings().then(applyLook).then(resolveAll)
  })
})
</script>

<template>
  <div class="fixed inset-0 flex flex-col text-foreground select-none">
    <!-- 顶栏：整条可拖动；右边只有置顶和关闭 -->
    <div data-tauri-drag-region class="h-10 shrink-0 flex items-center gap-1 pl-3.5 pr-1.5">
      <span data-tauri-drag-region class="icon-[lucide--type] w-4 h-4 text-muted-foreground" />
      <span data-tauri-drag-region class="text-[13px] font-medium">{{ t('fonts.miniTitle') }}</span>
      <span data-tauri-drag-region class="flex-1 min-w-0 truncate text-[11.5px] text-right pr-1"
        :class="notice?.bad ? 'text-destructive' : 'text-muted-foreground'">{{ notice?.text }}</span>
      <button class="mini-btn" :class="pinned ? 'is-on' : ''" :title="pinned ? t('fonts.miniUnpin') : t('fonts.miniPin')" @click="togglePin">
        <span class="w-4 h-4" :class="pinned ? 'icon-[lucide--pin]' : 'icon-[lucide--pin-off]'" />
      </button>
      <button class="mini-btn hover:text-destructive!" :title="t('fonts.close')" @click="win.close()">
        <span class="icon-[lucide--x] w-4 h-4" />
      </button>
    </div>

    <!-- 套用到：跟主窗口共用一个设置，在这里也能直接连各个软件 -->
    <div class="shrink-0 px-2.5 pb-1.5 flex justify-end">
      <ApplyTargets :target="settings.fontApplyTarget" :busy="busy" @change="setTarget" @notice="flash" />
    </div>

    <!-- 列表：一行名字一行样张 -->
    <div class="fade-y flex-1 min-h-0 overflow-y-auto px-2 pt-1 pb-20">
      <div v-if="loaded && !rows.length" class="h-full flex items-center justify-center text-[13px] text-muted-foreground px-6 text-center">
        {{ tab === 'fav' ? t('fonts.miniEmptyFav') : t('fonts.miniEmpty') }}
      </div>
      <div v-for="r in rows" :key="r.id" class="mini-row" :class="selected === r.id ? 'is-on' : ''"
        @click="pick(r)" @pointerdown="onDown($event, r)" @pointermove="onMove" @pointerup="downAt = null">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="text-[14px] font-semibold truncate">{{ r.name }}</span>
          <span v-if="r.safe" class="shrink-0 inline-flex items-center gap-0.5 text-[11px]" :style="{ color: TIER_COLOR.open }">
            <span class="icon-[lucide--shield-check] w-3.5 h-3.5" />{{ t('fonts.miniSafe') }}
          </span>
          <span class="flex-1" />
          <button class="star-btn" :class="favs.has(r.id) ? 'is-on' : ''" :title="t('fonts.fav')"
            @click.stop="toggleFav(r.id)" @pointerdown.stop>
            <span class="w-4 h-4" :class="favs.has(r.id) ? 'icon-[tabler--star-filled]' : 'icon-[lucide--star]'" />
          </button>
        </div>
        <div class="whitespace-nowrap overflow-hidden text-ellipsis"
          :style="{ fontFamily: css[r.fam.key] ?? undefined, fontSize: sizeOf(r) + 'px', lineHeight: 1.35 }">
          {{ textOf(r) }}
        </div>
      </div>
    </div>

    <!-- 底栏：像手机底部那样切用途 -->
    <nav class="mini-tabs absolute left-2.5 right-2.5 bottom-2.5 h-14 flex items-stretch rounded-xl border">
      <button v-for="tb in TABS" :key="tb.id" class="flex-1 flex flex-col items-center justify-center gap-0.5 rounded-xl transition-colors"
        :class="tab === tb.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
        @click="tab = tb.id; resolveAll()">
        <span class="w-5 h-5" :class="tb.icon" />
        <span class="text-[11px]" :class="tab === tb.id ? 'font-medium' : ''">{{ t(tb.label) }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.mini-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--muted-foreground);
  transition: background-color 120ms ease, color 120ms ease;
}
.mini-btn:hover { background: color-mix(in srgb, var(--foreground) 8%, transparent); color: var(--foreground); }
.mini-btn.is-on { color: var(--foreground); }
.star-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: color-mix(in oklab, var(--muted-foreground) 70%, transparent);
  transition: background-color 120ms ease, color 120ms ease;
}
.star-btn:hover { background: color-mix(in srgb, var(--foreground) 8%, transparent); color: var(--foreground); }
.star-btn.is-on { color: #f2b21c; }
.mini-row {
  padding: 7px 10px 9px;
  border-radius: 10px;
  cursor: grab;
  transition: background-color 120ms ease;
}
.mini-row:hover { background: color-mix(in srgb, var(--muted) 55%, transparent); }
.mini-row.is-on { background: var(--muted); }
.mini-row:active { cursor: grabbing; }
.mini-tabs {
  background: color-mix(in oklab, var(--card) 78%, transparent);
  border-color: color-mix(in oklab, var(--border) 80%, transparent);
  backdrop-filter: blur(14px) saturate(1.2);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.18);
}
.fade-y {
  mask-image: linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 80px), transparent 100%);
}
</style>
