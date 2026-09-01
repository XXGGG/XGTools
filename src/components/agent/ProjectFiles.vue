<script setup lang="ts">
/**
 * 项目文件夹的树。
 *
 * # 和笔记页那棵树的关系
 *
 * 后端是同一套(`vault_list` 本来就按「根 + 相对路径」取,根传谁都行),
 * 但**状态是分开的**:笔记页那棵树钉在笔记库根上,是「我的整个知识库」;
 * 这棵钉在项目文件夹上,是「现在手头这一件事」。共用一份状态的话,
 * 在工作台里点开一个目录会把笔记页那边也搅动一遍 —— 两个地方各看各的才对。
 *
 * # 单击和双击是两件事
 *
 * · 单击文件 = **把它插进输入框**(变成 `@路径`)。这是最常做的动作:
 *   「看看这个文件」—— 不用去资源管理器找路径,看见就点。
 * · 双击 = 在中间那栏打开来看。
 *
 * 这个分工不是随手定的:干活时「让 AI 去看」的次数远多于「我自己要看」,
 * 次数多的那个给单击。
 *
 * # 为什么自己调自己
 *
 * 目录能套几层不由我们说了算。写死两层的话,第三层的文件就永远点不到 ——
 * 递归是唯一诚实的画法。展开过的目录才去读,没展开的不读:一次读完整棵树,
 * 遇到 node_modules 那种目录会当场卡住。
 */
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'

const props = withDefaults(defineProps<{
  root: string
  /** 这一层画的是哪个目录。根目录是空串 */
  rel?: string
  depth?: number
}>(), { rel: '', depth: 0 })

const emit = defineEmits<{
  (e: 'mention', relPath: string): void
  (e: 'open', relPath: string): void
}>()

type Entry = { name: string; path: string; isDir: boolean }

const rows = ref<Entry[]>([])
const openDirs = ref<Record<string, boolean>>({})
const loading = ref(false)
const error = ref('')

async function load() {
  if (!props.root) { rows.value = []; return }
  loading.value = true
  error.value = ''
  try {
    const list = await invoke<any[]>('vault_list', { root: props.root, rel: props.rel })
    rows.value = (list ?? []).map((e) => ({
      name: String(e.name ?? ''),
      path: String(e.path ?? ''),
      isDir: !!e.isDir,
    }))
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

watch(() => [props.root, props.rel], load, { immediate: true })

function toggle(dir: Entry) {
  openDirs.value = { ...openDirs.value, [dir.path]: !openDirs.value[dir.path] }
}

/*
  单击要等一下再动手。

  双击一个文件时,浏览器**先发两次 click 再发 dblclick** —— 不等的话「打开」之前
  会先往输入框里塞两遍 @引用。所以单击先记个定时器,250ms 内没等到双击才真的插;
  等到了就把它撤掉。
*/
let clickTimer: number | undefined

function onClick(e: Entry) {
  if (e.isDir) { toggle(e); return }
  window.clearTimeout(clickTimer)
  clickTimer = window.setTimeout(() => emit('mention', e.path), 250)
}

function onDblClick(e: Entry) {
  if (e.isDir) return
  window.clearTimeout(clickTimer)
  emit('open', e.path)
}
</script>

<template>
  <div>
    <p v-if="error" class="px-2 py-1.5 text-[12px] text-red-500 wrap-break-word">{{ error }}</p>
    <p v-else-if="loading && !rows.length" class="px-2 py-2 text-center text-[12px] text-muted-foreground">…</p>
    <p v-else-if="!rows.length && depth === 0" class="px-2 py-3 text-center text-[12px] text-muted-foreground">
      这个文件夹是空的
    </p>

    <template v-for="e in rows" :key="e.path">
      <button @click="onClick(e)" @dblclick="onDblClick(e)"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        class="w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-lg text-[13px] text-left
               transition-colors hover:bg-muted/60">
        <span v-if="e.isDir" class="w-3 h-3 shrink-0 text-muted-foreground"
          :class="openDirs[e.path] ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'" />
        <span v-else class="icon-[lucide--file-text] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ e.name }}</span>
      </button>

      <ProjectFiles v-if="e.isDir && openDirs[e.path]" :root="root" :rel="e.path" :depth="depth + 1"
        @mention="(p: string) => emit('mention', p)" @open="(p: string) => emit('open', p)" />
    </template>
  </div>
</template>
