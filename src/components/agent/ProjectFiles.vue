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
 * # 单击就是打开
 *
 * 和在 VSCode 里点文件一样 —— 点一下就打开来看,不用先猜「这一下会发生什么」。
 *
 * 「让 AI 去看某一段」走另一条路:在打开的文件里刮选一段,按 **Alt+K**,
 * 那一段的位置(`@路径#行号`)就进了输入框。这比「点一下插一个整文件」准得多 ——
 * 你想让它看的多半是文件里的某一处,不是整篇。
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

function onClick(e: Entry) {
  if (e.isDir) { toggle(e); return }
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
      <button @click="onClick(e)"
        :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
        class="w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-lg text-[13px] text-left
               transition-colors hover:bg-muted/60">
        <span v-if="e.isDir" class="w-3 h-3 shrink-0 text-muted-foreground"
          :class="openDirs[e.path] ? 'icon-[lucide--chevron-down]' : 'icon-[lucide--chevron-right]'" />
        <span v-else class="icon-[lucide--file-text] w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ e.name }}</span>
      </button>

      <ProjectFiles v-if="e.isDir && openDirs[e.path]" :root="root" :rel="e.path" :depth="depth + 1"
        @open="(p: string) => emit('open', p)" />
    </template>
  </div>
</template>
