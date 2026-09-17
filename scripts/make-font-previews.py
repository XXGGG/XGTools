# -*- coding: utf-8 -*-
"""给字体库「推荐」里每一款字体做一个样张子集，随应用打包。

为什么要这么干：用户想在**没装之前**就看到字体长什么样。每款字体下载一次，
只留样张要用的那些字（src/lib/fontSamples.ts 里出现过的，外加字母数字标点），
压成 woff2 放进 src/assets/font-preview/<id>.woff2 —— 每个几 KB 到几十 KB，
离线可用，样张瞬间出来。

顺手做一个「缺字框」字体 _notdef.woff2（Adobe NotDef，OFL）：把每个码位都画成一个方框。
页面上画本机字体时拿它垫底，字体里缺的字就显示成方框，而不是悄悄换成别的字体 ——
做游戏最怕的就是「看着都有，一进游戏缺一堆字」。

跑法（改了推荐目录或样张文字之后跑一次）：
    python scripts/make-font-previews.py
需要：pip install fonttools brotli

XGCut 下载过的字体（它的 target/font-cache）会直接拿来用，不重复下。
"""

import io
import os
import re
import sys
import zipfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "src-tauri", "src", "font_catalog.rs")
SAMPLES = os.path.join(ROOT, "src", "lib", "fontSamples.ts")
OUT_DIR = os.path.join(ROOT, "src", "assets", "font-preview")
CACHE = os.path.join(ROOT, "src-tauri", "target", "font-cache")
XGCUT_CACHE = os.path.join(os.path.dirname(ROOT), "XGCut", "target", "font-cache")

NOTDEF_URL = "https://github.com/adobe-fonts/adobe-notdef/raw/master/AND-Regular.otf"

EXTRA = (
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    "，。、！？：；「」《》—·…,.!?:;'\"()[]/+-%&#@~ "
)


def sample_text():
    """fontSamples.ts 里所有字符串字面量里的字，去重"""
    src = io.open(SAMPLES, encoding="utf-8").read()
    chars = set(EXTRA)
    for m in re.findall(r"'([^'\\]*)'", src):
        chars.update(m)
    return "".join(sorted(chars))


def parse_catalog():
    src = io.open(CATALOG, encoding="utf-8").read()
    out = []
    for block in re.findall(r"Pack \{(.*?)\n    \}", src, re.S):
        def field(name):
            # 前面加个界，免得 url 把 license_url 也匹配进来
            m = re.search(r'(?<![a-z_])%s: "([^"]*)"' % name, block)
            return m.group(1) if m else ""
        if field("id"):
            out.append({"id": field("id"), "url": field("url"), "name": field("name"), "pick": field("pick")})
    return out


def fetch(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "XGTools/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(path + ".part", path)
    return path


def cached(pid, url):
    raw = url.rsplit("/", 1)[-1]
    name = pid + "_" + raw
    for d in (CACHE, XGCUT_CACHE):
        p = os.path.join(d, name)
        if os.path.exists(p) and os.path.getsize(p) > 1024:
            return p
    return fetch(url, os.path.join(CACHE, name))


def pick_from_zip(path, pick):
    """压缩包里挑一份当样张：优先 pick 指定的语言版本、优先常规字重"""
    with zipfile.ZipFile(path) as z:
        names = [
            n for n in z.namelist()
            if n.lower().endswith((".ttf", ".otf"))
            and "__MACOSX" not in n
            and not os.path.basename(n).startswith("._")
        ]
        if not names:
            return None, None

        def score(n):
            low = os.path.basename(n).lower()
            s = 0
            if pick and pick in low:
                s -= 100
            if any(k in low for k in ("regular", "normal", "book")):
                s -= 50
            # 寒蝉点阵有 8 像素和 16 像素两套，样张字号大，用 16 像素那套
            if "16px" in low:
                s -= 20
            for heavy in ("bold", "black", "heavy", "extralight", "ultralight",
                          "light", "thin", "extra", "semi", "medium"):
                if heavy in low:
                    s += 40
            if "italic" in low:
                s += 8
            if low.endswith(".otf"):
                s += 1
            return s + len(low) / 200.0

        best = sorted(names, key=score)[0]
        return z.read(best), best


def make_notdef():
    from fontTools.ttLib import TTFont
    out = os.path.join(OUT_DIR, "_notdef.woff2")
    if os.path.exists(out):
        return
    src = fetch(NOTDEF_URL, os.path.join(CACHE, "_AND-Regular.otf"))
    f = TTFont(src)
    f.flavor = "woff2"
    f.save(out)
    print("  缺字框字体 → _notdef.woff2  %.1f KB" % (os.path.getsize(out) / 1024))


def main():
    from fontTools import subset as ftsubset
    from fontTools.ttLib import TTFont

    os.makedirs(OUT_DIR, exist_ok=True)
    text = sample_text()
    packs = parse_catalog()
    print("推荐里共 %d 款字体，样张用到 %d 个字" % (len(packs), len(text)))
    make_notdef()

    done, failed = 0, []
    for p in packs:
        out = os.path.join(OUT_DIR, p["id"] + ".woff2")
        try:
            src = cached(p["id"], p["url"])
            if src.lower().endswith(".zip"):
                data, inner = pick_from_zip(src, p["pick"])
                if not data:
                    raise RuntimeError("压缩包里没有字体文件")
                src = os.path.join(CACHE, p["id"] + "__" + os.path.basename(inner))
                os.makedirs(CACHE, exist_ok=True)
                open(src, "wb").write(data)
            ftsubset.main([
                src,
                "--text=%s" % text,
                "--output-file=%s" % out,
                "--flavor=woff2",
                "--layout-features=",
                "--no-hinting",
                "--desubroutinize",
                "--drop-tables+=DSIG",
                # 版权、名字、协议这几条留着：子集也是那款字体，协议要跟着走
                "--name-IDs=0,1,2,3,4,5,6,13,14",
                "--notdef-outline",
            ])
            n = TTFont(out)["maxp"].numGlyphs
            print("  %-10s → %-26s %6.1f KB  %4d 字" % (p["name"], os.path.basename(out), os.path.getsize(out) / 1024, n))
            done += 1
        except Exception as e:  # 单款失败不该拖垮整批
            failed.append((p["id"], str(e)[:90]))
            print("  × %s 失败：%s" % (p["id"], str(e)[:90]))

    # 目录里已经删掉的字体，样张也删掉
    ids = {p["id"] for p in packs}
    for fn in os.listdir(OUT_DIR):
        if fn.endswith(".woff2") and not fn.startswith("_") and fn[:-6] not in ids:
            os.remove(os.path.join(OUT_DIR, fn))
            print("  删掉过期的样张 %s" % fn)

    total = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR))
    print("\n做好 %d 个样张子集，一共 %.0f KB，放在 src/assets/font-preview/" % (done, total / 1024))
    if failed:
        print("这几款没做出来（界面上会显示成「装好才能看」）：")
        for fid, why in failed:
            print("   %-20s %s" % (fid, why))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
