/**
 * 一句话翻译。给命令面板用的:输入一段文字,回车,拿回译文。
 *
 * 引擎顺序沿用翻译页配好的那条链和兜底(见 lib/translateChain),不另开一套 ——
 * 用户在翻译页排好的优先级,面板里理所当然也该生效。
 * 目标语言按内容定:中文占三成以上就译成英文,否则译成中文;和截图翻译用的是同一条规矩。
 */
import { translateRacing } from './translateChain'

export type QuickTranslation = {
  /** 原文,用来判断「第二次回车」是不是同一句 */
  source: string
  text: string
  detected: string | null
  target: string
  engine: string
}

export async function quickTranslate(source: string): Promise<QuickTranslation> {
  const zh = (source.match(/[一-鿿]/g) || []).length / Math.max(1, source.length)
  const target = zh > 0.3 ? 'en' : 'zh'
  const r = await translateRacing(source, target)
  return { source, text: r.text.trim(), detected: r.detected, target, engine: r.engine }
}
