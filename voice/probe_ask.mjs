// 开发自测：打字提问，盯着 /events 看每一步的耗时（不进安装包）
const qs = process.argv.slice(2)
const es = await fetch('http://127.0.0.1:18733/events')
const reader = es.body.getReader(); const dec = new TextDecoder()
let buf = '', t0 = 0, reply = '', marks = []
async function ask(q) {
  reply = ''; marks = []; t0 = Date.now()
  await fetch('http://127.0.0.1:18733/ask', { method: 'POST', body: JSON.stringify({ text: q }) })
}
let i = 0
await ask(qs[i])
for (;;) {
  const { value, done } = await reader.read(); if (done) break
  buf += dec.decode(value, { stream: true })
  let k
  while ((k = buf.indexOf('\n\n')) >= 0) {
    const line = buf.slice(0, k); buf = buf.slice(k + 2)
    if (!line.startsWith('data:')) continue
    const ev = JSON.parse(line.slice(5))
    const t = Date.now() - t0
    if (ev.type === 'delta') reply += ev.text
    if (['search', 'search_done', 'latency', 'error'].includes(ev.type)) marks.push(`${ev.type}@${t}ms${ev.query ? ' ' + ev.query : ''}${ev.n !== undefined ? ' n=' + ev.n : ''}${ev.text ? ' ' + ev.text : ''}`)
    if (ev.type === 'state' && ev.state === 'idle' && t > 300) {
      console.log(`${qs[i]} → ${reply}\n   ${marks.join(' | ')} | 念完 ${t}ms`)
      if (++i >= qs.length) process.exit(0)
      await ask(qs[i])
    }
  }
}
