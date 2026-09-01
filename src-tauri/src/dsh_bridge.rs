//! XGTools ↔ DSH 的通信桥。
//!
//! 我们用自己的界面驱动 DSH,所以要自己跟它的协议说话。两条通道:
//!
//! - **一元 RPC**:`POST {dsh}/api/<method>`,body 是
//!   `{ type: "client-request", rpcId, method, payload }`,回 `{ result: { ok, value } }`。
//! - **事件流**:`ws://{dsh}/api/events.mux` 和 `/api/events.host`,只走 WebSocket。
//!
//! **为什么这两条都必须由 Rust 走,不能让前端直接连:**
//!
//! DSH 有一道防 DNS 重绑定的信任围栏 —— 每个 `/api` 请求的 `Host` 必须是回环权威,
//! 带浏览器标记时 `Origin` 必须与之完全一致,`sec-fetch-site: cross-site` 直接 403。
//! XGTools 的页面源是 `tauri.localhost`,前端直接 fetch 必然被拒。
//!
//! Rust 这边发出去的请求不带 `Origin`、不带 Fetch-Metadata,是「非浏览器客户端走回环」,
//! 正好是围栏放行的那一类。这不是绕过安全 —— 围栏防的是被重绑的网页,不是本机程序。

use futures_util::{SinkExt, StreamExt};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// 每条事件流一个连接。断了自己重连 —— 边车重启、DSH 内部重载都会断,
/// 断了不重连的话审批和提问弹窗会静悄悄地再也不出现。
const STREAMS: [&str; 2] = ["events.mux", "events.host"];

#[derive(Default)]
pub struct DshBridge {
    /// 当前已连上的 DSH 地址。为空表示没连。
    base: Mutex<Option<String>>,
    /// 代数:每次重连 +1。老连接发现自己的代数过期就自行退出,
    /// 否则重连之后同一帧会被渲染两次,界面上就是回复重影。
    generation: Mutex<u64>,
}

/// 一元 RPC 共用一个 HTTP 客户端(clone 很便宜,内部是 Arc)。
///
/// 每次现建一个的话连接池也跟着现建现扔 —— 回环上每次都要重新握手,
/// 而这些调用很密:切一次会话就是好几发。
///
/// **超时必须有。** 边车卡住时不给超时,前端那句「正在读取这段对话…」会一直转下去,
/// 用户看到的是「点了没反应、堵住了」,而且永远不会变成一句能看懂的错误。
/// 宁可 30 秒后说一句超时,也不要转到天荒地老。
fn client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let built = reqwest::Client::builder()
        // 本机回环,不需要代理;走系统代理反而会被某些加速器截胡
        .no_proxy()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("建 HTTP 客户端失败: {e}"))?;
    Ok(CLIENT.get_or_init(|| built).clone())
}

/// 调 DSH 的一元 RPC。
///
/// `method` 形如 `session.create`、`session.prompt`、`commands/execute` ——
/// 点号和斜杠两种都有,原样拼进 URL,别自作主张归一化。
#[tauri::command]
pub async fn dsh_rpc(
    app: AppHandle,
    method: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let base = {
        let bridge = app.state::<DshBridge>();
        let b = bridge.base.lock().unwrap();
        b.clone().ok_or_else(|| "DSH 还没连上".to_string())?
    };

    let rpc_id = uuid::Uuid::new_v4().to_string();
    let body = serde_json::json!({
        "type": "client-request",
        "rpcId": rpc_id,
        "method": method,
        "payload": payload,
    });

    let url = format!("{}/api/{}", base.trim_end_matches('/'), method);
    let resp = client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{method} 请求失败: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // 403 基本只有一个原因,直接说出来,省得下次再查一遍围栏
        if status.as_u16() == 403 {
            return Err(format!("{method} 被拒(403)。DSH 的信任围栏只放行回环、无 Origin 的请求"));
        }
        return Err(format!("{method} 失败,HTTP {status}: {}", text.chars().take(200).collect::<String>()));
    }

    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{method} 返回的不是 JSON: {e}"))?;

    // 约定:{ result: { ok: false, error } } 是业务失败,HTTP 仍是 200
    if let Some(result) = value.get("result") {
        if result.get("ok") == Some(&serde_json::Value::Bool(false)) {
            let msg = result
                .get("error")
                .and_then(|e| e.get("message").or(Some(e)))
                .map(|e| e.to_string())
                .unwrap_or_else(|| "未知错误".into());
            return Err(format!("{method}: {msg}"));
        }
        if let Some(v) = result.get("value") {
            return Ok(v.clone());
        }
    }
    Ok(value)
}

/// 回应 DSH 主动发起的请求(权限审批、向用户提问)。
///
/// 这类请求从 `events.mux` 推过来,带一个 `rpcId`;用户点了「允许」之后,
/// 答案要按同一个 rpcId 回过去。回错了或者不回,那次工具调用就永远挂着。
#[tauri::command]
pub async fn dsh_respond(
    app: AppHandle,
    rpc_id: String,
    value: serde_json::Value,
) -> Result<(), String> {
    use tauri::Manager;
    let base = {
        let bridge = app.state::<DshBridge>();
        let b = bridge.base.lock().unwrap();
        b.clone().ok_or_else(|| "DSH 还没连上".to_string())?
    };
    let body = serde_json::json!({
        "type": "client-response",
        "rpcId": rpc_id,
        "result": { "ok": true, "value": value },
    });
    let url = format!("{}/api/respond", base.trim_end_matches('/'));
    let resp = client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("回应失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("回应未被接收,HTTP {}", resp.status()));
    }
    Ok(())
}

/// 取一段会话历史,**把流式碎片扔掉再回给前端**。
///
/// 为什么要单开一个命令,而不是让前端自己调 `session.history`:
/// 那份日志里 99.8% 是 `assistant/chunk` —— 模型每吐几个字记一条。实测一个只问了
/// 10 句话的会话,日志 17 万条,其中 16 万条是碎片;哪怕只要「最近 40 条消息」,
/// 服务端回的仍然是 16 万条(它数的是消息,不是记录)。
///
/// 这 16 万条要一路穿过 IPC 变成 JS 对象,光这一步就够界面卡住好几秒 ——
/// 而它们**一条都用不上**:完整的那句话另有 `assistant/message`。
/// 所以在这儿就地筛掉,前端只收到几百条。
#[tauri::command]
pub async fn dsh_history(
    app: AppHandle,
    session_id: String,
    max_messages: Option<u32>,
) -> Result<serde_json::Value, String> {
    let mut payload = serde_json::json!({ "sessionId": session_id });
    if let Some(m) = max_messages {
        payload["maxMessages"] = serde_json::json!(m);
    }
    let mut value = dsh_rpc(app, "session.history".into(), payload).await?;

    if let Some(events) = value.get_mut("events").and_then(|e| e.as_array_mut()) {
        events.retain(|entry| {
            entry
                .get("event")
                .and_then(|e| e.get("type"))
                .and_then(|t| t.as_str())
                .map(|t| t != "assistant/chunk")
                .unwrap_or(true)
        });
    }
    Ok(value)
}

/// 把 `http://127.0.0.1:1234` 变成 `ws://127.0.0.1:1234/api/events.mux`
fn ws_url(base: &str, stream: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b.strip_prefix("http://").map(|r| format!("ws://{r}"))
        .or_else(|| b.strip_prefix("https://").map(|r| format!("wss://{r}")))
        .unwrap_or_else(|| b.to_string());
    format!("{b}/api/{stream}")
}

/// 连上 DSH 并把两条事件流接过来。边车 ready 之后调一次。
#[tauri::command]
pub fn dsh_connect(app: AppHandle, url: String) -> Result<(), String> {
    use tauri::Manager;
    let bridge = app.state::<DshBridge>();
    let gen = {
        let mut g = bridge.generation.lock().unwrap();
        *g += 1;   // 老连接的代数就此过期
        *g
    };
    *bridge.base.lock().unwrap() = Some(url.clone());

    for stream in STREAMS {
        spawn_stream(app.clone(), url.clone(), stream, gen);
    }
    Ok(())
}

#[tauri::command]
pub fn dsh_disconnect(app: AppHandle) {
    use tauri::Manager;
    if let Some(bridge) = app.try_state::<DshBridge>() {
        *bridge.generation.lock().unwrap() += 1;
        *bridge.base.lock().unwrap() = None;
    }
}

/// 当前这个连接是不是还算数。重连之后老任务靠它自行了断。
fn generation_valid(app: &AppHandle, gen: u64) -> bool {
    use tauri::Manager;
    app.try_state::<DshBridge>()
        .map(|b| *b.generation.lock().unwrap() == gen)
        .unwrap_or(false)
}

fn spawn_stream(app: AppHandle, base: String, stream: &'static str, gen: u64) {
    // 必须用 tauri::async_runtime::spawn,不能用 tokio::spawn。
    // `dsh_connect` 是同步命令,跑在没有 Tokio 运行时的线程上;那里调 tokio::spawn
    // 会 panic「there is no reactor running」,而且是 non-unwinding panic ——
    // 整个应用直接 abort,连错误对话框都没有。踩过一次。
    tauri::async_runtime::spawn(async move {
        let url = ws_url(&base, stream);
        let mut backoff_ms = 400u64;

        loop {
            if !generation_valid(&app, gen) {
                return;   // 已经重连过了,这条老链路退场
            }

            match tokio_tungstenite::connect_async(&url).await {
                Ok((socket, _)) => {
                    backoff_ms = 400;
                    let _ = app.emit("dsh://stream", serde_json::json!({
                        "stream": stream, "state": "open",
                    }));

                    let (mut write, mut read) = socket.split();
                    while let Some(msg) = read.next().await {
                        if !generation_valid(&app, gen) {
                            let _ = write.close().await;
                            return;
                        }
                        match msg {
                            Ok(tokio_tungstenite::tungstenite::Message::Text(t)) => {
                                // 原样把帧交给前端解析 —— Rust 这层不理解业务语义,
                                // 加了解析就等于把协议知识复制成两份,上游一改要改两处。
                                let _ = app.emit("dsh://frame", serde_json::json!({
                                    "stream": stream, "data": t.to_string(),
                                }));
                            }
                            Ok(tokio_tungstenite::tungstenite::Message::Ping(p)) => {
                                let _ = write.send(tokio_tungstenite::tungstenite::Message::Pong(p)).await;
                            }
                            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) | Err(_) => break,
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    let _ = app.emit("dsh://stream", serde_json::json!({
                        "stream": stream, "state": "error", "message": e.to_string(),
                    }));
                }
            }

            if !generation_valid(&app, gen) {
                return;
            }
            let _ = app.emit("dsh://stream", serde_json::json!({
                "stream": stream, "state": "closed",
            }));

            // 退避重连。events.mux 是审批和提问的通道,它断了不重连,
            // 后面所有需要确认的工具调用都会永远挂着而且没有任何提示。
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = (backoff_ms * 2).min(8_000);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_base_becomes_ws() {
        assert_eq!(ws_url("http://127.0.0.1:3080", "events.mux"),
                   "ws://127.0.0.1:3080/api/events.mux");
        // 结尾斜杠不能带出双斜杠
        assert_eq!(ws_url("http://127.0.0.1:3080/", "events.host"),
                   "ws://127.0.0.1:3080/api/events.host");
        assert_eq!(ws_url("https://example.com", "events.mux"),
                   "wss://example.com/api/events.mux");
    }
}
