//! 字体协议：能不能商用、能不能打包进游戏。
//!
//! 结论只看两样东西：**字体文件里自己写的协议**（name 表 13、14 条），和几张我们认得的名单
//! （Windows 自带的、厂商声明免费商用的、商业字库厂）。认不出就老实说认不出，不猜。
//!
//! # 分档
//!
//! | 档 | 是什么 | 游戏打包 | 视频 | 做图印刷 |
//! |---|---|---|---|---|
//! | open    | OFL / Apache / MIT 这类开源协议 | 可以 | 可以 | 可以 |
//! | free    | 厂商说免费商用，但不是开源协议 | 看条款 | 可以 | 可以 |
//! | paid    | 商业字体，要买授权 | 不行 | 不行 | 不行 |
//! | system  | 随 Windows 来的 | 不行 | 有风险 | 有风险 |
//! | unknown | 文件里没写，名单里也没有 | 自己查 | 自己查 | 自己查 |
//!
//! 「免费但不开源」单独一档，是因为这类条款随时会改（站酷、阿里都改过），
//! 而且各家对「嵌进软件里分发」的说法不一样 —— 视频和海报一般没事，打包进游戏要看条款。

use crate::font_sfnt::FaceInfo;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Open,
    Free,
    Unknown,
    System,
    Paid,
}

/// 某一种用途能不能用
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mark {
    Yes,
    /// 能用，但有风险
    Warn,
    No,
    /// 说不准，要自己去看条款
    Ask,
}

#[derive(Serialize, Clone, Debug)]
pub struct Verdict {
    pub tier: Tier,
    /// 界面上显示的协议名：OFL、Apache、厂商免费商用、Windows 自带……
    pub license: String,
    pub game: Mark,
    pub video: Mark,
    pub print: Mark,
    /// 一两句大白话：为什么是这个结论、用的时候要注意什么
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Ofl,
    Apache,
    Mit,
    Ufl,
    Ipa,
    Gpl,
    Arphic,
    Cc0,
    CcBy,
    PublicDomain,
    NonCommercial,
    FreeCommercial,
    Other,
    Blank,
}

fn kind_of(desc: &str, url: &str) -> Kind {
    let t = format!("{} {}", desc.to_lowercase(), url.to_lowercase());
    let any = |ks: &[&str]| ks.iter().any(|k| t.contains(k));
    // 「不许商用」先看：CC BY-NC、仅限个人使用这些字眼一出现，别的写得再好听也不算
    if any(&[
        "non-commercial", "noncommercial", "non commercial", "by-nc", "personal use only",
        "for personal use", "个人使用", "个人非商业", "非商业", "禁止商用", "不得用于商业", "不可商用",
    ]) {
        Kind::NonCommercial
    } else if any(&[
        "open font license", "scripts.sil.org/ofl", "openfontlicense.org", "ofl-1.1", "ofl 1.1",
        "sil ofl", "/ofl.txt",
    ]) {
        Kind::Ofl
    } else if any(&["apache license", "apache.org/licenses"]) {
        Kind::Apache
    } else if any(&["mit license", "permission is hereby granted, free of charge", "opensource.org/licenses/mit"]) {
        Kind::Mit
    } else if any(&["ubuntu font licence", "ubuntu font license"]) {
        Kind::Ufl
    } else if any(&["ipa font license", "opensource.org/licenses/ipafont"]) {
        Kind::Ipa
    } else if any(&["gnu general public", "gnu.org/licenses/gpl", "font exception"]) {
        Kind::Gpl
    } else if any(&["arphic public license"]) {
        Kind::Arphic
    } else if any(&["creativecommons.org/publicdomain/zero", "cc0"]) {
        Kind::Cc0
    } else if any(&["public domain", "公有领域"]) {
        Kind::PublicDomain
    } else if any(&["creativecommons.org/licenses/by/", "creative commons attribution", "cc by 4.0", "cc-by"]) {
        Kind::CcBy
    } else if any(&[
        "免费商用", "免费可商用", "可免费商用", "可商用", "free for commercial", "free commercial",
        "commercial use is permitted", "free for personal and commercial",
    ]) {
        Kind::FreeCommercial
    } else if t.trim().is_empty() {
        Kind::Blank
    } else {
        Kind::Other
    }
}

// ─── 名单 ───────────────────────────────────────

/// Windows 自带的字体族（英文族名，小写）。整名对上，或者是它开头再跟一个空格（「Segoe UI Black」）
const WINDOWS_FAMILIES: &[&str] = &[
    "arial", "arial black", "bahnschrift", "calibri", "cambria", "cambria math", "candara",
    "comic sans ms", "consolas", "constantia", "corbel", "courier new", "ebrima",
    "franklin gothic", "gabriola", "gadugi", "georgia", "holomdl2 assets", "hololens mdl2 assets",
    "impact", "ink free", "javanese text", "leelawadee", "leelawadee ui", "lucida console",
    "lucida sans unicode", "malgun gothic", "marlett", "microsoft himalaya", "microsoft jhenghei",
    "microsoft new tai lue", "microsoft phagspa", "microsoft sans serif", "microsoft tai le",
    "microsoft yahei", "microsoft yi baiti", "mingliu-extb", "pmingliu-extb", "mingliu_hkscs-extb",
    "mingliu_mscs-extb",
    "mongolian baiti", "ms gothic", "ms pgothic", "ms ui gothic", "mv boli", "myanmar text",
    "nirmala ui", "nirmala text", "palatino linotype", "segoe fluent icons", "segoe mdl2 assets",
    "segoe print", "segoe script", "segoe ui", "segoe ui emoji", "segoe ui historic",
    "segoe ui symbol", "segoe ui variable", "simsun", "nsimsun", "simsun-extb", "simsun-extg",
    "simhei", "kaiti", "fangsong", "dengxian", "sitka", "sylfaen", "symbol", "tahoma",
    "times new roman", "trebuchet ms", "verdana", "webdings", "wingdings", "yu gothic",
    "yu gothic ui", "yu mincho", "meiryo", "meiryo ui", "ms mincho", "ms pmincho", "mingliu",
    "pmingliu", "mingliu_hkscs", "dfkai-sb", "gulim", "gulimche", "dotum", "dotumche", "batang",
    "batangche", "gungsuh", "gungsuhche", "ud digi kyokasho", "biz udgothic", "biz udmincho",
    "biz udpgothic", "biz udpmincho", "segoe ui black", "segoe ui light", "segoe ui semibold",
    "segoe ui semilight", "cascadia code", "cascadia mono",
];

/// 随 Windows 来的中文字体。字形多半是方正、中易这些字库厂做的，拿去商用风险最大
const WINDOWS_CJK: &[&str] = &[
    "microsoft yahei", "simsun", "nsimsun", "simhei", "kaiti", "fangsong", "dengxian",
    "microsoft jhenghei", "mingliu", "pmingliu", "dfkai-sb",
];

fn in_list(list: &[&str], family: &str) -> bool {
    let f = family.trim().to_lowercase();
    list.iter().any(|&k| f == k || f.starts_with(&format!("{k} ")))
}

/// 这个族名是不是 Windows 自带的那一批（Cascadia 这种开源的也算，它也是随系统来的）
pub fn is_windows_family(family_en: &str) -> bool {
    in_list(WINDOWS_FAMILIES, family_en)
}

/// 厂商声明免费商用、但不是开源协议的（在族名、中文名、版权里找）
const FREE_VENDOR: &[&str] = &[
    "alibaba puhuiti", "alibaba-puhuiti", "阿里巴巴普惠体", "alimama", "阿里妈妈",
    "dingtalk", "钉钉进步体", "harmonyos sans", "harmonyos_sans", "misans", "oppo sans",
    "opposans", "vivo sans", "vivosans", "honor sans", "douyin sans", "抖音美好体",
    "tencent sans", "tencentsans", "腾讯体", "youshebiaotihei", "优设标题黑", "优设好身体",
    "pangmenzhengdao", "庞门正道", "zcool", "站酷", "胡晓波", "hu xiaobo", "包图小白体",
    "yrdzst", "杨任东竹石体", "演示春风楷", "演示夏行楷", "演示秋鸿楷", "演示悠然小楷",
    "演示佛系体", "字体圈欣意冠黑", "xinyiguanhei", "峰广明锐体",
];

/// 方正四款免费商用字体（黑、书宋、仿宋、楷）。要先在方正官网登记才算拿到授权
const FOUNDER_FREE: &[&str] = &["fzhei-b01", "fzshusong-z01", "fzfangsong-z02", "fzkai-z03"];

/// 商业字库厂：版权、厂商、网址、族名里出现这些字眼
const PAID_VENDORS: &[(&str, &str)] = &[
    ("founder", "方正"), ("方正", "方正"), ("hanyi", "汉仪"), ("汉仪", "汉仪"),
    ("dynacomware", "华康"), ("dynafont", "华康"), ("华康", "华康"), ("arphic", "文鼎"),
    ("文鼎", "文鼎"), ("makefont", "造字工房"), ("造字工房", "造字工房"),
    ("sinotype", "华文"), ("华文", "华文"), ("monotype", "Monotype"), ("linotype", "Linotype"),
    ("international typeface", "ITC"), ("agfa", "Agfa"), ("bitstream", "Bitstream"),
    ("adobe systems", "Adobe"), ("adobe inc", "Adobe"), ("morisawa", "森泽"),
    ("fontworks", "Fontworks"), ("iwata", "岩田"), ("typebank", "Typebank"), ("sandoll", "Sandoll"),
    ("yoon design", "Yoon"), ("hoefler", "Hoefler"), ("font bureau", "Font Bureau"),
    ("emigre", "Emigre"), ("dalton maag", "Dalton Maag"), ("字魂", "字魂"), ("hanbiao", "汉标"),
    ("汉标", "汉标"),
    // Office 带进来的那一批：隶书、幼圆是四通的，Papyrus 这些是 Letraset（Esselte）的
    ("stone co", "四通"), ("esselte", "Letraset"), ("letraset", "Letraset"),
    ("bigelow", "Bigelow & Holmes"), (" urw", "URW"), ("ricoh", "理光"), ("design science", "Design Science"),
    // 软件自己带的：华硕奥创中心、腾讯应用宝……版权写明不许拿出去用
    ("asus design center", "华硕"), ("tencent technology", "腾讯"),
    // 放最后：前面几家的字常写着「Portions Copyright Microsoft」，要先认出真正的出处
    ("microsoft", "微软"),
];

/// 族名开头就能认出厂家的：方正（FZ…）、汉仪（HY…）
const PAID_PREFIXES: &[(&str, &str)] = &[("fz", "方正"), ("hy", "汉仪")];

// ─── 下结论 ─────────────────────────────────────

fn open(license: &str, notes: &[&str]) -> Verdict {
    Verdict {
        tier: Tier::Open,
        license: license.into(),
        game: Mark::Yes,
        video: Mark::Yes,
        print: Mark::Yes,
        notes: notes.iter().map(|s| s.to_string()).collect(),
    }
}

/// 字体文件自己把嵌入许可标成「受限」（fsType 低 4 位是 2）
fn restricted(f: &FaceInfo) -> bool {
    f.fs_type & 0x000F == 0x0002
}

/// 一份字体的协议结论。`in_windows_dir` = 文件在 C:\Windows\Fonts 里
pub fn assess(f: &FaceInfo, in_windows_dir: bool) -> Verdict {
    const OFL_NOTE: &str = "打包进游戏时，把协议文件（OFL.txt）一起放进去；不能单独拿字体去卖";
    const ATTACH_NOTE: &str = "打包进游戏时，把协议文件一起放进去";
    match kind_of(&f.license, &f.license_url) {
        Kind::Ofl => return open("OFL", &[OFL_NOTE]),
        Kind::Apache => return open("Apache", &[ATTACH_NOTE]),
        Kind::Mit => return open("MIT", &[ATTACH_NOTE]),
        Kind::Ufl => return open("Ubuntu 字体协议", &[ATTACH_NOTE]),
        Kind::Ipa => return open("IPA", &[ATTACH_NOTE]),
        Kind::Arphic => return open("文鼎公众授权", &[ATTACH_NOTE]),
        Kind::Cc0 => return open("CC0", &[]),
        Kind::PublicDomain => return open("公有领域", &[]),
        Kind::Gpl => return open("GPL", &["打包进游戏可以，但字体文件本身要保持 GPL，并附上协议"]),
        Kind::CcBy => return open("CC BY", &["用的时候要署上作者名字"]),
        Kind::NonCommercial => {
            return Verdict {
                tier: Tier::Paid,
                license: "只许个人非商用".into(),
                game: Mark::No,
                video: Mark::No,
                print: Mark::No,
                notes: vec!["协议里写明了只许个人、非商业使用；商用要另外买授权".into()],
            }
        }
        _ => {}
    }

    let names = format!("{} | {} | {}", f.family_en, f.family, f.legacy_family).to_lowercase();
    let hay = format!(
        "{names} | {} | {} | {} | {} | {}",
        f.copyright, f.manufacturer, f.designer, f.vendor_url, f.license
    )
    .to_lowercase();
    let fam_en = f.family_en.to_lowercase();
    let kind = kind_of(&f.license, &f.license_url);

    // 方正那四款得在「商业字库厂」之前认，不然会被当成要买授权
    if FOUNDER_FREE.iter().any(|k| fam_en.starts_with(k) || f.legacy_family.to_lowercase().starts_with(k)) {
        return Verdict {
            tier: Tier::Free,
            license: "方正免费商用".into(),
            game: Mark::Ask,
            video: Mark::Yes,
            print: Mark::Yes,
            notes: vec![
                "方正免费商用的四款之一，但要先在方正官网登记，拿到授权书才算数".into(),
                "打包进游戏要看方正的条款".into(),
            ],
        };
    }

    if kind == Kind::FreeCommercial || FREE_VENDOR.iter().any(|k| hay.contains(k)) {
        let mut v = Verdict {
            tier: Tier::Free,
            license: "厂商免费商用".into(),
            game: Mark::Ask,
            video: Mark::Yes,
            print: Mark::Yes,
            notes: vec![
                "厂商说可以免费商用，但不是开源协议，条款随时会改，以官网为准".into(),
                "打包进游戏要看条款：有的允许嵌进软件，有的不许".into(),
            ],
        };
        if restricted(f) {
            v.game = Mark::No;
            v.notes.push("字体文件自己标了「不许嵌入」".into());
        }
        return v;
    }

    if in_windows_dir && in_list(WINDOWS_FAMILIES, &f.family_en) {
        let mut notes = vec![
            "随 Windows 来的，只授权在这台电脑上显示和打印".into(),
            "不能拿去分发，所以不能打包进游戏；做商用视频、海报也有风险".into(),
        ];
        if in_list(WINDOWS_CJK, &f.family_en) {
            notes.push("中文的这几款字形是方正、中易这些字库厂做的，他们一直在追商用侵权，视频和海报里尽量别用".into());
        }
        return Verdict {
            tier: Tier::System,
            license: "Windows 自带".into(),
            game: Mark::No,
            video: Mark::Warn,
            print: Mark::Warn,
            notes,
        };
    }

    let vendor = PAID_VENDORS
        .iter()
        .find(|(k, _)| hay.contains(k))
        .map(|(_, v)| *v)
        .or_else(|| {
            // 族名开头的 FZ / HY 只在中文字体上认，免得误伤叫 Hyper… 的西文字体
            (f.sc || f.tc)
                .then(|| PAID_PREFIXES.iter().find(|(p, _)| fam_en.starts_with(p)).map(|(_, v)| *v))
                .flatten()
        });
    if let Some(v) = vendor {
        let mut notes = vec![format!("出自{v}，是商业字体：商用要先买授权；自己看、个人非商用一般没问题")];
        if in_windows_dir {
            notes.push("多半是装 Office 之类的软件时带进来的，只授权在那个软件里用".into());
        }
        return Verdict {
            tier: Tier::Paid,
            license: format!("{v}（商业字体）"),
            game: Mark::No,
            video: Mark::No,
            print: Mark::No,
            notes,
        };
    }

    let mut v = Verdict {
        tier: Tier::Unknown,
        license: "认不出".into(),
        game: Mark::Ask,
        video: Mark::Ask,
        print: Mark::Ask,
        notes: vec![if kind == Kind::Other {
            "字体里写了协议，但认不出是哪一种，点开原文自己看".into()
        } else {
            "字体文件里没写协议，商用前自己查一下出处".into()
        }],
    };
    if restricted(f) {
        v.game = Mark::No;
        v.notes.push("字体文件自己标了「不许嵌入」".into());
    }
    v
}

/// 一族好几份字体，结论取最严的那份
pub fn assess_family<'a>(faces: impl Iterator<Item = (&'a FaceInfo, bool)>) -> Option<Verdict> {
    faces.map(|(f, w)| assess(f, w)).max_by_key(|v| v.tier)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(family_en: &str, license: &str, copyright: &str) -> FaceInfo {
        FaceInfo {
            family: family_en.into(),
            family_en: family_en.into(),
            legacy_family: family_en.into(),
            license: license.into(),
            copyright: copyright.into(),
            ..Default::default()
        }
    }

    #[test]
    fn ofl_is_open_everywhere() {
        let v = assess(
            &face("LXGW WenKai", "This Font Software is licensed under the SIL Open Font License, Version 1.1.", ""),
            false,
        );
        assert_eq!((v.tier, v.game, v.video, v.print), (Tier::Open, Mark::Yes, Mark::Yes, Mark::Yes));
        assert_eq!(v.license, "OFL");
    }

    #[test]
    fn ofl_by_url_only() {
        let mut f = face("Some Font", "", "");
        f.license_url = "https://openfontlicense.org".into();
        assert_eq!(assess(&f, false).tier, Tier::Open);
    }

    #[test]
    fn windows_fonts_cannot_ship_in_games() {
        let arial = face(
            "Arial",
            "You may use this font as permitted by the EULA for the product in which this font is included to display and print content.",
            "© 2017 The Monotype Corporation. All Rights Reserved.",
        );
        let v = assess(&arial, true);
        assert_eq!(v.tier, Tier::System, "Windows 名单要排在 Monotype 前面");
        assert_eq!((v.game, v.video), (Mark::No, Mark::Warn));
        // 同名字体不在 Windows 目录里（自己装了一份），就不能当成系统自带
        assert_ne!(assess(&arial, false).tier, Tier::System);

        let mut yahei = face("Microsoft YaHei", "", "© 2017 Microsoft Corporation. All Rights Reserved.");
        yahei.family = "微软雅黑".into();
        let v = assess(&yahei, true);
        assert_eq!(v.tier, Tier::System);
        assert!(v.notes.iter().any(|n| n.contains("方正")));
        assert_eq!(assess(&face("Segoe UI Black", "", ""), true).tier, Tier::System);
    }

    #[test]
    fn vendor_free_and_founder_free() {
        let v = assess(&face("Alibaba PuHuiTi 3.0", "", "Alibaba"), false);
        assert_eq!((v.tier, v.game, v.video), (Tier::Free, Mark::Ask, Mark::Yes));
        let v = assess(&face("FZHei-B01S", "", "Beijing Founder Electronics Co.,Ltd."), false);
        assert_eq!(v.tier, Tier::Free, "方正免费四款不能被当成商业字体");
        assert!(v.notes[0].contains("登记"));
    }

    #[test]
    fn commercial_vendors() {
        let mut f = face("FZLanTingHei-R-GBK", "", "Copyright(c) Beijing Founder Electronics Co.,Ltd.");
        f.sc = true;
        let v = assess(&f, false);
        assert_eq!((v.tier, v.game, v.print), (Tier::Paid, Mark::No, Mark::No));
        assert!(v.license.contains("方正"));
        // 没写厂家、但族名 HY 开头的中文字体
        let mut hy = face("HYQiHei", "", "");
        hy.sc = true;
        assert_eq!(assess(&hy, false).tier, Tier::Paid);
        // 西文字体叫 Hyper 什么的，不能被 HY 前缀误伤
        assert_eq!(assess(&face("Hyperion", "", ""), false).tier, Tier::Unknown);
        // Office 带进来的：隶书是四通的；Papyrus 写着「Portions Copyright Microsoft」，出处要认成 Letraset
        let v = assess(&face("LiSu", "", "(C) Copyright Stone Co., 1996"), true);
        assert_eq!(v.tier, Tier::Paid);
        assert!(v.notes.iter().any(|n| n.contains("Office")), "Windows 目录里的商业字体要提一句是软件带进来的");
        let v = assess(&face("Papyrus", "", "Copyright © Esselte Corporation 1997.  Portions Copyright Microsoft Corp"), true);
        assert!(v.license.contains("Letraset"), "{}", v.license);
        let v = assess(&face("MS Reference Sans Serif", "", "Typeface and data © 1996 Microsoft Corporation."), true);
        assert_eq!(v.tier, Tier::Paid);
        // 真正的 Windows 字体不能被「微软」这一条抢先
        assert_eq!(assess(&face("Segoe UI", "", "© 2017 Microsoft Corporation."), true).tier, Tier::System);
        assert_eq!(assess(&face("MingLiU_MSCS-ExtB", "", "© DynaComware Corp. 2022"), true).tier, Tier::System);
    }

    #[test]
    fn non_commercial_beats_everything() {
        let v = assess(&face("Cute Font", "Licensed under CC BY-NC 4.0. Free for personal use.", ""), false);
        assert_eq!((v.tier, v.game), (Tier::Paid, Mark::No));
    }

    #[test]
    fn blank_is_unknown_and_restricted_blocks_games() {
        let v = assess(&face("Mystery", "", ""), false);
        assert_eq!((v.tier, v.game), (Tier::Unknown, Mark::Ask));
        let mut f = face("Mystery", "", "");
        f.fs_type = 0x0002;
        assert_eq!(assess(&f, false).game, Mark::No);
    }

    #[test]
    fn family_takes_the_strictest() {
        let a = face("X", "SIL Open Font License", "");
        let b = face("X", "", "Monotype");
        let v = assess_family([(&a, false), (&b, false)].into_iter()).unwrap();
        assert_eq!(v.tier, Tier::Paid);
    }
}
