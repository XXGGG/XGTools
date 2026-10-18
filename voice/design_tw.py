"""开发自测：用 Qwen3-TTS VoiceDesign 按文字描述造几个台湾女生音色试听（借 XGLingo 装好的模型和环境跑）。

用法（在 XGLingo/tts 的环境里）：uv run --project C:/XGCode/XGLingo/tts python design_tw.py
"""
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf

os.environ.setdefault("HF_HUB_OFFLINE", "1")
import torch
from qwen_tts import Qwen3TTSModel

MODELS = Path("C:/XGCode/XGLingo/models")
OUT = Path(__file__).parent / "samples"
OUT.mkdir(exist_ok=True)
TEXT = "嗨，我是 Fairy。你今天过得怎么样？刚才那件事真的太好笑了，快跟我讲讲后来呢。"
DESIGNS = {
    "v1-sweet": "A cute, sweet young Chinese woman around 20, natural standard Mandarin, bright and playful, speaking naturally at a brisk, slightly fast pace like chatting with a close friend.",
    "v2-gentle": "A gentle, warm young Chinese woman in her early twenties, natural standard Mandarin, soft and tender, relaxed and natural, speaking at a slightly fast conversational pace like talking to her boyfriend.",
    "v3-lively": "An energetic, cheerful young Chinese woman, natural standard Mandarin, bubbly and expressive, speaking quickly and naturally, very friendly.",
}

t = time.time()
model = Qwen3TTSModel.from_pretrained(str(MODELS / "Qwen3-TTS-12Hz-1.7B-VoiceDesign"), device_map="cuda:0",
                                      dtype=torch.bfloat16, attn_implementation="sdpa")
print("load %.1fs" % (time.time() - t), flush=True)
for name, desc in DESIGNS.items():
    t = time.time()
    wavs, sr = model.generate_voice_design(text=[TEXT], language=["Chinese"], instruct=[desc])
    w = np.asarray(wavs[0], dtype=np.float32)
    sf.write(OUT / f"{name}.wav", w, sr)
    print(name, "gen %.1fs for %.1fs audio" % (time.time() - t, len(w) / sr), flush=True)
