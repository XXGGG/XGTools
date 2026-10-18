"""
XGTools 语音助手的本机服务（第一版，先看效果）。

一轮对话 = 前端把录好的声音（16k 单声道 float32）POST 到 /turn，这里依次：
  1. SenseVoice 识别成文字（模型常驻内存，一句话 0.1 秒级）
  2. 交给本机 Ollama 的 qwen3.5（关思考、流式），边出字边按句子切
  3. 每切出一句就马上合成语音发回去 —— 不等整段回答写完，第一句就能先开口
结果用一行一个 JSON 的流式响应发回前端（user / delta / audio / done）。
前端中途断开（用户插嘴打断），这里就停下不再生成。

模型：
  - SenseVoice 复用 XGCut 下好的那份（%LOCALAPPDATA%/XGCut/models/sensevoice）
  - Kokoro 本机合成（%LOCALAPPDATA%/XGTools/models/kokoro-multi-lang-v1_1）
  - 也可以选微软在线的台湾女声（edge-tts），音色更像但开口要慢 2 秒左右
"""
import asyncio
import base64
import io
import json
import os
import re
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
from aiohttp import ClientSession, web

PORT = int(os.environ.get('XG_VOICE_PORT', '18733'))
LOCAL = Path(os.environ.get('LOCALAPPDATA', '.'))
SV_DIR = LOCAL / 'XGCut' / 'models' / 'sensevoice'
KOKORO_DIR = LOCAL / 'XGTools' / 'models' / 'kokoro-multi-lang-v1_1'
OLLAMA = os.environ.get('XG_OLLAMA', 'http://127.0.0.1:11434')

_asr = None
_tts = None
TTS_LOCK = asyncio.Lock()
THREADS = max(2, min(8, (os.cpu_count() or 4) - 2))


def asr():
    global _asr
    if _asr is None:
        _asr = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(SV_DIR / 'model.int8.onnx'), tokens=str(SV_DIR / 'tokens.txt'),
            num_threads=4, use_itn=True, language='auto')
    return _asr


def kokoro():
    global _tts
    if _tts is None:
        d = KOKORO_DIR
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(d / 'model.onnx'), voices=str(d / 'voices.bin'), tokens=str(d / 'tokens.txt'),
                    data_dir=str(d / 'espeak-ng-data'), dict_dir=str(d / 'dict'),
                    lexicon=f"{d / 'lexicon-us-en.txt'},{d / 'lexicon-zh.txt'}"),
                num_threads=THREADS, provider='cpu'),
            rule_fsts=f"{d / 'phone-zh.fst'},{d / 'date-zh.fst'},{d / 'number-zh.fst'}",
            max_num_sentences=1)
        _tts = sherpa_onnx.OfflineTts(cfg)
    return _tts


def wav_bytes(samples: np.ndarray, rate: int) -> bytes:
    pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def synth(text: str, engine: str, voice: str, speed: float) -> bytes:
    if engine == 'edge':
        import edge_tts
        rate = f"{int(round((speed - 1) * 100)):+d}%"
        out = bytearray()
        async for c in edge_tts.Communicate(text, voice or 'zh-TW-HsiaoYuNeural', rate=rate).stream():
            if c['type'] == 'audio':
                out += c['data']
        return bytes(out)
    sid = int(voice) if str(voice).isdigit() else 47

    def run():
        a = kokoro().generate(text, sid=sid, speed=speed)
        return wav_bytes(np.array(a.samples, dtype=np.float32), a.sample_rate)
    # 一次只合成一句：几句同时抢 CPU 会把第一句也拖慢，而第一句开口最要紧
    async with TTS_LOCK:
        return await asyncio.to_thread(run)


def transcribe(pcm: np.ndarray) -> str:
    s = asr().create_stream()
    s.accept_waveform(16000, pcm)
    asr().decode_stream(s)
    return s.result.text.strip()


# 句子切点：句号问号感叹号换行一定切；逗号在攒够一点字之后也切，第一句越短越早开口
HARD = re.compile(r'[。！？!?；;\n]')
SOFT = re.compile(r'[，,、：:～~]')


def take_sentence(buf: str, first: bool):
    m = HARD.search(buf)
    if m:
        return buf[:m.end()], buf[m.end():]
    if len(buf) >= (2 if first else 16):
        for m in SOFT.finditer(buf):
            if m.end() >= (2 if first else 12):
                return buf[:m.end()], buf[m.end():]
    return None, buf


# 念出来之前去掉 markdown 符号和表情，免得把星号念出来
def speakable(s: str) -> str:
    s = re.sub(r'[*#`>_~\[\]()|]', '', s)
    s = re.sub(r'[\U0001F300-\U0001FAFF☀-➿]', '', s)
    return s.strip()


async def handle_turn(req: web.Request):
    q = req.query
    body = await req.read()
    try:
        meta = json.loads(base64.b64decode(req.headers.get('X-Meta-B64', '')).decode('utf-8') or '{}')
    except Exception:
        meta = {}
    resp = web.StreamResponse(headers={'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*'})
    await resp.prepare(req)

    async def send(obj):
        await resp.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))

    t0 = time.time()
    text = (meta.get('text') or '').strip()
    if not text and body:
        pcm = np.frombuffer(body, dtype=np.float32)
        text = await asyncio.to_thread(transcribe, pcm)
    await send({'type': 'user', 'text': text, 'ms': int((time.time() - t0) * 1000)})
    if not text:
        await send({'type': 'done'})
        return resp

    messages = [{'role': 'system', 'content': meta.get('system', '')}] + meta.get('history', []) + [{'role': 'user', 'content': text}]
    engine, voice, speed = meta.get('engine', 'kokoro'), meta.get('voice', ''), float(meta.get('speed', 1.0))
    payload = {
        'model': meta.get('model', 'qwen3.5:9b'), 'messages': messages, 'stream': True, 'think': False,
        'keep_alive': '30m', 'options': {'temperature': float(meta.get('temperature', 0.7)), 'num_ctx': 4096},
    }
    buf, seq, first, full = '', 0, True, ''
    tts_jobs: list[asyncio.Task] = []

    async def speak(sentence: str, n: int):
        clean = speakable(sentence)
        if not clean:
            return
        audio = await synth(clean, engine, voice, speed)
        return n, audio

    async def flush_ready(wait_all=False):
        # 按顺序把合成好的句子发出去（后面的先合成好也要等前面的）
        while tts_jobs and (wait_all or tts_jobs[0].done()):
            r = await tts_jobs.pop(0)
            if r:
                n, audio = r
                await send({'type': 'audio', 'seq': n, 'mime': 'audio/mpeg' if engine == 'edge' else 'audio/wav',
                            'data': base64.b64encode(audio).decode('ascii'), 'ms': int((time.time() - t0) * 1000)})

    try:
        async with ClientSession() as s:
            async with s.post(f'{OLLAMA}/api/chat', json=payload) as r:
                async for line in r.content:
                    if not line.strip():
                        continue
                    j = json.loads(line)
                    delta = j.get('message', {}).get('content', '')
                    if delta:
                        full += delta
                        buf += delta
                        await send({'type': 'delta', 'text': delta})
                        while True:
                            sent, buf = take_sentence(buf, first)
                            if not sent:
                                break
                            first = False
                            tts_jobs.append(asyncio.create_task(speak(sent, seq)))
                            seq += 1
                    await flush_ready()
                    if j.get('done'):
                        break
        if buf.strip():
            tts_jobs.append(asyncio.create_task(speak(buf, seq)))
        await flush_ready(wait_all=True)
        await send({'type': 'done', 'text': full, 'ms': int((time.time() - t0) * 1000)})
    except (ConnectionResetError, asyncio.CancelledError):
        # 前端断开 = 用户打断，剩下的不用做了
        for t in tts_jobs:
            t.cancel()
    return resp


async def handle_health(_req):
    return web.json_response({
        'ok': True, 'asr': (SV_DIR / 'model.int8.onnx').exists(), 'kokoro': (KOKORO_DIR / 'model.onnx').exists(),
    }, headers={'Access-Control-Allow-Origin': '*'})


async def handle_options(_req):
    return web.Response(headers={
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'})


async def warm_llm(_app):
    # 让 Ollama 先把模型载进显存（空提示词只加载不生成），第一句话就不用等 4 秒
    async def go():
        try:
            async with ClientSession() as s:
                await s.post(f'{OLLAMA}/api/generate', json={'model': os.environ.get('XG_MODEL', 'qwen3.5:9b'), 'keep_alive': '30m'})
        except Exception:
            pass
    asyncio.create_task(go())


def main():
    # 先把模型载进内存，第一次说话就不用等
    asr()
    if (KOKORO_DIR / 'model.onnx').exists():
        kokoro()
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.on_startup.append(warm_llm)
    app.router.add_get('/health', handle_health)
    app.router.add_post('/turn', handle_turn)
    app.router.add_route('OPTIONS', '/{tail:.*}', handle_options)
    web.run_app(app, host='127.0.0.1', port=PORT, print=None)


if __name__ == '__main__':
    main()
