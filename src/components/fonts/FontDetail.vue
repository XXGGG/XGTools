<script setup lang="ts">
/**
 * 字体库右边的详情：协议结论、放进场景里看、做游戏用的查字、文件和操作。
 *
 * 本机字体和推荐里的字体共用这一块。推荐里的没装之前没有文件可查，
 * 「查字」那一段换成目录里记的「有简体 / 繁体 / 假名」，并提示装好后能查具体缺哪些字。
 */
import { computed, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from '@/i18n'
import InfoTip from '@/components/InfoTip.vue'
import FontScenes from './FontScenes.vue'
import { repFace } from '@/lib/fontFaces'
import {
  MARK_COLOR, MARK_ICON, TIER_COLOR,
  type Coverage, type Face, type Family, type Mark, type Pack, type Verdict,
} from '@/lib/fontTypes'

const props = defineProps<{
  family: Family | null
  pack: Pack | null
  /** 画这款字用的 font-family；null = 画不出来 */
  css: string | null
  /** 只有西文 */
  latin: boolean
  custom: string
  accent: string
  /** 正在安装：进度 0~1 */
  installing: number | null
}>()

const emit = defineEmits<{
  close: []
  toggle: [enable: boolean]
  uninstall: []
  install: []
  reveal: [path: string]
  copy: [text: string]
  drag: [paths: string[]]
  open: [url: string]
}>()

const { t } = useI18n()

const name = computed(() => props.family?.name ?? props.pack?.name ?? '')
const nameEn = computed(() => props.family?.nameEn ?? props.pack?.latin ?? '')

/** 推荐里的字体（没装、系统里也没有）就按目录里写的协议下结论 */
const verdict = computed<Verdict>(() => {
  if (props.family) return props.family.verdict
  return {
    tier: 'open',
    license: props.pack?.license ?? 'OFL',
    game: 'yes',
    video: 'yes',
    print: 'yes',
    notes: [t('fonts.ofl_note')],
  }
})

const uses: { key: 'game' | 'video' | 'print'; label: string; icon: string }[] = [
  { key: 'game', label: 'fonts.useGame', icon: 'icon-[lucide--gamepad-2]' },
  { key: 'video', label: 'fonts.useVideo', icon: 'icon-[lucide--clapperboard]' },
  { key: 'print', label: 'fonts.usePrint', icon: 'icon-[lucide--image]' },
]
const markText = (m: Mark) => t(`fonts.mark_${m}`)

const licenseUrl = computed(() => props.family?.licenseUrl || props.pack?.licenseUrl || '')
const homeUrl = computed(() => props.pack?.home || props.family?.vendorUrl || '')
const isHttp = (u: string) => /^https?:\/\//i.test(u)

const scripts = computed(() => {
  const f = props.family
  const p = props.pack
  const has = {
    sc: f ? f.sc : !!p?.sc,
    tc: f ? f.tc : !!p?.tc,
    kana: f ? f.kana : !!p?.kana,
    hangul: f ? f.hangul : false,
    latin: f ? f.latin : !!p?.latinOk,
  }
  return (['sc', 'tc', 'kana', 'hangul', 'latin'] as const).map((k) => ({ k, on: has[k] }))
})

const pxList = computed(() => {
  const px = props.pack?.px ?? []
  return px.map((p) => `${p} / ${p * 2} / ${p * 3}`).join('；')
})

// ── 查字 ──
const face = computed<Face | null>(() => (props.family ? repFace(props.family) : null))
const cov = ref<Coverage | null>(null)
const covBusy = ref(false)
const covErr = ref('')
const paste = ref('')
const missing = ref<{ missing: string; checked: number } | null>(null)
const missBusy = ref(false)

watch(() => props.family?.key ?? props.pack?.id, () => {
  cov.value = null
  covErr.value = ''
  missing.value = null
})

async function checkCoverage() {
  if (!face.value) return
  covBusy.value = true
  covErr.value = ''
  try {
    cov.value = await invoke<Coverage>('font_coverage', { path: face.value.path, index: face.value.index })
  } catch (e) {
    covErr.value = String(e)
  } finally {
    covBusy.value = false
  }
}

async function checkMissing() {
  if (!face.value || !paste.value.trim()) return
  missBusy.value = true
  try {
    missing.value = await invoke('font_missing', { path: face.value.path, index: face.value.index, text: paste.value })
  } catch (e) {
    covErr.value = String(e)
  } finally {
    missBusy.value = false
  }
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const weightText = (f: Face) => [f.style, f.italic && !/italic|oblique/i.test(f.style) ? 'Italic' : ''].filter(Boolean).join(' ') || String(f.weight)

const allPaths = computed(() => props.family?.faces.map((f) => f.path) ?? props.pack?.files ?? [])
</script>

<template>
  <div class="flex flex-col gap-4 pb-2">
    <!-- 名字：用它自己的字写 -->
    <div class="flex items-start gap-2">
      <div class="flex-1 min-w-0">
        <div class="text-[26px] leading-tight truncate" :style="{ fontFamily: css ?? undefined }" :title="name">{{ name }}</div>
        <div v-if="nameEn !== name" class="text-[12px] text-muted-foreground truncate mt-0.5">{{ nameEn }}</div>
      </div>
      <button @click="emit('close')" :title="t('fonts.close')" class="tool-btn shrink-0 -mr-1 -mt-1">
        <span class="icon-[lucide--x] w-4 h-4" />
      </button>
    </div>

    <!-- ── 协议 ── -->
    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5">
        <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.license') }}</span>
        <span class="rounded-[5px] px-1.5 py-px text-[11px]"
          :style="{ color: TIER_COLOR[verdict.tier], background: `color-mix(in srgb, ${TIER_COLOR[verdict.tier]} 14%, transparent)` }">
          {{ t(`fonts.tier_${verdict.tier}`) }}
        </span>
        <span v-if="verdict.license !== t(`fonts.tier_${verdict.tier}`)" class="text-[12px] text-muted-foreground truncate">
          {{ verdict.license }}
        </span>
      </div>
      <div class="grid grid-cols-3 gap-1.5">
        <div v-for="u in uses" :key="u.key" class="rounded-[10px] border px-2 py-2 flex flex-col items-center gap-1 text-center">
          <span class="w-4 h-4 text-muted-foreground" :class="u.icon" />
          <span class="text-[11.5px] text-muted-foreground leading-tight">{{ t(u.label) }}</span>
          <span class="flex items-center gap-1 text-[13px] font-medium" :style="{ color: MARK_COLOR[verdict[u.key]] }">
            <span class="w-3.5 h-3.5" :class="MARK_ICON[verdict[u.key]]" />{{ markText(verdict[u.key]) }}
          </span>
        </div>
      </div>
      <ul class="flex flex-col gap-1 text-[12.5px] leading-relaxed">
        <li v-for="n in verdict.notes" :key="n" class="flex gap-1.5">
          <span class="mt-[7px] size-1 rounded-full shrink-0 bg-muted-foreground/60" />{{ n }}
        </li>
      </ul>
      <div class="flex flex-wrap gap-1.5">
        <button v-if="isHttp(licenseUrl)" @click="emit('open', licenseUrl)" class="chip-btn">
          <span class="icon-[lucide--scroll-text] w-3.5 h-3.5" />{{ t('fonts.licenseOrigin') }}
        </button>
        <button v-if="isHttp(homeUrl)" @click="emit('open', homeUrl)" class="chip-btn">
          <span class="icon-[lucide--external-link] w-3.5 h-3.5" />{{ t('fonts.homepage') }}
        </button>
      </div>
      <details v-if="family?.licenseText || family?.copyright" class="text-[12px] text-muted-foreground">
        <summary class="cursor-pointer select-none hover:text-foreground">{{ t('fonts.ownWords') }}</summary>
        <p v-if="family?.copyright" class="mt-1.5 whitespace-pre-wrap break-words">{{ family.copyright }}</p>
        <p v-if="family?.licenseText" class="mt-1.5 whitespace-pre-wrap break-words">{{ family.licenseText }}</p>
      </details>
    </section>

    <!-- ── 放进场景里看 ── -->
    <section class="flex flex-col gap-2">
      <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.scenes') }}</span>
      <FontScenes :family="css" :latin="latin" :custom="family ? custom : ''" :fail-label="t('fonts.fail')"
        :labels="{ game: t('fonts.sceneGame'), subtitle: t('fonts.sceneSubtitle'), cover: t('fonts.sceneCover'), poster: t('fonts.scenePoster') }" />
    </section>

    <!-- ── 做游戏 ── -->
    <section class="flex flex-col gap-2">
      <div class="flex items-center gap-1.5">
        <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.gameSection') }}</span>
      </div>
      <div class="flex flex-wrap gap-1">
        <span v-for="s in scripts" :key="s.k" class="rounded-[5px] px-1.5 py-px text-[11px]"
          :class="s.on ? 'text-foreground' : 'text-muted-foreground/60 line-through'"
          :style="{ background: 'color-mix(in srgb, var(--foreground) ' + (s.on ? 9 : 4) + '%, transparent)' }">
          {{ t(`fonts.script_${s.k}`) }}
        </span>
        <span v-if="family?.variable" class="rounded-[5px] px-1.5 py-px text-[11px] text-muted-foreground"
          style="background: color-mix(in srgb, var(--foreground) 6%, transparent)">{{ t('fonts.variable') }}</span>
      </div>
      <div v-if="pxList" class="flex items-center gap-1.5 text-[12.5px]">
        <span class="icon-[lucide--grid-3x3] w-3.5 h-3.5 text-muted-foreground" />
        {{ t('fonts.pixel', { list: pxList }) }}
      </div>

      <template v-if="face">
        <div class="flex items-center gap-1.5">
          <button @click="checkCoverage" :disabled="covBusy" class="chip-btn">
            <span class="w-3.5 h-3.5" :class="covBusy ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--list-checks]'" />
            {{ t('fonts.checkCoverage') }}
          </button>
          <InfoTip :text="t('fonts.coverageTip')" />
        </div>
        <div v-if="cov" class="flex flex-col gap-1.5">
          <div v-for="row in [
              { label: t('fonts.coverageL1'), a: cov.level1, b: cov.level1Total },
              { label: t('fonts.coverageAll'), a: cov.all, b: cov.allTotal },
              { label: t('fonts.coverageKana'), a: cov.kana, b: cov.kanaTotal },
            ]" :key="row.label" class="flex items-center gap-2 text-[12px]">
            <span class="w-[104px] shrink-0 text-muted-foreground">{{ row.label }}</span>
            <span class="flex-1 h-1.5 rounded-full overflow-hidden" style="background: color-mix(in srgb, var(--foreground) 8%, transparent)">
              <span class="block h-full rounded-full" :style="{
                width: pct(row.a, row.b) + '%',
                background: row.a === row.b ? '#22a55b' : pct(row.a, row.b) > 90 ? '#d99a1e' : '#dc4040',
              }" />
            </span>
            <span class="w-[92px] shrink-0 text-right tabular-nums">{{ row.a }} / {{ row.b }}</span>
          </div>
          <p v-if="cov.level1Missing" class="text-[12px] text-muted-foreground break-all">
            {{ t('fonts.missingL1') }}<span class="text-foreground">{{ cov.level1Missing }}</span>
          </p>
        </div>
        <textarea v-model="paste" rows="3" :placeholder="t('fonts.pastePlaceholder')"
          class="w-full resize-y rounded-[10px] border bg-transparent px-3 py-2 text-[13px] outline-none focus:border-foreground/30" />
        <div class="flex items-center gap-2">
          <button @click="checkMissing" :disabled="missBusy || !paste.trim()" class="chip-btn">
            <span class="w-3.5 h-3.5" :class="missBusy ? 'icon-[lucide--loader-circle] animate-spin' : 'icon-[lucide--search-check]'" />
            {{ t('fonts.checkMissing') }}
          </button>
          <span v-if="missing && !missing.missing" class="text-[12px]" style="color: #22a55b">
            {{ t('fonts.missingNone', { n: missing.checked }) }}
          </span>
        </div>
        <p v-if="missing?.missing" class="text-[12.5px] break-all">
          <span class="text-muted-foreground">{{ t('fonts.missingSome', { m: [...missing.missing].length, n: missing.checked }) }}</span>
          <span style="color: #dc4040">{{ missing.missing }}</span>
        </p>
        <p v-if="covErr" class="text-[12px] text-destructive">{{ covErr }}</p>
      </template>
      <p v-else class="text-[12px] text-muted-foreground">{{ t('fonts.needInstall') }}</p>
    </section>

    <!-- ── 文件和操作 ── -->
    <section class="flex flex-col gap-2">
      <span class="text-[12px] font-medium text-muted-foreground">{{ t('fonts.files') }}</span>

      <!-- 推荐里的：安装 -->
      <div v-if="pack && !family" class="flex items-center gap-2">
        <button v-if="pack.installedBy === 'xgcut'" disabled class="chip-btn opacity-70">{{ t('fonts.installedByXgcut') }}</button>
        <button v-else @click="emit('install')" :disabled="installing != null"
          class="relative overflow-hidden h-8 px-4 rounded-lg text-[13px] font-medium text-white"
          :style="{ background: accent }">
          <span v-if="installing != null" class="absolute inset-y-0 left-0 bg-white/25" :style="{ width: Math.round(installing * 100) + '%' }" />
          <span class="relative tabular-nums">{{ installing != null ? Math.round(installing * 100) + '%' : t('fonts.install') }}</span>
        </button>
        <span class="text-[12px] text-muted-foreground">{{ t('fonts.sizeMb', { n: pack.sizeMb }) }}</span>
        <InfoTip :text="t('fonts.installTip')" />
      </div>

      <template v-if="family">
        <div class="flex flex-col rounded-[10px] border divide-y">
          <div v-for="f in family.faces" :key="f.path + f.index" class="flex items-center gap-2 px-2.5 py-1.5">
            <div class="flex-1 min-w-0">
              <div class="text-[12.5px] truncate">
                {{ weightText(f) }}
                <span v-if="f.disabled" class="ml-1 text-[11px] text-muted-foreground">{{ t('fonts.disabledChip') }}</span>
              </div>
              <div class="text-[11px] text-muted-foreground truncate" :title="f.displayPath">{{ f.displayPath }} · {{ size(f.bytes) }}</div>
            </div>
            <button @click="emit('reveal', f.path)" :title="t('fonts.reveal')" class="tool-btn size-7!">
              <span class="icon-[lucide--folder-search] w-3.5 h-3.5" />
            </button>
            <button @pointerdown.prevent="emit('drag', [f.path])" :title="t('fonts.dragFile')" class="tool-btn size-7! cursor-grab">
              <span class="icon-[lucide--grip-vertical] w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          <button @click="emit('copy', family.name)" class="chip-btn">
            <span class="icon-[lucide--copy] w-3.5 h-3.5" />{{ t('fonts.copyZh') }}
          </button>
          <button v-if="family.nameEn !== family.name" @click="emit('copy', family.nameEn)" class="chip-btn">
            <span class="icon-[lucide--copy] w-3.5 h-3.5" />{{ t('fonts.copyEn') }}
          </button>
          <button @pointerdown.prevent="emit('drag', allPaths)" class="chip-btn cursor-grab">
            <span class="icon-[lucide--grip-vertical] w-3.5 h-3.5" />{{ t('fonts.dragAll') }}
          </button>
        </div>

        <div v-if="family.manageable" class="flex items-center gap-1.5">
          <button v-if="family.disabled" @click="emit('toggle', true)" class="chip-btn">
            <span class="icon-[lucide--eye] w-3.5 h-3.5" />{{ t('fonts.enable') }}
          </button>
          <button v-else @click="emit('toggle', false)" class="chip-btn">
            <span class="icon-[lucide--eye-off] w-3.5 h-3.5" />{{ t('fonts.disable') }}
          </button>
          <InfoTip :text="t('fonts.disableTip')" />
          <button @click="emit('uninstall')" class="chip-btn ml-auto text-destructive!">
            <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />{{ t('fonts.uninstall') }}
          </button>
        </div>
        <div v-else class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span class="icon-[lucide--lock] w-3.5 h-3.5" />{{ t('fonts.readOnly') }}
          <InfoTip :text="t('fonts.readOnlyTip')" />
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 0.6rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.tool-btn:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 1.875rem;
  padding: 0 0.7rem;
  border-radius: 0.55rem;
  font-size: 12.5px;
  color: var(--foreground);
  background: color-mix(in srgb, var(--foreground) 6%, transparent);
  transition: background-color 140ms ease;
}
.chip-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--foreground) 11%, transparent);
}
.chip-btn:disabled {
  opacity: 0.55;
}
</style>
