"""开发自测：Kokoro 合成速度、识别速度（不进安装包）"""
import time
from pathlib import Path

import numpy as np

import server

t = time.time(); tts = server.kokoro(); print('kokoro load %.2fs, speakers %d' % (time.time() - t, tts.num_speakers))
out = Path(__file__).parent / 'samples'
out.mkdir(exist_ok=True)
for sid in (3, 10, 20, 30, 40, 47, 50):
    t = time.time()
    a = tts.generate('欸你好呀，我是 Fairy，今天想聊什么？', sid=sid, speed=1.05)
    dt = time.time() - t
    (out / f'zf_{sid}.wav').write_bytes(server.wav_bytes(np.array(a.samples, dtype=np.float32), a.sample_rate))
    print('sid', sid, 'synth %.2fs for %.1fs audio' % (dt, len(a.samples) / a.sample_rate))

t = time.time(); server.asr(); print('asr load %.2fs' % (time.time() - t))
import wave
with wave.open(str(out / 'zf_47.wav')) as w:
    pcm = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768
    rate = w.getframerate()
# 重采样到 16k 喂识别，顺便验证识别和合成能互相对上
idx = np.linspace(0, len(pcm) - 1, int(len(pcm) * 16000 / rate)).astype(int)
t = time.time(); print('asr:', server.transcribe(pcm[idx]), '%.2fs' % (time.time() - t))
