"""
联网查询：抓 DuckDuckGo 的纯 HTML 结果页，取前几条的标题和摘要给模型参考。

- 不用 ddgs 那类库：它自带的 DNS 解析在这台机器上解析不了任何域名（系统 DNS 是好的），
  直接用 aiohttp 走系统网络最稳。也不用申请 Key。
- 不抓 Bing：Bing 结果页是脚本渲染的，直接取 HTML 一条结果都没有。
- 搜一次 0.5 秒左右。
"""
import asyncio
import html
import re

from aiohttp import ClientSession, ClientTimeout

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0'


def _text(s: str) -> str:
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


async def _html(s: ClientSession, query: str) -> list[dict]:
    async with s.post('https://html.duckduckgo.com/html/', data={'q': query, 'kl': 'cn-zh'}) as r:
        page = await r.text()
    titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', page, flags=re.S)
    snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', page, flags=re.S)
    return [{'title': _text(t), 'body': _text(b)} for t, b in zip(titles, snips)]


async def _lite(s: ClientSession, query: str) -> list[dict]:
    async with s.post('https://lite.duckduckgo.com/lite/', data={'q': query, 'kl': 'cn-zh'}) as r:
        page = await r.text()
    titles = re.findall(r"class=['\"]result-link['\"][^>]*>(.*?)</a>", page, flags=re.S)
    snips = re.findall(r"class=['\"]result-snippet['\"][^>]*>(.*?)</td>", page, flags=re.S)
    return [{'title': _text(t), 'body': _text(b)} for t, b in zip(titles, snips)]


async def search(query: str, n: int = 5) -> list[dict]:
    # DuckDuckGo 连着搜几次会偶尔回一个空页（限流），换个入口、隔一下再试，三次都空才算没结果
    async with ClientSession(timeout=ClientTimeout(total=8), headers={'User-Agent': UA}) as s:
        for attempt, fn in enumerate((_html, _lite, _html)):
            try:
                out = await fn(s, query)
            except Exception:
                out = []
            if out:
                return out[:n]
            await asyncio.sleep(0.3 * (attempt + 1))
    return []


def as_context(results: list[dict]) -> str:
    if not results:
        return '（没搜到结果）'
    return '\n'.join(f"{i + 1}. {r['title']}：{r['body']}" for i, r in enumerate(results))
