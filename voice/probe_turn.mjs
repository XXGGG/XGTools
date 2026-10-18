// 开发自测：用文字代替录音跑一轮 /turn，看每一步的耗时（不进安装包）
const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const system = `你是 Fairy，夏戈的私人助手，一个温柔可爱的女生。用简体中文回答，自然、亲切。回答要短：一般一到三句话。不要列表、不要 markdown、不要表情符号。问到事实就直接答，算年龄按今天的日期算。今天是 ${date}。`
for (const text of process.argv.slice(2)) {
  const meta = { text, system, history: [], engine: 'gsv', voice: 'gentle', speed: 1.1 }
  const t0 = Date.now()
  const r = await fetch('http://127.0.0.1:18733/turn', { method: 'POST', headers: { 'X-Meta-B64': Buffer.from(JSON.stringify(meta)).toString('base64') } })
  let buf = '', reply = '', first = 0, firstText = 0, n = 0, playEnd = 0, playEndPrev = 0, gaps = 0
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
      if (ev.type === 'delta') { reply += ev.text; firstText ||= Date.now() - t0 }
      if (ev.type === 'pcm' || ev.type === 'mp3') { n++; first ||= Date.now() - t0; const sec = Buffer.from(ev.data, 'base64').length / 2 / (ev.rate || 32000); playEnd = Math.max(playEnd, Date.now() - t0) + sec * 1000; if (Date.now() - t0 > playEndPrev + 30 && playEndPrev) gaps += Date.now() - t0 - playEndPrev; playEndPrev = playEnd }
      if (ev.type === 'error') console.log('ERR', ev.text)
    }
  }
  console.log(`${text} → ${reply}\n   首字 ${firstText}ms，首句声音 ${first}ms，共 ${n} 段，总 ${Date.now() - t0}ms，播放中断累计 ${gaps}ms`)
}
