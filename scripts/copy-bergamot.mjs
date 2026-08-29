/*
  把 @browsermt/bergamot-translator 的 worker 三件套(胶水 js、worker js、5MB 的 wasm)
  拷到 public/bergamot/,让页面能用 new Worker('/bergamot/translator-worker.js') 起它。

  为什么不直接从 node_modules import:那个 worker 是老式 importScripts 写法,
  Vite 的 worker 打包对它无能为力;而且 wasm 要和胶水 js 同目录才找得到。
  public/bergamot/ 进 .gitignore,和 fonts 一样是生成物,predev / prebuild 时自动拷。
*/
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'node_modules/@browsermt/bergamot-translator/worker')
const dst = join(root, 'public/bergamot')
mkdirSync(dst, { recursive: true })
let copied = 0
for (const f of ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm']) {
  const a = join(src, f), b = join(dst, f)
  if (existsSync(b) && statSync(b).size === statSync(a).size) continue
  copyFileSync(a, b); copied++
}
console.log(`bergamot worker: ${copied} 个文件拷到 public/bergamot/`)
