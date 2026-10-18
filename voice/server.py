"""
XGTools 语音助手的本机服务（voice 分支）。

这一版起，收音和放音都在这里做，界面只是个显示屏和遥控器：
  - 麦克风一直开着，唤醒词模型（sherpa-onnx KWS）在后台听；听到唤醒词，或者界面上点了球，就开始录
  - 录音时按能量判断说完没有（说过话之后静 0.7 秒），录完 SenseVoice 识别
  - 交给本机 Ollama 的 qwen3.5（关思考、流式）。它觉得需要查资料时会调用 web_search，
    这里抓网页搜索结果再交给它答（先说一句「我查一下」垫着）
  - 回答边写边念：第一小句一切出来先念，剩下的写完一次合成（GPT-SoVITS，模仿内置的三段参考音）
  - 念的时候再喊唤醒词 / 再点球 = 打断：立刻闭嘴开始听
所以应用缩到托盘、界面没打开，喊一声也能用。

界面通过 /events（SSE）收状态和文字，通过 /config 推设置、/listen 和 /stop 当遥控。
"""
import asyncio
import base64
import json
import os
import queue
import re
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import sherpa_onnx
import sounddevice as sd
from aiohttp import ClientSession, ClientTimeout, web

import websearch

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get('XG_VOICE_PORT', '18733'))
LOCAL = Path(os.environ.get('LOCALAPPDATA', '.'))
SV_DIR = LOCAL / 'XGCut' / 'models' / 'sensevoice'
KWS_DIR = LOCAL / 'XGTools' / 'models' / 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
KOKORO_DIR = LOCAL / 'XGTools' / 'models' / 'kokoro-multi-lang-v1_1'
OLLAMA = os.environ.get('XG_OLLAMA', 'http://127.0.0.1:11434')
GSV_DIR = Path(os.environ.get('XG_GSV_DIR', r'C:\XGCode\XGCreator\VoiceStudio\engines\gpt-sovits'))
GSV_PORT = int(os.environ.get('XG_GSV_PORT', '9881'))
GSV = f'http://127.0.0.1:{GSV_PORT}'
OUT_RATE = 32000  # 放音统一 32k（GPT-SoVITS 的原生采样率），别的引擎重采样过来

VOICE_REF_TEXT = '嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。'
VOICES = {'gentle': HERE / 'voices' / 'gentle.wav', 'sweet': HERE / 'voices' / 'sweet.wav', 'lively': HERE / 'voices' / 'lively.wav'}

# 界面推过来的设置（界面没开过时就用这些默认值）
CFG = {
    'name': 'Fairy', 'persona': '你是 {name}，夏戈的私人助手。回答要短，一到三句话。现在是 {now}。',
    'engine': 'gsv', 'voice': 'gentle', 'speed': 1.1, 'volume': 1.8, 'model': 'qwen3.5:9b',
    'wake': True, 'wakeWord': '小精灵', 'search': True,
}

THREADS = max(2, min(8, (os.cpu_count() or 4) - 2))
_asr = _tts = _kws = None
_gsv_proc: subprocess.Popen | None = None


# ───────────────────────── 模型 ─────────────────────────

def asr():
    global _asr
    if _asr is None:
        _asr = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(SV_DIR / 'model.int8.onnx'), tokens=str(SV_DIR / 'tokens.txt'), num_threads=4, use_itn=True, language='auto')
    return _asr


def transcribe(pcm: np.ndarray) -> str:
    s = asr().create_stream()
    s.accept_waveform(16000, pcm)
    asr().decode_stream(s)
    return s.result.text.strip()


def kokoro():
    global _tts
    if _tts is None:
        d = KOKORO_DIR
        _tts = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(d / 'model.onnx'), voices=str(d / 'voices.bin'), tokens=str(d / 'tokens.txt'),
                    data_dir=str(d / 'espeak-ng-data'), dict_dir=str(d / 'dict'),
                    lexicon=f"{d / 'lexicon-us-en.txt'},{d / 'lexicon-zh.txt'}"),
                num_threads=THREADS, provider='cpu'),
            rule_fsts=f"{d / 'phone-zh.fst'},{d / 'date-zh.fst'},{d / 'number-zh.fst'}", max_num_sentences=1))
    return _tts


def wake_keywords(word: str) -> str:
    """唤醒词转成 KWS 模型要的拼音 token 串（例：小精灵 → x iǎo j īng l íng @小精灵）"""
    from pypinyin import Style, pinyin
    parts = []
    for ini, fin in zip(pinyin(word, style=Style.INITIALS, strict=False), pinyin(word, style=Style.FINALS_TONE, strict=False)):
        if ini[0]:
            parts.append(ini[0])
        parts.append(fin[0])
    return ' '.join(parts) + f' @{word}'


def make_kws(word: str):
    d = KWS_DIR
    kw = d / 'xg_keywords.txt'
    kw.write_text(wake_keywords(word) + '\n', encoding='utf-8')
    return sherpa_onnx.KeywordSpotter(
        tokens=str(d / 'tokens.txt'),
        encoder=str(d / 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder=str(d / 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        joiner=str(d / 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        num_threads=2, keywords_file=str(kw), keywords_score=1.5, keywords_threshold=0.2, max_active_paths=4)


def start_gsv():
    """GPT-SoVITS 的接口服务：没在跑就起一个，用 voice/gsv_infer.yaml（预训练底模，零样本模仿参考音）"""
    global _gsv_proc
    py = GSV_DIR / '.venv' / 'Scripts' / 'python.exe'
    if not py.exists() or (_gsv_proc and _gsv_proc.poll() is None):
        return
    _gsv_proc = subprocess.Popen(
        [str(py), 'api_v2.py', '-c', str(HERE / 'gsv_infer.yaml'), '-p', str(GSV_PORT)], cwd=str(GSV_DIR),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


# ───────────────────────── 放音 ─────────────────────────

class Player:
    """往声卡里塞 32k 单声道 float32；能随时清空（打断）"""

    def __init__(self):
        self.buf = np.zeros(0, dtype=np.float32)
        self.lock = threading.Lock()
        self.stream = sd.OutputStream(samplerate=OUT_RATE, channels=1, dtype='float32', callback=self._cb, blocksize=1024)
        self.stream.start()

    def _cb(self, out, frames, _t, _s):
        with self.lock:
            n = min(frames, len(self.buf))
            out[:n, 0] = self.buf[:n]
            out[n:, 0] = 0
            self.buf = self.buf[n:]

    def push(self, pcm16: bytes, rate: int):
        a = np.frombuffer(pcm16, dtype='<i2').astype(np.float32) / 32768
        if rate != OUT_RATE and len(a):
            a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * OUT_RATE / rate)), np.arange(len(a)), a).astype(np.float32)
        a = np.clip(a * float(CFG['volume']), -1, 1)
        with self.lock:
            self.buf = np.concatenate([self.buf, a])

    def busy(self):
        with self.lock:
            return len(self.buf) > 0

    def stop(self):
        with self.lock:
            self.buf = np.zeros(0, dtype=np.float32)


# ───────────────────────── 合成 ─────────────────────────

def to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()


async def synth_stream(text: str):
    """一句话合成，边合成边吐 (采样率, 16 位 PCM)"""
    engine, voice, speed = CFG['engine'], CFG['voice'], float(CFG['speed'])
    if engine == 'kokoro':
        a = await asyncio.to_thread(lambda: kokoro().generate(text, sid=47, speed=speed))
        yield a.sample_rate, to_pcm16(np.array(a.samples, dtype=np.float32))
        return
    # GPT-SoVITS 流式模式 3（最快开口）：WAV 流，先 44 字节头，后面全是 32k 16 位 PCM
    body = {'text': text, 'text_lang': 'zh', 'ref_audio_path': str(VOICES.get(voice, VOICES['gentle'])), 'prompt_text': VOICE_REF_TEXT,
            'prompt_lang': 'zh', 'media_type': 'wav', 'streaming_mode': 3, 'speed_factor': speed, 'parallel_infer': False, 'text_split_method': 'cut5'}
    async with ClientSession(timeout=ClientTimeout(total=60)) as s:
        async with s.post(f'{GSV}/tts', json=body) as r:
            if r.status != 200:
                raise RuntimeError(f'GPT-SoVITS {r.status}: {(await r.text())[:200]}')
            head, pending = b'', b''
            async for chunk in r.content.iter_any():
                if len(head) < 44:
                    need = 44 - len(head)
                    head += chunk[:need]
                    chunk = chunk[need:]
                pending += chunk
                n = len(pending) // 2 * 2
                if n >= 3200:
                    yield 32000, pending[:n]
                    pending = pending[n:]
            if pending:
                yield 32000, pending[:len(pending) // 2 * 2]


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


def speakable(s: str) -> str:
    s = re.sub(r'[*#`>_~\[\]()|]', '', s)
    s = re.sub(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]', '', s)
    return s.strip()


# ───────────────────────── 助手本体 ─────────────────────────

WEEK = '一二三四五六日'
TOOLS = [{'type': 'function', 'function': {
    'name': 'web_search',
    'description': '上网搜索。用在：新闻、天气、价格、某人现在多少岁或最近怎样、最近发生的事、你不确定的事实。闲聊、常识、算数不要用。',
    'parameters': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': '搜索关键词，简短'}}, 'required': ['query']}}}]


class Assistant:
    def __init__(self):
        self.state = 'idle'  # idle / listening / thinking / speaking
        self.history: list[dict] = []
        self.subs: set[asyncio.Queue] = set()
        self.turn_task: asyncio.Task | None = None
        self.player: Player | None = None
        self.mic_q: queue.Queue = queue.Queue()
        self.kws = None
        self.kws_stream = None
        self.kws_word = ''
        self.rec: list[np.ndarray] = []
        self.spoke = False
        self.silent_ms = 0.0
        self.total_ms = 0.0

    # 事件广播给所有打开着的界面
    def emit(self, **ev):
        for q in list(self.subs):
            q.put_nowait(ev)

    def set_state(self, s: str):
        if self.state != s:
            self.state = s
            self.emit(type='state', state=s)

    def system_prompt(self) -> str:
        n = datetime.now()
        now = f'{n.year}年{n.month}月{n.day}日 星期{WEEK[n.weekday()]} {n.hour}点{n.minute:02d}分'
        p = CFG['persona'].replace('{name}', CFG['name']).replace('{now}', now).replace('{date}', now)
        if '{now}' not in CFG['persona'] and '{date}' not in CFG['persona']:
            p += f'\n现在是 {now}。'
        if CFG.get('search'):
            p += ('\n你可以用 web_search 上网查。问到具体某个人的年龄、生日、近况，或者天气、新闻、价格、比分、最近发生的事，'
                  '一定先调用 web_search 再回答，不要凭记忆答；查到了就以搜索结果为准，直接说结论，不要说「我查不到」。闲聊、讲笑话、常识不用查。')
        return p

    def ensure_kws(self):
        if not CFG.get('wake'):
            self.kws = self.kws_stream = None
            return
        if self.kws is None or self.kws_word != CFG['wakeWord']:
            self.kws = make_kws(CFG['wakeWord'])
            self.kws_stream = self.kws.create_stream()
            self.kws_word = CFG['wakeWord']

    # 唤醒 / 点球：打断正在说的，开始听
    def start_listening(self):
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        if self.player:
            self.player.stop()
        self.rec, self.spoke, self.silent_ms, self.total_ms = [], False, 0.0, 0.0
        self.set_state('listening')

    def stop_all(self):
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        if self.player:
            self.player.stop()
        self.set_state('idle')

    async def mic_loop(self):
        def cb(indata, _frames, _t, _s):
            self.mic_q.put(indata[:, 0].copy())
        stream = sd.InputStream(samplerate=16000, channels=1, dtype='float32', blocksize=1600, callback=cb)
        stream.start()
        while True:
            block = await asyncio.to_thread(self.mic_q.get)
            ms = len(block) / 16
            rms = float(np.sqrt(np.mean(block * block)))
            # 唤醒词：除了正在录音，其余时候都在听（说话时喊它 = 打断）
            if self.state != 'listening' and self.kws is not None:
                self.kws_stream.accept_waveform(16000, block)
                while self.kws.is_ready(self.kws_stream):
                    self.kws.decode_stream(self.kws_stream)
                if self.kws.get_result(self.kws_stream):
                    self.kws.reset_stream(self.kws_stream)
                    self.emit(type='wake', word=self.kws_word)
                    self.start_listening()
                    continue
            if self.state == 'listening':
                self.rec.append(block)
                self.total_ms += ms
                self.emit(type='level', v=min(1.0, rms * 12))
                if rms > 0.02:
                    self.spoke, self.silent_ms = True, 0.0
                elif self.spoke:
                    self.silent_ms += ms
                if (self.spoke and self.silent_ms > 700) or (not self.spoke and self.total_ms > 8000) or self.total_ms > 20000:
                    pcm = np.concatenate(self.rec) if self.rec else np.zeros(0, dtype=np.float32)
                    self.rec = []
                    if not self.spoke:
                        self.set_state('idle')
                    else:
                        self.set_state('thinking')
                        self.turn_task = asyncio.create_task(self.turn(pcm))

    async def say(self, text: str, t0: float, first_audio: list):
        clean = speakable(text)
        if not clean:
            return
        async for rate, data in synth_stream(clean):
            if not first_audio:
                first_audio.append(time.time() - t0)
                self.emit(type='latency', ms=int(first_audio[0] * 1000))
            self.player.push(data, rate)
            self.set_state('speaking')

    async def chat_stream(self, messages, use_tools: bool):
        """流式问模型：吐 ('delta', 文字) 或 ('tool', 调用列表)"""
        payload = {'model': CFG['model'], 'messages': messages, 'stream': True, 'think': False, 'keep_alive': '30m',
                   # 带工具的那一轮温度压低：要不要查得判断稳，温度高了它常常懒得查、凭记忆瞎答
                   'options': {'temperature': 0.1 if use_tools else 0.6, 'num_ctx': 4096}}
        if use_tools:
            payload['tools'] = TOOLS
        async with ClientSession(timeout=ClientTimeout(total=120)) as s:
            async with s.post(f'{OLLAMA}/api/chat', json=payload) as r:
                async for line in r.content:
                    if not line.strip():
                        continue
                    j = json.loads(line)
                    m = j.get('message', {})
                    if m.get('tool_calls'):
                        yield 'tool', m['tool_calls']
                    if m.get('content'):
                        yield 'delta', m['content']
                    if j.get('done'):
                        break

    async def turn(self, pcm: np.ndarray | None, typed: str = ''):
        t0 = time.time()
        first_audio: list = []
        try:
            text = typed or await asyncio.to_thread(transcribe, pcm)
            self.emit(type='user', text=text)
            if not text:
                self.set_state('idle')
                return
            messages = [{'role': 'system', 'content': self.system_prompt()}] + self.history[-12:] + [{'role': 'user', 'content': text}]
            self.emit(type='reply_start')
            sentences: asyncio.Queue = asyncio.Queue()

            async def speaker():
                # 第一小句一切出来就先念；剩下的写完一次合成，句子之间不断
                first_s = await sentences.get()
                if first_s is None:
                    return
                await self.say(first_s, t0, first_audio)
                rest = []
                while (s := await sentences.get()) is not None:
                    rest.append(s)
                if rest:
                    await self.say(''.join(rest), t0, first_audio)

            spk = asyncio.create_task(speaker())
            full, buf, first = '', '', True
            for _round in range(2):
                calls = None
                async for kind, val in self.chat_stream(messages, use_tools=bool(CFG.get('search')) and _round == 0):
                    if kind == 'tool':
                        calls = val
                        continue
                    full += val
                    buf += val
                    self.emit(type='delta', text=val)
                    while True:
                        sent, buf = take_sentence(buf, first)
                        if not sent:
                            break
                        first = False
                        sentences.put_nowait(sent)
                if not calls:
                    break
                # 要查资料：先说一句垫着，同时去搜
                q = (calls[0].get('function', {}).get('arguments') or {}).get('query') or text
                self.emit(type='search', query=q)
                if first:
                    sentences.put_nowait('我查一下哦。')
                    first = False
                try:
                    results = await websearch.search(q)
                except Exception as e:
                    results = []
                    self.emit(type='error', text=f'搜索失败：{e}')
                self.emit(type='search_done', n=len(results))
                messages = messages + [{'role': 'assistant', 'content': '', 'tool_calls': calls},
                                       {'role': 'tool', 'tool_name': 'web_search', 'content': websearch.as_context(results)}]
            if buf.strip():
                sentences.put_nowait(buf)
            sentences.put_nowait(None)
            await spk
            self.history += [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': full}]
            self.emit(type='reply_done', text=full, ms=int((time.time() - t0) * 1000))
            # 等念完再回到空闲
            while self.player.busy():
                await asyncio.sleep(0.05)
            self.set_state('idle')
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.emit(type='error', text=str(e))
            self.set_state('idle')


A = Assistant()


# ───────────────────────── 接口 ─────────────────────────

CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': '*'}


async def h_events(req):
    resp = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', **CORS})
    await resp.prepare(req)
    q: asyncio.Queue = asyncio.Queue()
    A.subs.add(q)
    try:
        await resp.write(f"data: {json.dumps({'type': 'hello', 'state': A.state, 'history': A.history[-20:]}, ensure_ascii=False)}\n\n".encode())
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), 15)
                await resp.write(f'data: {json.dumps(ev, ensure_ascii=False)}\n\n'.encode())
            except asyncio.TimeoutError:
                await resp.write(b': ping\n\n')
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    finally:
        A.subs.discard(q)
    return resp


async def h_config(req):
    CFG.update(await req.json())
    try:
        A.ensure_kws()
    except Exception as e:
        return web.json_response({'ok': False, 'error': f'唤醒词设置失败：{e}'}, headers=CORS)
    return web.json_response({'ok': True}, headers=CORS)


async def h_listen(_req):
    A.start_listening()
    return web.json_response({'ok': True}, headers=CORS)


async def h_ask(req):
    # 打字提问（不用麦克风）：界面以后的输入框、开发自测都走这里
    text = ((await req.json()).get('text') or '').strip()
    if text:
        A.start_listening()
        A.set_state('thinking')
        A.turn_task = asyncio.create_task(A.turn(None, text))
    return web.json_response({'ok': True}, headers=CORS)


async def h_stop(_req):
    A.stop_all()
    return web.json_response({'ok': True}, headers=CORS)


async def h_clear(_req):
    A.history = []
    return web.json_response({'ok': True}, headers=CORS)


async def h_health(_req):
    gsv = False
    try:
        async with ClientSession(timeout=ClientTimeout(total=1)) as s:
            async with s.get(f'{GSV}/docs') as r:
                gsv = r.status == 200
    except Exception:
        pass
    return web.json_response({'ok': True, 'gsv': gsv, 'wake': A.kws is not None, 'state': A.state}, headers=CORS)


async def h_options(_req):
    return web.Response(headers=CORS)


async def on_start(app):
    A.player = Player()
    A.ensure_kws()
    asyncio.create_task(A.mic_loop())

    async def warm():
        try:
            async with ClientSession() as s:
                await s.post(f'{OLLAMA}/api/generate', json={'model': CFG['model'], 'keep_alive': '30m'})
        except Exception:
            pass
        for _ in range(120):
            try:
                async for _x in synth_stream('嗯。'):
                    pass
                return
            except Exception:
                await asyncio.sleep(1)
    asyncio.create_task(warm())


async def on_stop(_app):
    if _gsv_proc and _gsv_proc.poll() is None:
        subprocess.run(['taskkill', '/F', '/T', '/PID', str(_gsv_proc.pid)], capture_output=True,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def main():
    start_gsv()
    asr()
    app = web.Application()
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    app.router.add_get('/events', h_events)
    app.router.add_get('/health', h_health)
    app.router.add_post('/config', h_config)
    app.router.add_post('/listen', h_listen)
    app.router.add_post('/stop', h_stop)
    app.router.add_post('/ask', h_ask)
    app.router.add_post('/clear', h_clear)
    app.router.add_route('OPTIONS', '/{tail:.*}', h_options)
    web.run_app(app, host='127.0.0.1', port=PORT, print=None)


if __name__ == '__main__':
    main()
