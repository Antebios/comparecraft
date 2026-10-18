//! File loading/saving with encoding, BOM, line-ending and binary detection.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub lines: Vec<String>,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub final_newline: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub binary: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfo {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub kind: String,
}

pub fn modified_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Heuristic used by most diff tools: a NUL byte in the first 8 KiB means binary,
/// unless the data starts with a UTF-16 BOM.
pub fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// Decode bytes into (text, encoding label, had_bom).
pub fn decode(bytes: &[u8]) -> (String, String, bool) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), "UTF-8".into(), true);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (t, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return (t.trim_start_matches('\u{FEFF}').to_string(), "UTF-16LE".into(), true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (t, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return (t.trim_start_matches('\u{FEFF}').to_string(), "UTF-16BE".into(), true);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "UTF-8".into(), false),
        Err(_) => {
            let (t, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (t.into_owned(), "Windows-1252".into(), false)
        }
    }
}

pub fn encode(text: &str, encoding: &str, bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    match encoding {
        "UTF-16LE" => {
            if bom {
                out.extend_from_slice(&[0xFF, 0xFE]);
            }
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        "UTF-16BE" => {
            if bom {
                out.extend_from_slice(&[0xFE, 0xFF]);
            }
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
        "Windows-1252" => {
            let (b, _, _) = encoding_rs::WINDOWS_1252.encode(text);
            out.extend_from_slice(&b);
        }
        _ => {
            if bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
        }
    }
    out
}

/// Split text into lines, stripping CR, LF and CRLF terminators.
/// Returns (lines, eol label, final newline present).
pub fn split_lines(text: &str) -> (Vec<String>, String, bool) {
    let mut lines = Vec::new();
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(text[start..i].to_string());
                lf += 1;
                i += 1;
                start = i;
            }
            b'\r' => {
                lines.push(text[start..i].to_string());
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                } else {
                    cr += 1;
                    i += 1;
                }
                start = i;
            }
            _ => i += 1,
        }
    }
    let final_newline = start == bytes.len() && !bytes.is_empty();
    if start < bytes.len() {
        lines.push(text[start..].to_string());
    }
    let kinds = [lf > 0, crlf > 0, cr > 0].iter().filter(|b| **b).count();
    let eol = if kinds > 1 {
        "Mixed"
    } else if crlf > 0 {
        "CRLF"
    } else if cr > 0 {
        "CR"
    } else if lf > 0 {
        "LF"
    } else if cfg!(windows) {
        "CRLF"
    } else {
        "LF"
    };
    (lines, eol.to_string(), final_newline)
}

pub fn read_all(path: &Path) -> io::Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

pub fn load_text(path: &str) -> io::Result<TextFile> {
    let p = Path::new(path);
    let meta = fs::metadata(p)?;
    if meta.is_dir() {
        return Err(io::Error::other(format!("{path} is a folder")));
    }
    let bytes = read_all(p)?;
    let binary = looks_binary(&bytes);
    let (text, encoding, bom) = decode(&bytes);
    let (lines, eol, final_newline) = split_lines(&text);
    Ok(TextFile {
        path: path.to_string(),
        lines,
        encoding,
        bom,
        eol,
        final_newline,
        size: meta.len(),
        modified: modified_ms(&meta),
        binary,
        read_only: meta.permissions().readonly(),
    })
}

pub fn eol_str(eol: &str) -> &'static str {
    match eol {
        "CRLF" => "\r\n",
        "CR" => "\r",
        _ => "\n",
    }
}

pub fn join_lines(lines: &[String], eol: &str, final_newline: bool) -> String {
    let sep = eol_str(eol);
    let mut s = lines.join(sep);
    if final_newline && !lines.is_empty() {
        s.push_str(sep);
    }
    s
}

/// How backups of overwritten files are named (see `backup_path`).
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupSpec {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub dir: Option<String>,
}

/// Backup file name for `p`. Kinds (for "abc.txt"): nameTildeExt "abc~.txt", nameExtTilde "abc.txt~",
/// nameExtBak "abc.txt.bak" (default), tildeNameExt "~abc.txt", nameBak "abc.bak", nameBakExt "abc.bak.txt",
/// folder `dir`/"abc.txt" (a relative `dir` is resolved against the file's folder).
pub fn backup_path(p: &Path, kind: &str, dir: Option<&str>) -> PathBuf {
    let file = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone());
    let ext = p.extension().map(|e| e.to_string_lossy().into_owned());
    let parent = p.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = match (kind, ext.as_deref()) {
        ("nameTildeExt", Some(e)) => format!("{stem}~.{e}"),
        ("nameTildeExt" | "nameExtTilde", _) => format!("{file}~"),
        ("tildeNameExt", _) => format!("~{file}"),
        ("nameBak", _) => format!("{stem}.bak"),
        ("nameBakExt", Some(e)) => format!("{stem}.bak.{e}"),
        ("nameBakExt", None) => format!("{file}.bak"),
        ("folder", _) => match dir.filter(|d| !d.trim().is_empty()) {
            Some(d) => return parent.join(d).join(&file),
            None => format!("{file}.bak"),
        },
        _ => format!("{file}.bak"),
    };
    parent.join(name)
}

/// Copies an existing file to its backup location, creating the backup folder if needed.
pub fn make_backup(p: &Path, spec: &BackupSpec) -> io::Result<()> {
    let kind = if spec.kind.is_empty() { "nameExtBak" } else { spec.kind.as_str() };
    let bak = backup_path(p, kind, spec.dir.as_deref());
    if let Some(parent) = bak.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::copy(p, bak).map(|_| ())
}

#[allow(clippy::too_many_arguments)]
pub fn save_text(
    path: &str,
    lines: &[String],
    encoding: &str,
    bom: bool,
    eol: &str,
    final_newline: bool,
    backup: Option<&BackupSpec>,
) -> io::Result<()> {
    let p = Path::new(path);
    if let Some(spec) = backup {
        if p.is_file() {
            make_backup(p, spec)?;
        }
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let text = join_lines(lines, eol, final_newline);
    fs::write(p, encode(&text, encoding, bom))
}

pub fn path_info(path: &str) -> PathInfo {
    match fs::metadata(path) {
        Ok(m) => {
            let kind = if m.is_dir() { "folder".to_string() } else { detect_kind(path) };
            PathInfo {
                path: path.into(),
                exists: true,
                is_dir: m.is_dir(),
                size: m.len(),
                modified: modified_ms(&m),
                kind,
            }
        }
        Err(_) => PathInfo {
            path: path.into(),
            exists: false,
            is_dir: false,
            size: 0,
            modified: None,
            kind: "missing".into(),
        },
    }
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svg", "avif"];
const TABLE_EXTS: &[&str] = &["csv", "tsv", "tab"];

/// Picks the file viewer for a path, similar to how a diff tool associates
/// file formats with views: pictures, tables, binary (hex) or text.
pub fn detect_kind(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        return "picture".into();
    }
    if TABLE_EXTS.contains(&ext.as_str()) {
        return "table".into();
    }
    let mut buf = vec![0u8; 8192];
    if let Ok(mut f) = fs::File::open(path) {
        if let Ok(n) = f.read(&mut buf) {
            if looks_binary(&buf[..n]) {
                return "hex".into();
            }
        }
    }
    "text".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_mixed_line_endings() {
        let (l, eol, fin) = split_lines("a\r\nb\nc");
        assert_eq!(l, vec!["a", "b", "c"]);
        assert_eq!(eol, "Mixed");
        assert!(!fin);
        let (l, eol, fin) = split_lines("a\r\nb\r\n");
        assert_eq!(l, vec!["a", "b"]);
        assert_eq!(eol, "CRLF");
        assert!(fin);
        let (l, _, _) = split_lines("");
        assert!(l.is_empty());
        let (l, _, fin) = split_lines("\n");
        assert_eq!(l, vec![""]);
        assert!(fin);
    }

    #[test]
    fn decodes_boms_and_roundtrips() {
        let (t, enc, bom) = decode(&[0xEF, 0xBB, 0xBF, b'h', b'i']);
        assert_eq!((t.as_str(), enc.as_str(), bom), ("hi", "UTF-8", true));
        let bytes = encode("héllo", "UTF-16LE", true);
        let (t, enc, bom) = decode(&bytes);
        assert_eq!((t.as_str(), enc.as_str(), bom), ("héllo", "UTF-16LE", true));
        let (t, enc, _) = decode(&[b'c', 0xE9]);
        assert_eq!((t.as_str(), enc.as_str()), ("cé", "Windows-1252"));
    }

    #[test]
    fn backup_names() {
        let n = |file: &str, kind: &str| backup_path(Path::new(file), kind, None).to_string_lossy().replace('\\', "/");
        let cases = [
            ("nameTildeExt", "d/abc~.txt", "d/abc~"),
            ("nameExtTilde", "d/abc.txt~", "d/abc~"),
            ("nameExtBak", "d/abc.txt.bak", "d/abc.bak"),
            ("tildeNameExt", "d/~abc.txt", "d/~abc"),
            ("nameBak", "d/abc.bak", "d/abc.bak"),
            ("nameBakExt", "d/abc.bak.txt", "d/abc.bak"),
            ("unknown", "d/abc.txt.bak", "d/abc.bak"),
            ("folder", "d/abc.txt.bak", "d/abc.bak"),
        ];
        for (kind, with_ext, without) in cases {
            assert_eq!(n("d/abc.txt", kind), with_ext, "{kind}");
            assert_eq!(n("d/abc", kind), without, "{kind}");
        }
        let f = backup_path(Path::new("d/abc.txt"), "folder", Some("old")).to_string_lossy().replace('\\', "/");
        assert_eq!(f, "d/old/abc.txt");
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.txt");
        fs::write(&p, "one").unwrap();
        let ps = p.to_string_lossy().into_owned();
        save_text(&ps, &["two".into()], "UTF-8", false, "LF", true, Some(&BackupSpec::default())).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("f.txt.bak")).unwrap(), "one");
    }

    #[test]
    fn binary_detection() {
        assert!(looks_binary(&[1, 2, 0, 3]));
        assert!(!looks_binary(b"plain text"));
        assert!(!looks_binary(&[0xFF, 0xFE, b'a', 0]));
    }
}
