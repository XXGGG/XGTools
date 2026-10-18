"""开发自测：联网查询（抓 Bing）能不能用、快不快（不进安装包）"""
import asyncio
import sys
import time

import websearch

sys.stdout.reconfigure(encoding='utf-8')


async def main():
    for q in ('刘谦 年龄', '今天 深圳 天气', '最新 英伟达 新闻'):
        t = time.time()
        r = await websearch.search(q)
        print(q, '%.1fs' % (time.time() - t), len(r))
        for x in r[:3]:
            print('   -', x['title'][:40], '|', x['body'][:80])

asyncio.run(main())
