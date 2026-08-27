<script setup lang="ts">
/**
 * 无限画布 —— 官方 Excalidraw 塞进 Vue 里。
 *
 * # 为什么要拖一个 React 进来
 *
 * Excalidraw 只有 React 版，没有 Vue 版，也没有 web component 版。
 * 而这个功能的要求是「Obsidian 那边画完，这边打开一模一样」——
 * 那种手绘线条是 roughjs 按每个元素的 seed 随机出来的，自己重写一套
 * 永远对不上，两边看到的会是两张不同的图。所以只能用同一个库。
 *
 * 代价是多背一个 React 运行时（gzip 后 40KB 上下）。为此整个组件走
 * 异步加载：不打开画布的人一个字节都不下载。
 *
 * # 为什么手动 createRoot 而不是找个胶水库
 *
 * 就挂一个组件，胶水库要处理的插槽、事件、双向 props 一个都用不上。
 * 二十行手写的比多一个依赖清楚。
 *
 * # 字体
 *
 * Excalidraw 默认去 CDN 拉手写字体。这是个离线的桌面应用，所以字体整套
 * 拷进 public/excalidraw/，用 EXCALIDRAW_ASSET_PATH 指过去。
 * 不指的话中文会掉回系统黑体，和 Obsidian 那边看着就不是一张图了。
 */
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Scene } from '@/composables/useExcalidraw'

const props = defineProps<{
  scene: Scene
  /** 深色模式跟着应用走 */
  dark: boolean
  readOnly?: boolean
}>()

const emit = defineEmits<{ change: [Scene] }>()

const host = ref<HTMLElement | null>(null)
const root = shallowRef<any>(null)
const api = shallowRef<any>(null)
const loading = ref(true)
const error = ref('')

/** 只有真正改了画的东西才回抛。滚动、缩放、选中都会触发 onChange，不能一律当修改 */
let lastSig = ''

function signature(elements: any[], files: Record<string, any>) {
  // versionNonce 是 Excalidraw 给每次真实改动递增的标记 —— 比深比较便宜得多
  return `${elements.length}:${elements.map((e) => e.versionNonce).join(',')}:${Object.keys(files ?? {}).join(',')}`
}

onMounted(async () => {
  try {
    // 字体路径必须在库加载**之前**设好,它是在模块初始化时读的
    ;(window as any).EXCALIDRAW_ASSET_PATH = '/excalidraw/'

    const [React, ReactDOM, Excalidraw] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@excalidraw/excalidraw'),
    ])
    await import('@excalidraw/excalidraw/index.css')
    if (!host.value) return

    lastSig = signature(props.scene.elements, props.scene.files)

    root.value = ReactDOM.createRoot(host.value)
    /*
      props 整体断成 any。

      Excalidraw 的类型把 elements 声明成 readonly、appState 要求一个完整的
      内部状态对象 —— 而我们喂进去的是从磁盘读回来的存档,本来就是「部分状态」,
      官方的 initialData 也接受这种形状。硬凑类型只会写出一堆假的字段。
    */
    root.value.render(
      React.createElement(Excalidraw.Excalidraw as any, {
        excalidrawAPI: (a: any) => { api.value = a },
        initialData: {
          elements: props.scene.elements,
          appState: {
            ...props.scene.appState,
            theme: props.dark ? 'dark' : 'light',
            // 存档里可能留着「上次正拿着套索」这种状态,打开就变成在画画
            activeTool: { type: 'selection' },
          },
          files: props.scene.files,
          scrollToContent: true,
        },
        viewModeEnabled: props.readOnly ?? false,
        langCode: 'zh-CN',
        onChange: (elements: any[], appState: any, files: Record<string, any>) => {
          const sig = signature(elements, files)
          if (sig === lastSig) return
          lastSig = sig
          emit('change', {
            ...props.scene,
            elements,
            appState: Excalidraw.serializeAsJSON
              ? JSON.parse(Excalidraw.serializeAsJSON(elements, appState, files, 'local')).appState
              : appState,
            files,
          })
        },
      } as any),
    )
    loading.value = false
  } catch (e) {
    error.value = String((e as Error)?.message ?? e)
    loading.value = false
  }
})

watch(() => props.dark, (d) => {
  api.value?.updateScene({ appState: { theme: d ? 'dark' : 'light' } })
})

onBeforeUnmount(() => {
  // React 的卸载得排到 Vue 这一轮之后,不然会在 Vue 卸载 DOM 的中途去动同一棵树
  const r = root.value
  root.value = null
  api.value = null
  if (r) setTimeout(() => r.unmount(), 0)
})
</script>

<template>
  <div class="relative h-full min-h-0">
    <div ref="host" class="xg-excalidraw h-full" />
    <p v-if="loading" class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
      …
    </p>
    <p v-else-if="error"
      class="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-destructive">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
/* Excalidraw 自己会撑满容器,但它要求容器有确定的高度 */
.xg-excalidraw :deep(.excalidraw) { height: 100%; }
/*
  它自带的圆角是 0。这里包在一张圆角卡片里,不裁一下四个角会顶出去,
  画布的白底盖住卡片的圆角,看着像贴了块补丁。
*/
.xg-excalidraw { border-radius: inherit; overflow: hidden; }
</style>
