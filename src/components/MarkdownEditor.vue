<script setup lang="ts">
/**
 * Markdown 编辑器 —— Obsidian 那种「边打边渲染」。
 *
 * # 为什么是 CodeMirror 而不是 ProseMirror / Milkdown
 *
 * 那一类富文本内核会把文档解析进自己的模型,保存时再序列化回 Markdown ——
 * 也就是**每次保存都重写整份文件**。模型不认识的语法会被改写或丢掉,而用户
 * 的库里恰恰全是这种东西:Obsidian 的 `[[双链]]`、`%%` 注释、`==高亮==`、
 * callout、内嵌的 ```base 代码块。这是在他真实的笔记库上跑,不能冒这个险。
 *
 * CodeMirror 的文档**就是那串 Markdown 文本**,所有渲染都是视图层的装饰,
 * 存出去和纯 textarea 逐字节相同。Obsidian 自己也是这么做的。
 *
 * # 装饰从哪来
 *
 * @atomic-editor/editor(MIT)。它本身是一组 CM6 扩展,另外附带一个 React
 * 组件 —— **我们只挑扩展,不碰那个组件**,所以这里没有 React。
 * 那个包 sideEffects 标了 false,生产构建会把组件连同它的 react import
 * 一起摇掉。
 *
 * 下面这份扩展清单是照它 React 组件里那份抄的,**顺序有讲究**:
 * 语法解析要先于装饰、装饰要在主题之后、更新监听要在装饰之后。
 */
import { shallowRef, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import { EditorState, Compartment } from '@codemirror/state'
import {
  EditorView, keymap, drawSelection, dropCursor, rectangularSelection,
  highlightActiveLine, highlightSpecialChars,
} from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { indentOnInput } from '@codemirror/language'
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown'
import {
  inlinePreview, imageBlocks, tables, wikiLinks,
  atomicEditorTheme, atomicMarkdownSyntax, highlightMarkdown,
  autoCloseCodeFence, extendEmphasisPair, startAsteriskList,
  readOnlyExtension,
} from '@atomic-editor/editor'
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages'
import '@atomic-editor/editor/styles.css'
import type { WikiLinkSuggestion } from '@atomic-editor/editor'
import { isDarkNow } from '@/composables/useAppSettings'

const props = withDefaults(defineProps<{
  modelValue: string
  readOnly?: boolean
  /** 点了渲染出来的链接。Tauri 里要走系统浏览器,不能让 webview 自己导航走 */
  onOpenLink?: (url: string) => void
  /** [[双链]] 的自动补全候选 */
  wikiSuggest?: (q: string) => Promise<WikiLinkSuggestion[]>
  /** 点了 [[双链]] */
  onOpenWiki?: (target: string) => void
}>(), { readOnly: false })

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const host = shallowRef<HTMLDivElement | null>(null)
const view = shallowRef<EditorView | null>(null)
const roCompartment = new Compartment()

/*
  这个库的浅色主题靠根元素上的 data-theme="light",而我们全局用的是
  documentElement 上的 .dark 类。两套约定,所以这里把我们的状态翻译过去。
*/
const themeAttr = computed(() => (isDarkNow() ? undefined : 'light'))

function extensions() {
  const openLink = (url: string) => props.onOpenLink?.(url)
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    rectangularSelection(),
    highlightActiveLine(),
    closeBrackets(),
    startAsteriskList,      // 回车续列表 / 空条目退一级
    extendEmphasisPair,     // **加粗** 成对扩写
    autoCloseCodeFence,     // ``` 自动配对
    EditorView.lineWrapping,
    search({ top: true }),
    /*
      base: markdownLanguage 才有 GFM(表格、删除线、任务列表、自动链接);
      纯 CommonMark 的话 inlinePreview 根本看不到 Task / Table 这些节点。
      extensions: highlightMarkdown 是 ==高亮== 的解析规则 —— 少了它
      `==xx==` 会原样显示,而且不报错,很难看出是解析层缺东西。
    */
    markdown({
      base: markdownLanguage,
      codeLanguages: [...ATOMIC_CODE_LANGUAGES],
      extensions: highlightMarkdown,
    }),
    // 把括号自动配对扩展到 Markdown 的成对符号上
    markdownLanguage.data.of({
      closeBrackets: { brackets: ['(', '[', '{', "'", '"', '*', '_', '`'] },
    }),
    atomicMarkdownSyntax,
    atomicEditorTheme,
    keymap.of([
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...markdownKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    // 装饰这三个要排在主题之后
    tables({ onLinkClick: openLink }),
    imageBlocks(),
    inlinePreview({ onLinkClick: openLink }),
    wikiLinks({
      suggest: props.wikiSuggest,
      onOpen: (t) => props.onOpenWiki?.(t),
      openOnClick: true,
    }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged) return
      emit('update:modelValue', u.state.doc.toString())
    }),
    roCompartment.of(readOnlyExtension(props.readOnly)),
  ]
}

onMounted(() => {
  if (!host.value) return
  view.value = new EditorView({
    parent: host.value,
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
  })
})

onBeforeUnmount(() => {
  view.value?.destroy()
  view.value = null
})

/*
  外部换了内容(切标签、外部改动)才整份替换。
  **必须先比一次** —— 不比的话,用户自己敲的每一个字都会因为 modelValue 回流
  而触发一次全文替换,光标直接跳到文末,根本没法打字。
*/
watch(() => props.modelValue, (v) => {
  const ed = view.value
  if (!ed || v === ed.state.doc.toString()) return
  ed.dispatch({ changes: { from: 0, to: ed.state.doc.length, insert: v } })
})

watch(() => props.readOnly, (ro) => {
  view.value?.dispatch({ effects: roCompartment.reconfigure(readOnlyExtension(ro)) })
})

defineExpose({ focus: () => view.value?.focus() })
</script>

<template>
  <div ref="host" class="xg-md-editor h-full min-h-0 overflow-hidden" :data-theme="themeAttr" />
</template>

<style scoped>
/* 编辑器自己管滚动,外面这层只负责给它一个有界的高度 */
.xg-md-editor :deep(.cm-editor) { height: 100%; }
.xg-md-editor :deep(.cm-scroller) { overflow: auto; }
</style>
