/**
 * 字体库页面画样张用的字体。
 *
 * # 本机字体：按「全名」找到那一份
 *
 * 直接写 font-family: "某某" 不靠谱 —— 族名对不上时浏览器悄悄换成默认字体，
 * 用户会以为这款字就长那样（阿里巴巴普惠体那种九个字重各叫一个名字的，最容易对不上）。
 * 这里给每一族注册一个 @font-face，来源写 local("全名")：全名和 PostScript 名在系统里
 * 是唯一的，找得到就一定是那一份；找不到 load() 会报错，我们就知道这一行画不出来，
 * 而不是画错。
 *
 * 系统里找不到的（被停用的、名字特殊的），退回直接读字体文件；文件太大就放弃，
 * 那一行显示「画不出来」。
 *
 * # 缺字画成方框
 *
 * 本机字体后面都垫一个「缺字框」字体（Adobe NotDef，OFL）：这款字里没有的字画成方框，
 * 不会被悄悄换成别的字体 —— 做游戏最怕看着都有，一进游戏缺一堆字。
 *
 * # 推荐里没装的字体
 *
 * 用随应用打包的样张子集（scripts/make-font-previews.py）。子集只带了样张那些字，
 * 所以后面垫的是界面字体而不是方框：别的字「缺」是子集没带，不是字体没有。
 */
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Face, Family } from './fontTypes'

const FILES = import.meta.glob('../assets/font-preview/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const PREVIEW_URL: Record<string, string> = {}
for (const [path, url] of Object.entries(FILES)) {
  PREVIEW_URL[path.split('/').pop()!.replace('.woff2', '')] = url
}

export const NOTDEF = 'XG NotDef'
/** 超过这么大的文件不退回直接读：一个中文字体几十兆，全读进页面太重 */
const MAX_FILE = 40 * 1024 * 1024

let notdef: Promise<void> | null = null
function ensureNotdef() {
  return (notdef ??= (async () => {
    const url = PREVIEW_URL._notdef
    if (!url) return
    try {
      const f = new FontFace(NOTDEF, `url(${url})`)
      await f.load()
      document.fonts.add(f)
    } catch {
      /* 缺字框加载不了也不影响画字，只是缺的字会回落 */
    }
  })())
}

let seq = 0
const cache = new Map<string, Promise<string | null>>()

/** local() 里的名字要加引号；名字里自带的引号、反斜杠去掉 */
const q = (s: string) => `"${s.replace(/["\\]/g, '')}"`

/** 一族里拿哪一份画样张：没停用的、最接近常规字重的（后端已按这个排好序） */
export function repFace(fam: Family): Face {
  return fam.faces.find((f) => !f.disabled) ?? fam.faces[0]
}

async function loadFace(face: Face): Promise<string | null> {
  await ensureNotdef()
  const name = `xgf-${++seq}`
  const names = [face.fullName, face.postscript, face.fullNameZh].filter(Boolean)
  if (!face.disabled && names.length) {
    try {
      const f = new FontFace(name, names.map((n) => `local(${q(n)})`).join(', '))
      await f.load()
      document.fonts.add(f)
      return `"${name}", "${NOTDEF}"`
    } catch {
      /* 系统里按名字找不到，往下试直接读文件 */
    }
  }
  // .ttc 里第二份以后没法用网址指定是哪一份；太大的文件不读
  if (face.index > 0 || face.bytes > MAX_FILE) return null
  try {
    await invoke('font_allow_files', { paths: [face.path] })
    const f = new FontFace(name, `url("${convertFileSrc(face.path)}")`)
    await f.load()
    document.fonts.add(f)
    return `"${name}", "${NOTDEF}"`
  } catch {
    return null
  }
}

/** 本机某一族：返回可以直接塞进 font-family 的字符串；画不出来返回 null */
export function localFamily(fam: Family): Promise<string | null> {
  return faceFamily(repFace(fam))
}

/** 某一份字体（详情里看别的字重时用） */
export function faceFamily(face: Face): Promise<string | null> {
  const key = `${face.path}#${face.index}#${face.disabled ? 'off' : 'on'}`
  let p = cache.get(key)
  if (!p) {
    p = loadFace(face)
    cache.set(key, p)
  }
  return p
}

export const hasPreview = (id: string) => !!PREVIEW_URL[id]

/** 推荐里的字体没装时用的样张子集 */
export function previewFamily(id: string): Promise<string | null> {
  const key = `pack:${id}`
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      const url = PREVIEW_URL[id]
      if (!url) return null
      try {
        const name = `xgpv-${id}`
        const f = new FontFace(name, `url(${url})`)
        await f.load()
        document.fonts.add(f)
        return `"${name}"`
      } catch {
        return null
      }
    })()
    cache.set(key, p)
  }
  return p
}

/** 装完 / 卸完之后清掉旧的，下次重新找 */
export function forgetFaces() {
  cache.clear()
}
