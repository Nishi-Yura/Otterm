//! Text for the terminal grid, done in Rust so that every OS shows the same thing (decisions C3
//! and C4): a list of font families is resolved against the installed fonts, each grapheme
//! cluster is shaped with the first font that has its characters, and the glyphs are rasterized
//! into one bitmap per cluster that the renderer keeps in its atlas.

use std::sync::Arc;

use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::{Angle, Format, Transform};
use swash::{CacheKey, FontRef};

/// Font bytes shared with the font database.
type Data = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// One face of a family: its bytes, and what swash needs to find it in its caches again.
struct Face {
    data: Data,
    index: u32,
    offset: u32,
    key: CacheKey,
}

impl Face {
    fn load(db: &fontdb::Database, id: fontdb::ID) -> Option<Face> {
        let (source, index) = db.face_source(id)?;
        let data: Data = match source {
            fontdb::Source::Binary(bytes) | fontdb::Source::SharedFile(_, bytes) => bytes,
            fontdb::Source::File(path) => Arc::new(std::fs::read(path).ok()?),
        };
        let font = FontRef::from_index((*data).as_ref(), index as usize)?;
        let (offset, key) = (font.offset, font.key);
        Some(Face { data, index, offset, key })
    }

    fn font(&self) -> FontRef<'_> {
        FontRef { data: (*self.data).as_ref(), offset: self.offset, key: self.key }
    }

    fn shaper(&self) -> Option<rustybuzz::Face<'_>> {
        rustybuzz::Face::from_slice((*self.data).as_ref(), self.index)
    }
}

/// A family resolved to its regular face and, when the family has them, bold and italic ones.
struct Family {
    regular: Face,
    bold: Option<Face>,
    italic: Option<Face>,
    bold_italic: Option<Face>,
}

impl Family {
    /// The face for a style; `synthetic` says which of bold and italic it lacks, to be faked.
    fn face(&self, style: Style) -> (&Face, Style) {
        match (style.bold, style.italic) {
            (true, true) => {
                if let Some(f) = &self.bold_italic {
                    return (f, Style::default());
                }
                if let Some(f) = &self.bold {
                    return (f, Style { bold: false, italic: true });
                }
                if let Some(f) = &self.italic {
                    return (f, Style { bold: true, italic: false });
                }
                (&self.regular, style)
            }
            (true, false) => self.bold.as_ref().map_or((&self.regular, style), |f| (f, Style::default())),
            (false, true) => self.italic.as_ref().map_or((&self.regular, style), |f| (f, Style::default())),
            (false, false) => (&self.regular, Style::default()),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
}

/// The families of one font configuration, in fallback order. Resolving reads the font files, so
/// a set is built once per configuration and shared.
pub struct FontSet {
    families: Vec<Family>,
}

impl FontSet {
    /// Resolve `names` against `db`; families that are not installed are skipped. `None` when none
    /// of them is.
    pub fn resolve(db: &fontdb::Database, names: &[String]) -> Option<FontSet> {
        let mut families = Vec::new();
        for name in names {
            let query = |weight, style| {
                let q = fontdb::Query {
                    families: &[fontdb::Family::Name(name)],
                    weight,
                    stretch: fontdb::Stretch::Normal,
                    style,
                };
                db.query(&q)
            };
            let Some(regular_id) = query(fontdb::Weight::NORMAL, fontdb::Style::Normal) else { continue };
            // fontdb returns the closest face; one that is not the requested weight or style is
            // the regular face again, which is then faked instead.
            let variant = |weight, style: fontdb::Style| {
                let id = query(weight, style)?;
                let info = db.face(id)?;
                let bold_ok = weight != fontdb::Weight::BOLD || info.weight >= fontdb::Weight::SEMIBOLD;
                let italic_ok = style == fontdb::Style::Normal || info.style != fontdb::Style::Normal;
                (id != regular_id && bold_ok && italic_ok).then(|| Face::load(db, id)).flatten()
            };
            let Some(regular) = Face::load(db, regular_id) else { continue };
            families.push(Family {
                bold: variant(fontdb::Weight::BOLD, fontdb::Style::Normal),
                italic: variant(fontdb::Weight::NORMAL, fontdb::Style::Italic),
                bold_italic: variant(fontdb::Weight::BOLD, fontdb::Style::Italic),
                regular,
            });
        }
        (!families.is_empty()).then_some(FontSet { families })
    }
}

/// Grid metrics of the primary font at a pixel size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metrics {
    /// Advance of `M` in pixels; the cell width before letter spacing.
    pub advance: f32,
    pub ascent: f32,
    pub descent: f32,
}

/// A rasterized grapheme cluster: straight-alpha RGBA, white where the text color goes unless
/// `color` (an emoji keeps its own colors).
#[derive(Debug, Clone, Default)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    /// Offset from the cluster's origin (the pen at the baseline), x to the right, y down.
    pub left: i32,
    pub top: i32,
    pub color: bool,
    pub data: Vec<u8>,
}

/// Shapes and rasterizes clusters of one font set at one pixel size.
pub struct Rasterizer {
    set: Arc<FontSet>,
    size: f32,
    hint: bool,
    context: ScaleContext,
}

impl Rasterizer {
    pub fn new(set: Arc<FontSet>, size: f32, hint: bool) -> Self {
        Self { set, size: size.max(1.0), hint, context: ScaleContext::new() }
    }

    pub fn metrics(&self) -> Metrics {
        let face = &self.set.families[0].regular;
        let font = face.font();
        let m = font.metrics(&[]).scale(self.size);
        let gid = font.charmap().map('M');
        let advance = font.glyph_metrics(&[]).scale(self.size).advance_width(gid);
        // A font without M (symbols only) falls back on its average width.
        let advance = if advance > 0.0 { advance } else { m.average_width.max(m.max_width / 2.0) };
        Metrics { advance, ascent: m.ascent, descent: m.descent }
    }

    /// Rasterize one cluster; `None` when it has no visible pixels.
    pub fn render(&mut self, text: &str, style: Style) -> Option<Bitmap> {
        let set = Arc::clone(&self.set);
        let (family, shaped) = shape(&set, text, style)?;
        let (face, synthetic) = family.face(style);
        let font = face.font();
        let scale = self.size / shaped.upem;
        let mut scaler = self.context.builder(font).size(self.size).hint(self.hint).build();
        let mut render =
            Render::new(&[Source::ColorOutline(0), Source::ColorBitmap(StrikeWith::BestFit), Source::Outline]);
        render.format(Format::Alpha);
        if synthetic.bold {
            render.embolden(self.size / 24.0);
        }
        if synthetic.italic {
            render.transform(Some(Transform::skew(Angle::from_degrees(-12.0), Angle::ZERO)));
        }

        // Each glyph's image and where its top-left lands, relative to the pen at the baseline.
        let mut images = Vec::with_capacity(shaped.glyphs.len());
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let mut pen_x = 0.0f32;
        for g in &shaped.glyphs {
            let image = render.render(&mut scaler, g.id);
            if let Some(img) = image
                && img.placement.width > 0
                && img.placement.height > 0
            {
                let left = (pen_x + g.x_offset * scale).round() as i32 + img.placement.left;
                let top = (-g.y_offset * scale).round() as i32 - img.placement.top;
                x0 = x0.min(left);
                y0 = y0.min(top);
                x1 = x1.max(left + img.placement.width as i32);
                y1 = y1.max(top + img.placement.height as i32);
                images.push((img, left, top));
            }
            pen_x += g.x_advance * scale;
        }
        if images.is_empty() {
            return None;
        }
        let width = (x1 - x0) as u32;
        let height = (y1 - y0) as u32;
        let color = images.iter().any(|(img, ..)| matches!(img.content, Content::Color));
        let mut data = vec![0u8; (width * height * 4) as usize];
        for (img, left, top) in &images {
            let (w, h) = (img.placement.width as usize, img.placement.height as usize);
            for y in 0..h {
                for x in 0..w {
                    let dst = (((top - y0) as usize + y) * width as usize + (left - x0) as usize + x) * 4;
                    let px = match img.content {
                        Content::Mask => {
                            let a = img.data[y * w + x];
                            [255, 255, 255, a]
                        }
                        Content::SubpixelMask => {
                            let i = (y * w + x) * 4;
                            let a = img.data[i..i + 3].iter().map(|&v| v as u16).sum::<u16>() / 3;
                            [255, 255, 255, a as u8]
                        }
                        Content::Color => {
                            let i = (y * w + x) * 4;
                            [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
                        }
                    };
                    // Overlapping glyphs (a mark over its base): the stronger coverage wins.
                    if px[3] > data[dst + 3] {
                        data[dst..dst + 4].copy_from_slice(&px);
                    }
                }
            }
        }
        Some(Bitmap { width, height, left: x0, top: y0, color, data })
    }
}

/// Shape `text` with the first family whose font has every character of it; the primary family
/// when none does (its boxes are the honest answer).
fn shape<'a>(set: &'a FontSet, text: &str, style: Style) -> Option<(&'a Family, Shaped)> {
    {
        let mut first: Option<(&Family, Shaped)> = None;
        for family in &set.families {
            let (face, _) = family.face(style);
            let Some(shaper) = face.shaper() else { continue };
            let mut buffer = rustybuzz::UnicodeBuffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            let out = rustybuzz::shape(&shaper, &[], buffer);
            let glyphs: Vec<ShapedGlyph> = out
                .glyph_infos()
                .iter()
                .zip(out.glyph_positions())
                .map(|(info, pos)| ShapedGlyph {
                    id: info.glyph_id as u16,
                    x_advance: pos.x_advance as f32,
                    x_offset: pos.x_offset as f32,
                    y_offset: pos.y_offset as f32,
                })
                .collect();
            let shaped = Shaped { upem: shaper.units_per_em() as f32, glyphs };
            if shaped.glyphs.iter().all(|g| g.id != 0) {
                return Some((family, shaped));
            }
            if first.is_none() {
                first = Some((family, shaped));
            }
        }
        first
    }
}

struct ShapedGlyph {
    id: u16,
    x_advance: f32,
    x_offset: f32,
    y_offset: f32,
}

struct Shaped {
    upem: f32,
    glyphs: Vec<ShapedGlyph>,
}
