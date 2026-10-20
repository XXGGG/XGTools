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
import random
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

import agent
import websearch

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get('XG_VOICE_PORT', '18733'))
LOCAL = Path(os.environ.get('LOCALAPPDATA', '.'))
SV_DIR = LOCAL / 'XGCut' / 'models' / 'sensevoice'
KWS_DIR = LOCAL / 'XGTools' / 'models' / 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
# 英文唤醒词用另一个模型（GigaSpeech 训的，只认英文），17MB，设了英文唤醒词才下
KWS_EN_DIR = LOCAL / 'XGTools' / 'models' / 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'
KWS_EN_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2'
KOKORO_DIR = LOCAL / 'XGTools' / 'models' / 'kokoro-multi-lang-v1_1'
OLLAMA = os.environ.get('XG_OLLAMA', 'http://127.0.0.1:11434')
GSV_DIR = Path(os.environ.get('XG_GSV_DIR', r'C:\XGCode\XGCreator\VoiceStudio\engines\gpt-sovits'))
GSV_PORT = int(os.environ.get('XG_GSV_PORT', '9881'))
GSV = f'http://127.0.0.1:{GSV_PORT}'
OUT_RATE = 32000  # 放音统一 32k（GPT-SoVITS 的原生采样率），别的引擎重采样过来

# 导入的语音包（GPT-SoVITS 模型 + 参考音）：每个一个文件夹，里面有 pack.json
PACKS_DIR = LOCAL / 'XGTools' / 'voicepacks'
_gsv_weights: tuple = ('', '')   # GPT-SoVITS 现在挂着的 (GPT 权重, SoVITS 权重)；空 = 底模

VOICE_REF_TEXT = '嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。'
VOICES = {'gentle': HERE / 'voices' / 'gentle.wav', 'sweet': HERE / 'voices' / 'sweet.wav', 'lively': HERE / 'voices' / 'lively.wav'}

# 界面推过来的设置（界面没开过时就用这些默认值）
CFG = {
    'name': 'Fairy', 'persona': '你是 {name}，一个私人语音助手。回答要短，一到三句话。现在是 {now}。',
    'engine': 'gsv', 'voice': 'gentle', 'speed': 1.1, 'volume': 1.8, 'model': 'qwen3.5:9b',
    'wake': True, 'wakeWord': '小精灵', 'wakeWordEn': 'HEY FAIRY', 'search': True,
    'ownerOnly': False, 'bargeIn': True, 'think': True, 'replyLang': 'zh',
    # 大模型：local = 本机 Ollama；online = OpenAI 兼容的在线接口（DeepSeek 等）
    'llm': 'local', 'apiUrl': 'https://api.deepseek.com', 'apiKey': '', 'apiModel': 'deepseek-chat',
}

THREADS = max(2, min(8, (os.cpu_count() or 4) - 2))
_asr = _tts = _kws = _spk = None

# 声纹（认主人）：3D-Speaker 的 CAM++ 中文模型，28MB，第一次录主人声音时才下
SPK_MODEL = LOCAL / 'XGTools' / 'models' / 'campplus_sv_zh-cn_16k.onnx'
SPK_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
OWNER_FILE = LOCAL / 'XGTools' / 'owner_voice.npy'
OWNER: np.ndarray | None = np.load(OWNER_FILE) if OWNER_FILE.exists() else None
# 实测（同一个人不同录音 0.48~0.66，主人和助手自己的声音 0.02~0.15）：0.35 以上算主人；
# 打断时麦克风里混着它自己的声音，分数会被拉低一些，放宽到 0.3
OWNER_MIN = 0.35
BARGE_MIN = 0.3
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


def spk():
    global _spk
    if _spk is None:
        _spk = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(SPK_MODEL), num_threads=2))
    return _spk


def voiced(pcm: np.ndarray) -> np.ndarray:
    """只留有声音的部分（按 0.1 秒一段看响度），静音会把声纹拉偏"""
    if len(pcm) < 1600:
        return pcm
    seg = pcm[:len(pcm) // 1600 * 1600].reshape(-1, 1600)
    rms = np.sqrt((seg * seg).mean(1))
    keep = seg[rms > max(0.012, float(np.percentile(rms, 30)))]
    return keep.reshape(-1) if len(keep) else pcm


def embed(pcm: np.ndarray) -> np.ndarray | None:
    if not SPK_MODEL.exists() or len(pcm) < 8000:
        return None
    st = spk().create_stream()
    st.accept_waveform(16000, pcm)
    st.input_finished()
    if not spk().is_ready(st):
        return None
    e = np.array(spk().compute(st), dtype=np.float32)
    n = np.linalg.norm(e)
    return e / n if n else None


def owner_score(pcm: np.ndarray) -> float | None:
    """和主人声纹有多像（-1~1）；没录过主人 / 声音太短就是 None"""
    if OWNER is None:
        return None
    e = embed(voiced(pcm))
    return None if e is None else float(e @ OWNER)


_SELF: dict[str, np.ndarray] = {}


def self_score(pcm: np.ndarray) -> float | None:
    """和它自己现在用的音色有多像：它说话时念到自己的名字，别把自己叫醒、把自己打断"""
    ref = Path(voice_ref(CFG.get('voice', 'gentle'))['wav'])
    if not ref.exists() or not SPK_MODEL.exists():
        return None
    if CFG['voice'] not in _SELF:
        import wave
        with wave.open(str(ref)) as w:
            a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768
            sr = w.getframerate()
        if sr != 16000:
            a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)), np.arange(len(a)), a).astype(np.float32)
        e = embed(voiced(a))
        if e is None:
            return None
        _SELF[CFG['voice']] = e
    e = embed(voiced(pcm))
    return None if e is None else float(e @ _SELF[CFG['voice']])


PUNCT = ' \t,，。.!！?？~～、:：;；"“”\'‘’'


def strip_wake(text: str, wake: str) -> str:
    """把识别结果开头的唤醒词去掉（读音像就算，不要求字一模一样）"""
    t = text.lstrip(PUNCT)
    if re.search(r'[A-Za-z]', wake):
        # 英文：开头几个词和唤醒词逐个比，首字母一样、或者很像（hey / hi / hay，fairy / friry / ferry）就算
        ws = wake.lower().split()
        m = re.match(r'^((?:[A-Za-z]+[\s,，.。!！]*){%d})' % len(ws), t)
        if m:
            got = re.findall(r'[A-Za-z]+', m.group(1).lower())
            if all(g[0] == w[0] or (w in ('hey', 'hi', 'hello') and g in ('hey', 'hi', 'hello', 'hay', 'a', 'eh')) for g, w in zip(got, ws)):
                return t[m.end():].lstrip(PUNCT)
        # 也可能被听成中文的「嘿」「嗨」开头
        t2 = re.sub(r'^(嘿|嗨|黑|海|害)[\s,，]*', '', t)
        if t2 != t:
            m = re.match(r'^[A-Za-z]+', t2)
            return t2[m.end():].lstrip(PUNCT) if m else t2
        return t
    # 中文：拿开头同样多个字的拼音（不带声调）和唤醒词比，最多错一个字
    from pypinyin import lazy_pinyin
    n = len(wake)
    want = lazy_pinyin(wake)
    got = lazy_pinyin(t[:n])
    if len(got) == n and sum(a != b for a, b in zip(got, want)) <= 1:
        return t[n:].lstrip(PUNCT)
    return t


def is_owner(pcm: np.ndarray) -> bool:
    """开了「只听主人的」才把关；没录过主人或判不出来就放行"""
    if not CFG.get('ownerOnly') or OWNER is None:
        return True
    sc = owner_score(pcm)
    return sc is None or sc >= OWNER_MIN


ACKS = {'zh': ['嗯？', '怎么啦？', '我在！', '在呢。', '你说~'],
        'en': ['Hmm?', 'Yes?', "I'm here!", "What's up?"]}
_ACK_CACHE: dict[tuple, list] = {}   # (语言, 音色, 句子) → [(采样率, pcm)]


async def ack_audio(lang: str) -> list | None:
    """随机挑一句回应，第一次用到时合成并缓存"""
    phrase = random.choice(ACKS.get(lang, ACKS['zh']))
    key = (lang, CFG.get('engine'), CFG.get('voice'), CFG.get('speed'), phrase)
    if key not in _ACK_CACHE:
        try:
            _ACK_CACHE[key] = [x async for x in synth_stream(phrase)]
        except Exception:  # noqa: BLE001
            return None
    return _ACK_CACHE[key]


async def warm_acks():
    for lang in ('zh', 'en'):
        for phrase in ACKS[lang]:
            key = (lang, CFG.get('engine'), CFG.get('voice'), CFG.get('speed'), phrase)
            if key not in _ACK_CACHE:
                try:
                    _ACK_CACHE[key] = [x async for x in synth_stream(phrase)]
                except Exception:  # noqa: BLE001
                    return


VOLUME = {'level': 1.0, 'muted': False}


def volume_watch():
    """后台线程：每 2 秒看一次系统主音量（pycaw 走 COM，要在自己的线程里初始化）"""
    try:
        import comtypes
        from pycaw.pycaw import AudioUtilities
        comtypes.CoInitialize()
    except Exception:  # noqa: BLE001
        return
    while True:
        try:
            ep = AudioUtilities.GetSpeakers().EndpointVolume
            VOLUME['level'] = float(ep.GetMasterVolumeLevelScalar())
            VOLUME['muted'] = bool(ep.GetMute())
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)


def too_quiet() -> bool:
    return VOLUME['muted'] or VOLUME['level'] < 0.04


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
    # :2.0 是加分、#0.12 是这个词自己的触发阈值（比全局的 0.2 松一点）
    return ' '.join(parts) + f' :2.0 #0.12 @{word}'


def make_kws(word: str, en: bool = False):
    d = KWS_EN_DIR if en else KWS_DIR
    kw = d / 'xg_keywords.txt'
    if en:
        # 英文按 BPE 切成模型认得的片段（▁HE Y ▁FA IR Y），同样加点分、放宽一点阈值
        from sherpa_onnx import text2token
        toks = text2token([word.upper()], tokens=str(d / 'tokens.txt'), tokens_type='bpe', bpe_model=str(d / 'bpe.model'))[0]
        # @ 后面是这个词的名字，里面不能有空格（有空格 sherpa-onnx 会把后半截当成 token，直接把整个进程退掉）
        kw.write_text(' '.join(toks) + f" :2.0 #0.12 @{word.upper().replace(' ', '_')}\n", encoding='utf-8')
    else:
        kw.write_text(wake_keywords(word) + '\n', encoding='utf-8')
    return sherpa_onnx.KeywordSpotter(
        tokens=str(d / 'tokens.txt'),
        encoder=str(d / 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        decoder=str(d / 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        joiner=str(d / 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
        num_threads=2, keywords_file=str(kw), keywords_score=1.5, keywords_threshold=0.2, max_active_paths=4)


def download_kws_en() -> str:
    """英文唤醒词模型没有就下下来解开（只留 int8 的那套）；失败返回原因"""
    if (KWS_EN_DIR / 'tokens.txt').exists():
        return ''
    import tarfile
    import urllib.request
    KWS_EN_DIR.parent.mkdir(parents=True, exist_ok=True)
    tmp = KWS_EN_DIR.parent / 'kws-en.tar.bz2'
    try:
        urllib.request.urlretrieve(KWS_EN_URL, tmp)
        with tarfile.open(tmp) as t:
            t.extractall(KWS_EN_DIR.parent, filter='data')
        for f in KWS_EN_DIR.glob('*-64.onnx'):
            f.unlink()
        return ''
    except Exception as e:  # noqa: BLE001
        return f'下载英文唤醒词模型失败：{e}'
    finally:
        tmp.unlink(missing_ok=True)


def start_gsv():
    """GPT-SoVITS 的接口服务：没在跑就起一个，用 voice/gsv_infer.yaml（预训练底模，零样本模仿参考音）"""
    global _gsv_proc
    py = GSV_DIR / '.venv' / 'Scripts' / 'python.exe'
    if not py.exists() or (_gsv_proc and _gsv_proc.poll() is None):
        return
    # GPT-SoVITS 启动时会把配置文件改写一遍：拷一份到 %LOCALAPPDATA% 再给它，别让它改仓库里的模板
    cfg = LOCAL / 'XGTools' / 'gsv_infer.yaml'
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text((HERE / 'gsv_infer.yaml').read_text(encoding='utf-8'), encoding='utf-8')
    _gsv_proc = subprocess.Popen(
        [str(py), 'api_v2.py', '-c', str(cfg), '-p', str(GSV_PORT)], cwd=str(GSV_DIR),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def load_packs() -> dict[str, dict]:
    out = {}
    if PACKS_DIR.exists():
        for d in sorted(PACKS_DIR.iterdir()):
            f = d / 'pack.json'
            if f.exists():
                try:
                    m = json.loads(f.read_text(encoding='utf-8'))
                    m['dir'] = d
                    out[f'pack:{d.name}'] = m
                except ValueError:
                    pass
    return out


def voice_ref(voice: str) -> dict:
    """音色 → 参考音、参考文字、语言、（语音包才有的）GPT-SoVITS 权重"""
    if voice.startswith('pack:'):
        m = load_packs().get(voice)
        if m:
            d = m['dir']
            return {'wav': str(d / m['ref_audio']), 'text': m.get('ref_text', ''), 'lang': m.get('ref_lang', 'zh'),
                    'gpt': str(d / m['gpt']) if m.get('gpt') else '', 'sovits': str(d / m['sovits']) if m.get('sovits') else ''}
    return {'wav': str(VOICES.get(voice, VOICES['gentle'])), 'text': VOICE_REF_TEXT, 'lang': 'zh', 'gpt': '', 'sovits': ''}


def import_pack(src: str) -> dict:
    """把一个语音包文件夹拷进来：认 .ckpt（GPT）、.pth（SoVITS）、参考音 .wav 和 ref.txt"""
    import shutil
    sp = Path(src)
    if not sp.is_dir():
        raise ValueError('要选一个文件夹')
    wavs = sorted(sp.glob('*.wav')) + sorted(sp.glob('*.mp3'))
    if not wavs:
        raise ValueError('文件夹里没有参考音（.wav）')
    ckpt = next(iter(sorted(sp.glob('*.ckpt'))), None)
    pth = next(iter(sorted(sp.glob('*.pth'))), None)
    ref, text, lang = wavs[0], '', 'zh'
    rt = sp / 'ref.txt'
    if rt.exists():
        lines = [x.strip() for x in rt.read_text(encoding='utf-8', errors='ignore').splitlines()]
        if lines and (sp / lines[0]).exists():
            ref = sp / lines[0]
        text = lines[1] if len(lines) > 1 else ''
        lang = lines[2] if len(lines) > 2 and lines[2] else 'zh'
    if not text:
        # 没给文字：社区包常把文字写在文件名里（「情绪-这句话说的是什么.wav」）
        text = ref.stem.split('-', 1)[-1].strip()
    name = sp.name
    dst = PACKS_DIR / name
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    for f in [ref, ckpt, pth]:
        if f:
            shutil.copy2(f, dst / f.name)
    meta = {'name': name, 'ref_audio': ref.name, 'ref_text': text, 'ref_lang': lang,
            'gpt': ckpt.name if ckpt else '', 'sovits': pth.name if pth else ''}
    (dst / 'pack.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    return {'id': f'pack:{name}', 'name': name}


# ───────────────────────── 放音 ─────────────────────────

class Player:
    """往声卡里塞 32k 单声道 float32；能随时清空（打断）"""

    def __init__(self):
        self.buf = np.zeros(0, dtype=np.float32)
        self.lock = threading.Lock()
        self.level = 0.0  # 正在放的声音有多响（0~1），界面拿去让球跟着说话起伏
        self.stream = sd.OutputStream(samplerate=OUT_RATE, channels=1, dtype='float32', callback=self._cb, blocksize=1024)
        self.stream.start()

    def _cb(self, out, frames, _t, _s):
        with self.lock:
            n = min(frames, len(self.buf))
            out[:n, 0] = self.buf[:n]
            out[n:, 0] = 0
            self.buf = self.buf[n:]
        self.level = min(1.0, float(np.sqrt(np.mean(out[:, 0] * out[:, 0]))) * 4)

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

def yaml_default_weights() -> tuple[str, str]:
    """gsv_infer.yaml 里 custom 那组的底模权重（换回内置音色时用）"""
    t = (HERE / 'gsv_infer.yaml').read_text(encoding='utf-8')
    blk = t.split('custom:', 1)[-1]
    g = re.search(r't2s_weights_path:\s*(\S+)', blk)
    v = re.search(r'vits_weights_path:\s*(\S+)', blk)
    return (g.group(1) if g else '', v.group(1) if v else '')


def to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()


async def synth_stream(text: str):
    """一句话合成，边合成边吐 (采样率, 16 位 PCM)"""
    engine, voice, speed = CFG['engine'], CFG['voice'], float(CFG['speed'])
    if engine == 'kokoro':
        a = await asyncio.to_thread(lambda: kokoro().generate(text, sid=47, speed=speed))
        yield a.sample_rate, to_pcm16(np.array(a.samples, dtype=np.float32))
        return
    ref = voice_ref(voice)
    # 语音包带了自己的 GPT-SoVITS 权重：先换上（底模音色就换回底模）
    global _gsv_weights
    want = (ref['gpt'], ref['sovits'])
    if want != _gsv_weights:
        cfgp = yaml_default_weights()
        async with ClientSession(timeout=ClientTimeout(total=120)) as s:
            await s.get(f'{GSV}/set_gpt_weights', params={'weights_path': want[0] or cfgp[0]})
            await s.get(f'{GSV}/set_sovits_weights', params={'weights_path': want[1] or cfgp[1]})
        _gsv_weights = want
    # GPT-SoVITS 流式模式 3（最快开口）：WAV 流，先 44 字节头，后面全是 32k 16 位 PCM
    # 读音偶尔不对（「面条」念成「面交」）是 GPT-SoVITS 采样的随机性：同一句每次念都不一样，偶尔抽到错的音。
    # 把采样收紧（温度、top_k 调低）、随机种子固定，同一句话每次念出来都一样；纯中文按中文处理，有英文单词才用中英混合模式（混合模式分词更容易出错）
    lang = 'auto' if re.search(r'[A-Za-z]{2,}', text) else 'zh'
    body = {'text': text, 'text_lang': lang, 'ref_audio_path': ref['wav'], 'prompt_text': ref['text'],
            'prompt_lang': ref['lang'], 'media_type': 'wav', 'streaming_mode': 3, 'speed_factor': speed, 'parallel_infer': False, 'text_split_method': 'cut5',
            'top_k': 5, 'top_p': 0.8, 'temperature': 0.6, 'repetition_penalty': 1.35, 'seed': 42}
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


# 让它退下的话：说了就回待命，不再接着聊
DISMISS = re.compile(r'^(好了|好的|行了|嗯)?[，, ]*(退下|退下吧|没事了?|没事儿|没啥事|不用了|去吧|走吧|你走吧|休息吧|去休息|拜拜|再见|再会|就这样吧?|先这样吧?|闭嘴|安静)[吧了啦哦]*[，, ]*(谢谢你?|谢啦)?[。！!.~～]*$')


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


class Assistant:
    def __init__(self):
        self.state = 'idle'  # idle / listening / thinking / speaking
        # 游戏模式：全屏玩游戏时整个助手歇着（不听唤醒词、不录音、不回话），界面那边按前台程序开关它
        self.paused = False
        self.history: list[dict] = []
        self.subs: set[asyncio.Queue] = set()
        self.turn_task: asyncio.Task | None = None
        self.player: Player | None = None
        self.mic_q: queue.Queue = queue.Queue()
        self.kws = None
        self.kws_stream = None
        self.kws_word = ''
        self.kws_en = None
        self.kws_en_stream = None
        self.kws_en_word = ''
        self.rec: list[np.ndarray] = []
        self.spoke = False
        self.silent_ms = 0.0
        self.total_ms = 0.0
        # 连续对话：叫醒 / 点球之后一直接着听，10 秒没人说话或者让它退下才回待命
        self.convo = False
        self.wait_ms = 8000.0
        self.ring: list[np.ndarray] = []      # 最近 2 秒的麦克风，判唤醒 / 打断是不是主人
        self.enroll: list[np.ndarray] | None = None  # 正在录主人声音时收在这里
        self.barge_ms = 0.0                   # 它说话时你持续出声多久了
        self.saying = ''                      # 正在念的这段（判断是不是自己念到了自己的名字）
        # 喊了唤醒词之后：先等一小会儿看你是不是接着就说事（「小精灵，现在几点了」）；
        # 没接着说就回一声「嗯？」再听。ack_wait > 0 = 还在等；ack_mute_until = 回应声放完之前别录（会录进它自己的声音）
        self.ack_wait = 0.0
        self.ack_mute_until = 0.0
        self.woke_with = ''

    # 事件广播给所有打开着的界面
    def emit(self, **ev):
        for q in list(self.subs):
            q.put_nowait(ev)

    def set_state(self, s: str):
        if self.state != s:
            self.state = s
            self.emit(type='state', state=s)

    def system_prompt(self) -> str:
        return agent.system_prompt(CFG)

    def ensure_kws(self):
        if not CFG.get('wake'):
            self.kws = self.kws_stream = None
            self.kws_en = self.kws_en_stream = None
            return
        if CFG.get('wakeWord') and (self.kws is None or self.kws_word != CFG['wakeWord']):
            self.kws = make_kws(CFG['wakeWord'])
            self.kws_stream = self.kws.create_stream()
            self.kws_word = CFG['wakeWord']
        en = (CFG.get('wakeWordEn') or '').strip().upper()
        if not en:
            self.kws_en = self.kws_en_stream = None
        elif (KWS_EN_DIR / 'tokens.txt').exists() and (self.kws_en is None or self.kws_en_word != en):
            self.kws_en = make_kws(en, en=True)
            self.kws_en_stream = self.kws_en.create_stream()
            self.kws_en_word = en

    # 唤醒 / 点球：打断正在说的，开始听
    def start_listening(self, follow_up: bool = False):
        if not follow_up:
            if self.turn_task and not self.turn_task.done():
                self.turn_task.cancel()
            if self.player:
                self.player.stop()
        self.convo = True
        self.ack_wait, self.ack_mute_until, self.woke_with = 0.0, 0.0, ''   # 唤醒词那条路径会在之后再设
        # 第一次叫它给 8 秒开口；回完话接着听的那一段，10 秒没人说话就回待命
        self.wait_ms = 10000.0 if follow_up else 8000.0
        self.rec, self.spoke, self.silent_ms, self.total_ms = [], False, 0.0, 0.0
        self.set_state('listening')

    def stop_all(self):
        self.convo = False
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
            self.ring.append(block)
            if len(self.ring) > 20:
                self.ring.pop(0)
            if self.enroll is not None:
                self.enroll.append(block)
                self.emit(type='level', v=min(1.0, rms * 12))
                continue
            if self.paused:
                continue
            # 打断：它在说话 / 念的时候你开口，比对是主人就停下来听你说（它自己的声音不像主人，不会把自己打断）
            if self.state == 'speaking' and CFG.get('bargeIn') and OWNER is not None:
                self.barge_ms = self.barge_ms + ms if rms > 0.03 else max(0.0, self.barge_ms - ms)
                if self.barge_ms >= 400:
                    self.barge_ms = 0.0
                    tail = np.concatenate(self.ring[-8:])
                    sc = await asyncio.to_thread(owner_score, tail)
                    if sc is not None and sc >= BARGE_MIN:
                        self.emit(type='barge', score=round(sc, 2))
                        self.start_listening()
                        self.rec, self.spoke = [tail], True
                        continue
            # 唤醒词：除了正在录音，其余时候都在听（说话时喊它 = 打断）
            heard = ''
            if self.state != 'listening':
                for kws, st, word in ((self.kws, self.kws_stream, self.kws_word), (self.kws_en, self.kws_en_stream, self.kws_en_word)):
                    if kws is None:
                        continue
                    st.accept_waveform(16000, block)
                    while kws.is_ready(st):
                        kws.decode_stream(st)
                    if kws.get_result(st):
                        kws.reset_stream(st)
                        heard = word
            if heard:
                if True:
                    tail = np.concatenate(self.ring[-15:])
                    print(f'[wake] 听到唤醒词 {heard}', flush=True)
                    if too_quiet():
                        print('[wake] 系统音量太小 / 静音，不响应', flush=True)
                        self.emit(type='too_quiet')
                        continue
                    # 它自己正在说话、说到了自己的名字：听着像它自己的声音就当没听见
                    if self.state == 'speaking':
                        sc = await asyncio.to_thread(self_score, tail)
                        # 没有声纹模型判不了声音：它正在念的这段里就有自己的名字，也当没听见
                        if (sc is not None and sc > 0.4) or (sc is None and heard.lower() in self.saying.lower()):
                            continue
                    if not await asyncio.to_thread(is_owner, tail):
                        print(f'[wake] 不像主人的声音（{owner_score(tail)}），不响应', flush=True)
                        self.emit(type='not_owner')
                        continue
                    self.emit(type='wake', word=heard)
                    self.start_listening()
                    self.woke_with = heard
                    self.rec, self.spoke = list(self.ring[-15:]), True
                    continue
            if self.state == 'listening':
                if time.time() < self.ack_mute_until or (self.ack_mute_until and self.player.busy()):
                    continue                     # 回应声还在放
                if self.ack_mute_until and not self.player.busy():
                    self.ack_mute_until = 0.0
                    self.rec, self.spoke, self.silent_ms, self.total_ms = [], False, 0.0, 0.0
                if self.ack_wait > 0:
                    if rms > 0.02 and self.ack_wait < 400:
                        self.ack_wait = 0.0      # 喊完名字接着就说事了：不回应，直接听
                    else:
                        self.ack_wait -= ms
                        if self.ack_wait <= 0:   # 喊完就停了：回一声，再接着听
                            self.ack_wait = 0.0
                            pcm_ack = await ack_audio(CFG.get('replyLang', 'zh'))
                            if pcm_ack:
                                for rate, data in pcm_ack:
                                    self.player.push(data, rate)
                                self.ack_mute_until = time.time() + 0.3
                                self.emit(type='ack')
                            continue
                self.rec.append(block)
                self.total_ms += ms
                self.emit(type='level', v=min(1.0, rms * 12))
                if rms > 0.02:
                    self.spoke, self.silent_ms = True, 0.0
                elif self.spoke:
                    self.silent_ms += ms
                if (self.spoke and self.silent_ms > 700) or (not self.spoke and self.total_ms > self.wait_ms) or self.total_ms > 20000:
                    pcm = np.concatenate(self.rec) if self.rec else np.zeros(0, dtype=np.float32)
                    self.rec = []
                    if not self.spoke:
                        self.convo = False
                        self.set_state('idle')
                    else:
                        self.set_state('thinking')
                        self.turn_task = asyncio.create_task(self.turn(pcm))

    async def say(self, text: str, t0: float, first_audio: list):
        clean = speakable(text)
        if not clean:
            return
        self.saying = clean
        async for rate, data in synth_stream(clean):
            if not first_audio:
                first_audio.append(time.time() - t0)
                self.emit(type='latency', ms=int(first_audio[0] * 1000))
            self.player.push(data, rate)
            self.set_state('speaking')

    async def chat_stream(self, messages, use_tools: bool):
        """流式问模型：吐 ('delta', 文字) 或 ('tool', [{'id', 'name', 'args'}])"""
        if CFG.get('llm') == 'online':
            async for x in self.chat_stream_online(messages, use_tools):
                yield x
            return
        async for x in self.chat_stream_local(messages, use_tools):
            yield x

    async def chat_stream_online(self, messages, use_tools: bool):
        url = (CFG.get('apiUrl') or '').rstrip('/')
        if not url.endswith('/chat/completions'):
            url += '/chat/completions'
        body = {'model': CFG.get('apiModel') or 'deepseek-chat', 'messages': messages, 'stream': True,
                'temperature': 0.1 if use_tools else 0.6}
        if use_tools:
            body['tools'] = agent.tools_for(CFG)
        calls: dict[int, dict] = {}
        async with ClientSession(timeout=ClientTimeout(total=180, sock_read=40)) as s:
            async with s.post(url, json=body, headers={'Authorization': f"Bearer {CFG.get('apiKey', '')}"}) as r:
                if r.status != 200:
                    raise RuntimeError(f'在线模型出错（HTTP {r.status}）：{(await r.text())[:200]}')
                async for raw in r.content:
                    line = raw.decode('utf-8', 'ignore').strip()
                    if not line.startswith('data:'):
                        continue
                    data = line[5:].strip()
                    if data == '[DONE]':
                        break
                    d = (json.loads(data).get('choices') or [{}])[0].get('delta', {})
                    if d.get('content'):
                        yield 'delta', d['content']
                    for tc in d.get('tool_calls') or []:
                        c = calls.setdefault(tc.get('index', 0), {'id': '', 'name': '', 'arguments': ''})
                        c['id'] = tc.get('id') or c['id']
                        fn = tc.get('function') or {}
                        c['name'] += fn.get('name') or ''
                        c['arguments'] += fn.get('arguments') or ''
        if calls:
            out = []
            for i, c in sorted(calls.items()):
                try:
                    args = json.loads(c['arguments'] or '{}')
                except ValueError:
                    args = {}
                out.append({'id': c['id'] or f'call_{i}', 'name': c['name'], 'args': args})
            yield 'tool', out

    async def chat_stream_local(self, messages, use_tools: bool):
        # 先想一想再回答：实测 9B 模型开了思考只多一两秒，但该算的会去算、该查的会去查（不开就常常心算出错、凭印象答）
        payload = {'model': CFG['model'], 'messages': messages, 'stream': True, 'think': bool(CFG.get('think', True)), 'keep_alive': '30m',
                   # 带工具的那一轮温度压低：要不要查得判断稳，温度高了它常常懒得查、凭记忆瞎答
                   'options': {'temperature': 0.1 if use_tools else 0.6, 'num_ctx': 8192}}
        if use_tools:
            payload['tools'] = agent.tools_for(CFG)
        async with ClientSession(timeout=ClientTimeout(total=180, sock_read=40)) as s:
            async with s.post(f'{OLLAMA}/api/chat', json=payload) as r:
                async for line in r.content:
                    if not line.strip():
                        continue
                    j = json.loads(line)
                    m = j.get('message', {})
                    if m.get('tool_calls'):
                        yield 'tool', [{'id': f'call_{k}', 'name': c.get('function', {}).get('name', ''),
                                        'args': c.get('function', {}).get('arguments') or {}} for k, c in enumerate(m['tool_calls'])]
                    if m.get('content'):
                        yield 'delta', m['content']
                    if j.get('done'):
                        break

    async def turn(self, pcm: np.ndarray | None, typed: str = ''):
        t0 = time.time()
        first_audio: list = []
        try:
            if not typed and pcm is not None and not await asyncio.to_thread(is_owner, pcm):
                self.emit(type='not_owner')
                if self.convo:
                    self.start_listening(follow_up=True)
                else:
                    self.set_state('idle')
                return
            text = typed or await asyncio.to_thread(transcribe, pcm)
            woke = self.woke_with
            if woke and not typed:
                text = strip_wake(text, woke)
            self.woke_with = ''
            if not re.sub(r'[\W_]+', '', text):  # 只识别出个标点（杂音、它自己说话的尾音）当作没说话
                text = ''
            if woke and not text and not typed:
                self.emit(type='user', text='')
                pcm_ack = await ack_audio(CFG.get('replyLang', 'zh'))
                self.start_listening(follow_up=True)
                if pcm_ack:
                    for rate, data in pcm_ack:
                        self.player.push(data, rate)
                    self.ack_mute_until = time.time() + 0.3
                    self.emit(type='ack')
                return
            self.emit(type='user', text=text)
            if not text:
                if self.convo and not typed:
                    self.start_listening(follow_up=True)
                else:
                    self.set_state('idle')
                return
            if DISMISS.match(text.strip()):
                self.convo = False
                self.set_state('speaking')
                await self.say('好，有事再叫我。', t0, first_audio)
                while self.player.busy():
                    await asyncio.sleep(0.05)
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
            # 像通用智能体那样：模型自己决定要不要用工具、用几次（搜 → 打开网页看 → 计算 ……），
            # 每轮把工具结果喂回去，直到它直接给出回答；最多 5 轮，最后一轮不给工具，逼它收尾
            for _round in range(7):
                calls = None
                # 最后一轮不给工具逼它收尾；用过工具却什么都没说（偶尔会这样），也再给一轮不带工具的
                async for kind, val in self.chat_stream(messages, use_tools=_round < 5):
                    if kind == 'tool':
                        calls = (calls or []) + val
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
                    if full.strip() or _round == 0 or _round >= 5:
                        break
                    messages = messages + [{'role': 'user', 'content': '（根据上面工具给的结果，直接回答我刚才的问题。）'}]
                    continue
                # 第一次用工具先说一句垫着，免得干等
                if first:
                    sentences.put_nowait('我查一下哦。' if any(c['name'] != 'calculate' for c in calls) else '我算一下。')
                    first = False
                online = CFG.get('llm') == 'online'
                results = []
                for c in calls:
                    name, args = c['name'], c['args'] if isinstance(c['args'], dict) else {}
                    self.emit(type='search', query=args.get('query', '') if name == 'web_search' else '', label=agent.tool_label(name, args))
                    try:
                        out = await agent.run_tool(name, args)
                    except Exception as e:  # noqa: BLE001
                        out = f'出错了：{e}'
                    results.append({'role': 'tool', 'tool_call_id': c['id'], 'content': out} if online
                                   else {'role': 'tool', 'tool_name': name, 'content': out})
                if online:
                    asst = {'role': 'assistant', 'content': None, 'tool_calls': [
                        {'id': c['id'], 'type': 'function', 'function': {'name': c['name'], 'arguments': json.dumps(c['args'], ensure_ascii=False)}} for c in calls]}
                else:
                    asst = {'role': 'assistant', 'content': '', 'tool_calls': [{'function': {'name': c['name'], 'arguments': c['args']}} for c in calls]}
                messages = messages + [asst] + results
            if buf.strip():
                sentences.put_nowait(buf)
            sentences.put_nowait(None)
            await spk
            self.history += [{'role': 'user', 'content': text}, {'role': 'assistant', 'content': full}]
            self.emit(type='reply_done', text=full, ms=int((time.time() - t0) * 1000))
            # 等念完：还在会话里就接着听（不用再喊它），否则回到空闲
            while self.player.busy():
                await asyncio.sleep(0.05)
            if self.convo:
                self.start_listening(follow_up=True)
            else:
                self.set_state('idle')
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # 出错别闷着：说一声，界面上也标出来，然后回待命
            busy = isinstance(e, (asyncio.TimeoutError, TimeoutError)) or 'Timeout' in type(e).__name__
            why = '大模型半天没反应，可能是显卡被别的程序占满了' if busy else str(e) or type(e).__name__
            print(f'[turn] 出错：{why}', flush=True)
            self.emit(type='error', text=why)
            try:
                self.set_state('speaking')
                await self.say('我这边卡住了，等会儿再问我吧。' if busy else '出了点问题，没能回答你。', time.time(), [])
                while self.player.busy():
                    await asyncio.sleep(0.05)
            except Exception:  # noqa: BLE001
                pass
            self.convo = False
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
        await resp.write(f"data: {json.dumps({'type': 'hello', 'state': A.state, 'paused': A.paused, 'owner': OWNER is not None, 'history': A.history[-20:]}, ensure_ascii=False)}\n\n".encode())
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
    new = await req.json()
    # 唤醒词模型是中文的：英文 / 数字 / 符号会让 sherpa-onnx 直接把整个进程退掉（2026-10-19 用户设成 Fairy，
    # 服务一收到设置就消失，查了半天）。不是纯中文就不接收，保留原来的唤醒词
    en = str(new.get('wakeWordEn', CFG.get('wakeWordEn', ''))).strip()
    if en and not re.fullmatch(r'[A-Za-z]+( [A-Za-z]+){0,3}', en):
        new['wakeWordEn'] = CFG.get('wakeWordEn', '')
        CFG.update({k: v for k, v in new.items() if k != 'wakeWordEn'})
        return web.json_response({'ok': False, 'error': f'英文唤醒词只能是 1～4 个英文单词，「{en}」用不了'}, headers=CORS)
    if en and not (KWS_EN_DIR / 'tokens.txt').exists():
        async def fetch_en():
            err = await asyncio.to_thread(download_kws_en)
            if err:
                A.emit(type='error', text=err)
            else:
                A.ensure_kws()
        asyncio.create_task(fetch_en())
    word = str(new.get('wakeWord', CFG['wakeWord'])).strip()
    bad = not re.fullmatch(r'[一-鿿]{2,8}', word)
    if bad:
        new['wakeWord'] = CFG['wakeWord']
    CFG.update(new)
    if bad:
        try:
            A.ensure_kws()
        except Exception:
            pass
        return web.json_response({'ok': False, 'error': f'唤醒词只能是 2 到 8 个汉字，「{word}」用不了，还在用「{CFG["wakeWord"]}」'}, headers=CORS)
    try:
        A.ensure_kws()
    except Exception as e:
        return web.json_response({'ok': False, 'error': f'唤醒词设置失败：{e}'}, headers=CORS)
    return web.json_response({'ok': True}, headers=CORS)


async def h_listen(_req):
    if A.paused:
        return web.json_response({'ok': False, 'error': '游戏模式中'}, headers=CORS)
    A.start_listening()
    return web.json_response({'ok': True}, headers=CORS)


async def h_ask(req):
    # 打字提问（不用麦克风）：界面以后的输入框、开发自测都走这里
    text = ((await req.json()).get('text') or '').strip()
    if text and not A.paused:
        A.start_listening()
        A.set_state('thinking')
        A.turn_task = asyncio.create_task(A.turn(None, text))
    return web.json_response({'ok': True}, headers=CORS)


async def h_say(req):
    # 只念不聊：笔记「念给我听」用。念的过程中喊唤醒词 / 点球照样能打断
    text = ((await req.json()).get('text') or '').strip()
    if text:
        A.stop_all()  # 也会把 convo 清掉：念完就回待命，不接着听

        async def go():
            first: list = []
            try:
                A.set_state('speaking')
                # 跟对话一样：第一小句切出来就先念，后面的每两百来字一段接着合成（合成比念得快，句子之间不断）
                t0 = time.time()
                head, rest = take_sentence(text, True)
                if head:
                    await A.say(head, t0, first)
                else:
                    rest = text
                parts = [p for p in re.split(r'(?<=[。！？!?\n])', rest) if p.strip()]
                chunk = ''
                for p in parts:
                    chunk += p
                    if len(chunk) >= 200:
                        await A.say(chunk, t0, first)
                        chunk = ''
                if chunk:
                    await A.say(chunk, t0, first)
                while A.player.busy():
                    await asyncio.sleep(0.05)
            finally:
                A.set_state('idle')
        A.turn_task = asyncio.create_task(go())
    return web.json_response({'ok': True}, headers=CORS)


async def h_stop(_req):
    A.stop_all()
    return web.json_response({'ok': True}, headers=CORS)


async def h_pause(req):
    on = bool((await req.json()).get('on'))
    if on and not A.paused:
        A.stop_all()
        A.rec = []
    A.paused = on
    A.emit(type='paused', on=on)
    return web.json_response({'ok': True}, headers=CORS)


async def h_clear(_req):
    A.history = []
    return web.json_response({'ok': True}, headers=CORS)


async def ensure_spk_model() -> str:
    """声纹模型没有就下（28MB）；失败返回原因"""
    if SPK_MODEL.exists():
        return ''
    SPK_MODEL.parent.mkdir(parents=True, exist_ok=True)
    tmp = SPK_MODEL.with_suffix('.part')
    try:
        async with ClientSession(timeout=ClientTimeout(total=600)) as s:
            async with s.get(SPK_URL) as r:
                if r.status != 200:
                    return f'下载声纹模型失败：HTTP {r.status}'
                with open(tmp, 'wb') as f:
                    async for chunk in r.content.iter_chunked(1 << 16):
                        f.write(chunk)
        tmp.replace(SPK_MODEL)
        return ''
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return f'下载声纹模型失败：{e}'


ENROLL: list[np.ndarray] = []


async def h_enroll(req):
    """录主人声音：record 录一段（5 秒，照着念一句），save 把几段合成一个声纹存下，clear 删掉"""
    global OWNER
    act = (await req.json()).get('action')
    if act == 'record':
        err = await ensure_spk_model()
        if err:
            return web.json_response({'ok': False, 'error': err}, headers=CORS)
        A.stop_all()
        A.enroll = []
        A.emit(type='enroll', on=True)
        await asyncio.sleep(5)
        pcm = np.concatenate(A.enroll) if A.enroll else np.zeros(0, dtype=np.float32)
        A.enroll = None
        A.emit(type='enroll', on=False)
        e = await asyncio.to_thread(lambda: embed(voiced(pcm)))
        if e is None or float(np.sqrt((pcm * pcm).mean() if len(pcm) else 0)) < 0.005:
            return web.json_response({'ok': False, 'error': '没听清，离麦克风近一点再念一次'}, headers=CORS)
        ENROLL.append(e)
        return web.json_response({'ok': True, 'n': len(ENROLL)}, headers=CORS)
    if act == 'save':
        if not ENROLL:
            return web.json_response({'ok': False, 'error': '还没录'}, headers=CORS)
        m = np.mean(ENROLL, axis=0)
        OWNER = (m / np.linalg.norm(m)).astype(np.float32)
        np.save(OWNER_FILE, OWNER)
        ENROLL.clear()
        return web.json_response({'ok': True}, headers=CORS)
    if act == 'reset':
        ENROLL.clear()
        return web.json_response({'ok': True}, headers=CORS)
    if act == 'clear':
        OWNER = None
        ENROLL.clear()
        OWNER_FILE.unlink(missing_ok=True)
        return web.json_response({'ok': True}, headers=CORS)
    if act == 'status':
        return web.json_response({'ok': True, 'owner': OWNER is not None}, headers=CORS)
    return web.json_response({'ok': False, 'error': '不认识的操作'}, headers=CORS)


async def h_voices(_req):
    vs = [{'id': k, 'name': n, 'pack': False} for k, n in (('gentle', '温柔'), ('sweet', '甜美'), ('lively', '活泼'))]
    vs += [{'id': k, 'name': m.get('name', k[5:]), 'pack': True, 'weights': bool(m.get('gpt') and m.get('sovits'))} for k, m in load_packs().items()]
    return web.json_response({'voices': vs}, headers=CORS)


async def h_import_pack(req):
    d = await req.json()
    try:
        if d.get('delete'):
            import shutil
            shutil.rmtree(PACKS_DIR / str(d['delete']).removeprefix('pack:'), ignore_errors=True)
            return web.json_response({'ok': True}, headers=CORS)
        return web.json_response({'ok': True, **await asyncio.to_thread(import_pack, str(d.get('path', '')))}, headers=CORS)
    except Exception as e:  # noqa: BLE001
        return web.json_response({'ok': False, 'error': str(e)}, headers=CORS)


async def h_health(_req):
    gsv = False
    try:
        async with ClientSession(timeout=ClientTimeout(total=1)) as s:
            async with s.get(f'{GSV}/docs') as r:
                gsv = r.status == 200
    except Exception:
        pass
    return web.json_response({'ok': True, 'gsv': gsv, 'wake': A.kws is not None, 'state': A.state, 'paused': A.paused}, headers=CORS)


async def h_options(_req):
    return web.Response(headers=CORS)


async def on_start(app):
    A.player = Player()
    threading.Thread(target=volume_watch, daemon=True).start()
    A.ensure_kws()
    asyncio.create_task(A.mic_loop())

    async def out_level():
        # 说话时每 50ms 报一次音量，球跟着一起一伏
        while True:
            await asyncio.sleep(0.05)
            if A.state == 'speaking' and A.subs:
                A.emit(type='out', v=round(A.player.level, 3))
    asyncio.create_task(out_level())

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
                break
            except Exception:
                await asyncio.sleep(1)
        await warm_acks()
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
    app.router.add_post('/say', h_say)
    app.router.add_post('/clear', h_clear)
    app.router.add_post('/pause', h_pause)
    app.router.add_post('/enroll', h_enroll)
    app.router.add_get('/voices', h_voices)
    app.router.add_post('/pack', h_import_pack)
    app.router.add_route('OPTIONS', '/{tail:.*}', h_options)
    web.run_app(app, host='127.0.0.1', port=PORT, print=None)


if __name__ == '__main__':
    main()
