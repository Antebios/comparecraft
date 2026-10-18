//! Folder snapshots: a JSON record of a folder tree (names, sizes, times and optionally CRCs) that
//! can be compared against like a read-only folder.

use crate::folder::{walk, Ctx, FolderOptions, Loc, Meta};
use crate::quick::crc32_file;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "comparecraft-snapshot";
pub const EXTENSION: &str = "ccsnap";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SnapshotFile {
    pub format: String,
    pub version: u32,
    pub root: String,
    pub created: i64,
    pub entries: Vec<SnapEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SnapEntry {
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub crc: Option<u32>,
}

/// A loaded snapshot indexed by folder.
#[derive(Debug)]
pub struct Snapshot {
    pub root: String,
    /// Folder relative path ("" = root) -> its entries.
    dirs: HashMap<String, Vec<(String, Meta)>>,
}

impl Snapshot {
    pub fn from_file(f: SnapshotFile) -> Snapshot {
        let mut dirs: HashMap<String, Vec<(String, Meta)>> = HashMap::new();
        dirs.insert(String::new(), vec![]);
        for e in f.entries {
            let rel = e.rel.replace('\\', "/").trim_matches('/').to_string();
            if rel.is_empty() {
                continue;
            }
            // Ensure all ancestor folders exist even when the file omits them.
            let mut parent = String::new();
            let segs: Vec<&str> = rel.split('/').collect();
            for seg in &segs[..segs.len() - 1] {
                let child = if parent.is_empty() { seg.to_string() } else { format!("{parent}/{seg}") };
                if !dirs.contains_key(&child) {
                    dirs.insert(child.clone(), vec![]);
                    dirs.entry(parent.clone()).or_default().push((seg.to_string(), Meta { is_dir: true, ..Meta::default() }));
                }
                parent = child;
            }
            let name = segs[segs.len() - 1].to_string();
            if e.dir {
                if dirs.contains_key(&rel) {
                    // Already created implicitly: update its timestamp.
                    if let Some(m) = dirs.get_mut(&parent).and_then(|v| v.iter_mut().find(|(n, _)| *n == name)) {
                        m.1.modified = e.modified;
                    }
                    continue;
                }
                dirs.insert(rel.clone(), vec![]);
            }
            let meta = Meta { is_dir: e.dir, len: if e.dir { 0 } else { e.size }, modified: e.modified, crc: if e.dir { None } else { e.crc }, protected: false };
            dirs.entry(parent).or_default().push((name, meta));
        }
        Snapshot { root: f.root, dirs }
    }

    pub(crate) fn children(&self, rel: &str) -> Option<&[(String, Meta)]> {
        self.dirs.get(rel).map(|v| v.as_slice())
    }
}

/// Whether `p` is a snapshot file: by extension, or by sniffing the start of the file.
pub fn is_snapshot(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    if p.extension().is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION)) {
        return true;
    }
    let mut buf = vec![0u8; 4096];
    let n = fs::File::open(p).and_then(|mut f| f.read(&mut buf)).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.trim_start().starts_with('{') && head.contains(&format!("\"{FORMAT}\""))
}

pub fn load(p: &Path) -> io::Result<Snapshot> {
    let f: SnapshotFile = serde_json::from_slice(&fs::read(p)?).map_err(|e| io::Error::other(format!("{}: {e}", p.display())))?;
    if f.format != FORMAT {
        return Err(io::Error::other(format!("{} is not a CompareCraft snapshot", p.display())));
    }
    Ok(Snapshot::from_file(f))
}

/// Writes a snapshot of `dir` to `out` and returns the number of entries. With `options`, its masks
/// and filters select the items; folders without files are omitted unless `empty_dirs`.
pub fn save_snapshot(dir: &str, out: &str, crc: bool, empty_dirs: bool, options: Option<&FolderOptions>) -> io::Result<usize> {
    let root = PathBuf::from(dir);
    if !root.is_dir() {
        return Err(io::Error::other(format!("Folder not found: {dir}")));
    }
    let defaults = FolderOptions::default();
    let cx = Ctx::new(options.unwrap_or(&defaults));
    let mut items = vec![];
    walk(&Loc::Disk(root.clone()), "", &cx, &mut items)?;
    let mut entries: Vec<SnapEntry> = items
        .into_iter()
        .map(|(rel, m)| SnapEntry {
            crc: if crc && !m.is_dir { crc32_file(&crate::folder::join_rel(dir, &rel)).ok() } else { None },
            rel,
            dir: m.is_dir,
            size: m.len,
            modified: m.modified,
        })
        .collect();
    if !empty_dirs {
        let with_files: std::collections::HashSet<String> = entries
            .iter()
            .filter(|e| !e.dir)
            .flat_map(|e| {
                let segs: Vec<&str> = e.rel.split('/').collect();
                (1..segs.len()).map(move |i| segs[..i].join("/")).collect::<Vec<_>>()
            })
            .collect();
        entries.retain(|e| !e.dir || with_files.contains(&e.rel));
    }
    let created = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let count = entries.len();
    let file = SnapshotFile { format: FORMAT.into(), version: 1, root: dir.to_string(), created, entries };
    let out = Path::new(out);
    if let Some(p) = out.parent() {
        if !p.as_os_str().is_empty() {
            fs::create_dir_all(p)?;
        }
    }
    fs::write(out, serde_json::to_vec_pretty(&file)?)?;
    Ok(count)
}
