//! The `otmod:` scheme (docs/05 §5.4 B, decision D7): a `custom` view runs in a sandboxed iframe
//! with no scripts, and may load images, fonts, CSS and audio from its own mod's folder, nothing else.
//!
//! Requests look like `otmod://<mod-id>/<path>`. WebView2 on Windows serves custom schemes as
//! `http://otmod.localhost/<mod-id>/<path>`, so with the host `otmod.localhost` (or `localhost`) the
//! mod id is the first path segment instead.

use std::path::{Component, Path};

use tauri::http::{self, HeaderValue, Request, Response, StatusCode, header};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::mods::ModsState;

/// The file types a view may load, with their media types. Anything else is a 404.
const TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("avif", "image/avif"),
    ("ico", "image/x-icon"),
    ("css", "text/css"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("ttf", "font/ttf"),
    ("otf", "font/otf"),
    ("mp3", "audio/mpeg"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
    ("m4a", "audio/mp4"),
];

/// Answer one `otmod:` request. Reading the file happens on a thread, so the UI never waits for it.
pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let Some((id, rel)) = split(request.uri()) else {
        return responder.respond(not_found());
    };
    // Only enabled mods (as the last `mods_list` found them) have assets served. A disabled or
    // unknown mod, or a workspace mod nobody approved, gets a 404.
    let dir = ctx.app_handle().state::<ModsState>().servable_dir(&id);
    std::thread::spawn(move || {
        let response = match dir.and_then(|dir| asset(&dir, &rel)) {
            Some((bytes, mime)) => ok(bytes, mime),
            None => not_found(),
        };
        responder.respond(response);
    });
}

/// The mod id and the path inside its folder, from either URL form (see the module comment).
fn split(uri: &http::Uri) -> Option<(String, String)> {
    let host = uri.host()?;
    let path = uri.path().trim_start_matches('/');
    let (id, rest) =
        if host == "otmod.localhost" || host == "localhost" { path.split_once('/')? } else { (host, path) };
    Some((percent_decode(id)?, percent_decode(rest)?))
}

/// Decode `%XX` escapes. A malformed escape or non-UTF-8 result is `None`.
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let digits = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(digits, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The bytes and media type of `rel` inside the mod folder `dir`, if it is an allowed asset that
/// really lies inside `dir`. The path must be plain names only (no `..`, no root, no drive prefix),
/// and the canonical file must still lie inside the canonical folder, so a symlink cannot lead out.
fn asset(dir: &Path, rel: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = Path::new(rel);
    if rel.is_empty() || rel.contains(['\\', '\0']) || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = TYPES.iter().find(|(e, _)| *e == ext)?.1;
    let root = dir.canonicalize().ok()?;
    let file = root.join(path).canonicalize().ok()?;
    if !file.starts_with(&root) || !file.is_file() {
        return None;
    }
    Some((std::fs::read(&file).ok()?, mime))
}

/// A 200 with the asset. `nosniff` keeps the type we chose; `*` lets the opaque-origin frame fetch
/// fonts (which need CORS) as well.
fn ok(bytes: Vec<u8>, mime: &'static str) -> Response<Vec<u8>> {
    let mut response = Response::new(bytes);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    response
}

fn not_found() -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}
