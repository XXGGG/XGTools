/**
 * 音频试听页的波形：解码 → 压成一小串峰值 → 交给画布画。
 *
 * # 为什么在前端解码
 *
 * WebView 自带的解码器（WebAudio）wav / mp3 / ogg / flac / m4a 全认，不用另外装东西。
 * 解码出来的 PCM 只拿来算峰值，算完就扔 —— 留下的只有几百个数。
 *
 * # 不能一口气全解
 *
 * 一个音效文件夹几百个文件，一进来全部解码，CPU 和内存一起顶满，界面卡死。
 * 所以：**看得见的行才去解**（行自己用 IntersectionObserver 触发），
 * 同时最多解两个，其余排队；结果按「路径 + 修改时间」缓存，文件没改过就不重解。
 */
import { convertFileSrc } from '@tauri-apps/api/core'

/** 右边列表里的一个音频（后端 audio_list_dir 给的） */
export type AudioFile = {
  name: string
  path: string
  size: number
  modified: number
  /** 相对所选文件夹的子路径。只有「含子文件夹」时才有 */
  dir?: string
}
/** 裁剪区间（秒）。只影响拖出去的那一份，原文件不动 */
export type Trim = { start: number; end: number }

export type Peaks = {
  /** 每一格的峰值，0~1，已按这个文件自己的最大值归一 */
  max: Float32Array
  /** 时长（秒） */
  duration: number
}

/** 一条波形压成多少格。画布再宽也就一千多像素，再多没意义 */
const BUCKETS = 1000
/** 同时解码几个 */
const CONCURRENCY = 2
/**
 * 超过这么大的不自动画波形。
 * 解码要把整段 PCM 摊开，一首 5 分钟的歌摊开就是上百 MB —— 音效库里偶尔混进一首
 * 背景音乐很正常，为它把内存顶上去不值。播放不受影响，只是那一行不画波形。
 */
export const MAX_AUTO_BYTES = 60 * 1024 * 1024

let decoder: OfflineAudioContext | null = null
/**
 * 解码用的离线上下文，**不开真正的音频设备**。
 * 采样率给低一点（22050）：只是算峰值和时长，用不着原样精度，内存还省一半。
 */
function ctx() {
  return (decoder ??= new OfflineAudioContext(1, 1, 22050))
}

let running = 0
const waiting: (() => void)[] = []
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function decode(path: string): Promise<Peaks | null> {
  try {
    const res = await fetch(convertFileSrc(path))
    if (!res.ok) return null
    const audio = await ctx().decodeAudioData(await res.arrayBuffer())
    const n = audio.length
    if (!n) return { max: new Float32Array(0), duration: audio.duration }

    const step = Math.max(1, Math.floor(n / BUCKETS))
    const out = new Float32Array(Math.ceil(n / step))
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c)
      for (let i = 0, b = 0; i < n; i += step, b++) {
        let m = out[b]
        const stop = Math.min(n, i + step)
        for (let j = i; j < stop; j++) {
          const v = data[j] < 0 ? -data[j] : data[j]
          if (v > m) m = v
        }
        out[b] = m
      }
    }
    /*
      按这个文件自己的最大值归一。
      音效素材音量差得很远，不归一的话轻的那些就是一条贴着中线的细线，
      根本看不出哪里有声音 —— 而找「声音从哪开始」正是看波形最主要的用处。
    */
    let peak = 0
    for (const v of out) if (v > peak) peak = v
    if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak
    return { max: out, duration: audio.duration }
  } catch {
    // 浏览器解不了的格式（aiff / wma 之类）：不画波形，别的照常
    return null
  }
}

const cache = new Map<string, Promise<Peaks | null>>()

/** 拿一个文件的波形。同一个文件没改过就只解一次 */
export function loadPeaks(path: string, modified: number, size: number): Promise<Peaks | null> {
  const key = `${path}|${modified}`
  let p = cache.get(key)
  if (!p) {
    p = size > MAX_AUTO_BYTES ? Promise.resolve(null) : slot(() => decode(path))
    cache.set(key, p)
  }
  return p
}
