/*
  本机离线翻译:Firefox 同款的 Bergamot 引擎(wasm)+ Mozilla 训练的中英模型。

  三块东西:
  1. 引擎 —— public/bergamot/ 里的 worker 三件套,从 @browsermt/bergamot-translator
     拷过来(scripts/copy-bergamot.mjs)。跑在 Web Worker 里,纯 CPU,单句几十到一两百毫秒。
  2. 模型 —— Mozilla Remote Settings 上给 Firefox 用的那份(MPL-2.0),中英各一个方向,
     加起来约 120 MB。**不随安装包走**,用户在翻译设置里点一下才下,存到应用数据目录,
     以后不联网也能翻。下面 PAIRS 就是 2026-08 的记录,连 sha256 一起写死:
     启动不用去问 Remote Settings,下载完还能校验。Mozilla 更新模型时改这张表。
  3. 这个文件 —— 自己实现主线程这边的调度,不 import 那个 npm 包的 translator.js:
     它的 loadWorker 用 `new URL('./worker/…', import.meta.url)` 起 worker,进了 Vite
     预构建就指错地方;而 worker 那头的消息协议只有四个方法,自己写更清楚。

  每个 webview 各起各的 worker(命令面板、主窗口、截图窗口互不相通),模型加载进
  内存约 100 MB;闲置五分钟自动卸掉。
*/
import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { BaseDirectory, exists, mkdir, readFile, remove } from '@tauri-apps/plugin-fs'

const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/'
const DIR = 'bergamot'                       // $APPDATA/bergamot/
const IDLE_UNLOAD_MS = 5 * 60_000

type FileRec = { url: string; size: number; sha256: string }
type Pair = { from: 'en' | 'zh'; to: 'en' | 'zh'; files: Record<'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab', FileRec | undefined> }

const rec = (loc: string, size: number, sha256: string): FileRec => ({ url: CDN + 'main-workspace/translations-models/' + loc, size, sha256 })

/** Mozilla translations-models 集合里 zh-Hans 的桌面版记录(en→zh v2.2,zh→en v2.0) */
export const PAIRS: Pair[] = [
  {
    from: 'en', to: 'zh',
    files: {
      model: rec('a7ff7d5e-e67e-406c-a34b-a7edea35b10e.bin', 43849787, '4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c'),
      lex: rec('da8fccc0-31df-4665-9703-96d36606e019.bin', 6506248, '4a5e5827788060f1d718a8132b69440929387514a045796e9b77f935db68c055'),
      srcvocab: rec('ea98c52c-58dc-45d5-af23-38f2b029d020.spm', 806952, 'bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5'),
      trgvocab: rec('bddbda68-d4d2-4317-a0a1-119caa47525e.spm', 772004, 'aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d'),
      vocab: undefined,
    },
  },
  {
    from: 'zh', to: 'en',
    files: {
      model: rec('052699bf-6f88-4c74-bb14-e49a943b4f59.bin', 59504955, '3535442962ec8f4a553cc19b206befcac689ee9cddaea44fa91e21527fc30ac2'),
      lex: rec('645c720c-6920-470d-9bb7-3f9a6b0a9cae.bin', 9220016, 'cdcad3592dc2bc4676c34c4d37203f7649ee989195cf083cbb60f1ea011f976b'),
      vocab: rec('88a4925d-ff4a-4c76-8813-95e2ac600b14.spm', 1359697, 'dff594318ab7d8b7b60b844ab98ebe6b932ae8045fab15235404c787715965b3'),
      srcvocab: undefined,
      trgvocab: undefined,
    },
  },
]

const allFiles = (): FileRec[] => PAIRS.flatMap((p) => Object.values(p.files).filter((f): f is FileRec => !!f))
export const LOCAL_MODEL_BYTES = allFiles().reduce((n, f) => n + f.size, 0)

/** 本地缓存文件名:用 CDN 上那个 uuid 文件名,版本一换名字就换,不会串 */
const localName = (f: FileRec) => DIR + '/' + f.url.slice(f.url.lastIndexOf('/') + 1)

// ─── 模型文件:状态 / 下载 / 删除 ───────────────────────────────

export type LocalModelStatus = 'unknown' | 'missing' | 'downloading' | 'ready' | 'error'

/** 给设置页看的状态。各窗口各自一份,但都从磁盘上的同一批文件判断 */
export const localModel = reactive({
  status: 'unknown' as LocalModelStatus,
  /** 0..1 */
  progress: 0,
  error: '',
})

export async function checkLocalModel(): Promise<boolean> {
  try {
    const present = await Promise.all(allFiles().map((f) => exists(localName(f), { baseDir: BaseDirectory.AppData })))
    const ok = present.every(Boolean)
    if (localModel.status !== 'downloading') localModel.status = ok ? 'ready' : 'missing'
    return ok
  } catch (e) {
    localModel.status = 'error'
    localModel.error = String(e)
    return false
  }
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 下一个文件,边下边报进度,下完校验 sha256。
 * 下载走 Rust(download_to_appdata):Mozilla 的 CDN 不给 CORS 头,网页里 fetch 直接失败。
 */
async function downloadFile(f: FileRec, onBytes: (n: number) => void): Promise<void> {
  let last = 0
  const stop = await listen<{ url: string; loaded: number; total: number }>('download-progress', (e) => {
    if (e.payload.url !== f.url) return
    onBytes(e.payload.loaded - last)
    last = e.payload.loaded
  })
  try {
    await invoke('download_to_appdata', { url: f.url, relPath: localName(f) })
  } finally {
    stop()
  }
  const u8 = await readFile(localName(f), { baseDir: BaseDirectory.AppData })
  const hash = await sha256Hex(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
  if (hash !== f.sha256) {
    try { await remove(localName(f), { baseDir: BaseDirectory.AppData }) } catch { /* 删不掉下次也会重下 */ }
    throw new Error('文件校验不通过,可能下载途中被截断,再试一次')
  }
  onBytes(f.size - last)
}

export async function downloadLocalModel(): Promise<void> {
  if (localModel.status === 'downloading') return
  localModel.status = 'downloading'
  localModel.progress = 0
  localModel.error = ''
  let done = 0
  try {
    await mkdir(DIR, { baseDir: BaseDirectory.AppData, recursive: true })
    for (const f of allFiles()) {
      // 已经有的跳过 —— 断了重来只补缺的那几个
      if (await exists(localName(f), { baseDir: BaseDirectory.AppData })) {
        done += f.size
        localModel.progress = done / LOCAL_MODEL_BYTES
        continue
      }
      await downloadFile(f, (n) => { done += n; localModel.progress = Math.min(1, done / LOCAL_MODEL_BYTES) })
    }
    localModel.status = 'ready'
    localModel.progress = 1
  } catch (e) {
    localModel.status = 'error'
    localModel.error = String(e instanceof Error ? e.message : e)
  }
}

export async function removeLocalModel(): Promise<void> {
  unloadTranslator()
  for (const f of allFiles()) {
    try { await remove(localName(f), { baseDir: BaseDirectory.AppData }) } catch { /* 本来就没有 */ }
  }
  localModel.status = 'missing'
  localModel.progress = 0
}

// ─── 引擎:worker 代理 ───────────────────────────────────────

type Pending = { accept: (v: unknown) => void; reject: (e: Error) => void }

class Engine {
  private worker: Worker
  private serial = 0
  private pending = new Map<number, Pending>()
  private loaded = new Set<string>()
  private ready: Promise<void>

  constructor() {
    this.worker = new Worker('/bergamot/translator-worker.js')
    this.worker.addEventListener('message', ({ data }: MessageEvent<{ id: number; result?: unknown; error?: { message?: string } }>) => {
      const p = this.pending.get(data.id)
      if (!p) return
      this.pending.delete(data.id)
      if (data.error !== undefined) p.reject(new Error(data.error?.message ?? String(data.error)))
      else p.accept(data.result)
    })
    this.worker.addEventListener('error', (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'worker error'))
      this.pending.clear()
    })
    this.ready = this.call('initialize', {}) as Promise<void>
  }

  private call(name: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((accept, reject) => {
      const id = ++this.serial
      this.pending.set(id, { accept, reject })
      this.worker.postMessage({ id, name, args })
    })
  }

  private async ensureModel(pair: Pair): Promise<void> {
    const key = pair.from + pair.to
    if (this.loaded.has(key)) return
    const read = async (f: FileRec | undefined): Promise<ArrayBuffer | null> => {
      if (!f) return null
      const u8 = await readFile(localName(f), { baseDir: BaseDirectory.AppData })
      // 传给 worker 的得是干净的 ArrayBuffer(postMessage 拷贝整段 buffer,偏移不为零会带上多余数据)
      return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
        ? (u8.buffer as ArrayBuffer)
        : u8.slice().buffer as ArrayBuffer
    }
    const [model, shortlist, vocab, srcvocab, trgvocab] = await Promise.all([
      read(pair.files.model), read(pair.files.lex), read(pair.files.vocab), read(pair.files.srcvocab), read(pair.files.trgvocab),
    ])
    const vocabs = vocab ? [vocab] : [srcvocab, trgvocab]
    await this.ready
    await this.call('loadTranslationModel', { from: pair.from, to: pair.to }, { model, shortlist, vocabs, qualityModel: null, config: {} })
    this.loaded.add(key)
  }

  async translate(pair: Pair, text: string): Promise<string> {
    await this.ensureModel(pair)
    const res = (await this.call('translate', {
      models: [{ from: pair.from, to: pair.to }],
      texts: [{ text, html: false, qualityScores: false }],
    })) as { target: { text: string } }[]
    return res[0]?.target.text ?? ''
  }

  terminate() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('engine unloaded'))
    this.pending.clear()
  }
}

let engine: Engine | null = null
let idleTimer = 0
let queue: Promise<unknown> = Promise.resolve()

function touch() {
  window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(unloadTranslator, IDLE_UNLOAD_MS)
}

export function unloadTranslator() {
  window.clearTimeout(idleTimer)
  engine?.terminate()
  engine = null
}

/**
 * 离线翻译一段文字。target 是 'zh' 或 'en',只支持中英互译。
 * 模型没下载会抛错,调用方去提示用户到翻译设置里下。
 */
export async function localTranslate(text: string, target: 'zh' | 'en'): Promise<string> {
  const pair = PAIRS.find((p) => p.to === target)
  if (!pair) throw new Error(`离线翻译不支持目标语言 ${target}`)
  if (localModel.status !== 'ready' && !(await checkLocalModel())) throw new Error('离线模型还没下载,去翻译设置里下载')
  // 串行:worker 一次只干一件事,排队比并发发过去更省内存
  const run = queue.then(async () => {
    engine ??= new Engine()
    touch()
    try {
      return await engine.translate(pair, text)
    } catch (e) {
      // 引擎坏了(wasm 崩了之类)就整个丢掉,下次调用重起
      unloadTranslator()
      throw e
    }
  })
  queue = run.catch(() => {})
  return run
}
