"""开发自测：CosyVoice3 用 Qwen3 造的音色当参考，流式合成的首包延迟和速度（借 VoiceStudio 的环境跑）。"""
import os
import sys
import time

E = r'C:\XGCode\XGCreator\VoiceStudio\engines\cosyvoice'
M = r'C:\XGCode\XGCreator\VoiceStudio\models\cosyvoice\Fun-CosyVoice3-0.5B'
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [E, os.path.join(E, 'third_party', 'Matcha-TTS')]
os.chdir(E)
import torch
import soundfile as sf
from cosyvoice.cli.cosyvoice import AutoModel

REF_TEXT = "嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。"
t = time.time()
m = AutoModel(model_dir=M, fp16=True)
print('load %.1fs' % (time.time() - t), flush=True)
ref = os.path.join(HERE, 'samples', 'v2-gentle.wav')
print('cuda', torch.cuda.is_available(), flush=True)
t = time.time()
m.add_zero_shot_spk('You are a helpful assistant.<|endofprompt|>' + REF_TEXT, ref, 'fairy')
print('spk %.1fs' % (time.time() - t), flush=True)
for warm in range(1):
    for j in m.inference_zero_shot('热身一下。', '', '', zero_shot_spk_id='fairy', stream=True):
        pass
for text in ['你好呀，今天想聊点什么？', '何老师今年五十二岁啦，他可是很厉害的主持人呢。', '好呀，我帮你切到下一首。']:
    t = time.time(); first = None; parts = []
    for j in m.inference_zero_shot(text, '', '', zero_shot_spk_id='fairy', stream=True):
        if first is None:
            first = time.time() - t
        parts.append(j['tts_speech'])
    w = torch.cat(parts, dim=1)[0].numpy()
    print(text, 'first %.2fs total %.2fs audio %.1fs' % (first, time.time() - t, len(w) / m.sample_rate), flush=True)
    sf.write(os.path.join(HERE, 'samples', 'cosy-' + str(len(text)) + '.wav'), w, m.sample_rate)
