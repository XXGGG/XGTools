"""
XGTools 语音助手的本机服务（voice 分支，先看效果）。

一轮对话 = 前端把录好的声音（16k 单声道 float32）POST 到 /turn，这里依次：
  1. SenseVoice 识别成文字（模型常驻内存，一句话 0.1 秒级）
  2. 交给本机 Ollama 的 qwen3.5（关思考、流式），边出字边按句子切
  3. 切出来的句子排队交给合成，合成出来的声音一小段一小段地发回去 —— 不等整句合成完就能先开口
结果用一行一个 JSON 的流式响应发回前端（user / delta / pcm / done）。
前端中途断开（用户插嘴打断），这里就停下不再生成。

声音：
  - 默认 GPT-SoVITS 零样本：拿 voices/ 里的三段参考音（Qwen3-TTS 按描述造的：温柔 / 甜美 / 活泼）模仿，
    「快速流式」模式开口约 0.5 秒。GPT-SoVITS 借用 VoiceStudio 装好的那份（路径见 GSV_DIR）
  - 备用：Kokoro 本机 CPU 合成（快但不好听）、微软在线台湾女声（慢 2 秒）
"""
import asyncio
import base64
import io
import json
import os
import re
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
from aiohttp import ClientSession, ClientTimeout, web

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get('XG_VOICE_PORT', '18733'))
LOCAL = Path(os.environ.get('LOCALAPPDATA', '.'))
SV_DIR = LOCAL / 'XGCut' / 'models' / 'sensevoice'
KOKORO_DIR = LOCAL / 'XGTools' / 'models' / 'kokoro-multi-lang-v1_1'
OLLAMA = os.environ.get('XG_OLLAMA', 'http://127.0.0.1:11434')
GSV_DIR = Path(os.environ.get('XG_GSV_DIR', r'C:\XGCode\XGCreator\VoiceStudio\engines\gpt-sovits'))
GSV_PORT = int(os.environ.get('XG_GSV_PORT', '9881'))
GSV = f'http://127.0.0.1:{GSV_PORT}'

# 三个内置音色：参考音都是同一句话
VOICE_REF_TEXT = '嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。'
VOICES = {'gentle': HERE / 'voices' / 'gentle.wav', 'sweet': HERE / 'voices' / 'sweet.wav', 'lively': HERE / 'voices' / 'lively.wav'}

_asr = None
_tts = None
THREADS = max(2, min(8, (os.cpu_count() or 4) - 2))
_gsv_proc: subprocess.Popen | None = None


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


def start_gsv():
    """GPT-SoVITS 的接口服务：没在跑就起一个，用 voice/gsv_infer.yaml（预训练底模，零样本模仿参考音）"""
    global _gsv_proc
    py = GSV_DIR / '.venv' / 'Scripts' / 'python.exe'
    if not py.exists() or (_gsv_proc and _gsv_proc.poll() is None):
        return
    _gsv_proc = subprocess.Popen(
        [str(py), 'api_v2.py', '-c', str(HERE / 'gsv_infer.yaml'), '-p', str(GSV_PORT)], cwd=str(GSV_DIR),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()


async def synth_stream(text: str, engine: str, voice: str, speed: float):
    """一句话合成成声音，边合成边往外吐：(格式, 采样率, 字节)。pcm 是 16 位单声道"""
    if engine == 'edge':
        import edge_tts
        rate = f"{int(round((speed - 1) * 100)):+d}%"
        out = bytearray()
        async for c in edge_tts.Communicate(text, voice or 'zh-TW-HsiaoYuNeural', rate=rate).stream():
            if c['type'] == 'audio':
                out += c['data']
        yield 'mp3', 0, bytes(out)
        return
    if engine == 'kokoro':
        sid = int(voice) if str(voice).isdigit() else 47
        a = await asyncio.to_thread(lambda: kokoro().generate(text, sid=sid, speed=speed))
        yield 'pcm', a.sample_rate, to_pcm16(np.array(a.samples, dtype=np.float32))
        return
    # gpt-sovits：流式模式 3（最快开口），返回的是 WAV 流：先 44 字节头，后面全是 32k 16 位 PCM
    ref = VOICES.get(voice, VOICES['gentle'])
    body = {'text': text, 'text_lang': 'zh', 'ref_audio_path': str(ref), 'prompt_text': VOICE_REF_TEXT, 'prompt_lang': 'zh',
            'media_type': 'wav', 'streaming_mode': 3, 'speed_factor': speed, 'parallel_infer': False, 'text_split_method': 'cut5'}
    async with ClientSession(timeout=ClientTimeout(total=60)) as s:
        async with s.post(f'{GSV}/tts', json=body) as r:
            if r.status != 200:
                raise RuntimeError(f'GPT-SoVITS {r.status}: {(await r.text())[:200]}')
            head = b''
            pending = b''
            async for chunk in r.content.iter_any():
                if len(head) < 44:
                    need = 44 - len(head)
                    head += chunk[:need]
                    chunk = chunk[need:]
                pending += chunk
                # 按偶数字节切，别把一个采样劈成两半
                n = len(pending) // 2 * 2
                if n >= 3200:
                    yield 'pcm', 32000, pending[:n]
                    pending = pending[n:]
            if pending:
                yield 'pcm', 32000, pending[:len(pending) // 2 * 2]


def transcribe(pcm: np.ndarray) -> str:
    s = asr().create_stream()
    s.accept_waveform(16000, pcm)
    asr().decode_stream(s)
    return s.result.text.strip()


# 句子切点：句号问号感叹号换行一定切；逗号在攒够一点字之后也切，第一句越短越早开口
HARD = re.compile(r'[。！？!?；;\n…]')
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
    s = re.sub(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]', '', s)
    return s.strip()


async def handle_turn(req: web.Request):
    body = await req.read()
    try:
        meta = json.loads(base64.b64decode(req.headers.get('X-Meta-B64', '')).decode('utf-8') or '{}')
    except Exception:
        meta = {}
    resp = web.StreamResponse(headers={'Content-Type': 'application/x-ndjson', 'Access-Control-Allow-Origin': '*'})
    await resp.prepare(req)
    wlock = asyncio.Lock()

    async def send(obj):
        async with wlock:
            await resp.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))

    t0 = time.time()
    text = (meta.get('text') or '').strip()
    if not text and body:
        text = await asyncio.to_thread(transcribe, np.frombuffer(body, dtype=np.float32))
    await send({'type': 'user', 'text': text, 'ms': int((time.time() - t0) * 1000)})
    if not text:
        await send({'type': 'done'})
        return resp

    messages = [{'role': 'system', 'content': meta.get('system', '')}] + meta.get('history', []) + [{'role': 'user', 'content': text}]
    engine, voice, speed = meta.get('engine', 'gsv'), meta.get('voice', 'gentle'), float(meta.get('speed', 1.1))
    payload = {
        'model': meta.get('model', 'qwen3.5:9b'), 'messages': messages, 'stream': True, 'think': False,
        'keep_alive': '30m', 'options': {'temperature': float(meta.get('temperature', 0.7)), 'num_ctx': 4096},
    }
    sentences: asyncio.Queue[str | None] = asyncio.Queue()

    async def say(s: str):
        clean = speakable(s)
        if not clean:
            return
        try:
            async for fmt, rate, data in synth_stream(clean, engine, voice, speed):
                await send({'type': fmt, 'rate': rate, 'data': base64.b64encode(data).decode('ascii'), 'ms': int((time.time() - t0) * 1000)})
        except Exception as e:
            await send({'type': 'error', 'text': f'合成失败：{e}'})

    async def speaker():
        # 第一小句一切出来就先念，越早开口越好；
        # 剩下的等回答写完（小模型一两秒就写完，这时第一句还在念）一次合成，
        # 每句单独发请求的话句子之间会断开好几百毫秒
        first_s = await sentences.get()
        if first_s is None:
            return
        await say(first_s)
        rest = []
        while (s := await sentences.get()) is not None:
            rest.append(s)
        if rest:
            await say(''.join(rest))

    spk = asyncio.create_task(speaker())
    buf, first, full = '', True, ''
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
                            sentences.put_nowait(sent)
                    if j.get('done'):
                        break
        if buf.strip():
            sentences.put_nowait(buf)
        sentences.put_nowait(None)
        await spk
        await send({'type': 'done', 'text': full, 'ms': int((time.time() - t0) * 1000)})
    except (ConnectionResetError, asyncio.CancelledError):
        # 前端断开 = 用户打断，剩下的不用做了
        spk.cancel()
    return resp


async def handle_health(_req):
    gsv = False
    try:
        async with ClientSession(timeout=ClientTimeout(total=1)) as s:
            async with s.get(f'{GSV}/docs') as r:
                gsv = r.status == 200
    except Exception:
        pass
    return web.json_response({
        'ok': True, 'asr': (SV_DIR / 'model.int8.onnx').exists(), 'kokoro': (KOKORO_DIR / 'model.onnx').exists(), 'gsv': gsv,
    }, headers={'Access-Control-Allow-Origin': '*'})


async def handle_options(_req):
    return web.Response(headers={
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': '*'})


async def warm(_app):
    async def go():
        # 让 Ollama 先把模型载进显存（空提示词只加载不生成），第一句话就不用等 4 秒
        try:
            async with ClientSession() as s:
                await s.post(f'{OLLAMA}/api/generate', json={'model': os.environ.get('XG_MODEL', 'qwen3.5:9b'), 'keep_alive': '30m'})
        except Exception:
            pass
        # GPT-SoVITS 起来后先念一句热身（第一次合成要多花几秒加载）
        for _ in range(120):
            try:
                async for _x in synth_stream('嗯。', 'gsv', 'gentle', 1.1):
                    pass
                return
            except Exception:
                await asyncio.sleep(1)
    asyncio.create_task(go())


async def shutdown(_app):
    if _gsv_proc and _gsv_proc.poll() is None:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(_gsv_proc.pid)], capture_output=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def main():
    start_gsv()
    asr()
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.on_startup.append(warm)
    app.on_cleanup.append(shutdown)
    app.router.add_get('/health', handle_health)
    app.router.add_post('/turn', handle_turn)
    app.router.add_route('OPTIONS', '/{tail:.*}', handle_options)
    web.run_app(app, host='127.0.0.1', port=PORT, print=None)


if __name__ == '__main__':
    main()
