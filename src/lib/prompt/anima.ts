/*
  中文描述 → Anima 提示词（用大模型打磨）。

  Anima（CircleStone Labs × Comfy Org 的动漫底模）同时吃 Danbooru 标签和英文自然语言，
  官方写法见 huggingface.co/circlestone-labs/Anima 的 README，要点：
  - 标签全小写、用空格不用下划线；顺序 = 质量/年代/安全 → 人数 → 角色 → 作品 → @画师 → 其他
  - 自然语言至少写两句，太短会出怪图；标签和句子可以混写
  - 画师要加 @ 前缀；权重要比 SDXL 给得重（如 (chibi:2)）
  - Aesthetic / Turbo 版别用 score_ 标签；Turbo 的负面提示词无效
  社区同类做法（Tomiigo/anima-prompt-pipeline、NeuralBooru、Civitai 上的 Anima system prompt）
  的共识是：低温度、只做「转写」不做「创作」、标签和句子都把属性绑在主语上。

  这里让模型只出「安全标签 + 人数 + 内容标签」和「英文句子」，质量前缀由程序按底模版本拼，
  免得模型乱加 score_ 或者漏掉。模型还要给一份中文回译，用户一眼能看出有没有被改意思。
*/
import { invoke } from '@tauri-apps/api/core'
import { engineMeta, loadAiConfigs, loadChain, translateChain } from '@/lib/translateChain'
import type { PromptTag } from '@/lib/prompt/promptData'

export type AnimaVariant = 'base' | 'aesthetic' | 'turbo'

/** 质量前缀：Base 用官方推荐的那串；Aesthetic / Turbo 官方说别带 score_ */
export const ANIMA_PREFIX: Record<AnimaVariant, string> = {
  base: 'masterpiece, best quality, score_7',
  aesthetic: 'masterpiece, best quality',
  turbo: 'masterpiece, best quality',
}

/** 负面提示词：Turbo 是 CFG 1，负面不起作用，给空 */
export const ANIMA_NEGATIVE: Record<AnimaVariant, string> = {
  base: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration',
  aesthetic: 'worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration',
  turbo: '',
}

export const ANIMA_SYSTEM_PROMPT = `You turn a Chinese image description into a prompt for Anima, an anime text-to-image model trained on Danbooru tags and English captions.

Your job is TRANSCRIPTION, not creative writing. The user will check your Chinese back-translation word by word; anything they did not write is a mistake.

FAITHFULNESS (most important, overrides everything below)
- Every tag and every sentence must come from words in the user's description. If you cannot point to the Chinese words a tag came from, delete that tag.
- Never add people, nationality, species, eye/hair color, hair length, body type, clothing, expression, emotion, lighting, weather, objects or actions the user did not write. "女孩" is just "1girl": not korean, not demon, no eye color.
- If the user is vague, stay vague. Do not fill gaps.
- No person unless the user wrote one. "双手靠在一起" has no subject: do NOT turn it into "a girl", "she" or "1girl". Describe only what is written (the hands). If an action implies someone ("站在雨里") but no gender is written, say "a person" / "someone" and use no 1girl / 1boy tag.
- If the user names a character, artist or series, keep it. Artist tags get an @ prefix (e.g. @wlop).

CANDIDATE TAGS
- The user message may contain a list of candidate tags from the user's tag library. They are only a spelling reference: use one ONLY when its meaning is literally in the description. Most candidates will not apply; ignore those. Never add a candidate just because it is listed.

EXACT VERBS (the model ignores weak verbs, so pick the precise one)
- 握 / 握着 / 攥 / 紧握 / 手握 = gripping, the hand closed tightly around the object ("holding x" tag + "gripping x tightly in her fist" in text). Not resting on a palm, not on a tray, not loosely held.
- 拿着 = holding (normal hold). 端着 = carrying something on a tray or flat on the palms. 捧着 = cupping with both hands. 举着 = raising it up. 抱着 = hugging it against the body.
- 蹲 = squatting (not kneeling). 跪 = kneeling. 站 = standing. 坐 = sitting. 趴 = on stomach. 躺 = lying.
- 从下往上拍 = from below. 从上往下拍 = from above. 平视 = straight-on. 背在身后 = behind back.

TAGS (one line, comma separated)
- Real Danbooru tags only, lowercase, spaces instead of underscores.
- Order: one safety tag (safe / sensitive / nsfw / explicit, judged from the content), subject count (1girl, 1boy, 2girls, 1other... only if the user wrote a person), character, series, @artist, then appearance, clothing, expression, pose and action, objects, setting, framing.
- "solo" only when there is exactly one character. Two girls = "2girls" without "solo".
- Held objects: "holding x" plus the object tag; a color the user gave goes on the object (e.g. "holding candle, red candle").
- If no real tag fits an idea, leave it out of the tags and say it in the text. Never invent tags.
- Do NOT write quality tags (masterpiece, best quality, score_*, highres). The app adds them.

TEXT (2 to 4 short English sentences)
- Same content as the tags, nothing more. Start with the subject the user wrote, then what they do. If they wrote no person, start with the thing they did describe.
- Bind every attribute to its owner ("She grips the red candle tightly in her fist"). With several characters, describe each separately and say who does what to whom.
- No quality words, no poetic filler, no mood words, no camera jargon the user did not ask for.

USER REMINDERS
- If the message contains a REMINDERS section, those are the user's standing rules. Follow them strictly; they override the defaults above.

CHECK BEFORE ANSWERING
- Re-read the user's description. Remove every tag or phrase that is not in it.

LITERAL
- The user's description translated into ONE natural English sentence, same meaning, nothing added or dropped. No subject the user did not write. This is a plain translation, not the polished TEXT.

TAGS_ZH
- The Chinese meaning of each tag, in the same order as TAGS, comma separated, one item per tag.

ZH
- A faithful Chinese translation of TEXT only (not the tags), so the user can check the polished sentences did not change the meaning.

Output JSON only, no markdown fences:
{"tags": "...", "tags_zh": "...", "literal": "...", "text": "...", "zh": "..."}

Examples
Input: 双手靠在一起
Output: {"tags": "safe, own hands together", "tags_zh": "安全, 双手合在一起", "literal": "Hands placed together.", "text": "Two hands are placed together, palms touching.", "zh": "两只手靠在一起，掌心相贴。"}

Input: 站在雨里看着远方
Output: {"tags": "safe, solo, standing, rain, looking afar", "tags_zh": "安全, 单人, 站立, 雨, 眺望远方", "literal": "Someone standing in the rain, looking into the distance.", "text": "A person stands in the rain. They look into the distance.", "zh": "一个人站在雨里，望向远方。"}

Input: 一个女孩站在石地板上手握着红色蜡烛
Output: {"tags": "safe, 1girl, solo, standing, holding candle, red candle, stone floor", "tags_zh": "安全, 1个女孩, 单人, 站立, 握着蜡烛, 红色蜡烛, 石地板", "literal": "A girl standing on a stone floor, gripping a red candle in her hand.", "text": "A girl stands on a stone floor. She grips a red candle tightly in her fist, her fingers closed around it.", "zh": "一个女孩站在石地板上。她用拳头紧紧握住一根红色蜡烛，手指包住蜡烛。"}`

/** mode：ai = 大模型按 Anima 写法整理过；plain = 没配 AI 引擎，只做了直译 */
/** literal：整句直译（不加工的一句英文）；text：按 Anima 写法打磨过的描述 */
/** tagZh：每个标签的中文（模型给的；界面里库内词优先用词库的中文） */
export interface AnimaResult { tags: string, tagZh: Record<string, string>, literal: string, text: string, zh: string, engine: string, mode: 'ai' | 'plain' }

/**
 * 选一个 AI 引擎：翻译链里排在前面、配好了 Key 的 AI 引擎优先；一个都没配就返回 null。
 * 不写死任何厂商或本机模型 —— 用户在翻译设置里配的是在线的还是本机的、配没配，都按他的来。
 */
export async function pickAiEngine() {
  const [chain, cfgs] = await Promise.all([loadChain(), loadAiConfigs()])
  const ready = (id: string) => engineMeta(id)?.kind === 'ai' && !!cfgs[id]?.api_key
  const engine = chain.find(ready) ?? Object.keys(cfgs).find(ready)
  return engine ? { engine, config: cfgs[engine] } : null
}

/** 把底层报错翻成人话：最常见的是本机模型服务没开 */
function friendlyError(e: unknown, url?: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  const local = !!url && /127\.0\.0\.1|localhost/.test(url)
  if (/请求失败/.test(msg) && local)
    return new Error(`连不上本机的模型服务（${url}），确认它已经启动`)
  return new Error(msg)
}

/** 从模型回答里抠出 JSON（小模型偶尔会包一层 ```json 或者前后多说两句） */
function parseJson(raw: string): { tags?: string, tags_zh?: string, literal?: string, text?: string, zh?: string } {
  const s = raw.replace(/```(?:json)?/g, '')
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('模型没按格式回答，再点一次试试')
  return JSON.parse(s.slice(a, b + 1))
}

/** 标签再过一遍：去下划线、全小写（score_ 例外）、去掉模型硬塞的质量词、去重 */
function cleanTags(tags: string): string {
  const QUALITY = /^(masterpiece|best quality|high quality|good quality|normal quality|highres|absurdres|score_\d.*)$/
  const seen = new Set<string>()
  const list = tags.split(',').map(t => t.trim()).filter(Boolean)
    .map(t => (/^score_/i.test(t) ? t : t.replace(/_/g, ' ').toLowerCase()))
    .filter(t => !QUALITY.test(t.toLowerCase()))
    .filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
  // 不止一个人（2girls、multiple boys、或者同时有 1girl 和 1boy）时 solo 是错的，小模型老忘，这里兜底删掉
  const people = list.filter(t => /^(\d\+?|multiple )(girls?|boys?|others?)$/.test(t))
  const many = people.some(t => !/^1(girl|boy|other)$/.test(t)) || people.length > 1
  return (many ? list.filter(t => t !== 'solo') : list).join(', ')
}

/**
 * 从本地词库里挑候选标签给模型参考：中文描述按两字一组切开，词库里中文名含这些片段的词都算候选。
 * 小模型自己想标签时爱造词（enjoying、snow mountain top）、近义词选错（蹲写成 kneeling），
 * 给它一份「中文 → 真 Danbooru 标签」的对照表，选对的概率高很多。
 */
export function pickCandidates(description: string, library: PromptTag[], max = 40): PromptTag[] {
  // 只收「整个中文名都出现在描述里」的词：描述里有「女孩」不会把「韩国女孩」「恶魔女孩」也塞给模型
  // （上一版按两字片段打分，只要沾到「女孩」「红色」就进候选，小模型就照单全收，添油加醋）
  const desc = description.replace(/\s+/g, '')
  const hits: { t: PromptTag, len: number }[] = []
  for (const t of library) {
    const names = t.label.replace(/[(（][^)）]*[)）]/g, '').split(/[/、]/).map(n => n.replace(/^\d+/, '').trim()).filter(n => n.length >= 2)
    const best = names.filter(n => desc.includes(n)).sort((x, y) => y.length - x.length)[0]
    if (best) hits.push({ t, len: best.length })
  }
  hits.sort((x, y) => y.len - x.len)
  return hits.slice(0, max).map(h => h.t)
}

export async function polishForAnima(description: string, library: PromptTag[], hintTags: string[] = [], reminders = ''): Promise<AnimaResult> {
  const picked = await pickAiEngine()
  // 没配 AI 引擎也能用：退回成普通翻译（免费 / 离线引擎），只给英文句子，不做 Anima 整理
  if (!picked) {
    const r = await translateChain(description.trim(), 'en')
    return { tags: '', tagZh: {}, literal: r.text.trim(), text: '', zh: '', engine: r.engine, mode: 'plain' }
  }
  const { engine, config } = picked
  let user = description.trim()
  const cands = pickCandidates(description, library)
  if (cands.length)
    user += `\n\nCANDIDATE TAGS (spelling reference only; use one only if its meaning is literally in the description above):\n${cands.map(c => `${c.label} = ${c.value}`).join('\n')}`
  // 用户自己的长期提醒（面板里那个「提醒」框），优先级最高
  if (reminders.trim())
    user += `\n\nREMINDERS (the user's standing rules, follow strictly):\n${reminders.trim()}`
  if (hintTags.length)
    user += `\n\nThe user also picked these tags; keep them unless they contradict the description: ${hintTags.join(', ')}`
  let raw: string
  try {
    raw = await invoke<string>('ai_complete', {
      engine,
      aiConfig: { api_key: config.api_key, api_url: config.api_url || null, model: config.model || null },
      system: ANIMA_SYSTEM_PROMPT,
      user,
    })
  }
  catch (e) {
    throw friendlyError(e, config.api_url)
  }
  const j = neuterIfUnstated(parseJson(raw), [description, hintTags.join(' '), reminders].join(' '))
  if (!j.tags && !j.text) throw new Error('模型没给出内容，再点一次试试')
  return { tags: cleanTags(j.tags ?? ''), tagZh: pairTagZh(j.tags ?? '', j.tags_zh ?? ''), literal: (j.literal ?? '').trim(), text: (j.text ?? '').trim(), zh: (j.zh ?? '').trim(), engine, mode: 'ai' }
}

/**
 * 用户没写男女，就不许冒出「一个女孩」。
 * 「双手靠在一起」「在海边奔跑」这种没写主语的描述，小模型十有八九补成 a girl / 1girl
 * （2026-10-14 用户报的）。系统提示词里讲了还是会漏，这里兜底：描述、手选标签、提醒里都没有性别字眼时，
 * 删掉 1girl / 1boy 这类人数标签，句子里的 girl / boy / she / he 换成中性说法。
 */
const GENDER_WORDS = /[女男她他娘妹姐哥弟郎]|girl|boy|woman|man\b|female|male/i
function neuterIfUnstated(j: Record<string, string>, said: string) {
  if (GENDER_WORDS.test(said)) return j
  const en = (t = '') => t
    .replace(/\b(a|the) (young |little )?(girl|boy|woman|man)\b/gi, (_m, a: string) => (a[0] === a[0].toUpperCase() ? 'A person' : 'a person'))
    .replace(/\b(girl|boy)'s\b/gi, "person's")
    .replace(/\b(She|He)\b/g, 'The person').replace(/\b(she|he)\b/g, 'the person')
    .replace(/\b(Her|His)\b/g, 'Their').replace(/\b(her|his)\b/g, 'their').replace(/\b(herself|himself)\b/g, 'themselves')
  const zh = (t = '') => t.replace(/(一个)?(年轻的|小)?(女孩|男孩|少女|少年|女生|男生|女人|男人)/g, '一个人').replace(/[她他]/g, 'TA')
  const tags = (t = '') => t.split(',').map(x => x.trim()).filter(x => x && !/^\d\+?(girls?|boys?)$|^multiple (girls|boys)$/i.test(x)).join(', ')
  return { ...j, tags: tags(j.tags), literal: en(j.literal), text: en(j.text), zh: zh(j.zh) }
}

/** 模型给的 tags 和 tags_zh 按顺序一一配对（数量对不上就只配能配的） */
function pairTagZh(tags: string, zh: string): Record<string, string> {
  const en = tags.split(',').map(t => t.trim().replace(/_/g, ' ').toLowerCase())
  const cn = zh.split(/[,，、]/).map(t => t.trim())
  const out: Record<string, string> = {}
  en.forEach((t, i) => { if (t && cn[i]) out[t] = cn[i] })
  return out
}

/** 拼成最终可以贴进 ComfyUI 的正面提示词 */
export function buildAnimaPrompt(variant: AnimaVariant, tags: string, text: string, embed = false): string {
  // embed：把英文描述用括号包起来接在标签后面，整条提示词只有一行（用户 10-11 要的另一种写法）
  if (embed && text) return [ANIMA_PREFIX[variant], tags, `(${text})`].filter(Boolean).join(', ')
  const head = [ANIMA_PREFIX[variant], tags].filter(Boolean).join(', ')
  return text ? `${head}\n\n${text}` : head
}
