/*
  提示词页的持久化：已选词、自定义预设、几个开关。

  XGWeb 里这些放在浏览器 localStorage；XGTools 的约定是走 Tauri store（各页各存各的 json），
  所以单开一份 prompt.json，不和 settings.json 抢。
  写法是「先给默认值、读到存档再覆盖、之后改动防抖写回」—— 读回来之前的改动不会被存档盖掉以外的东西影响，
  页面要等 ready 之后再做去重 / 补翻译这类依赖存档内容的事。
*/
import { ref, watch, type Ref } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'

const store = new LazyStore('prompt.json')
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleSave(key: string, value: unknown) {
  clearTimeout(timers.get(key))
  timers.set(key, setTimeout(async () => {
    timers.delete(key)
    try {
      await store.set(key, JSON.parse(JSON.stringify(value)))
      await store.save()
    }
    catch (e) {
      console.error('提示词存档写入失败:', e)
    }
  }, 300))
}

/** 一个会自动存进 prompt.json 的 ref。返回的 ready 在读完存档后 resolve */
export function storedRef<T>(key: string, initial: T): { data: Ref<T>, ready: Promise<void> } {
  const data = ref(initial) as Ref<T>
  let loaded = false
  const ready = (async () => {
    try {
      const saved = await store.get<T>(key)
      if (saved !== undefined && saved !== null)
        data.value = saved
    }
    catch (e) {
      console.error('提示词存档读取失败:', e)
    }
    loaded = true
  })()
  watch(data, (v) => { if (loaded) scheduleSave(key, v) }, { deep: true })
  return { data, ready }
}
