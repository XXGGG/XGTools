<script setup lang="ts">
/**
 * 字体库列表里的一行：左边名字和标签，右边用这款字画出样张。
 *
 * 字体是**滚到看得见才去找**的（IntersectionObserver）：一台电脑三四百款字体，
 * 一进页面全去加载，中文字体一款几十兆，页面当场卡住。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

export type Chip = { text: string; color?: string; title?: string }

const props = defineProps<{
  name: string
  nameEn: string
  chips: Chip[]
  /** 可见时调它拿 font-family；拿不到（画不出来）返回 null */
  resolve: () => Promise<string | null>
  /** 字体换了（装好了、启用了）就换个 key，重新找 */
  fontKey: string
  text: string
  size: number
  selected: boolean
  picked: boolean
  favorite: boolean
  /** 停用的、没装的：整行淡一点 */
  dim: boolean
  /** 右边的主按钮（推荐里的「安装」）。busy 是进度 0~1 */
  action?: { label: string; busy?: number | null; done?: boolean } | null
  accent: string
  pickLabel: string
  favLabel: string
  copyLabel: string
  dragLabel: string
  failLabel: string
}>()

const emit = defineEmits<{
  select: [e: MouseEvent]
  pick: []
  fav: []
  copy: []
  drag: []
  action: []
}>()

const root = ref<HTMLElement | null>(null)
const family = ref<string | null>(null)
const state = ref<'wait' | 'ok' | 'fail'>('wait')
let visible = false
let loadedKey = ''
let obs: IntersectionObserver | null = null

async function load() {
  if (!visible || loadedKey === props.fontKey) return
  const key = props.fontKey
  loadedKey = key
  state.value = 'wait'
  const f = await props.resolve()
  if (loadedKey !== key) return
  family.value = f
  state.value = f ? 'ok' : 'fail'
}

onMounted(() => {
  obs = new IntersectionObserver(
    (entries) => {
      visible = entries.some((e) => e.isIntersecting)
      void load()
    },
    { rootMargin: '200px 0px' },
  )
  if (root.value) obs.observe(root.value)
})
onBeforeUnmount(() => obs?.disconnect())
watch(() => props.fontKey, () => void load())
</script>

<template>
  <div ref="root" data-font-row :data-state="state" :data-name="name" @click="emit('select', $event)"
    class="group relative flex items-center gap-4 rounded-[10px] px-3 py-2 cursor-default transition-colors"
    :class="selected ? 'bg-muted' : 'hover:bg-muted/50'"
    :style="{
      minHeight: Math.max(64, size * 1.35 + 22) + 'px',
      boxShadow: selected ? `inset 3px 0 0 ${accent}` : undefined,
    }">
    <!-- 名字和标签 -->
    <div class="w-[196px] shrink-0 min-w-0" :class="dim ? 'opacity-55' : ''">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="text-[14px] font-medium truncate" :title="name">{{ name }}</span>
        <span v-if="favorite" class="icon-[lucide--star] w-3 h-3 shrink-0" :style="{ color: '#f2b21c' }" />
      </div>
      <div v-if="nameEn && nameEn !== name" class="text-[11.5px] text-muted-foreground truncate" :title="nameEn">
        {{ nameEn }}
      </div>
      <div class="mt-1 flex items-center gap-1 overflow-hidden">
        <span v-for="c in chips" :key="c.text" :title="c.title"
          class="shrink-0 rounded-[5px] px-1.5 py-px text-[10.5px] leading-[16px] whitespace-nowrap"
          :style="c.color
            ? { color: c.color, background: `color-mix(in srgb, ${c.color} 14%, transparent)` }
            : { background: 'color-mix(in srgb, var(--foreground) 7%, transparent)' }"
          :class="c.color ? '' : 'text-muted-foreground'">{{ c.text }}</span>
      </div>
    </div>

    <!-- 样张 -->
    <div class="flex-1 min-w-0 overflow-hidden" :class="dim ? 'opacity-55' : ''">
      <div v-if="state === 'fail'" class="text-[12px] text-muted-foreground">{{ failLabel }}</div>
      <div v-else class="whitespace-nowrap overflow-hidden text-ellipsis transition-opacity duration-200"
        :class="state === 'wait' ? 'opacity-0' : 'opacity-100'"
        :style="{ fontFamily: family ?? undefined, fontSize: size + 'px', lineHeight: 1.3 }">{{ text }}</div>
    </div>

    <!-- 操作：鼠标移上来才出现，选中的行常亮 -->
    <div class="shrink-0 flex items-center gap-0.5"
      :class="selected || picked ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'">
      <button @click.stop="emit('pick')" :title="pickLabel" class="row-btn"
        :style="picked ? { color: accent } : undefined">
        <span class="w-4 h-4" :class="picked ? 'icon-[lucide--square-check]' : 'icon-[lucide--square]'" />
      </button>
      <button @click.stop="emit('fav')" :title="favLabel" class="row-btn"
        :style="favorite ? { color: '#f2b21c' } : undefined">
        <span class="icon-[lucide--star] w-4 h-4" />
      </button>
      <button @click.stop="emit('copy')" :title="copyLabel" class="row-btn">
        <span class="icon-[lucide--copy] w-4 h-4" />
      </button>
      <!-- 按住这里拖出去：系统级拖放，Godot、PS 都接得住 -->
      <button @click.stop @pointerdown.stop.prevent="emit('drag')" :title="dragLabel" class="row-btn cursor-grab">
        <span class="icon-[lucide--grip-vertical] w-4 h-4" />
      </button>
    </div>

    <button v-if="action" @click.stop="emit('action')" :disabled="action.done || action.busy != null"
      class="shrink-0 relative overflow-hidden h-8 min-w-[76px] px-3 rounded-lg text-[12.5px] font-medium transition-colors"
      :style="action.done
        ? { color: 'var(--muted-foreground)', background: 'color-mix(in srgb, var(--foreground) 6%, transparent)' }
        : { color: '#fff', background: accent }">
      <span v-if="action.busy != null" class="absolute inset-y-0 left-0 bg-white/25"
        :style="{ width: Math.round(action.busy * 100) + '%' }" />
      <span class="relative tabular-nums">{{ action.busy != null ? Math.round(action.busy * 100) + '%' : action.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.row-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  color: var(--muted-foreground);
  transition: background-color 140ms ease, color 140ms ease;
}
.row-btn:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  color: var(--foreground);
}
</style>
