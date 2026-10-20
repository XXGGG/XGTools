"""开发自测：qwen3.5 关思考时能不能自己判断「要不要联网查」（不进安装包）"""
import asyncio
import json
import sys
import time

from aiohttp import ClientSession

sys.stdout.reconfigure(encoding='utf-8')
TOOLS = [{'type': 'function', 'function': {
    'name': 'web_search', 'description': '上网搜索最新的、你不确定的或会变化的信息：新闻、天气、价格、某人现在多少岁、最近发生的事。闲聊和常识不要用。',
    'parameters': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': '搜索关键词，简短'}}, 'required': ['query']}}}]
SYS = '你是 Fairy，一个私人语音助手。回答要短，一到三句话。今天是 2026年10月19日。'


async def main():
    async with ClientSession() as s:
        for q in ('你好呀', '刘谦今年多少岁', '深圳明天会下雨吗', '给我讲个笑话', '最近有什么科技新闻'):
            t = time.time()
            body = {'model': 'qwen3.5:9b', 'stream': False, 'think': False, 'tools': TOOLS, 'options': {'temperature': 0},
                    'messages': [{'role': 'system', 'content': SYS}, {'role': 'user', 'content': q}]}
            async with s.post('http://127.0.0.1:11434/api/chat', json=body) as r:
                j = await r.json()
            m = j['message']
            print(q, '%.2fs' % (time.time() - t), json.dumps(m.get('tool_calls'), ensure_ascii=False) if m.get('tool_calls') else m.get('content', '')[:60])

asyncio.run(main())
