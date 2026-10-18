// 开发自测：GPT-SoVITS 零样本（拿 Qwen3 造的音色当参考）流式合成的首包延迟（不进安装包）
import fs from 'node:fs'
const REF_TEXT = '嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。'
const ref = process.argv[2] ?? 'C:/XGCode/XGTools/voice/samples/v2-gentle.wav'
const texts = ['你好呀，今天想聊点什么？', '何老师今年五十二岁啦，他可是很厉害的主持人呢。', '好呀，我帮你切到下一首。']
for (const [i, text] of texts.entries()) {
  const t0 = Date.now()
  const r = await fetch('http://127.0.0.1:9881/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, text_lang: 'zh', ref_audio_path: ref, prompt_text: REF_TEXT, prompt_lang: 'zh', media_type: 'wav', streaming_mode: Number(process.env.SM ?? 3), speed_factor: 1.1, parallel_infer: false, text_split_method: 'cut0' }),
  })
  let first = 0; const bufs = []
  let got = 0
  for await (const c of r.body) { got += c.length; if (got > 4000) first ||= Date.now() - t0; bufs.push(Buffer.from(c)) }
  fs.writeFileSync(`C:/XGCode/XGTools/voice/samples/gsv-${i}.wav`, Buffer.concat(bufs))
  console.log(r.status, text, `首包 ${first}ms 总 ${Date.now() - t0}ms 音频 ${((got - 44) / 2 / 32000).toFixed(1)}s`)
}
