"""开发自测：唤醒词能不能被认出来、别的话会不会误唤醒（用合成的声音代替人声；不进安装包）"""
import sys

import numpy as np

import server

sys.stdout.reconfigure(encoding='utf-8')
WORD = sys.argv[1] if len(sys.argv) > 1 else '小精灵'
print('keywords:', server.wake_keywords(WORD))
kws = server.make_kws(WORD)
tts = server.kokoro()


def hits(text, sid):
    a = tts.generate(text, sid=sid, speed=1.0)
    x = np.array(a.samples, dtype=np.float32)
    x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * 16000 / a.sample_rate)), np.arange(len(x)), x).astype(np.float32)
    x = np.concatenate([np.zeros(8000, np.float32), x, np.zeros(16000, np.float32)])
    s = kws.create_stream()
    found = []
    for i in range(0, len(x), 1600):
        s.accept_waveform(16000, x[i:i + 1600])
        while kws.is_ready(s):
            kws.decode_stream(s)
        r = kws.get_result(s)
        if r:
            found.append(r)
            kws.reset_stream(s)
    return found


for sid in (10, 30, 47, 60):
    print(sid, '唤醒词:', hits(WORD, sid), '| 句中:', hits(f'嗨{WORD}，现在几点了', sid), '| 无关:', hits('今天天气不错，我们去散步吧', sid))
