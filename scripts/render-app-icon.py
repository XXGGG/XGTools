# -*- coding: utf-8 -*-
"""重新生成 XGTools 的 App 图标(百宝袋)。

改了口袋的形状(src/assets/icons/pocket.ts)或者想调它在图标里占多大,跑这个:

    python scripts/render-app-icon.py

它会:
  1. 用 Edge 的无头模式把口袋画成 1024×1024 的透明底 PNG(白、黑各一张);
  2. 白的交给 `pnpm tauri icon`,生成 src-tauri/icons 下的全套静态图标(程序文件、安装包、开始菜单用);
  3. 白、黑两张缩成 64px,放进 src-tauri/icons/taskbar-*.png —— 程序运行时按任务栏深浅色切换用
     (见 src-tauri/src/taskbar_icon.rs)。

README 顶上那张 public/app-icon.png 是黑底白口袋版,不在这里生成(GitHub 白底上白口袋看不见)。
需要:Windows 上装着 Edge,Python 装着 Pillow。
"""
import os
import shutil
import subprocess
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, 'src-tauri', 'icons')
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

# 和 pocket.ts 里的 POCKET_PATH 是同一个图形
PATH = ('M13.3 9.74 A34.09 34.09 0 0 0 34.7 9.74 Q36.76 8.93 38.22 10.56 '
        'A17.8 17.8 0 1 1 9.78 10.56 Q11.24 8.93 13.3 9.74 Z')
FILL = 0.98                    # 口袋宽度占整张图标的比例(用户要「几乎撑满」)
W = round(1024 * FILL)
H = round(W * 30.4 / 36)       # 视框只框住口袋外形:x 6~42,y 8.9~39.3
X, Y = (1024 - W) // 2, (1024 - H) // 2


def render(color: str, out: str) -> None:
    html = out + '.html'
    with open(html, 'w', encoding='utf-8') as f:
        f.write(f'''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:transparent;width:1024px;height:1024px;overflow:hidden}}svg{{display:block}}
</style></head><body><svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<svg x="{X}" y="{Y}" width="{W}" height="{H}" viewBox="6 8.9 36 30.4"><path fill="{color}" d="{PATH}"/></svg>
</svg></body></html>''')
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--default-background-color=00000000', '--window-size=1024,1024',
                    f'--screenshot={out}', 'file:///' + html.replace('\\', '/')],
                   capture_output=True, check=True)


def main() -> None:
    tmp = tempfile.mkdtemp(prefix='xgtools-icon-')
    try:
        white = os.path.join(tmp, 'pocket-white-1024.png')
        black = os.path.join(tmp, 'pocket-black-1024.png')
        render('#ffffff', white)
        render('#111111', black)
        for src, name in ((white, 'taskbar-white.png'), (black, 'taskbar-black.png')):
            Image.open(src).convert('RGBA').resize((64, 64), Image.LANCZOS).save(os.path.join(ICONS, name))
        subprocess.run(['pnpm', 'tauri', 'icon', white], cwd=ROOT, check=True, shell=True)
        Image.open(white).convert('RGBA').resize((512, 512), Image.LANCZOS).save(os.path.join(ICONS, 'app-icon.png'))
        print('done: src-tauri/icons 已更新')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
