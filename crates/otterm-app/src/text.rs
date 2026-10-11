//! Text for the renderer (decisions C3, C4): the UI asks for the grid metrics of a font list and
//! for batches of grapheme clusters, which come back as bitmaps for its glyph atlas.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use otterm_text::{FontSet, Rasterizer, Style};
use serde::{Deserialize, Serialize};

/// The bundled icon font (decision B14), so prompts show their icons without an installed Nerd
/// Font; the UI serves the same file to CSS.
static SYMBOLS_FONT: &[u8] = include_bytes!("../../../packages/ui/public/fonts/SymbolsNerdFontMono-Regular.ttf");

/// The installed fonts plus the bundled ones. Loading takes a moment, so [`config::warm_up`]
/// starts it in the background.
pub fn db() -> &'static fontdb::Database {
    static DB: OnceLock<fontdb::Database> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        db.load_font_source(fontdb::Source::Binary(Arc::new(SYMBOLS_FONT)));
        db
    })
}

/// Rasterizers kept between requests: one per font list and pixel size, a few at a time (zoom
/// steps, panes with different profiles).
const KEEP: usize = 6;

#[derive(Default)]
struct Engines {
    sets: HashMap<String, Arc<FontSet>>,
    rasterizers: Vec<(String, u32, Rasterizer)>,
}

fn engines() -> &'static Mutex<Engines> {
    static ENGINES: OnceLock<Mutex<Engines>> = OnceLock::new();
    ENGINES.get_or_init(Mutex::default)
}

/// Run `f` with the rasterizer for `families` at `size` pixels.
fn with_rasterizer<R>(families: &[String], size: f32, f: impl FnOnce(&mut Rasterizer) -> R) -> Result<R, String> {
    let key = families.join("\n");
    let size_bits = size.to_bits();
    let mut engines = engines().lock().map_err(|e| e.to_string())?;
    let at = engines.rasterizers.iter().position(|(k, s, _)| *k == key && *s == size_bits);
    let at = match at {
        Some(i) => i,
        None => {
            let set = match engines.sets.get(&key) {
                Some(set) => Arc::clone(set),
                None => {
                    let set = Arc::new(FontSet::resolve(db(), families).ok_or("none of the fonts is installed")?);
                    engines.sets.insert(key.clone(), Arc::clone(&set));
                    set
                }
            };
            if engines.rasterizers.len() >= KEEP {
                engines.rasterizers.remove(0);
            }
            // Hinting keeps small text crisp; large text is smoother without it.
            engines.rasterizers.push((key, size_bits, Rasterizer::new(set, size, size < 40.0)));
            engines.rasterizers.len() - 1
        }
    };
    // Most recently used last.
    let entry = engines.rasterizers.remove(at);
    engines.rasterizers.push(entry);
    let (_, _, rasterizer) = engines.rasterizers.last_mut().expect("just pushed");
    Ok(f(rasterizer))
}

/// Resolve a font list ahead of its first use (reading the font files is the slow part), so the
/// first window does not wait for it. Errors are left for the real request to report.
pub fn prepare(families: &[String], size_px: f32) {
    let _ = with_rasterizer(families, size_px, |_| ());
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRequest {
    pub families: Vec<String>,
    pub size_px: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub advance: f32,
    pub ascent: f32,
    pub descent: f32,
}

pub fn metrics(req: &MetricsRequest) -> Result<Metrics, String> {
    with_rasterizer(&req.families, req.size_px, |r| {
        let m = r.metrics();
        Metrics { advance: m.advance, ascent: m.ascent, descent: m.descent }
    })
}

#[derive(Deserialize)]
pub struct GlyphItem {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphRequest {
    pub families: Vec<String>,
    pub size_px: f32,
    pub items: Vec<GlyphItem>,
}

/// Bitmaps for every item, in order. Little-endian: per item `u16 width, u16 height, i16 left,
/// i16 top, u8 color, u8 0`, then `width * height * 4` bytes of straight-alpha RGBA. A width of
/// 0 is a cluster with nothing to draw.
pub fn glyphs(req: &GlyphRequest) -> Result<Vec<u8>, String> {
    /// Longer than any grapheme cluster; keeps a bad request from tying up the rasterizer.
    const MAX_TEXT: usize = 64;
    with_rasterizer(&req.families, req.size_px, |r| {
        let mut out = Vec::with_capacity(req.items.len() * 400);
        for item in &req.items {
            let style = Style { bold: item.bold, italic: item.italic };
            let bitmap = (item.text.len() <= MAX_TEXT).then(|| r.render(&item.text, style)).flatten();
            match bitmap {
                Some(b) => {
                    out.extend_from_slice(&(b.width as u16).to_le_bytes());
                    out.extend_from_slice(&(b.height as u16).to_le_bytes());
                    out.extend_from_slice(&(b.left as i16).to_le_bytes());
                    out.extend_from_slice(&(b.top as i16).to_le_bytes());
                    out.push(b.color as u8);
                    out.push(0);
                    out.extend_from_slice(&b.data);
                }
                None => out.extend_from_slice(&[0; 10]),
            }
        }
        out
    })
}
