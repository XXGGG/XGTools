<script setup lang="ts">
/**
 * 项目列表里的一行。
 *
 * 拆成组件不只是为了短:整段内联写在 Agent.vue 里时,它的二级菜单**弹不出来** ——
 * 会叠在主菜单上面,而同样一段写在 SessionItem 里就正常。
 * 差别只有「是不是一个独立组件」,所以就照着会话那一行的样子拆出来。
 */
import { useI18n } from '@/i18n'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import type { Project, ProjectCategory } from '@/composables/useProjects'

defineProps<{
  project: Project
  /** 能移到哪些项目类 */
  cats: ProjectCategory[]
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'rename'): void
  (e: 'move', categoryId: string): void
  (e: 'remove'): void
}>()

const { t } = useI18n()

/**
 * 「有子菜单的那一行」要长得和普通选项一模一样。
 *
 * 必须走 `as-child` 自己出 DOM 节点 —— reka 的 ContextMenuSubTrigger
 * **不把 class 透到 DOM 上**(探针量过:`data-slot="context-menu-sub-trigger"`
 * 在 DOM 里压根不存在),所以改组件里的类名怎么改都没反应。
 * 箭头也要自己画:as-child 只认一个子节点,组件那边再补一个就会多出一整行空行。
 */
const MENU_ROW = 'relative w-full flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none'
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <button @click="emit('open')"
        class="w-full h-11 flex items-center gap-2 pl-7 pr-2 rounded-xl text-[13px]
               transition-colors hover:bg-muted/60">
        <span class="shrink-0">{{ project.icon || '📁' }}</span>
        <span class="truncate">{{ project.name }}</span>
      </button>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-44">
      <ContextMenuItem @select="emit('rename')">
        <span class="icon-[lucide--pencil] w-4 h-4" />
        {{ t('agent.rename') }}
      </ContextMenuItem>

      <ContextMenuSub v-if="cats.length">
        <ContextMenuSubTrigger as-child>
          <div :class="MENU_ROW">
            <span class="icon-[lucide--folder-input] w-4 h-4 text-muted-foreground" />
            <span class="truncate">{{ t('agent.moveToCategory') }}</span>
            <span class="icon-[lucide--chevron-right] w-4 h-4 ml-auto text-muted-foreground" />
          </div>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent class="w-44">
          <ContextMenuItem v-for="c in cats" :key="c.id" @select="emit('move', c.id)">
            <!-- emoji 没有固定宽度,不框住的话每一行的文字起点都不一样 -->
            <span class="w-4 shrink-0 text-center leading-none">{{ c.icon || '📁' }}</span>
            <span class="truncate">{{ c.name }}</span>
            <span v-if="c.id === project.categoryId"
              class="icon-[lucide--check] w-3.5 h-3.5 ml-auto text-muted-foreground" />
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSeparator />
      <!-- 删项目要再确认一次：这一条底下挂着一整段对话,点错了拿不回来 -->
      <ContextMenuItem @select="emit('remove')" class="text-destructive focus:text-destructive">
        <span class="icon-[lucide--trash-2] w-4 h-4" />
        {{ t('agent.delProject') }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
