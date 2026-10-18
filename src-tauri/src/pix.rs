//! Picture comparison: decoding, per-pixel classification, statistics and the rendered
//! difference picture (tolerance, mismatch range and blend modes).
//!
//! Pixels are compared as raw, non-premultiplied RGBA. Pictures are placed on a shared
//! canvas at their offsets (top-left aligned by default); pixels covered by only one
//! picture are orphans.

use base64::Engine;
use image::{ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};

pub const DEFAULT_TOLERANCE: u8 = 25;
/// Minimum luminance used when shading difference colours.
const MIN_LUM: u32 = 0x60;

#[derive(Debug, Clone)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    /// RGBA, row-major, non-premultiplied.
    pub rgba: Vec<u8>,
    pub format: String,
    pub has_alpha: bool,
}

impl Picture {
    pub fn from_rgba(img: RgbaImage) -> Self {
        let (width, height) = img.dimensions();
        Picture { width, height, rgba: img.into_raw(), format: String::new(), has_alpha: true }
    }
    #[inline]
    fn px(&self, x: u32, y: u32) -> &[u8] {
        let i = ((y * self.width + x) * 4) as usize;
        &self.rgba[i..i + 4]
    }
}

fn format_name(f: Option<ImageFormat>) -> String {
    f.and_then(|f| f.extensions_str().first().copied()).unwrap_or("").to_uppercase()
}

/// Decodes a picture file. Bitmaps without an alpha channel treat the colour of their
/// bottom-left pixel as transparent (every pixel of exactly that colour gets alpha 0).
pub fn load_picture(path: &str) -> Result<Picture, String> {
    let reader = ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    decode(reader)
}

/// Decodes an in-memory picture (any supported format).
pub fn load_picture_bytes(bytes: &[u8]) -> Result<Picture, String> {
    decode(ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?)
}

fn decode<R: std::io::BufRead + std::io::Seek>(reader: ImageReader<R>) -> Result<Picture, String> {
    let fmt = reader.format();
    let img = reader.decode().map_err(|e| e.to_string())?;
    let has_alpha = img.color().has_alpha();
    let mut pic = Picture::from_rgba(img.to_rgba8());
    pic.format = format_name(fmt);
    pic.has_alpha = has_alpha;
    if fmt == Some(ImageFormat::Bmp) && !has_alpha && pic.width > 0 && pic.height > 0 {
        let key: [u8; 3] = pic.px(0, pic.height - 1)[..3].try_into().unwrap();
        for p in pic.rgba.chunks_exact_mut(4) {
            if p[..3] == key {
                p[3] = 0;
            }
        }
    }
    Ok(pic)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PixMode {
    /// Same / unimportant (within tolerance) / important difference colours.
    #[default]
    Tolerance,
    /// Yellow intensity proportional to the size of the difference.
    Range,
    /// Weighted mix of both pictures.
    Blend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PixOptions {
    pub mode: PixMode,
    /// Largest per-channel difference that is still unimportant (0..=255).
    pub tolerance: u8,
    /// Shade the difference colours by the pictures' luminance.
    pub ghost: bool,
    /// Treat unimportant differences as same (colour and statistics).
    pub ignore_unimportant: bool,
    /// Right picture weight in blend mode (0..=100).
    pub blend_pct: u8,
    /// Position of the right picture relative to the left one.
    pub offset_x: i32,
    pub offset_y: i32,
    /// RGBA colour of canvas areas covered by neither picture.
    pub background: [u8; 4],
    /// Per side: quarter turns clockwise, applied after the horizontal flip.
    pub rotate: [u8; 2],
    pub flip: [bool; 2],
    /// Resize the smaller picture to the other picture's dimensions.
    pub auto_scale: bool,
}

impl Default for PixOptions {
    fn default() -> Self {
        PixOptions {
            mode: PixMode::Tolerance,
            tolerance: DEFAULT_TOLERANCE,
            ghost: true,
            ignore_unimportant: false,
            blend_pct: 50,
            offset_x: 0,
            offset_y: 0,
            background: [0, 0, 0, 0],
            rotate: [0, 0],
            flip: [false, false],
            auto_scale: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixCounts {
    pub same: u64,
    pub unimportant: u64,
    pub important: u64,
    pub left_orphan: u64,
    pub right_orphan: u64,
}

/// Canvas placement for both pictures.
#[derive(Debug, Clone, Copy)]
struct Layout {
    pos: [(i64, i64); 2],
    width: u32,
    height: u32,
}

fn side_pos(offset: i32, side: usize) -> i64 {
    let o = offset as i64;
    match (o >= 0, side) {
        (true, 0) | (false, 1) => 0,
        (true, _) => o,
        (false, _) => -o,
    }
}

fn layout(a: &Picture, b: &Picture, o: &PixOptions) -> Layout {
    let pos = [(side_pos(o.offset_x, 0), side_pos(o.offset_y, 0)), (side_pos(o.offset_x, 1), side_pos(o.offset_y, 1))];
    let width = (pos[0].0 + a.width as i64).max(pos[1].0 + b.width as i64) as u32;
    let height = (pos[0].1 + a.height as i64).max(pos[1].1 + b.height as i64) as u32;
    Layout { pos, width, height }
}

/// Overlap rectangle on the canvas: (x0, y0, x1, y1), exclusive end; None when disjoint.
fn overlap(a: &Picture, b: &Picture, l: &Layout) -> Option<(i64, i64, i64, i64)> {
    let x0 = l.pos[0].0.max(l.pos[1].0);
    let y0 = l.pos[0].1.max(l.pos[1].1);
    let x1 = (l.pos[0].0 + a.width as i64).min(l.pos[1].0 + b.width as i64);
    let y1 = (l.pos[0].1 + a.height as i64).min(l.pos[1].1 + b.height as i64);
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

/// Pixel statistics. Only the colour channels are compared (alpha is ignored).
pub fn pix_stats(a: &Picture, b: &Picture, o: &PixOptions) -> PixCounts {
    let l = layout(a, b, o);
    let mut c = PixCounts {
        left_orphan: a.width as u64 * a.height as u64,
        right_orphan: b.width as u64 * b.height as u64,
        ..Default::default()
    };
    let Some((x0, y0, x1, y1)) = overlap(a, b, &l) else { return c };
    let area = ((x1 - x0) * (y1 - y0)) as u64;
    c.left_orphan -= area;
    c.right_orphan -= area;
    let tol = o.tolerance;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = a.px((x - l.pos[0].0) as u32, (y - l.pos[0].1) as u32);
            let q = b.px((x - l.pos[1].0) as u32, (y - l.pos[1].1) as u32);
            let d = [p[0].abs_diff(q[0]), p[1].abs_diff(q[1]), p[2].abs_diff(q[2])];
            if d == [0, 0, 0] {
                c.same += 1;
            } else if o.mode != PixMode::Range && d.iter().all(|&v| v <= tol) {
                c.unimportant += 1;
            } else {
                c.important += 1;
            }
        }
    }
    c
}

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

/// Colour shading table: entry for luminance L (>= 0x60) is `c * L / 255` per channel.
fn shade_table(c: [u8; 3], ghost: bool) -> Vec<[u8; 3]> {
    let base = if ghost {
        let m = *c.iter().max().unwrap() as u32;
        if m == 0 { [255; 3] } else { c.map(|v| (v as u32 * 255 / m) as u8) }
    } else {
        c
    };
    (0..256u32)
        .map(|lum| if ghost { base.map(|v| (lum.max(MIN_LUM) * v as u32 / 255) as u8) } else { base })
        .collect()
}

fn muldiv_round(v: u32, num: u32, den: u32) -> u8 {
    ((v * num * 2 + den) / (den * 2)) as u8
}

/// Renders the difference picture for the selected mode as RGBA.
pub fn render(a: &Picture, b: &Picture, o: &PixOptions) -> (u32, u32, Vec<u8>) {
    let l = layout(a, b, o);
    let (w, h) = (l.width, l.height);
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for _ in 0..(w as usize * h as usize) {
        out.extend_from_slice(&o.background);
    }
    let put = |out: &mut Vec<u8>, x: i64, y: i64, px: &[u8]| {
        let i = ((y as usize) * w as usize + x as usize) * 4;
        out[i..i + 4].copy_from_slice(px);
    };
    // Orphan areas show the picture that covers them.
    for (side, pic) in [a, b].into_iter().enumerate() {
        let (px0, py0) = l.pos[side];
        for y in 0..pic.height {
            for x in 0..pic.width {
                put(&mut out, px0 + x as i64, py0 + y as i64, pic.px(x, y));
            }
        }
    }
    let Some((x0, y0, x1, y1)) = overlap(a, b, &l) else { return (w, h, out) };
    let same_t = shade_table(WHITE, o.ghost);
    let imp_t = shade_table(RED, o.ghost);
    let unimp_t = shade_table(if o.ignore_unimportant { WHITE } else { BLUE }, o.ghost);
    let pct = o.blend_pct.min(100) as u32;
    let lut_l: Vec<u8> = (0..256).map(|v| muldiv_round(v, 100 - pct, 100)).collect();
    let lut_r: Vec<u8> = (0..256).map(|v| muldiv_round(v, pct, 100)).collect();
    let tol = o.tolerance;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = a.px((x - l.pos[0].0) as u32, (y - l.pos[0].1) as u32);
            let q = b.px((x - l.pos[1].0) as u32, (y - l.pos[1].1) as u32);
            let d = [p[0].abs_diff(q[0]), p[1].abs_diff(q[1]), p[2].abs_diff(q[2]), p[3].abs_diff(q[3])];
            let px: [u8; 4] = match o.mode {
                PixMode::Tolerance => {
                    let sum: u32 = p.iter().chain(q.iter()).map(|&v| v as u32).sum();
                    let lum = (sum >> 3) as usize;
                    let c = if d == [0; 4] {
                        same_t[lum]
                    } else if d.iter().any(|&v| v > tol) {
                        imp_t[lum]
                    } else {
                        unimp_t[lum]
                    };
                    [c[0], c[1], c[2], 255]
                }
                PixMode::Range => {
                    let s: u32 = d.iter().map(|&v| v as u32).sum();
                    let v = if s == 0 { 0 } else { (s / 4 + 48).min(255) as u8 };
                    [v, v, 0, 255]
                }
                PixMode::Blend => {
                    if p[3] == 255 && q[3] == 255 {
                        let m = |i: usize| (lut_l[p[i] as usize] as u32 + lut_r[q[i] as usize] as u32).min(255) as u8;
                        [m(0), m(1), m(2), 255]
                    } else {
                        let wa = lut_l[p[3] as usize] as u32;
                        let wb = lut_r[q[3] as usize] as u32;
                        if wa == 0 && wb == 0 {
                            [0, 0, 0, 0]
                        } else {
                            let al = (wa + wb).min(255);
                            let m = |i: usize| ((p[i] as u32 * wa + q[i] as u32 * wb) / al).min(255) as u8;
                            [m(0), m(1), m(2), al as u8]
                        }
                    }
                }
            };
            put(&mut out, x, y, &px);
        }
    }
    (w, h, out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PicInfo {
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub has_alpha: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixResult {
    pub left: PicInfo,
    pub right: PicInfo,
    pub width: u32,
    pub height: u32,
    pub counts: PixCounts,
    /// PNG data URL of the rendered difference picture.
    pub image: String,
    /// PNG data URLs of rotated, flipped or scaled pictures (None when shown as loaded).
    pub sides: [Option<String>; 2],
}

fn info(p: &Picture) -> PicInfo {
    PicInfo { width: p.width, height: p.height, format: p.format.clone(), has_alpha: p.has_alpha }
}

pub fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::ImageEncoder;
    let mut buf = Vec::new();
    PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::Adaptive)
        .write_image(rgba, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

type CacheKey = (String, u64, Option<std::time::SystemTime>);
static CACHE: std::sync::Mutex<Vec<(CacheKey, std::sync::Arc<Picture>)>> = std::sync::Mutex::new(Vec::new());

/// Loads a picture file through a small cache keyed by path, size and modification time.
fn load_cached(path: &str) -> Result<std::sync::Arc<Picture>, String> {
    let md = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let key: CacheKey = (path.to_string(), md.len(), md.modified().ok());
    if let Some((_, p)) = CACHE.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(p.clone());
    }
    let pic = std::sync::Arc::new(load_picture(path)?);
    let mut c = CACHE.lock().unwrap();
    c.retain(|(k, _)| k.0 != path);
    c.insert(0, (key, pic.clone()));
    c.truncate(4);
    Ok(pic)
}

fn source(path: &str, data: Option<&str>) -> Result<std::sync::Arc<Picture>, String> {
    match data {
        Some(d) => {
            let b64 = d.split_once(',').map_or(d, |(_, v)| v);
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
            load_picture_bytes(&bytes).map(std::sync::Arc::new)
        }
        None => load_cached(path),
    }
    .map_err(|e| format!("{path}: {e}"))
}

fn to_image(p: &Picture) -> RgbaImage {
    RgbaImage::from_raw(p.width, p.height, p.rgba.clone()).unwrap()
}

/// Applies a horizontal flip followed by `rotate` clockwise quarter turns.
pub fn transform(p: &Picture, rotate: u8, flip: bool) -> Picture {
    use image::imageops;
    if rotate % 4 == 0 && !flip {
        return p.clone();
    }
    let mut img = to_image(p);
    if flip {
        img = imageops::flip_horizontal(&img);
    }
    img = match rotate % 4 {
        1 => imageops::rotate90(&img),
        2 => imageops::rotate180(&img),
        3 => imageops::rotate270(&img),
        _ => img,
    };
    Picture { format: p.format.clone(), has_alpha: p.has_alpha, ..Picture::from_rgba(img) }
}

fn scaled(p: &Picture, w: u32, h: u32) -> Picture {
    let img = image::imageops::resize(&to_image(p), w, h, image::imageops::FilterType::Triangle);
    Picture { format: p.format.clone(), has_alpha: p.has_alpha, ..Picture::from_rgba(img) }
}

/// Compares two pictures. `left_data`/`right_data` optionally supply already-rasterised
/// pictures (base64 or data URL) for formats the decoder does not support.
pub fn pix_compare(left: &str, right: &str, o: &PixOptions, left_data: Option<&str>, right_data: Option<&str>) -> Result<PixResult, String> {
    let src = [source(left, left_data)?, source(right, right_data)?];
    let mut pics: Vec<Picture> = (0..2).map(|i| transform(&src[i], o.rotate[i], o.flip[i])).collect();
    let mut changed = [o.rotate[0] % 4 != 0 || o.flip[0], o.rotate[1] % 4 != 0 || o.flip[1]];
    if o.auto_scale && (pics[0].width, pics[0].height) != (pics[1].width, pics[1].height) {
        let area = |p: &Picture| p.width as u64 * p.height as u64;
        let (small, big) = if area(&pics[0]) < area(&pics[1]) { (0, 1) } else { (1, 0) };
        if pics[small].width > 0 && pics[small].height > 0 {
            pics[small] = scaled(&pics[small], pics[big].width, pics[big].height);
            changed[small] = true;
        }
    }
    let (a, b) = (&pics[0], &pics[1]);
    let counts = pix_stats(a, b, o);
    let (width, height, rgba) = render(a, b, o);
    let png = if width == 0 || height == 0 { Vec::new() } else { encode_png(width, height, &rgba)? };
    let mut sides = [None, None];
    for i in 0..2 {
        let p = &pics[i];
        if changed[i] && p.width > 0 && p.height > 0 {
            sides[i] = Some(data_url(&encode_png(p.width, p.height, &p.rgba)?));
        }
    }
    Ok(PixResult { left: info(a), right: info(b), width, height, counts, image: data_url(&png), sides })
}

/// Decodes a picture and re-encodes it as a PNG data URL (for formats a webview cannot show).
pub fn pix_image(path: &str) -> Result<String, String> {
    let reader = ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
    let img = reader.decode().map_err(|e| e.to_string())?.to_rgba8();
    let (w, h) = img.dimensions();
    Ok(data_url(&encode_png(w, h, img.as_raw())?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pic(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Picture {
        Picture::from_rgba(RgbaImage::from_fn(w, h, |x, y| image::Rgba(f(x, y))))
    }

    impl Picture {
        fn to_image(&self) -> RgbaImage {
            to_image(self)
        }
    }

    #[test]
    fn classifies_by_tolerance_and_orphans() {
        let a = pic(4, 2, |x, _| [100, 100, 100 + x as u8, 255]);
        let b = pic(3, 3, |x, y| if y == 0 { [100, 100, 100 + x as u8, 255] } else { [130, 100, 100, 255] });
        let c = pix_stats(&a, &b, &PixOptions::default());
        assert_eq!(c, PixCounts { same: 3, unimportant: 0, important: 3, left_orphan: 2, right_orphan: 3 });
        let c = pix_stats(&a, &b, &PixOptions { tolerance: 30, ..Default::default() });
        assert_eq!((c.unimportant, c.important), (3, 0));
        let c = pix_stats(&a, &b, &PixOptions { mode: PixMode::Range, tolerance: 255, ..Default::default() });
        assert_eq!((c.same, c.important), (3, 3));
    }

    #[test]
    fn offsets_move_right_picture() {
        let a = pic(2, 2, |_, _| [1, 2, 3, 255]);
        let b = pic(2, 2, |_, _| [1, 2, 3, 255]);
        let o = PixOptions { offset_x: 1, ..Default::default() };
        let c = pix_stats(&a, &b, &o);
        assert_eq!(c, PixCounts { same: 2, left_orphan: 2, right_orphan: 2, ..Default::default() });
        let (w, h, _) = render(&a, &b, &o);
        assert_eq!((w, h), (3, 2));
    }

    #[test]
    fn rotate_and_flip_compose() {
        let p = pic(3, 2, |x, y| [x as u8, y as u8, 0, 255]);
        let px = |q: &Picture, x: u32, y: u32| q.rgba[((y * q.width + x) * 4) as usize..][..2].to_vec();
        let cw = transform(&p, 1, false);
        assert_eq!((cw.width, cw.height), (2, 3));
        assert_eq!(px(&cw, 1, 0), vec![0, 0]);
        // Flipping vertically is a horizontal flip followed by a half turn.
        let v = transform(&p, 2, true);
        assert_eq!(px(&v, 0, 0), vec![0, 1]);
        assert_eq!(px(&v, 2, 1), vec![2, 0]);
    }

    #[test]
    fn auto_scale_resizes_smaller_picture() {
        let dir = std::env::temp_dir().join(format!("pixscale{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.png"), dir.join("b.png"));
        pic(4, 4, |_, _| [9, 9, 9, 255]).to_image().save(&a).unwrap();
        pic(2, 2, |_, _| [9, 9, 9, 255]).to_image().save(&b).unwrap();
        let o = PixOptions { auto_scale: true, ..Default::default() };
        let r = pix_compare(a.to_str().unwrap(), b.to_str().unwrap(), &o, None, None).unwrap();
        assert_eq!((r.right.width, r.right.height), (4, 4));
        assert_eq!(r.counts.same, 16);
        assert!(r.sides[0].is_none() && r.sides[1].is_some());
        std::fs::remove_dir_all(dir).ok();
    }
}
