"""
小精灵的「大脑」：系统提示 + 工具。

思路照着好用的通用智能体来：不给每类问题写死特例，而是
1. 把它是谁、怎么说话、什么时候该查该算，写成一份通用的行为准则（system_prompt）；
2. 给它几件通用工具 —— 上网搜、打开网页看全文、计算器（含日期），让它自己决定用不用、用几次；
3. 工具可以连着用好几轮（搜 → 打开看 → 算），直到它觉得够了再回答。

小模型的弱点是心算和比大小（比如比两个日期谁早），所以准则里要求：凡是要算的，交给计算器，不要心算。
"""
import ast
import math
import operator
import re
from datetime import date, datetime, timedelta

import websearch

WEEK = '一二三四五六日'


def now_text(n: datetime) -> str:
    # 时间按口语说（半夜 12 点 09 分），再附 24 小时制：只给「0 点 09 分」的话，用户说「12 点了」它会抬杠
    h = n.hour
    period = '半夜' if h < 5 else '早上' if h < 9 else '上午' if h < 12 else '中午' if h < 13 else '下午' if h < 18 else '晚上'
    return f'{n.year}年{n.month}月{n.day}日 星期{WEEK[n.weekday()]} {period}{h % 12 or 12}点{n.minute:02d}分（24 小时制 {h}:{n.minute:02d}）'


GUIDE = """
【你在做什么】
你在用户的电脑里，通过语音和用户对话。你说的每个字都会被念出来，所以：
- 用口语，短：通常一到三句话。不要列表、标题、markdown、表情符号、网址、括号注释。
- 直接回答问题本身，先说结论。
- 回答完就停。不要在结尾反问、不要问「还想了解什么」「要不要我……」。
  只有缺了关键信息、实在没法回答时，才简短问一句；能用合理的默认值就用默认值。
- 别抬杠、别咬文嚼字：对方的说法大体对就顺着说。
- 没听清、话没头没尾，就简短确认一句。

【怎么保证说的是对的】
- 你能上网查，也能算，所以不要说「我无法提供实时信息」「建议你去看手机」这类话 —— 自己去查、去算。
- 你的记忆停在训练的时候，世界在变。凡是会随时间变化的事（某人现在多大、近况、新闻、天气、价格、比分、
  最新版本、最近发生的事），以及你没把握的事实，先用 web_search 查，再回答。不要凭印象答。
- 搜索结果只有摘要；摘要不够就用 read_page 打开最相关的那条看全文。
- 凡是要算的（加减乘除、百分比、换算、两个日期隔多久、谁早谁晚、某人几岁），一律用 calculate 算，不要心算。
  比日期大小、算年龄这种事你心算很容易出错。
- 工具可以连着用：先查到出生日期，再用 calculate 算年龄。一次没查到就换个说法再查。
- 工具的结果比你的记忆可靠。查到了就照着说，不要说「根据资料」「我查到」。
- 真查不到、不确定，就直说不知道，不要编。
"""

TOOLS = [
    {'type': 'function', 'function': {
        'name': 'web_search',
        'description': '上网搜索，返回几条结果的标题、摘要和链接。用在：会随时间变化的事（人的年龄近况、新闻、天气、价格、比分、最近发生的事）、你没把握的事实。',
        'parameters': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': '搜索关键词，简短具体'}}, 'required': ['query']}}},
    {'type': 'function', 'function': {
        'name': 'read_page',
        'description': '打开一个网页，读它的正文（前几千字）。搜索摘要信息不够时，用它看 web_search 结果里的某个链接。',
        'parameters': {'type': 'object', 'properties': {'url': {'type': 'string', 'description': '网页链接'}}, 'required': ['url']}}},
    {'type': 'function', 'function': {
        'name': 'calculate',
        'description': ('计算器。写一个 Python 表达式，返回结果。支持 + - * / // % **、括号、round abs min max、math 里的函数；'
                        '日期：today() 今天，date(年,月,日)，两个日期相减得天数（.days），'
                        'age(出生日期) 今天满几周岁，weekday(日期) 星期几，add_days(日期, n) 往后数 n 天。'
                        '例：age(date(1974,4,28))、(date(2027,1,1)-today()).days、date(2026,4,28) < today()'),
        'parameters': {'type': 'object', 'properties': {'expression': {'type': 'string'}}, 'required': ['expression']}}},
]


def system_prompt(cfg: dict, now: datetime | None = None) -> str:
    n = now or datetime.now()
    t = now_text(n)
    p = cfg['persona'].replace('{name}', cfg['name']).replace('{now}', t).replace('{date}', t)
    if '{now}' not in cfg['persona'] and '{date}' not in cfg['persona']:
        p += f'\n现在是 {t}。'
    p += '\n' + GUIDE
    # 默认用哪种语言回答（设置里选）：对方用另一种语言问也照这个答，除非明确要求换
    if cfg.get('replyLang') == 'en':
        p += '- 用英文回答，即使对方说中文也用英文，除非对方明确要你说中文。\n'
    else:
        p += '- 用简体中文回答，即使对方说英文也用中文，除非对方明确要你说英文。\n'
    if not cfg.get('search'):
        p += '- 用户关掉了联网：web_search 和 read_page 现在用不了，遇到要查的事就说明你现在查不了。\n'
    return p


def tools_for(cfg: dict) -> list:
    return TOOLS if cfg.get('search') else [t for t in TOOLS if t['function']['name'] == 'calculate']


# ── 计算器：只认算术和下面这几个函数，别的一概不执行 ──

def _age(born: date) -> int:
    t = date.today()
    return t.year - born.year - ((t.month, t.day) < (born.month, born.day))


SAFE_FUNCS = {
    'round': round, 'abs': abs, 'min': min, 'max': max, 'int': int, 'float': float,
    'today': date.today, 'date': date, 'age': _age,
    'weekday': lambda d: '星期' + WEEK[d.weekday()],
    'add_days': lambda d, n: d + timedelta(days=n),
    **{k: getattr(math, k) for k in ('sqrt', 'log', 'log10', 'exp', 'sin', 'cos', 'tan', 'pi', 'e', 'floor', 'ceil')},
}
OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
       ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod, ast.Pow: operator.pow,
       ast.USub: operator.neg, ast.UAdd: operator.pos,
       ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Eq: operator.eq, ast.NotEq: operator.ne}


def _eval(node):
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in OPS:
        a, b = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(b) > 100:
            raise ValueError('指数太大')
        return OPS[type(node.op)](a, b)
    if isinstance(node, ast.UnaryOp) and type(node.op) in OPS:
        return OPS[type(node.op)](_eval(node.operand))
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in OPS:
        return OPS[type(node.ops[0])](_eval(node.left), _eval(node.comparators[0]))
    if isinstance(node, ast.Name) and node.id in SAFE_FUNCS:
        return SAFE_FUNCS[node.id]
    if isinstance(node, ast.Attribute) and node.attr in ('days', 'year', 'month', 'day'):
        return getattr(_eval(node.value), node.attr)
    if isinstance(node, ast.Call) and not node.keywords:
        f = _eval(node.func)
        if f in SAFE_FUNCS.values():
            return f(*[_eval(a) for a in node.args])
    raise ValueError('不支持的写法')


def calculate(expression: str) -> str:
    try:
        r = _eval(ast.parse(expression.strip(), mode='eval'))
    except Exception as e:  # noqa: BLE001
        return f'算不了：{e}'
    if isinstance(r, float):
        r = round(r, 6)
    if isinstance(r, date):
        r = f'{r.year}年{r.month}月{r.day}日（星期{WEEK[r.weekday()]}）'
    if isinstance(r, timedelta):
        r = f'{r.days} 天'
    return f'{expression} = {r}'


async def run_tool(name: str, args: dict) -> str:
    if name == 'web_search':
        res = await websearch.search(str(args.get('query', '')))
        return websearch.as_context(res, with_url=True)
    if name == 'read_page':
        return await websearch.read_page(str(args.get('url', '')))
    if name == 'calculate':
        return calculate(str(args.get('expression', '')))
    return f'没有 {name} 这个工具'


def tool_label(name: str, args: dict) -> str:
    """界面上那行小字：查了什么 / 看了哪页 / 算了什么"""
    if name == 'web_search':
        return f"查了一下：{args.get('query', '')}"
    if name == 'read_page':
        return f"看了网页：{re.sub(r'^https?://(www\.)?', '', str(args.get('url', '')))[:40]}"
    if name == 'calculate':
        return f"算了一下：{args.get('expression', '')}"
    return name
