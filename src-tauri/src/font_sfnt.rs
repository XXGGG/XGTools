//! 字体文件解析：认字体族、读协议、查有没有某个字。
//!
//! 只 seek 到需要的那几张表（name / OS/2 / maxp / cmap）读那一段，不整份读进内存 ——
//! 中文字体动辄二三十兆，一次列几百款的话整读会卡死。思路跟 XGCut 的 adopt.rs 一样，
//! 这里多管了三件事：
//!
//! 1. **.ttc 里每一份都读**。微软雅黑的 msyh.ttc 里装着「微软雅黑」和「微软雅黑 UI」
//!    两个族，只看第一份就漏一个。
//! 2. **cmap 真的查到字形号**。format 4 有一种写法是「这一段归我管，但每个字再查一张表」，
//!    表里是 0 的就是没有这个字。只看范围，会把缺的字也算成有。
//! 3. **老中文字体的 GBK 名字**。九十年代的字体把中文名按 GBK / Big5 塞进 name 表
//!    （平台 3、编码 3 / 4），当 UTF-16 解就是一串乱码。

use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

fn be16(b: &[u8], i: usize) -> u16 {
    match b.get(i..i + 2) {
        Some(s) => u16::from_be_bytes([s[0], s[1]]),
        None => 0,
    }
}

fn be32(b: &[u8], i: usize) -> u32 {
    match b.get(i..i + 4) {
        Some(s) => u32::from_be_bytes([s[0], s[1], s[2], s[3]]),
        None => 0,
    }
}

/// 单张表再大也到不了这个数；真读到这么长，多半是文件坏了
const MAX_TABLE: usize = 16 << 20;

type Dir = Vec<([u8; 4], u64, usize)>;

struct Font {
    f: File,
    len: u64,
}

impl Font {
    fn open(path: &Path) -> Option<Self> {
        let f = File::open(path).ok()?;
        let len = f.metadata().ok()?.len();
        Some(Self { f, len })
    }

    fn read_at(&mut self, off: u64, len: usize) -> Option<Vec<u8>> {
        if len == 0 || len > MAX_TABLE || off.checked_add(len as u64)? > self.len {
            return None;
        }
        self.f.seek(SeekFrom::Start(off)).ok()?;
        let mut buf = vec![0u8; len];
        self.f.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    /// 每一份字体在文件里从哪开始。普通字体只有一份；.ttc 在文件头里列着
    fn starts(&mut self) -> Vec<u64> {
        let Some(h) = self.read_at(0, 12) else { return vec![] };
        if &h[0..4] != b"ttcf" {
            return vec![0];
        }
        let n = (be32(&h, 8) as usize).min(64);
        let Some(offs) = self.read_at(12, n * 4) else { return vec![] };
        (0..n).map(|i| be32(&offs, i * 4) as u64).collect()
    }

    /// 某一份字体的表目录：表名 → (位置, 长度)
    fn directory(&mut self, start: u64) -> Option<Dir> {
        let h = self.read_at(start, 12)?;
        // 0x00010000 = TrueType，OTTO = CFF 轮廓，true = 老 Mac 的 TrueType
        if be32(&h, 0) != 0x0001_0000 && &h[0..4] != b"OTTO" && &h[0..4] != b"true" {
            return None;
        }
        let n = be16(&h, 4) as usize;
        if n == 0 || n > 512 {
            return None;
        }
        let d = self.read_at(start + 12, n * 16)?;
        Some(
            (0..n)
                .map(|i| {
                    let r = i * 16;
                    ([d[r], d[r + 1], d[r + 2], d[r + 3]], be32(&d, r + 8) as u64, be32(&d, r + 12) as usize)
                })
                .collect(),
        )
    }

    fn table(&mut self, dir: &Dir, tag: &[u8; 4]) -> Option<Vec<u8>> {
        let (_, off, len) = dir.iter().find(|(t, _, _)| t == tag)?;
        self.read_at(*off, *len)
    }
}

// ─── name 表 ───────────────────────────────────

struct NameRec {
    platform: u16,
    lang: u16,
    id: u16,
    text: String,
}

/// 我们要看的那几条：
/// 0 版权 · 1 族名 · 2 字型 · 4 全名 · 6 PostScript 名 · 8 厂商 · 9 设计师 ·
/// 11 厂商网址 · 13 协议描述 · 14 协议网址 · 16 排版族名 · 17 排版字型
const WANT: [u16; 12] = [0, 1, 2, 4, 6, 8, 9, 11, 13, 14, 16, 17];

fn decode_name(platform: u16, encoding: u16, raw: &[u8]) -> String {
    match (platform, encoding) {
        // 老中文字体：GBK（编码 3）/ Big5（编码 4）的字节塞在 16 位里，高字节是 0 的就是单字节字符
        (3, 3) | (3, 4) => {
            let mut bytes = Vec::with_capacity(raw.len());
            for c in raw.chunks(2) {
                if c.len() == 2 {
                    if c[0] != 0 {
                        bytes.push(c[0]);
                    }
                    bytes.push(c[1]);
                }
            }
            let enc = if encoding == 3 { encoding_rs::GBK } else { encoding_rs::BIG5 };
            enc.decode(&bytes).0.into_owned()
        }
        (0, _) | (3, _) => {
            let units: Vec<u16> = raw.chunks(2).map(|c| be16(c, 0)).collect();
            String::from_utf16_lossy(&units)
        }
        // 平台 1（Mac）只取英文那条，按单字节解
        _ => raw.iter().map(|&c| c as char).collect(),
    }
}

fn parse_names(t: &[u8]) -> Vec<NameRec> {
    let count = be16(t, 2) as usize;
    let storage = be16(t, 4) as usize;
    let mut out = vec![];
    for i in 0..count.min(4096) {
        let r = 6 + i * 12;
        if r + 12 > t.len() {
            break;
        }
        let id = be16(t, r + 6);
        if !WANT.contains(&id) {
            continue;
        }
        let platform = be16(t, r);
        let encoding = be16(t, r + 2);
        let lang = be16(t, r + 4);
        let len = be16(t, r + 8) as usize;
        let off = storage + be16(t, r + 10) as usize;
        let Some(raw) = t.get(off..off + len) else { continue };
        let text = decode_name(platform, encoding, raw);
        let text = text.trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
        if !text.is_empty() {
            out.push(NameRec { platform, lang, id, text });
        }
    }
    out
}

/// 简体、新加坡、繁体、香港、澳门
const ZH_LANGS: [u16; 5] = [0x0804, 0x1004, 0x0404, 0x0C04, 0x1404];

fn find_lang(recs: &[NameRec], id: u16, lang: u16) -> Option<String> {
    recs.iter()
        .find(|r| r.id == id && r.platform == 3 && r.lang == lang)
        .map(|r| r.text.clone())
}

fn pick_zh(recs: &[NameRec], id: u16) -> Option<String> {
    ZH_LANGS.iter().find_map(|&l| find_lang(recs, id, l))
}

fn pick_en(recs: &[NameRec], id: u16) -> Option<String> {
    find_lang(recs, id, 0x0409).or_else(|| {
        recs.iter()
            .find(|r| r.id == id && r.platform == 3 && (r.lang & 0xFF) == 0x09)
            .map(|r| r.text.clone())
    })
}

/// 按语言优先级挑一条。都没有就随便拿一条 Windows / Unicode 平台的，最后才退回 Mac 英文
fn pick(recs: &[NameRec], id: u16, zh_first: bool) -> Option<String> {
    let first = if zh_first {
        pick_zh(recs, id).or_else(|| pick_en(recs, id))
    } else {
        pick_en(recs, id).or_else(|| pick_zh(recs, id))
    };
    first
        .or_else(|| {
            recs.iter()
                .find(|r| r.id == id && (r.platform == 3 || r.platform == 0))
                .map(|r| r.text.clone())
        })
        .or_else(|| {
            recs.iter()
                .find(|r| r.id == id && r.platform == 1 && r.lang == 0)
                .map(|r| r.text.clone())
        })
}

// ─── cmap：这款字体里有哪些字 ───────────────────

/// 一款字体认得的全部字，按码位排好、连着的并成一段
#[derive(Default, Clone, Debug)]
pub struct Coverage {
    ranges: Vec<(u32, u32)>,
    /// 符号字体（Wingdings 那种），码位落在私用区，不代表真有这些字
    pub symbol: bool,
}

impl Coverage {
    pub fn has(&self, c: u32) -> bool {
        let i = self.ranges.partition_point(|r| r.1 < c);
        self.ranges.get(i).is_some_and(|r| r.0 <= c)
    }

    pub fn has_all(&self, cs: &[char]) -> bool {
        cs.iter().all(|&c| self.has(c as u32))
    }

    /// 这段文字里缺哪些字。去重、保持出现的顺序；空白和控制符不算
    pub fn missing(&self, text: &str) -> Vec<char> {
        let mut seen = std::collections::HashSet::new();
        text.chars()
            .filter(|c| !c.is_whitespace() && !c.is_control())
            .filter(|&c| seen.insert(c))
            .filter(|&c| !self.has(c as u32))
            .collect()
    }

    /// 一串字里有几个是认得的
    pub fn count_in(&self, chars: &str) -> usize {
        chars.chars().filter(|&c| self.has(c as u32)).count()
    }
}

fn push_char(out: &mut Vec<(u32, u32)>, c: u32) {
    if let Some(last) = out.last_mut() {
        if last.1 + 1 == c {
            last.1 = c;
            return;
        }
    }
    out.push((c, c));
}

fn merge(mut v: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    v.sort_unstable();
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(v.len());
    for (a, b) in v {
        match out.last_mut() {
            Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

fn fmt0(s: &[u8]) -> Vec<(u32, u32)> {
    let mut out = vec![];
    for c in 0..256u32 {
        if s.get(6 + c as usize).is_some_and(|&g| g != 0) {
            push_char(&mut out, c);
        }
    }
    out
}

fn fmt4(s: &[u8]) -> Vec<(u32, u32)> {
    let seg = be16(s, 6) as usize / 2;
    let ends = 14;
    let starts = 16 + seg * 2;
    let deltas = starts + seg * 2;
    let ros = deltas + seg * 2;
    let mut out = vec![];
    for i in 0..seg {
        let end = be16(s, ends + i * 2) as u32;
        let start = be16(s, starts + i * 2) as u32;
        let delta = be16(s, deltas + i * 2) as u32;
        let ro = be16(s, ros + i * 2) as usize;
        if start > end || start == 0xFFFF {
            continue;
        }
        if ro == 0 {
            // 字形号 = (码位 + delta) mod 65536，只有算出来正好是 0 的那一个字是空的
            let hole = (0x10000 - delta) & 0xFFFF;
            if (start..=end).contains(&hole) {
                if hole > start {
                    out.push((start, hole - 1));
                }
                if hole < end {
                    out.push((hole + 1, end));
                }
            } else {
                out.push((start, end));
            }
        } else {
            // 这一段每个字单独查表，表里是 0 的就是没这个字
            let base = ros + i * 2 + ro;
            for c in start..=end {
                let g = be16(s, base + (c - start) as usize * 2) as u32;
                if g != 0 && (g + delta) & 0xFFFF != 0 {
                    push_char(&mut out, c);
                }
            }
        }
    }
    out
}

fn fmt6(s: &[u8]) -> Vec<(u32, u32)> {
    let first = be16(s, 6) as u32;
    let n = be16(s, 8) as u32;
    let mut out = vec![];
    for i in 0..n {
        if be16(s, 10 + i as usize * 2) != 0 {
            push_char(&mut out, first + i);
        }
    }
    out
}

fn fmt10(s: &[u8]) -> Vec<(u32, u32)> {
    let first = be32(s, 12);
    let n = be32(s, 16).min(0x11_0000);
    let mut out = vec![];
    for i in 0..n {
        if be16(s, 20 + i as usize * 2) != 0 {
            push_char(&mut out, first + i);
        }
    }
    out
}

/// format 12（一段码位对一段连续字形）和 13（一段码位全对同一个字形）
fn fmt12(s: &[u8], many_to_one: bool) -> Vec<(u32, u32)> {
    let n = (be32(s, 12) as usize).min(1_000_000);
    let mut out = Vec::with_capacity(n.min(100_000));
    for i in 0..n {
        let g = 16 + i * 12;
        if g + 12 > s.len() {
            break;
        }
        let (a, b, glyph) = (be32(s, g), be32(s, g + 4), be32(s, g + 8));
        if a > b || b > 0x10_FFFF {
            continue;
        }
        if many_to_one {
            if glyph != 0 {
                out.push((a, b));
            }
        } else if glyph == 0 {
            // 这一段的头一个字对的是 0 号字形（缺字框），从第二个算起
            if a < b {
                out.push((a + 1, b));
            }
        } else {
            out.push((a, b));
        }
    }
    out
}

pub fn parse_cmap(t: &[u8]) -> Coverage {
    let n = be16(t, 2) as usize;
    let mut best: Option<(u8, usize)> = None;
    for i in 0..n.min(64) {
        let r = 4 + i * 8;
        if r + 8 > t.len() {
            break;
        }
        let (p, e, off) = (be16(t, r), be16(t, r + 2), be32(t, r + 4) as usize);
        if off >= t.len() {
            continue;
        }
        let fmt = be16(t, off);
        // 完整 Unicode 的 format 12 最全；BMP 的 format 4 次之；Mac 老表和符号表垫底
        let rank = match (p, e, fmt) {
            (3, 10, 12) | (3, 10, 13) => 0,
            (0, 4, 12) | (0, 6, 13) | (0, 4, 13) => 1,
            (3, 1, 4) => 2,
            (0, _, 4) => 3,
            (0, _, 6) | (3, 1, 6) | (0, _, 10) | (3, 10, 10) => 4,
            (1, 0, 0) | (1, 0, 6) => 8,
            (3, 0, _) => 9,
            _ => continue,
        };
        if best.map_or(true, |(b, _)| rank < b) {
            best = Some((rank, off));
        }
    }
    let Some((rank, off)) = best else { return Coverage::default() };
    let s = &t[off..];
    let ranges = match be16(s, 0) {
        0 => fmt0(s),
        4 => fmt4(s),
        6 => fmt6(s),
        10 => fmt10(s),
        12 => fmt12(s, false),
        13 => fmt12(s, true),
        _ => vec![],
    };
    Coverage { ranges: merge(ranges), symbol: rank == 9 }
}

// ─── 一份字体的全部信息 ───────────────────────

#[derive(Clone, Debug, Default, Serialize)]
pub struct FaceInfo {
    /// .ttc 里的第几份
    pub index: u32,
    /// 显示用的族名：有中文名用中文名
    pub family: String,
    /// 英文族名。归并、搜索、跟推荐目录对名字都用它
    pub family_en: String,
    /// 老式族名（nameID 1）。PS、剪映的字体下拉框里多半是这个
    pub legacy_family: String,
    pub style: String,
    /// 全名（nameID 4）。页面上画样张就靠它找到这一份字体
    pub full_name: String,
    pub full_name_zh: String,
    pub postscript: String,
    pub weight: u16,
    pub italic: bool,
    /// 可变字体：一个文件里字重能连续调
    pub variable: bool,
    /// OS/2 里的嵌入许可位
    pub fs_type: u16,
    pub vendor_id: String,
    pub copyright: String,
    pub manufacturer: String,
    pub designer: String,
    pub vendor_url: String,
    /// 协议描述（nameID 13）。OFL 规定协议写在这里
    pub license: String,
    /// 协议网址（nameID 14）
    pub license_url: String,
    pub glyphs: u16,
    /// 简体中文
    pub sc: bool,
    /// 繁体中文
    pub tc: bool,
    /// 日文假名
    pub kana: bool,
    pub hangul: bool,
    /// 完整的西文字母和数字
    pub latin: bool,
    pub symbol: bool,
}

/// 查「有没有简体 / 繁体 / 假名」各挑几个字，要全都有才算。
/// 简繁要分开挑：日文字体里有「国」，但没有「这」「说」「们」这种简化字
const SC_PROBE: [char; 5] = ['的', '这', '说', '们', '国'];
const TC_PROBE: [char; 4] = ['這', '說', '們', '國'];
const KANA_PROBE: [char; 4] = ['あ', 'の', 'ア', 'ン'];
const HANGUL_PROBE: [char; 3] = ['한', '국', '어'];
const LATIN_PROBE: [char; 6] = ['A', 'Z', 'a', 'z', '0', '9'];

/// 读一个字体文件里的每一份字体。读不了的文件返回空
pub fn read_faces(path: &Path) -> Vec<FaceInfo> {
    let Some(mut font) = Font::open(path) else { return vec![] };
    let mut out = vec![];
    for (i, start) in font.starts().into_iter().enumerate() {
        let Some(dir) = font.directory(start) else { continue };
        let Some(name) = font.table(&dir, b"name") else { continue };
        let recs = parse_names(&name);
        let family = pick(&recs, 16, true).or_else(|| pick(&recs, 1, true)).unwrap_or_default();
        if family.is_empty() {
            continue;
        }
        let family_en = pick(&recs, 16, false)
            .or_else(|| pick(&recs, 1, false))
            .unwrap_or_else(|| family.clone());
        let legacy_family = pick(&recs, 1, false).unwrap_or_else(|| family_en.clone());
        let style = pick(&recs, 17, false).or_else(|| pick(&recs, 2, false)).unwrap_or_default();
        let full_name = pick(&recs, 4, false)
            .unwrap_or_else(|| format!("{legacy_family} {style}").trim().to_string());
        let get = |id: u16| pick(&recs, id, false).unwrap_or_default();

        let (weight, fs_type, italic, vendor_id) = match font.table(&dir, b"OS/2") {
            Some(t) => (
                be16(&t, 4),
                be16(&t, 8),
                // fsSelection 第 0 位是斜体，第 9 位是 oblique
                be16(&t, 62) & 0x0201 != 0,
                t.get(58..62)
                    .map(|v| String::from_utf8_lossy(v).trim_matches(|c: char| c == '\0' || c == ' ').to_string())
                    .unwrap_or_default(),
            ),
            None => (400, 0, false, String::new()),
        };
        let glyphs = font.table(&dir, b"maxp").map(|t| be16(&t, 4)).unwrap_or(0);
        let variable = dir.iter().any(|(t, _, _)| t == b"fvar");
        let cov = font.table(&dir, b"cmap").map(|t| parse_cmap(&t)).unwrap_or_default();

        out.push(FaceInfo {
            index: i as u32,
            full_name_zh: pick_zh(&recs, 4).unwrap_or_default(),
            postscript: get(6),
            copyright: get(0),
            manufacturer: get(8),
            designer: get(9),
            vendor_url: get(11),
            license: get(13),
            license_url: get(14),
            weight,
            italic: italic || style.to_lowercase().contains("italic") || style.to_lowercase().contains("oblique"),
            variable,
            fs_type,
            vendor_id,
            glyphs,
            sc: !cov.symbol && cov.has_all(&SC_PROBE),
            tc: !cov.symbol && cov.has_all(&TC_PROBE),
            kana: !cov.symbol && cov.has_all(&KANA_PROBE),
            hangul: !cov.symbol && cov.has_all(&HANGUL_PROBE),
            latin: !cov.symbol && cov.has_all(&LATIN_PROBE),
            symbol: cov.symbol,
            family,
            family_en,
            legacy_family,
            style,
            full_name,
        });
    }
    out
}

/// 某个字体文件里第 index 份字体认得哪些字
pub fn coverage(path: &Path, index: u32) -> Option<Coverage> {
    let mut font = Font::open(path)?;
    let start = *font.starts().get(index as usize)?;
    let dir = font.directory(start)?;
    font.table(&dir, b"cmap").map(|t| parse_cmap(&t))
}

pub fn is_font_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("ttf" | "otf" | "ttc" | "otc")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手搓一张只有一个 format 4 子表的 cmap
    fn cmap_with(sub: Vec<u8>) -> Vec<u8> {
        let mut t = vec![0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12];
        t.extend(sub);
        t
    }

    fn fmt4_table(segs: &[(u16, u16, i16, u16)], glyph_array: &[u16]) -> Vec<u8> {
        let n = segs.len() as u16;
        let mut s = vec![];
        let w = |s: &mut Vec<u8>, v: u16| s.extend(v.to_be_bytes());
        w(&mut s, 4);
        w(&mut s, 0);
        w(&mut s, 0);
        w(&mut s, n * 2);
        w(&mut s, 0);
        w(&mut s, 0);
        w(&mut s, 0);
        for sg in segs {
            w(&mut s, sg.1);
        }
        w(&mut s, 0);
        for sg in segs {
            w(&mut s, sg.0);
        }
        for sg in segs {
            w(&mut s, sg.2 as u16);
        }
        for sg in segs {
            w(&mut s, sg.3);
        }
        for g in glyph_array {
            w(&mut s, *g);
        }
        s
    }

    #[test]
    fn format4_delta_and_lookup() {
        // 段 1：'A'..'C' 走 delta，全有
        // 段 2：'a'..'c' 查表：a 有、b 是 0（没有）、c 有
        // 段 3：结束标记
        let segs = [
            (0x41, 0x43, -0x40, 0),
            (0x61, 0x63, 0, 4), // 离 glyphIdArray 还差两段 × 2 字节
            (0xFFFF, 0xFFFF, 1, 0),
        ];
        let cov = parse_cmap(&cmap_with(fmt4_table(&segs, &[5, 0, 7])));
        assert!(cov.has('A' as u32) && cov.has('C' as u32));
        assert!(!cov.has('D' as u32));
        assert!(cov.has('a' as u32));
        assert!(!cov.has('b' as u32), "表里是 0 的字不算有");
        assert!(cov.has('c' as u32));
        assert_eq!(cov.missing("Abc d"), vec!['b', 'd']);
    }

    #[test]
    fn format12_skips_notdef_start() {
        let mut s = vec![0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
        for (a, b, g) in [(0x4E00u32, 0x4E05u32, 0u32), (0x1F600, 0x1F601, 9)] {
            s.extend(a.to_be_bytes());
            s.extend(b.to_be_bytes());
            s.extend(g.to_be_bytes());
        }
        let mut t = vec![0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12];
        t.extend(s);
        let cov = parse_cmap(&t);
        assert!(!cov.has(0x4E00), "对到 0 号字形的那个字是缺的");
        assert!(cov.has(0x4E01) && cov.has(0x4E05));
        assert!(cov.has(0x1F601));
        assert_eq!(cov.count_in("丁七😁"), 3);
    }

    #[test]
    fn merge_joins_adjacent() {
        assert_eq!(merge(vec![(5, 6), (1, 2), (3, 4), (10, 12)]), vec![(1, 6), (10, 12)]);
    }

    #[test]
    fn gbk_name_decodes() {
        // 「黑体」的 GBK 是 BA DA CC E5，老字体按 16 位存
        assert_eq!(decode_name(3, 3, &[0xBA, 0xDA, 0xCC, 0xE5]), "黑体");
        assert_eq!(decode_name(3, 3, &[0x00, b'A', 0xBA, 0xDA]), "A黑");
    }

    /// 拿本机的系统字体验一遍（没有这些文件的机器上直接跳过）
    #[test]
    fn real_windows_fonts() {
        let arial = Path::new(r"C:\Windows\Fonts\arial.ttf");
        if arial.exists() {
            let f = &read_faces(arial)[0];
            assert_eq!(f.family_en, "Arial");
            assert!(f.latin && !f.sc && !f.kana);
        }
        let yahei = Path::new(r"C:\Windows\Fonts\msyh.ttc");
        if yahei.exists() {
            let faces = read_faces(yahei);
            assert!(faces.len() >= 2, "msyh.ttc 里至少两份");
            assert!(faces.iter().any(|f| f.family_en == "Microsoft YaHei"));
            assert!(faces.iter().any(|f| f.family_en == "Microsoft YaHei UI"));
            assert!(faces[0].sc && faces[0].latin);
            assert!(faces[0].family.contains("微软雅黑"), "中文名：{}", faces[0].family);
            let cov = coverage(yahei, 0).unwrap();
            assert!(cov.missing("游戏字体 Game 123").is_empty());
        }
    }
}
