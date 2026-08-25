//! 文件搜索。**一律用系统自带的索引,不装任何东西、不自己建索引。**
//!
//! | 平台    | 后端                    | 用户要装吗 | 我们的开销 |
//! |---------|-------------------------|-----------|-----------|
//! | Windows | Windows Search(WSearch) | 不用      | 零        |
//! | macOS   | Spotlight(mdfind)       | 不用      | 零        |
//! | Linux   | plocate / locate        | 发行版自带或一条命令 | 零 |
//!
//! # 为什么不做「全盘」
//!
//! 全盘搜索在 Windows 上只有一条路:像 Everything 那样直接读 NTFS 的 MFT。
//! 代价是**管理员权限 + 一个常驻服务 + 自己那份几十上百 MB 的全盘索引**,
//! 首次还要全盘扫一遍。为了一个搜文件的功能让用户付这个,不划算。
//!
//! 而且查过同类,没人做全盘,它们的选择比这还保守:
//!   · Raycast —— 自己建索引,但官方手册写明**默认只覆盖用户主目录**
//!   · kunkun  —— 连索引都不建,现场遍历调用方指定的几个目录
//! 「全盘」不是这个品类的标配,它是 Everything 这个 Windows 特产造成的错觉。
//!
//! 我们比 Raycast 还省一层:**系统已经有一份索引在维护了**(开始菜单的搜索
//! 就靠它),我们只是去查,一份索引都不用建、一次扫描都不用做。
//! 覆盖面和 Raycast 的默认状态基本持平。
//!
//! 代价是如实的:Windows 索引默认只覆盖用户目录和几个已配置的位置,
//! 装在别的盘上的东西搜不到。用户可以在系统设置里加目录 —— 这是系统的开关,
//! 不是我们的。

use serde::Serialize;

#[cfg(not(windows))]
use std::process::Command;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchStatus {
    /// 后端标识:windows-search / spotlight / plocate。界面按它决定说什么话。
    pub backend: &'static str,
    /// 现在就能搜
    pub ready: bool,
    /// 没就绪时的具体原因。要说清楚是"服务没开"还是"没装",
    /// 只说一句「不可用」的话用户不知道该干什么。
    pub detail: String,
}

/* ══════════════════════════ Windows ══════════════════════════ */

#[cfg(windows)]
mod win_index {
    //! 查 Windows Search 的索引。
    //!
    //! 走 ADO 的晚绑定调用(`ADODB.Connection` + `Search.CollatorDSO` 提供程序)
    //! 而不是裸 OLE DB:后者要自己摆弄 IAccessor / DBBINDING,代码量是这里的
    //! 两三倍,而这条路一条 SQL 就够。

    // VARIANT 在 Win32::System::Variant,不在 windows::core ——
    // 而 BSTR::try_from(&VARIANT) 又挂在 Win32_System_Com_StructuredStorage
    // 这个 feature 上(见 Cargo.toml),两个都少不了。少了 feature 的报错形态是
    // 「类型推断失败」,完全看不出是缺 feature。
    use windows::core::{BSTR, GUID, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSIDFromProgID, IDispatch, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
        DISPPARAMS,
    };
    use windows::Win32::System::Variant::VARIANT;

    /// 调一个 IDispatch 上的方法/属性。
    ///
    /// 两个必须记住的细节:
    ///   · DISPPARAMS 里的参数要**倒序**放,正序会导致参数错位
    ///   · 属性和方法用的 flags 不一样(EOF/Value 是属性,MoveNext 是方法)
    unsafe fn call(
        obj: &IDispatch,
        name: &str,
        flags: DISPATCH_FLAGS,
        args: &[VARIANT],
    ) -> Result<VARIANT, String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut id = 0i32;
        obj.GetIDsOfNames(&GUID::zeroed(), &PCWSTR(wide.as_ptr()), 1, 0, &mut id)
            .map_err(|e| format!("找不到 {name}: {e}"))?;

        let mut rev: Vec<VARIANT> = args.iter().rev().cloned().collect();
        let params = DISPPARAMS {
            rgvarg: if rev.is_empty() {
                std::ptr::null_mut()
            } else {
                rev.as_mut_ptr()
            },
            cArgs: rev.len() as u32,
            rgdispidNamedArgs: std::ptr::null_mut(),
            cNamedArgs: 0,
        };
        let mut out = VARIANT::default();
        obj.Invoke(id, &GUID::zeroed(), 0, flags, &params, Some(&mut out), None, None)
            .map_err(|e| format!("调用 {name} 失败: {e}"))?;
        Ok(out)
    }

    fn as_string(v: &VARIANT) -> String {
        BSTR::try_from(v).map(|b| b.to_string()).unwrap_or_default()
    }

    fn as_bool(v: &VARIANT) -> bool {
        bool::try_from(v).unwrap_or(false)
    }

    /// 跑一条 Windows Search 的 SQL,返回第一列(字符串)。
    pub fn query(sql: &str, want_cols: usize) -> Result<Vec<Vec<String>>, String> {
        unsafe {
            // 忽略返回值:同一线程重复 init 会返回 S_FALSE,那不是错误。
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let prog: Vec<u16> = "ADODB.Connection"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let clsid = CLSIDFromProgID(PCWSTR(prog.as_ptr()))
                .map_err(|e| format!("系统里没有 ADO: {e}"))?;
            let conn: IDispatch = CoCreateInstance(&clsid, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("创建 ADO 连接失败: {e}"))?;

            let cs = VARIANT::from(
                "Provider=Search.CollatorDSO;Extended Properties='Application=Windows'",
            );
            call(&conn, "Open", DISPATCH_METHOD, &[cs])
                .map_err(|e| format!("连不上 Windows 索引({e})—— 检查 WSearch 服务是否在运行"))?;

            let q = VARIANT::from(sql);
            let rs_var = call(&conn, "Execute", DISPATCH_METHOD, &[q])?;
            let rs: IDispatch = IDispatch::try_from(&rs_var)
                .map_err(|e| format!("拿不到查询结果: {e}"))?;

            let mut rows = Vec::new();
            loop {
                let eof = call(&rs, "EOF", DISPATCH_PROPERTYGET, &[])?;
                if as_bool(&eof) {
                    break;
                }
                let fields_var = call(&rs, "Fields", DISPATCH_PROPERTYGET, &[])?;
                let fields: IDispatch = IDispatch::try_from(&fields_var)
                    .map_err(|e| format!("拿不到列集合: {e}"))?;

                let mut row = Vec::with_capacity(want_cols);
                for i in 0..want_cols {
                    let item_var =
                        call(&fields, "Item", DISPATCH_PROPERTYGET, &[VARIANT::from(i as i32)])?;
                    let item: IDispatch = IDispatch::try_from(&item_var)
                        .map_err(|e| format!("拿不到第 {i} 列: {e}"))?;
                    let val = call(&item, "Value", DISPATCH_PROPERTYGET, &[])?;
                    row.push(as_string(&val));
                }
                rows.push(row);

                call(&rs, "MoveNext", DISPATCH_METHOD, &[])?;
            }
            let _ = call(&conn, "Close", DISPATCH_METHOD, &[]);
            Ok(rows)
        }
    }
}

#[cfg(windows)]
fn status_impl() -> FileSearchStatus {
    // 直接跑一条最小查询来判断,而不是去看服务状态:
    // 服务在跑不等于查得通(提供程序没注册、索引损坏都可能),
    // 而用户要的答案是"现在能不能搜",不是"服务开没开"。
    match win_index::query("SELECT TOP 1 System.ItemUrl FROM SystemIndex", 1) {
        Ok(_) => FileSearchStatus {
            backend: "windows-search",
            ready: true,
            detail: String::new(),
        },
        Err(e) => FileSearchStatus {
            backend: "windows-search",
            ready: false,
            detail: e,
        },
    }
}

#[cfg(windows)]
fn search_impl(q: &str, limit: usize) -> Result<Vec<String>, String> {
    let sql = format!(
        "SELECT TOP {limit} System.ItemUrl FROM SystemIndex \
         WHERE System.FileName LIKE '%{}%' \
         ORDER BY System.DateModified DESC",
        escape_sql(q)
    );
    let rows = win_index::query(&sql, 1)?;
    Ok(rows
        .into_iter()
        .filter_map(|r| r.into_iter().next())
        .map(|u| from_item_url(&u))
        .collect())
}

/// `System.ItemUrl` 长这样:`file:C:/Users/x/a.md`。剥掉协议头就是真实路径。
///
/// **不要用 `System.ItemPathDisplay`** —— 那是**本地化显示路径**,
/// 中文系统上会返回 `C:\用户\x\...`、`C:\文档\...` 这种,
/// 看着像路径但 `Path::exists()` 是 false,拿去打开必然失败。
/// 现象是「搜得到但打不开」,而且只在中文系统上复现。
fn from_item_url(u: &str) -> String {
    u.strip_prefix("file:").unwrap_or(u).to_string()
}

/// LIKE 里的单引号要翻倍,否则用户搜一个撇号就能把 SQL 拼断。
/// 通配符也一并转义,不然搜 `%` 会变成"匹配任意内容"。
fn escape_sql(q: &str) -> String {
    q.replace('\'', "''").replace('%', "[%]").replace('_', "[_]")
}

/* ══════════════════════════ macOS ══════════════════════════ */

#[cfg(target_os = "macos")]
fn status_impl() -> FileSearchStatus {
    let ok = which("mdfind").is_some();
    FileSearchStatus {
        backend: "spotlight",
        ready: ok,
        detail: if ok {
            String::new()
        } else {
            "系统没有 mdfind,Spotlight 索引可能被关了".into()
        },
    }
}

#[cfg(target_os = "macos")]
fn search_impl(q: &str, limit: usize) -> Result<Vec<String>, String> {
    // -name 只按文件名匹配。不加的话 Spotlight 会连正文一起搜,
    // 在启动器这个场景里噪音太大 —— 正文搜索我们已经有笔记那一路了。
    let out = Command::new("mdfind")
        .arg("-name")
        .arg(q)
        .output()
        .map_err(|e| format!("mdfind 调不起来: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut v = lines_of(&out.stdout);
    v.truncate(limit); // mdfind 自己没有 -n,只能截断
    Ok(v)
}

/* ══════════════════════════ Linux ══════════════════════════ */

#[cfg(all(unix, not(target_os = "macos")))]
fn status_impl() -> FileSearchStatus {
    let has = which("plocate").or_else(|| which("locate"));
    FileSearchStatus {
        backend: "plocate",
        ready: has.is_some(),
        detail: if has.is_some() {
            String::new()
        } else {
            "装一个 plocate 再运行 updatedb".into()
        },
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn search_impl(q: &str, limit: usize) -> Result<Vec<String>, String> {
    let bin = which("plocate").or_else(|| which("locate")).ok_or("没有 plocate")?;
    let out = Command::new(bin)
        .arg("-l")
        .arg(limit.to_string())
        .arg("-i")
        .arg(q)
        .output()
        .map_err(|e| format!("locate 调不起来: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(lines_of(&out.stdout))
}

#[cfg(not(windows))]
fn which(exe: &str) -> Option<String> {
    let out = Command::new("which").arg(exe).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

#[cfg(not(windows))]
fn lines_of(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/* ══════════════════════════ 对外命令 ══════════════════════════ */

#[tauri::command]
pub fn file_search_status() -> FileSearchStatus {
    status_impl()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    /// 目录和文件在界面上要给不同图标
    pub is_dir: bool,
}

#[tauri::command]
pub fn file_search(query: String, limit: usize) -> Result<Vec<FileHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let paths = search_impl(q, limit.clamp(1, 50))?;
    Ok(paths
        .into_iter()
        .filter(|p| is_abs(p))
        .map(|p| {
            let name = p.rsplit(['\\', '/']).next().unwrap_or(&p).to_string();
            FileHit {
                is_dir: std::path::Path::new(&p).is_dir(),
                path: p.replace('\\', "/"),
                name,
            }
        })
        .collect())
}

fn is_abs(p: &str) -> bool {
    p.starts_with('/') || (p.len() > 2 && p.as_bytes()[1] == b':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 空查询不去碰索引() {
        assert!(file_search(String::from("   "), 10).unwrap().is_empty());
    }

    #[test]
    fn 绝对路径判定同时认两种分隔() {
        assert!(is_abs("C:/Users/x/a.txt"));
        assert!(is_abs("/home/x/a.txt"));
        assert!(!is_abs("a.txt"));
        assert!(!is_abs(""));
    }

    #[cfg(windows)]
    #[test]
    fn 剥掉_file_协议头() {
        assert_eq!(from_item_url("file:C:/a/b.md"), "C:/a/b.md");
        assert_eq!(from_item_url("C:/a/b.md"), "C:/a/b.md");
    }

    #[cfg(windows)]
    #[test]
    fn sql_转义挡住引号和通配符() {
        assert_eq!(escape_sql("it's"), "it''s");
        assert_eq!(escape_sql("100%"), "100[%]");
        assert_eq!(escape_sql("a_b"), "a[_]b");
    }
}
