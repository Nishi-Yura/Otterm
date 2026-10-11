//! The bridge to the user's AI provider (docs/10, decision M22): what `ctx.ai` in mods ends up
//! calling. It knows how to reach the providers, where the API key is (the OS keychain, never
//! config.toml), what to hide before sending, and what to write to the local log. It holds no
//! prompts of its own: the questions and the answers' shape belong to the `otterm.ai-assist` mod
//! and to any mod with the `ai` permission.
//!
//! Nothing here runs unless `[ai] enabled = true`, and nothing connects anywhere until a mod asks
//! on the user's behalf (docs/10 §5, decisions F2, H4).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use otterm_config::{Ai, AiProvider};
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use tauri::State;
use tauri::ipc::Channel;

use crate::{AppState, CmdResult, err};

/// Keychain service name; the entry name is the provider (`claude`, `openai`, ...).
const KEYCHAIN_SERVICE: &str = "otterm-ai";
/// Requests a mod may make in a minute (docs/10 §7).
const RATE_LIMIT: usize = 10;
const TIMEOUT: Duration = Duration::from_secs(120);
/// The Claude model when the user picked none (they choose another in Settings › AI).
const CLAUDE_DEFAULT_MODEL: &str = "claude-opus-5-5";
const OLLAMA_DEFAULT: &str = "http://localhost:11434";
const OLLAMA_DEFAULT_MODEL: &str = "qwen2.5-coder:7b";

/// A piece of the answer as it streams, for the UI and the mod.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Delta { text: String },
}

#[derive(Serialize)]
pub struct AiResult {
    text: String,
    /// `local` for Ollama and other endpoints on this machine, `cloud` otherwise.
    provider: &'static str,
    model: String,
    /// The prompt lost something to redaction.
    truncated: bool,
}

/// What the send preview shows (docs/10 §4.3).
#[derive(Serialize)]
pub struct AiPreview {
    provider: String,
    host: String,
    model: String,
    /// The prompt as it would be sent, secrets replaced.
    prompt: String,
    redactions: usize,
    /// Show the full preview (the first `preview_first_n` requests); later ones only link to it.
    full: bool,
}

fn provider_name(p: AiProvider) -> &'static str {
    match p {
        AiProvider::Local => "local",
        AiProvider::Claude => "claude",
        AiProvider::Openai => "openai",
        AiProvider::Gemini => "gemini",
        AiProvider::OpenaiCompatible => "openai-compatible",
    }
}

fn model_of(ai: &Ai) -> Result<String, String> {
    if let Some(m) = ai.model.as_deref().filter(|m| !m.trim().is_empty()) {
        return Ok(m.trim().to_owned());
    }
    match ai.provider {
        AiProvider::Claude => Ok(CLAUDE_DEFAULT_MODEL.into()),
        AiProvider::Local => Ok(OLLAMA_DEFAULT_MODEL.into()),
        _ => Err("set the model in Settings › AI ([ai] model)".into()),
    }
}

/// The URL a request goes to.
fn url_of(ai: &Ai, model: &str) -> Result<String, String> {
    let endpoint = || ai.endpoint.as_deref().map(|e| e.trim().trim_end_matches('/').to_owned());
    Ok(match ai.provider {
        AiProvider::Local => format!("{}/api/chat", endpoint().unwrap_or_else(|| OLLAMA_DEFAULT.into())),
        AiProvider::Claude => "https://api.anthropic.com/v1/messages".into(),
        AiProvider::Openai => "https://api.openai.com/v1/chat/completions".into(),
        AiProvider::Gemini => {
            format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse")
        }
        AiProvider::OpenaiCompatible => {
            let base =
                endpoint().filter(|e| !e.is_empty()).ok_or("set [ai] endpoint for an OpenAI-compatible server")?;
            format!("{base}/chat/completions")
        }
    })
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).and_then(|r| r.split(['/', '?']).next()).unwrap_or(url).to_owned()
}

/// Ollama or a server on this machine: nothing leaves the computer.
fn is_local(url: &str) -> bool {
    let host = host_of(url);
    let name = host.rsplit_once(':').map_or(host.as_str(), |(h, _)| h);
    matches!(name, "localhost" | "127.0.0.1" | "[::1]")
}

// --- keys ----------------------------------------------------------------------------------------

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider).map_err(err)
}

fn key_for(provider: AiProvider) -> Result<Option<String>, String> {
    match entry(provider_name(provider))?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Settings › AI: store a key in the OS keychain (an empty key removes it).
#[tauri::command]
pub fn ai_key_set(provider: String, key: String) -> CmdResult {
    let e = entry(&provider)?;
    if key.trim().is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(x) => Err(x.to_string()),
        };
    }
    e.set_password(key.trim()).map_err(err)
}

/// Whether a key is stored for `provider` (the key itself never goes back to the UI).
#[tauri::command]
pub fn ai_key_present(provider: String) -> bool {
    entry(&provider).and_then(|e| e.get_password().map_err(err)).is_ok()
}

// --- redaction -----------------------------------------------------------------------------------

/// Hide what looks secret (docs/10 §4.2). Returns the text and how many places were replaced.
pub fn redact(text: &str) -> (String, usize) {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            // Values after password=, token=, secret=, api_key= and the like.
            (r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)(\s*[=:]\s*)\S+", "$1$2[REDACTED]"),
            (r"\bsk-[A-Za-z0-9_\-]{16,}", "[REDACTED]"),
            (r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})", "[REDACTED]"),
            (r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED]"),
            (r"\bxox[abprs]-[A-Za-z0-9-]{10,}", "[REDACTED]"),
            (r"\bAIza[0-9A-Za-z_\-]{30,}", "[REDACTED]"),
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", "[REDACTED]"),
            // Long runs of letters and digits: tokens and hashes more often than words.
            (r"\b[A-Za-z0-9]{32,}\b", "[REDACTED]"),
        ]
        .into_iter()
        .filter_map(|(re, to)| Some((Regex::new(re).ok()?, to)))
        .collect()
    });
    let mut out = text.to_owned();
    let mut count = 0;
    for (re, to) in rules {
        count += re.find_iter(&out).count();
        out = re.replace_all(&out, *to).into_owned();
    }
    (shorten_home(&out), count)
}

/// The home folder becomes `~`, so the user name in it is not sent (docs/10 §4.2).
fn shorten_home(text: &str) -> String {
    static HOME: OnceLock<Option<Regex>> = OnceLock::new();
    let home = HOME.get_or_init(|| {
        let home = std::env::home_dir()?;
        let home = home.to_string_lossy();
        let home = home.trim_end_matches(['/', '\\']);
        if home.len() < 3 {
            return None;
        }
        // Either slash, and on Windows in any case: `C:\Users\me`, `c:/users/me`.
        let parts: Vec<String> = home.split(['/', '\\']).map(regex::escape).collect();
        let flags = if cfg!(windows) { "(?i)" } else { "" };
        Regex::new(&format!(r"{flags}{}\b", parts.join(r"[/\\]"))).ok()
    });
    match home {
        Some(re) => re.replace_all(text, "~").into_owned(),
        None => text.to_owned(),
    }
}

// --- rate limit, preview count, log ---------------------------------------------------------------

fn rate_ok(mod_id: &str) -> bool {
    static CALLS: OnceLock<Mutex<HashMap<String, Vec<Instant>>>> = OnceLock::new();
    let mut calls = CALLS.get_or_init(Default::default).lock().unwrap();
    let list = calls.entry(mod_id.to_owned()).or_default();
    list.retain(|t| t.elapsed() < Duration::from_secs(60));
    if list.len() >= RATE_LIMIT {
        return false;
    }
    list.push(Instant::now());
    true
}

fn state_file(name: &str) -> Option<PathBuf> {
    otterm_config::data_dir().map(|d| d.join("state").join(name))
}

fn previews_shown() -> u32 {
    state_file("ai-previews")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or(0)
}

/// The UI showed the full preview once more.
#[tauri::command]
pub fn ai_preview_seen() -> CmdResult {
    let path = state_file("ai-previews").ok_or("no data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    std::fs::write(path, (previews_shown() + 1).to_string()).map_err(err)
}

fn log_path() -> Option<PathBuf> {
    otterm_config::data_dir().map(|d| d.join("logs").join("ai-log.jsonl"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// What was sent and what came back, for the user to look at later (docs/10 §4.4).
fn log(ai: &Ai, entry: &Value) {
    if ai.log_retention_days == 0 {
        return;
    }
    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{entry}");
    }
}

/// Drop log lines older than `[ai] log_retention_days` (at startup).
pub fn prune_log(days: u32) {
    let Some(path) = log_path() else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let cutoff = now_secs().saturating_sub(u64::from(days) * 86_400);
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| {
            days > 0
                && serde_json::from_str::<Value>(l).ok().and_then(|v| v["time"].as_u64()).is_some_and(|t| t >= cutoff)
        })
        .collect();
    if kept.len() != text.lines().count() {
        let _ = std::fs::write(&path, kept.iter().map(|l| format!("{l}\n")).collect::<String>());
    }
}

// --- workspace switch -------------------------------------------------------------------------------

fn workspace_off_path() -> Option<PathBuf> {
    state_file("ai-off-workspaces.json")
}

fn off_list() -> Vec<String> {
    workspace_off_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn workspace_key(state: &AppState) -> Option<String> {
    state.config.workspace().map(|(ws, _)| ws.root.display().to_string().to_lowercase())
}

/// "Don't use AI in this workspace" (docs/10 §4.3), one click from the preview.
#[tauri::command]
pub fn ai_workspace_off(state: State<'_, AppState>, off: bool) -> CmdResult {
    let key = workspace_key(&state).ok_or("no workspace is open")?;
    let mut list = off_list();
    list.retain(|k| k != &key);
    if off {
        list.push(key);
    }
    let path = workspace_off_path().ok_or("no data folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(&list).map_err(err)?).map_err(err)
}

fn usable(state: &AppState) -> Result<Ai, String> {
    let ai = state.config.config().ai;
    if !ai.enabled {
        return Err("AI is off ([ai] enabled)".into());
    }
    if workspace_key(state).is_some_and(|k| off_list().contains(&k)) {
        return Err("AI is off in this workspace".into());
    }
    Ok(ai)
}

// --- commands -----------------------------------------------------------------------------------------

/// Whether a mod can ask now (`ctx.ai.available`).
#[tauri::command]
pub fn ai_available(state: State<'_, AppState>) -> bool {
    usable(&state).is_ok()
}

/// What would be sent, and where, for the preview (docs/10 §4.3).
#[tauri::command]
pub fn ai_preview(state: State<'_, AppState>, prompt: String) -> CmdResult<AiPreview> {
    let ai = usable(&state)?;
    let model = model_of(&ai)?;
    let url = url_of(&ai, &model)?;
    let (prompt, redactions) = if ai.redact_secrets { redact(&prompt) } else { (prompt, 0) };
    Ok(AiPreview {
        provider: provider_name(ai.provider).into(),
        host: host_of(&url),
        model,
        prompt,
        redactions,
        full: previews_shown() < ai.preview_first_n,
    })
}

/// Settings › AI: the models a local Ollama has. Only when the user opens that screen (F2).
#[tauri::command]
pub async fn ai_detect_local(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let ai = state.config.config().ai;
    let base = ai.endpoint.filter(|e| !e.trim().is_empty()).unwrap_or_else(|| OLLAMA_DEFAULT.into());
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent =
            ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(3))).build().into();
        let text = agent
            .get(format!("{}/api/tags", base.trim_end_matches('/')))
            .call()
            .map_err(|e| format!("no Ollama at {base}: {e}"))?
            .into_body()
            .read_to_string()
            .map_err(err)?;
        let body: Value = serde_json::from_str(&text).map_err(err)?;
        Ok(body["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["name"].as_str().map(str::to_owned))
            .collect())
    })
    .await
    .map_err(err)?
}

/// Ask the provider (`ctx.ai.complete` / `stream`). The UI has already shown the preview and the
/// user agreed; `prompt` is redacted again here so nothing slips past.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ai_complete(
    state: State<'_, AppState>,
    mod_id: String,
    purpose: String,
    system: Option<String>,
    prompt: String,
    max_tokens: Option<u32>,
    json_out: bool,
    events: Channel<AiEvent>,
) -> CmdResult<AiResult> {
    let ai = usable(&state)?;
    if !rate_ok(&mod_id) {
        return Err("too many AI requests from this mod (10 a minute)".into());
    }
    let model = model_of(&ai)?;
    let url = url_of(&ai, &model)?;
    let local = is_local(&url);
    let key = match ai.provider {
        AiProvider::Local => None,
        AiProvider::OpenaiCompatible => key_for(ai.provider)?,
        p => Some(key_for(p)?.ok_or("no API key stored: add one in Settings › AI")?),
    };
    let (prompt, redactions) = if ai.redact_secrets { redact(&prompt) } else { (prompt, 0) };
    let system = system.map(|s| if ai.redact_secrets { redact(&s).0 } else { s });
    let max_tokens = max_tokens.unwrap_or(2000).clamp(16, 16_000);
    let provider = ai.provider;
    let (m, p, s) = (model.clone(), prompt.clone(), system.clone());
    let text = tauri::async_runtime::spawn_blocking(move || {
        request(provider, &url, key.as_deref(), &m, s.as_deref(), &p, max_tokens, json_out, &mut |t| {
            let _ = events.send(AiEvent::Delta { text: t.to_owned() });
        })
    })
    .await
    .map_err(err)??;
    log(
        &ai,
        &json!({
            "time": now_secs(), "mod": mod_id, "purpose": purpose, "provider": provider_name(provider),
            "model": model, "system": system, "prompt": prompt, "response": text,
        }),
    );
    Ok(AiResult { text, provider: if local { "local" } else { "cloud" }, model, truncated: redactions > 0 })
}

// --- the providers --------------------------------------------------------------------------------

/// Send one request and read the streamed answer, calling `on_delta` for each piece.
#[allow(clippy::too_many_arguments)]
fn request(
    provider: AiProvider,
    url: &str,
    key: Option<&str>,
    model: &str,
    system: Option<&str>,
    prompt: &str,
    max_tokens: u32,
    json_out: bool,
    on_delta: &mut dyn FnMut(&str),
) -> Result<String, String> {
    let agent: ureq::Agent =
        ureq::Agent::config_builder().timeout_global(Some(TIMEOUT)).http_status_as_error(false).build().into();
    let mut req = agent.post(url).header("content-type", "application/json");
    let chat = |sys: Option<&str>| {
        let mut messages = Vec::new();
        if let Some(s) = sys {
            messages.push(json!({ "role": "system", "content": s }));
        }
        messages.push(json!({ "role": "user", "content": prompt }));
        messages
    };
    let body = match provider {
        AiProvider::Local => {
            let mut b = json!({ "model": model, "messages": chat(system), "stream": true });
            if json_out {
                b["format"] = json!("json");
            }
            b
        }
        AiProvider::Openai | AiProvider::OpenaiCompatible => {
            if let Some(k) = key {
                req = req.header("authorization", &format!("Bearer {k}"));
            }
            let mut b = json!({ "model": model, "messages": chat(system), "stream": true, "max_tokens": max_tokens });
            if json_out {
                b["response_format"] = json!({ "type": "json_object" });
            }
            b
        }
        AiProvider::Claude => {
            req = req
                .header("x-api-key", key.unwrap_or_default())
                .header("anthropic-version", "2023-06-01")
                // A declined request is re-run on Anthropic's recommended model instead of failing.
                .header("anthropic-beta", "server-side-fallback-2026-07-01");
            let mut b = json!({
                "model": model,
                "max_tokens": max_tokens,
                "stream": true,
                "messages": [{ "role": "user", "content": prompt }],
                // Short answers about commands: little deliberation is needed.
                "output_config": { "effort": "low" },
                "fallbacks": "default",
            });
            if let Some(s) = system {
                b["system"] = json!(s);
            }
            b
        }
        AiProvider::Gemini => {
            req = req.header("x-goog-api-key", key.unwrap_or_default());
            let mut b = json!({
                "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
                "generationConfig": { "maxOutputTokens": max_tokens },
            });
            if let Some(s) = system {
                b["systemInstruction"] = json!({ "parts": [{ "text": s }] });
            }
            if json_out {
                b["generationConfig"]["responseMimeType"] = json!("application/json");
            }
            b
        }
    };
    let response = req.send(body.to_string()).map_err(|e| format!("could not reach {}: {e}", host_of(url)))?;
    let status = response.status().as_u16();
    let reader = BufReader::new(response.into_body().into_reader());
    if status >= 400 {
        let text: String = reader.lines().map_while(Result::ok).collect::<Vec<_>>().join("\n");
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).map(str::to_owned))
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("{} answered {status}: {detail}", host_of(url)));
    }
    let mut full = String::new();
    let mut push = |t: &str| {
        if !t.is_empty() {
            full.push_str(t);
            on_delta(t);
        }
    };
    for line in reader.lines() {
        let line = line.map_err(err)?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match provider {
            // Ollama streams one JSON object per line.
            AiProvider::Local => {
                let v: Value = serde_json::from_str(line).map_err(err)?;
                if let Some(e) = v["error"].as_str() {
                    return Err(e.to_owned());
                }
                push(v["message"]["content"].as_str().unwrap_or_default());
                if v["done"].as_bool() == Some(true) {
                    break;
                }
            }
            // The others use server-sent events: `data: {...}` lines.
            _ => {
                let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
                if data == "[DONE]" {
                    break;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                match provider {
                    AiProvider::Claude => match v["type"].as_str() {
                        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
                            push(v["delta"]["text"].as_str().unwrap_or_default());
                        }
                        Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => {
                            return Err("the model declined this request".into());
                        }
                        Some("error") => {
                            return Err(v["error"]["message"].as_str().unwrap_or("error").to_owned());
                        }
                        _ => {}
                    },
                    AiProvider::Gemini => {
                        for part in v["candidates"][0]["content"]["parts"].as_array().into_iter().flatten() {
                            push(part["text"].as_str().unwrap_or_default());
                        }
                    }
                    _ => push(v["choices"][0]["delta"]["content"].as_str().unwrap_or_default()),
                }
            }
        }
    }
    Ok(full)
}
