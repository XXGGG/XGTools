<script setup lang="ts">
/**
 * 会话列表里的一行。
 *
 * 右键菜单里最要紧的一条是「变成项目」:聊着聊着发现「这其实是一件正经事」的时候,
 * 不用重开一轮把话重说一遍 —— 就地把这次对话立成一个项目,内容一个字不动,
 * 之后它就有自己的文件夹和位置了。
 */
import { useI18n } from '@/i18n'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from '@/components/ui/context-menu'
import type { ProjectCategory } from '@/composables/useProjects'

defineProps<{
  title: string
  time: string
  /** 后台还在跑。给个呼吸点,一眼看得出哪条在干活 */
  running?: boolean
  active: boolean
  pinned: boolean
  /** 能立到哪些项目类下面 */
  cats: ProjectCategory[]
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'pin'): void
  (e: 'rename'): void
  (e: 'archive'): void
  /** 把这次对话立成一个项目,放在这个项目类下面 */
  (e: 'promote', categoryId: string): void
}>()

const { t } = useI18n()

/**
 * 右键菜单里「有子菜单的那一行」要长得和普通选项一模一样。
 *
 * 必须走 `as-child` 自己出 DOM 节点 —— reka 的 ContextMenuSubTrigger
 * **不把 class 透到 DOM 上**(探针量过:`data-slot="context-menu-sub-trigger"`
 * 在 DOM 里压根不存在),所以改组件里的类名怎么改都没反应。折腾了三轮才查出来。
 * 箭头也要自己画:as-child 只认一个子节点,组件那边再补一个就会多出一整行空行。
 *
 * 这一串照着 ContextMenuItem 抄 —— 同一个菜单里的行必须逐字同款。
 */
const MENU_ROW = 'relative w-full flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none'


</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <button @click="emit('open')" :class="[
        'w-full text-left rounded-lg px-2.5 py-2 transition-colors',
        active ? 'bg-muted' : 'hover:bg-muted/50'
      ]">
        <div class="flex items-center gap-1.5">
          <span v-if="running" class="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <span v-if="pinned" class="icon-[lucide--pin] w-3 h-3 shrink-0 text-muted-foreground" />
          <span class="text-[13px] truncate" :class="title ? '' : 'text-muted-foreground italic'">
            {{ title || t('agent.untitled') }}
          </span>
        </div>
        <div class="text-[11px] text-muted-foreground mt-0.5">{{ time }}</div>
      </button>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-44">
      <ContextMenuItem @select="emit('pin')">
        <span class="icon-[lucide--pin] w-4 h-4" />
        {{ pinned ? t('agent.unpin') : t('agent.pin') }}
      </ContextMenuItem>
      <ContextMenuItem @select="emit('rename')">
        <span class="icon-[lucide--pencil] w-4 h-4" />
        {{ t('agent.rename') }}
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuSub v-if="cats.length">
        <ContextMenuSubTrigger as-child>
          <div :class="MENU_ROW">
            <span class="icon-[lucide--folder-input] w-4 h-4 text-muted-foreground" />
            <span class="truncate">{{ t('agent.promoteToProject') }}</span>
            <span class="icon-[lucide--chevron-right] w-4 h-4 ml-auto text-muted-foreground" />
          </div>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent class="w-44">
          <ContextMenuItem v-for="c in cats" :key="c.id" @select="emit('promote', c.id)">
            <!-- emoji 没有固定宽度,不框住的话每一行的文字起点都不一样 -->
            <span class="w-4 shrink-0 text-center leading-none">{{ c.icon || '📁' }}</span>
            <span class="truncate">{{ c.name }}</span>
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem v-else @select="emit('promote', '')">
        <span class="icon-[lucide--folder-input] w-4 h-4" />
        {{ t('agent.promoteToProject') }}
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem @select="emit('archive')" class="text-destructive focus:text-destructive">
        <span class="icon-[lucide--archive] w-4 h-4" />
        {{ t('agent.archive') }}
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
</template>
