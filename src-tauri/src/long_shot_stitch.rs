/*!
长截图的拼接：一帧一帧喂进来，接成一张长图。

# 要解决的事

滚动截图每抓一帧，和上一帧总有一大块是重叠的 —— 到底重叠了多少，得算出来。
按「我发了几格滚轮 × 每格多少像素」去猜是不行的：每个应用一格滚多少行都不一样，
带平滑滚动动画的还会在半路上被抓到。**只能拿画面自己去对。**

# 怎么对

拿上一帧**底部**的一条带子（band），在新一帧里从上往下找它出现在哪。
找到的位置一减，就知道内容往上跑了多少（`advance`），新露出来的就是新一帧
最下面那么多行。

为什么取底部而不是整帧：**网页的吸顶栏不跟着滚**。拿整帧去对，那条永远不动的
顶栏会把结果拽向「没滚动」。底部这条带子是纯内容区，滚多少它就跑多少。
（吸底栏会坑到这个办法，这是已知的边界，见 `find_advance` 里的注释。）

# 必须**容差**比，不能逐字节比

第一版是把每行压成一个哈希再比相等，快，但**在真实画面上几乎全军覆没**。
实测：一屏笔记正文往下滚 100 像素，前后两帧的重叠区里逐行字节相同的只有
**160 行里的 18 行**（11%）—— 滚动之后文字是重新栅格化的，亚像素抗锯齿差一点点，
整行的字节就不一样了。于是拼接器一路报「认不出」，长图只有第一屏。

换成「抽若干列、转灰度、算平均绝对差」之后，同一对画面：正确位移的平均差 0.07，
差一行的 2.53，完全对不上的 38 —— 信号清清楚楚。慢一点，但这是唯一能用的路。

**纯色行不参与打分**：一片空白里每行都长一样，随便对到哪儿都「完美匹配」，
拿它当证据会算出完全错误的位移。
*/

/// 底部那条带子最多取多高。太矮了证据不足，太高了留给滚动的余地就少
const BAND_MAX: usize = 220;
/// 每行抽多少列出来比。抽样只是为了快，48 列足够把一行的样子说清楚
const SAMPLES: usize = 48;
/// 带子里至少要有这么多「有内容的行」，否则这一帧不作数（对着一片空白没法定位）
const MIN_TEXTURED_ROWS: usize = 12;
/// 平均绝对差小于这个数才算对上。实测正确位移 0.07、错一行 2.5、完全不搭 38
const MAX_DIFF: f32 = 8.0;
/// 分数差在这个范围内算平手
const TIE: f32 = 0.5;
/// 判断「这一行是不是纯色」的容忍度
const FLAT_EPS: u8 = 2;

/// 一帧的指纹：逐行抽样灰度 + 哪些行是纯色
pub struct FrameSig {
    /// h * SAMPLES 个灰度值
    px: Vec<u8>,
    flat: Vec<bool>,
}

/// 把一帧 RGBA 压成指纹
pub fn frame_sig(rgba: &[u8], w: usize, h: usize) -> FrameSig {
    let stride = w * 4;
    let cols: Vec<usize> = (0..SAMPLES)
        .map(|i| (i * (w.saturating_sub(1))) / SAMPLES.max(1).saturating_sub(1).max(1))
        .map(|x| x.min(w.saturating_sub(1)))
        .collect();

    let mut px = Vec::with_capacity(h * SAMPLES);
    let mut flat = Vec::with_capacity(h);
    for y in 0..h {
        let row = &rgba[y * stride..y * stride + stride];
        let (mut lo, mut hi) = (255u8, 0u8);
        for &x in &cols {
            let p = &row[x * 4..x * 4 + 3];
            let g = ((p[0] as u16 + p[1] as u16 + p[2] as u16) / 3) as u8;
            px.push(g);
            lo = lo.min(g);
            hi = hi.max(g);
        }
        flat.push(hi.saturating_sub(lo) <= FLAT_EPS);
    }
    FrameSig { px, flat }
}

/// 上一帧到新一帧，内容往上跑了多少行。
///
/// `None` = 对不上（画面整个换了、或者这一块根本没有可辨认的内容）。
/// `Some(0)` = 一模一样，没滚动。
///
/// **已知边界**：吸底栏。带子取的是底部，页面底下如果压着一条不滚的工具栏，
/// 那条带子里有一截是不动的，会把 advance 往小了算 —— 表现是长图里有一段重复。
/// 真遇到了再说：代价是每帧多算一遍「顶部带子」去交叉验证，现在不值这个复杂度。
pub fn find_advance(prev: &FrameSig, next: &FrameSig, h: usize) -> Option<usize> {
    let band = BAND_MAX.min(h / 3).max(16);
    if h < band * 2 {
        return None;
    }
    let start = h - band;
    let rows: Vec<usize> = (start..h).filter(|&i| !prev.flat[i]).collect();
    if rows.len() < MIN_TEXTURED_ROWS {
        return None;
    }

    let mut best = (f32::MAX, 0usize);
    // k = 带子在新一帧里的起始行；advance = start - k。
    // 从大到小扫 = advance 从小到大，平手时天然留住 advance 更小的那个
    for k in (0..=start).rev() {
        let mut sum = 0u32;
        for &i in &rows {
            let a = &prev.px[i * SAMPLES..(i + 1) * SAMPLES];
            let j = i - start + k;
            let b = &next.px[j * SAMPLES..(j + 1) * SAMPLES];
            for (x, y) in a.iter().zip(b) {
                sum += x.abs_diff(*y) as u32;
            }
        }
        let diff = sum as f32 / (rows.len() * SAMPLES) as f32;
        /*
            平手时留住 advance 小的那个。
            宁可少推进、让长图里重复一小段，也不能多推进 —— 多推进等于把中间
            那几行永远漏掉了，而漏掉的内容事后根本看不出来。
        */
        if diff < best.0 - TIE {
            best = (diff, start - k);
        }
    }

    if best.0 <= MAX_DIFF {
        Some(best.1)
    } else {
        None
    }
}

/// 攒着的那张长图
pub struct Stitcher {
    pub width: usize,
    pub frame_h: usize,
    /// RGBA，长度 = width * height * 4
    canvas: Vec<u8>,
    height: usize,
    prev: Option<FrameSig>,
}

/// 喂一帧进去发生了什么
#[derive(Debug, PartialEq, Eq)]
pub enum Push {
    /// 接上了，新增这么多行
    Grew(usize),
    /// 画面没动
    Same,
    /// 对不上（内容整个换了、或者这一块认不出来）
    Lost,
}

impl Stitcher {
    pub fn new(width: usize, frame_h: usize) -> Self {
        Self { width, frame_h, canvas: Vec::new(), height: 0, prev: None }
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// 拿走结果
    pub fn into_image(self) -> (Vec<u8>, usize, usize) {
        (self.canvas, self.width, self.height)
    }

    pub fn push(&mut self, frame: &[u8]) -> Push {
        let stride = self.width * 4;
        debug_assert_eq!(frame.len(), stride * self.frame_h);
        let sig = frame_sig(frame, self.width, self.frame_h);

        let Some(prev) = self.prev.as_ref() else {
            // 第一帧：整帧就是长图的开头
            self.canvas.extend_from_slice(frame);
            self.height = self.frame_h;
            self.prev = Some(sig);
            return Push::Grew(self.frame_h);
        };

        match find_advance(prev, &sig, self.frame_h) {
            None => Push::Lost,
            Some(0) => Push::Same,
            Some(d) => {
                // 新露出来的就是这一帧最下面 d 行
                let from = (self.frame_h - d) * stride;
                self.canvas.extend_from_slice(&frame[from..]);
                self.height += d;
                self.prev = Some(sig);
                Push::Grew(d)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 60;
    const FH: usize = 120;

    /// 造一张高 h 的图，每一行都不一样 —— 拼错一行就能看出来
    fn tall(h: usize) -> Vec<u8> {
        let mut v = Vec::with_capacity(W * h * 4);
        for y in 0..h {
            for x in 0..W {
                // 让灰度随 y 大幅变化，抽样比对才有信号
                let g = ((y * 37 + x * 11) % 251) as u8;
                v.extend_from_slice(&[g, g.wrapping_add(40), g.wrapping_add(90), 255]);
            }
        }
        v
    }

    fn frame_at(src: &[u8], top: usize) -> Vec<u8> {
        src[top * W * 4..(top + FH) * W * 4].to_vec()
    }

    /// 抗锯齿抖动：每个像素随机 ±2。真实滚动就是这么把逐字节比对干掉的
    fn jitter(f: &[u8], seed: u64) -> Vec<u8> {
        let mut s = seed | 1;
        f.iter()
            .enumerate()
            .map(|(i, &b)| {
                if i % 4 == 3 {
                    return b; // alpha 不动
                }
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let d = ((s >> 33) % 5) as i16 - 2;
                (b as i16 + d).clamp(0, 255) as u8
            })
            .collect()
    }

    #[test]
    fn 一帧一帧接回原图() {
        let total = 600;
        let src = tall(total);
        let mut st = Stitcher::new(W, FH);

        let mut top = 0;
        assert_eq!(st.push(&frame_at(&src, top)), Push::Grew(FH));
        // 每次滚 37 行(故意用个不整齐的数)，滚到底
        while top + FH < total {
            let step = 37.min(total - FH - top);
            top += step;
            assert_eq!(st.push(&frame_at(&src, top)), Push::Grew(step), "top={top}");
        }

        let (canvas, w, h) = st.into_image();
        assert_eq!((w, h), (W, total));
        assert_eq!(canvas, src, "拼出来的和原图不一样");
    }

    /// 这一条就是第一版栽的地方：像素被抖过之后逐字节比对全部失效
    #[test]
    fn 像素有轻微抖动也要认得出来() {
        let src = tall(500);
        let mut st = Stitcher::new(W, FH);
        st.push(&jitter(&frame_at(&src, 0), 7));
        assert_eq!(st.push(&jitter(&frame_at(&src, 60), 99)), Push::Grew(60));
        assert_eq!(st.push(&jitter(&frame_at(&src, 120), 12345)), Push::Grew(60));
    }

    #[test]
    fn 没滚动就是没滚动() {
        let src = tall(400);
        let mut st = Stitcher::new(W, FH);
        st.push(&frame_at(&src, 0));
        assert_eq!(st.push(&frame_at(&src, 0)), Push::Same);
        assert_eq!(st.height(), FH);
    }

    #[test]
    fn 吸顶栏不影响判断() {
        // 顶部 30 行永远不动，下面照常滚
        let total = 500;
        let src = tall(total);
        let sticky = frame_at(&src, 0)[..30 * W * 4].to_vec();
        let with_sticky = |top: usize| {
            let mut f = frame_at(&src, top);
            f[..30 * W * 4].copy_from_slice(&sticky);
            f
        };

        let mut st = Stitcher::new(W, FH);
        st.push(&with_sticky(0));
        assert_eq!(st.push(&with_sticky(50)), Push::Grew(50));
        assert_eq!(st.push(&with_sticky(100)), Push::Grew(50));
    }

    #[test]
    fn 一片空白认不出来位移() {
        // 全白的一帧没有任何可辨认的东西,宁可说"认不出"也不能瞎接
        let blank = vec![255u8; W * FH * 4];
        let mut st = Stitcher::new(W, FH);
        st.push(&blank);
        assert_eq!(st.push(&blank), Push::Lost);
    }

    #[test]
    fn 画面整个换掉了() {
        let a = tall(FH);
        let mut b = tall(FH);
        for (i, px) in b.chunks_exact_mut(4).enumerate() {
            px[0] = ((i * 97) & 0xff) as u8;
            px[1] = ((i * 151) & 0xff) as u8;
            px[2] = ((i * 211) & 0xff) as u8;
        }
        let mut st = Stitcher::new(W, FH);
        st.push(&a);
        assert_eq!(st.push(&b), Push::Lost);
    }
}
