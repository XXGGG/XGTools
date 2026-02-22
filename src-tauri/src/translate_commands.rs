use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

// ─── 数据结构 ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct TranslateRequest {
    pub text: String,
    pub source_lang: String, // "auto", "zh", "en", ...
    pub target_lang: String, // "zh", "en", ...
    pub engine: String,      // "google", "bing", "openai", "claude", "gemini", "deepseek"
    pub ai_config: Option<AiConfig>,
}

#[derive(Serialize, Clone)]
pub struct TranslateResult {
    pub text: String,
    pub detected_lang: Option<String>,
    pub engine: String,
}

#[derive(Deserialize, Clone)]
pub struct AiConfig {
    pub api_key: String,
    pub api_url: Option<String>,
    pub model: Option<String>,
}

// ─── Tauri Command ────────────────────────────────────

#[tauri::command]
pub async fn translate(request: TranslateRequest) -> Result<TranslateResult, String> {
    if request.text.trim().is_empty() {
        return Ok(TranslateResult {
            text: String::new(),
            detected_lang: None,
            engine: request.engine.clone(),
        });
    }

    match request.engine.as_str() {
        "google" => google_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "bing" => bing_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "deepl" => deepl_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "transmart" => transmart_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "yandex" => yandex_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "mymemory" => mymemory_translate(&request.text, &request.source_lang, &request.target_lang).await,
        "openai" | "claude" | "gemini" | "deepseek"
        | "qwen" | "zhipu" | "yi" | "moonshot" | "groq" | "custom" => {
            let config = request.ai_config.as_ref().ok_or("AI 引擎需要配置 API Key")?;
            ai_translate(&request.text, &request.source_lang, &request.target_lang, config, &request.engine).await
        }
        _ => Err(format!("不支持的翻译引擎: {}", request.engine)),
    }
}

// ─── Google Translate (免费) ──────────────────────────

async fn google_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://translate.googleapis.com/translate_a/single")
        .query(&[
            ("client", "gtx"),
            ("sl", src),
            ("tl", tgt),
            ("dt", "t"),
            ("q", text),
        ])
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("Google 翻译请求失败: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Google 翻译解析失败: {}", e))?;

    // 拼接所有翻译片段: body[0] 是数组，每个元素 [0] 是翻译文本
    let mut translated = String::new();
    if let Some(segments) = body.get(0).and_then(|v| v.as_array()) {
        for seg in segments {
            if let Some(t) = seg.get(0).and_then(|v| v.as_str()) {
                translated.push_str(t);
            }
        }
    }

    if translated.is_empty() {
        return Err("Google 翻译返回空结果".into());
    }

    let detected = body.get(2).and_then(|v| v.as_str()).map(|s| s.to_string());

    Ok(TranslateResult {
        text: translated,
        detected_lang: detected,
        engine: "google".into(),
    })
}

// ─── Bing/Microsoft Translate (免费) ─────────────────

async fn bing_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // 1. 获取 auth token
    let token = client
        .get("https://edge.microsoft.com/translate/auth")
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("Bing 获取 token 失败: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Bing token 解析失败: {}", e))?;

    // 2. 构建翻译请求
    let mut query = vec![
        ("api-version".to_string(), "3.0".to_string()),
        ("to".to_string(), bing_lang_code(tgt).to_string()),
    ];
    if src != "auto" {
        query.push(("from".to_string(), bing_lang_code(src).to_string()));
    }

    let body = serde_json::json!([{ "Text": text }]);

    let resp = client
        .post("https://api-edge.cognitive.microsofttranslator.com/translate")
        .query(&query)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Bing 翻译请求失败: {}", e))?;

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Bing 翻译解析失败: {}", e))?;

    // 解析: [{ "translations": [{ "text": "...", "to": "..." }], "detectedLanguage": { "language": "...", "score": 1.0 } }]
    let translated = result
        .get(0)
        .and_then(|v| v.get("translations"))
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("text"))
        .and_then(|v| v.as_str())
        .ok_or("Bing 翻译返回格式错误")?
        .to_string();

    let detected = result
        .get(0)
        .and_then(|v| v.get("detectedLanguage"))
        .and_then(|v| v.get("language"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(TranslateResult {
        text: translated,
        detected_lang: detected,
        engine: "bing".into(),
    })
}

/// Bing 语言代码映射
fn bing_lang_code(lang: &str) -> &str {
    match lang {
        "zh" => "zh-Hans",
        "en" => "en",
        "ja" => "ja",
        "ko" => "ko",
        "fr" => "fr",
        "de" => "de",
        "es" => "es",
        "ru" => "ru",
        _ => lang,
    }
}

// ─── DeepL 翻译 (免费 jsonrpc) ──────────────────────

/// DeepL 语言代码映射（大写）
fn deepl_lang_code(lang: &str) -> &str {
    match lang {
        "zh" => "ZH",
        "en" => "EN",
        "ja" => "JA",
        "ko" => "KO",
        "fr" => "FR",
        "de" => "DE",
        "es" => "ES",
        "ru" => "RU",
        "auto" => "auto",
        _ => lang,
    }
}

async fn deepl_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // 1. 生成随机 id（参考 DeepLX: rand(100000..199999) * 1000）
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = ((nanos % 99999) as i64 + 100000) * 1000;

    // 2. 计算 timestamp（反检测：基于 'i' 字符数量调整）
    let ts_millis = (nanos / 1_000_000) as i64;
    let i_count = text.chars().filter(|c| *c == 'i').count() as i64;
    let ts = if i_count > 0 {
        let divisor = i_count + 1;
        ts_millis - (ts_millis % divisor) + divisor
    } else {
        ts_millis
    };

    // 3. 构建 source_lang
    let source_lang = if src == "auto" {
        "auto"
    } else {
        deepl_lang_code(src)
    };

    // 4. 构建请求体
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "LMT_handle_texts",
        "id": id,
        "params": {
            "splitting": "newlines",
            "lang": {
                "source_lang_user_selected": source_lang,
                "target_lang": deepl_lang_code(tgt)
            },
            "texts": [{"text": text, "requestAlternatives": 3}],
            "timestamp": ts
        }
    });

    // 5. 反检测：修改 JSON 中 "method" 的空格风格
    let mut body_str = serde_json::to_string(&body)
        .map_err(|e| format!("DeepL 序列化失败: {}", e))?;
    if (id + 5) % 29 == 0 || (id + 3) % 13 == 0 {
        body_str = body_str.replacen("\"method\":\"", "\"method\" : \"", 1);
    } else {
        body_str = body_str.replacen("\"method\":\"", "\"method\": \"", 1);
    }

    // 6. 发送请求（模拟浏览器 headers）
    let resp = client
        .post("https://www2.deepl.com/jsonrpc")
        .header("Content-Type", "application/json")
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Origin", "https://www.deepl.com")
        .header("Referer", "https://www.deepl.com/")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-site")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
        .body(body_str)
        .send()
        .await
        .map_err(|e| format!("DeepL 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("DeepL 解析失败: {}", e))?;

    if !status.is_success() {
        let err_msg = result
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("DeepL API 错误 ({}): {}", status, err_msg));
    }

    // 7. 解析: result.result.texts[0].text
    let translated = result
        .get("result")
        .and_then(|r| r.get("texts"))
        .and_then(|t| t.get(0))
        .and_then(|t| t.get("text"))
        .and_then(|t| t.as_str())
        .ok_or("DeepL 返回格式错误")?
        .to_string();

    let detected = result
        .get("result")
        .and_then(|r| r.get("lang"))
        .and_then(|l| l.as_str())
        .map(|s| s.to_lowercase());

    Ok(TranslateResult {
        text: translated,
        detected_lang: detected,
        engine: "deepl".into(),
    })
}

// ─── 腾讯交互翻译 TransMart (免费) ─────────────────

async fn transmart_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // 按换行拆分文本
    let text_list: Vec<&str> = text.lines().collect();

    // 生成 client_key（模拟浏览器指纹）
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let client_key = format!(
        "browser-chrome-134.0.0-Windows_NT-{:08x}-{:04x}-{:04x}-{:04x}-{:012x}-{}",
        ts as u32, (ts >> 32) as u16, (ts >> 48) as u16, (ts >> 16) as u16, ts, ts
    );

    let body = serde_json::json!({
        "header": {
            "fn": "auto_translation",
            "client_key": client_key
        },
        "type": "plain",
        "model_category": "normal",
        "source": {
            "lang": if src == "auto" { "auto" } else { src },
            "text_list": text_list
        },
        "target": {
            "lang": tgt
        }
    });

    let resp = client
        .post("https://yi.qq.com/api/imt")
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36")
        .header("Referer", "https://yi.qq.com/zh-CN/index")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("TransMart 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("TransMart 解析失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("TransMart API 错误 ({}): {:?}", status, result));
    }

    // 解析: auto_translation 是数组，用 \n join
    let translated = result
        .get("auto_translation")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty())
        .ok_or("TransMart 返回格式错误")?;

    Ok(TranslateResult {
        text: translated,
        detected_lang: None,
        engine: "transmart".into(),
    })
}

// ─── Yandex 翻译 (免费) ─────────────────────────────

async fn yandex_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // 生成 UUID 风格的 ID
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let uuid = format!("{:032x}", ts);
    let yandex_id = format!("{}-0-0", uuid);

    let url = format!(
        "https://translate.yandex.net/api/v1/tr.json/translate?id={}&srv=android",
        yandex_id
    );

    // source_lang 为空字符串表示自动检测
    let from = if src == "auto" { "" } else { src };

    let form_body = format!(
        "source_lang={}&target_lang={}&text={}",
        from,
        tgt,
        urlencoding::encode(text)
    );

    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", "Mozilla/5.0")
        .body(form_body)
        .send()
        .await
        .map_err(|e| format!("Yandex 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Yandex 解析失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("Yandex API 错误 ({}): {:?}", status, result));
    }

    // 解析: text[0]
    let translated = result
        .get("text")
        .and_then(|t| t.get(0))
        .and_then(|t| t.as_str())
        .ok_or("Yandex 返回格式错误")?
        .to_string();

    let detected = result
        .get("detected")
        .and_then(|d| d.get("lang"))
        .and_then(|l| l.as_str())
        .map(|s| s.to_string());

    Ok(TranslateResult {
        text: translated,
        detected_lang: detected,
        engine: "yandex".into(),
    })
}

// ─── MyMemory 翻译 (免费，中国可用) ────────────────

/// MyMemory 语言代码映射
fn mymemory_lang_code(lang: &str) -> &str {
    match lang {
        "zh" => "zh-CN",
        "en" => "en-GB",
        _ => lang,
    }
}

async fn mymemory_translate(text: &str, src: &str, tgt: &str) -> Result<TranslateResult, String> {
    let client = reqwest::Client::new();

    // MyMemory 不支持 auto，但如果 src 是 auto 就用 "autodetect"
    let from = if src == "auto" { "autodetect" } else { mymemory_lang_code(src) };
    let to = mymemory_lang_code(tgt);
    let langpair = format!("{}|{}", from, to);

    let resp = client
        .get("https://api.mymemory.translated.net/get")
        .query(&[("q", text), ("langpair", &langpair)])
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("MyMemory 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("MyMemory 解析失败: {}", e))?;

    if !status.is_success() {
        return Err(format!("MyMemory API 错误 ({}): {:?}", status, result));
    }

    // 解析: responseData.translatedText
    let translated = result
        .get("responseData")
        .and_then(|r| r.get("translatedText"))
        .and_then(|t| t.as_str())
        .ok_or("MyMemory 返回格式错误")?
        .to_string();

    if translated.is_empty() {
        return Err("MyMemory 返回空结果".into());
    }

    // 尝试从 matches 中获取检测语言
    let detected = result
        .get("matches")
        .and_then(|m| m.get(0))
        .and_then(|m| m.get("source"))
        .and_then(|s| s.as_str())
        .map(|s| s.split('-').next().unwrap_or(s).to_string());

    Ok(TranslateResult {
        text: translated,
        detected_lang: detected,
        engine: "mymemory".into(),
    })
}

// ─── AI 翻译引擎 ─────────────────────────────────────

const TRANSLATE_SYSTEM_PROMPT: &str = r#"You are a professional translation engine. Your sole purpose is to translate text accurately.

Rules:
- Only output the translated text, nothing else
- Do not explain, do not add notes, do not answer questions
- If the input is Chinese, translate to English
- If the input is English, translate to Chinese
- Preserve formatting, line breaks, and punctuation style
- For technical terms, keep commonly used English terms as-is"#;

async fn ai_translate(
    text: &str,
    src: &str,
    tgt: &str,
    config: &AiConfig,
    engine: &str,
) -> Result<TranslateResult, String> {
    if config.api_key.is_empty() {
        return Err(format!("{} 需要配置 API Key", engine));
    }

    let lang_hint = build_lang_hint(src, tgt);
    let user_msg = if lang_hint.is_empty() {
        text.to_string()
    } else {
        format!("{}\n\n{}", lang_hint, text)
    };

    let translated = match engine {
        "claude" => claude_request(&user_msg, config).await?,
        "gemini" => gemini_request(&user_msg, config).await?,
        _ => openai_compatible_request(&user_msg, config, engine).await?,
    };

    Ok(TranslateResult {
        text: translated.trim().to_string(),
        detected_lang: None,
        engine: engine.into(),
    })
}

fn build_lang_hint(src: &str, tgt: &str) -> String {
    let src_name = lang_display_name(src);
    let tgt_name = lang_display_name(tgt);
    if src == "auto" {
        format!("Translate to {}:", tgt_name)
    } else {
        format!("Translate from {} to {}:", src_name, tgt_name)
    }
}

fn lang_display_name(code: &str) -> &str {
    match code {
        "zh" => "Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "ru" => "Russian",
        "auto" => "Auto-detect",
        _ => code,
    }
}

/// OpenAI-compatible API (OpenAI, DeepSeek, 通义千问, 智谱, 零一万物, Moonshot, Groq, 自定义)
async fn openai_compatible_request(
    user_msg: &str,
    config: &AiConfig,
    engine: &str,
) -> Result<String, String> {
    let (default_url, default_model) = match engine {
        "openai" => ("https://api.openai.com/v1/chat/completions", "gpt-4o-mini"),
        "deepseek" => ("https://api.deepseek.com/chat/completions", "deepseek-chat"),
        "qwen" => ("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", "qwen-plus"),
        "zhipu" => ("https://open.bigmodel.cn/api/paas/v4/chat/completions", "glm-4-flash"),
        "yi" => ("https://api.lingyiwanwu.com/v1/chat/completions", "yi-lightning"),
        "moonshot" => ("https://api.moonshot.cn/v1/chat/completions", "moonshot-v1-8k"),
        "groq" => ("https://api.groq.com/openai/v1/chat/completions", "llama-3.1-8b-instant"),
        _ => ("https://api.openai.com/v1/chat/completions", "gpt-4o-mini"),
    };

    let url = config.api_url.as_deref().unwrap_or(default_url);
    let model = config.model.as_deref().unwrap_or(default_model);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": TRANSLATE_SYSTEM_PROMPT },
            { "role": "user", "content": user_msg }
        ],
        "temperature": 0.1
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{} 请求失败: {}", engine, e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("{} 解析失败: {}", engine, e))?;

    if !status.is_success() {
        let err_msg = result
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("{} API 错误: {}", engine, err_msg));
    }

    result
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
        .ok_or(format!("{} 返回格式错误", engine))
}

/// Claude API (Anthropic Messages API)
async fn claude_request(user_msg: &str, config: &AiConfig) -> Result<String, String> {
    let url = config
        .api_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com/v1/messages");
    let model = config
        .model
        .as_deref()
        .unwrap_or("claude-sonnet-4-20250514");

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "system": TRANSLATE_SYSTEM_PROMPT,
        "messages": [
            { "role": "user", "content": user_msg }
        ]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Claude 解析失败: {}", e))?;

    if !status.is_success() {
        let err_msg = result
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("Claude API 错误: {}", err_msg));
    }

    result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or("Claude 返回格式错误".into())
}

/// Gemini API (Google Generative AI)
async fn gemini_request(user_msg: &str, config: &AiConfig) -> Result<String, String> {
    let model = config
        .model
        .as_deref()
        .unwrap_or("gemini-2.0-flash");

    let url = if let Some(custom_url) = &config.api_url {
        format!("{}?key={}", custom_url, config.api_key)
    } else {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, config.api_key
        )
    };

    let body = serde_json::json!({
        "system_instruction": {
            "parts": [{ "text": TRANSLATE_SYSTEM_PROMPT }]
        },
        "contents": [{
            "parts": [{ "text": user_msg }]
        }],
        "generationConfig": {
            "temperature": 0.1
        }
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Gemini 请求失败: {}", e))?;

    let status = resp.status();
    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Gemini 解析失败: {}", e))?;

    if !status.is_success() {
        let err_msg = result
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("Gemini API 错误: {}", err_msg));
    }

    result
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or("Gemini 返回格式错误".into())
}

// ─── 获取模型列表 ────────────────────────────────────

#[derive(Deserialize)]
pub struct ListModelsRequest {
    pub engine: String,
    pub api_key: String,
    pub api_url: Option<String>,
}

#[tauri::command]
pub async fn list_models(request: ListModelsRequest) -> Result<Vec<String>, String> {
    if request.api_key.is_empty() {
        return Err("需要 API Key".into());
    }

    let client = reqwest::Client::new();

    match request.engine.as_str() {
        "claude" => list_claude_models(&client, &request).await,
        "gemini" => list_gemini_models(&client, &request).await,
        _ => list_openai_compatible_models(&client, &request).await,
    }
}

/// OpenAI 兼容的 /models 接口
async fn list_openai_compatible_models(
    client: &reqwest::Client,
    req: &ListModelsRequest,
) -> Result<Vec<String>, String> {
    // 从 chat/completions URL 推导 models URL
    let default_base = match req.engine.as_str() {
        "openai" => "https://api.openai.com/v1",
        "deepseek" => "https://api.deepseek.com",
        "qwen" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4",
        "yi" => "https://api.lingyiwanwu.com/v1",
        "moonshot" => "https://api.moonshot.cn/v1",
        "groq" => "https://api.groq.com/openai/v1",
        _ => "",
    };

    let base_url = if let Some(custom) = &req.api_url {
        // 用户自定义 URL，去掉 /chat/completions 部分
        custom
            .trim_end_matches('/')
            .trim_end_matches("/chat/completions")
            .to_string()
    } else {
        default_base.to_string()
    };

    if base_url.is_empty() {
        return Err("无法确定 API 基础 URL".into());
    }

    let url = format!("{}/models", base_url);

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", req.api_key))
        .send()
        .await
        .map_err(|e| format!("获取模型列表失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("获取模型列表失败 ({})", resp.status()));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析模型列表失败: {}", e))?;

    // OpenAI 格式: { "data": [{ "id": "gpt-4o-mini", ... }] }
    let models = result
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()))
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}

/// Claude /v1/models
async fn list_claude_models(
    client: &reqwest::Client,
    req: &ListModelsRequest,
) -> Result<Vec<String>, String> {
    let url = req
        .api_url
        .as_deref()
        .map(|u| {
            u.trim_end_matches('/')
                .trim_end_matches("/messages")
                .to_string()
                + "/models"
        })
        .unwrap_or_else(|| "https://api.anthropic.com/v1/models".to_string());

    let resp = client
        .get(&url)
        .header("x-api-key", &req.api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("获取 Claude 模型列表失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("获取 Claude 模型列表失败 ({})", resp.status()));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Claude 模型列表失败: {}", e))?;

    // Claude 格式: { "data": [{ "id": "claude-...", ... }] }
    let models = result
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|id| id.as_str()))
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}

/// Gemini models
async fn list_gemini_models(
    client: &reqwest::Client,
    req: &ListModelsRequest,
) -> Result<Vec<String>, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}",
        req.api_key
    );

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("获取 Gemini 模型列表失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("获取 Gemini 模型列表失败 ({})", resp.status()));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 Gemini 模型列表失败: {}", e))?;

    // Gemini 格式: { "models": [{ "name": "models/gemini-2.0-flash", ... }] }
    let models = result
        .get("models")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.trim_start_matches("models/").to_string())
                })
                // 只保留支持 generateContent 的模型
                .filter(|name| name.starts_with("gemini"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(models)
}
