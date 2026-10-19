//! Folder Merge: a three-way comparison of two changed folders against their common base.
//!
//! Each file is classified by which side changed relative to the base, using the pairwise
//! folder comparisons (so the session's filters and comparison criteria apply).

use crate::folder::{self, FolderOptions, Node, Side, Status};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MergeStatus {
    /// Unchanged on both sides.
    Same,
    /// Changed (added, modified or deleted) on the left only.
    Left,
    /// Changed on the right only.
    Right,
    /// The same change on both sides.
    Both,
    /// Different changes on each side.
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeItem {
    pub rel: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Side>,
    pub status: MergeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSummary {
    pub same: u32,
    pub left: u32,
    pub right: u32,
    pub both: u32,
    pub conflict: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMergeResult {
    pub items: Vec<MergeItem>,
    pub summary: MergeSummary,
}

/// One pairwise comparison of a file: what each side has and whether they match.
#[derive(Default, Clone)]
struct Pair {
    a: Option<Side>,
    b: Option<Side>,
    equal: bool,
    error: Option<String>,
}

fn flatten(n: &Node, out: &mut BTreeMap<String, Pair>) {
    for c in &n.children {
        if c.dir {
            flatten(c, out);
        } else {
            out.insert(
                c.rel.clone(),
                Pair { a: c.left.clone(), b: c.right.clone(), equal: matches!(c.status, Status::Same | Status::Similar), error: c.error.clone() },
            );
        }
    }
}

fn pairs(a: &str, b: &str, o: &FolderOptions) -> std::io::Result<BTreeMap<String, Pair>> {
    let mut m = BTreeMap::new();
    flatten(&folder::compare_folders(a, b, o)?.root, &mut m);
    Ok(m)
}

fn stat(root: &str, rel: &str) -> Option<Side> {
    let p = folder::join_rel(root, rel);
    let m = fs::metadata(&p).ok().filter(|m| m.is_file())?;
    Some(Side {
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: m.len(),
        modified: m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
    })
}

/// Classifies one file from its presence on each side and the pairwise equalities.
pub fn classify(has_base: bool, l: bool, r: bool, b: bool, lb_eq: bool, rb_eq: bool, lr_eq: bool) -> MergeStatus {
    // Two absent versions are equal; one absent and one present are not.
    let same = |x: bool, y: bool, eq: bool| if x && y { eq } else { x == y };
    if !has_base {
        return if same(l, r, lr_eq) {
            MergeStatus::Same
        } else if !r {
            MergeStatus::Left
        } else if !l {
            MergeStatus::Right
        } else {
            MergeStatus::Conflict
        };
    }
    let lc = !same(l, b, lb_eq);
    let rc = !same(r, b, rb_eq);
    match (lc, rc) {
        (false, false) => MergeStatus::Same,
        (true, false) => MergeStatus::Left,
        (false, true) => MergeStatus::Right,
        (true, true) if same(l, r, lr_eq) => MergeStatus::Both,
        _ => MergeStatus::Conflict,
    }
}

/// Compares `left` and `right` against `base` (optional) and reports the files in `output`.
pub fn compare_merge(left: &str, right: &str, base: Option<&str>, output: Option<&str>, o: &FolderOptions) -> std::io::Result<FolderMergeResult> {
    let mut o = o.clone();
    o.flatten = false;
    o.align.clear();
    let lr = pairs(left, right, &o)?;
    let (lb, rb) = match base {
        Some(b) => (pairs(left, b, &o)?, pairs(right, b, &o)?),
        None => (BTreeMap::new(), BTreeMap::new()),
    };
    let mut rels: Vec<&String> = lr.keys().chain(lb.keys()).chain(rb.keys()).collect();
    rels.sort();
    rels.dedup();
    let mut items = Vec::new();
    let mut summary = MergeSummary::default();
    let none = Pair::default();
    for rel in rels {
        let p_lr = lr.get(rel).unwrap_or(&none);
        let p_lb = lb.get(rel).unwrap_or(&none);
        let p_rb = rb.get(rel).unwrap_or(&none);
        let left_side = p_lr.a.clone().or_else(|| p_lb.a.clone());
        let right_side = p_lr.b.clone().or_else(|| p_rb.a.clone());
        let base_side = p_lb.b.clone().or_else(|| p_rb.b.clone());
        let status = classify(
            base.is_some(),
            left_side.is_some(),
            right_side.is_some(),
            base_side.is_some(),
            p_lb.equal,
            p_rb.equal,
            p_lr.equal,
        );
        match status {
            MergeStatus::Same => summary.same += 1,
            MergeStatus::Left => summary.left += 1,
            MergeStatus::Right => summary.right += 1,
            MergeStatus::Both => summary.both += 1,
            MergeStatus::Conflict => summary.conflict += 1,
        }
        items.push(MergeItem {
            name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
            rel: rel.clone(),
            left: left_side,
            right: right_side,
            base: base_side,
            output: output.filter(|s| !s.is_empty()).and_then(|out| stat(out, rel)),
            status,
            error: p_lr.error.clone().or_else(|| p_lb.error.clone()).or_else(|| p_rb.error.clone()),
        });
    }
    Ok(FolderMergeResult { items, summary })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn classify_three_way() {
        use MergeStatus::*;
        // Unchanged, edited on one side, edited the same on both, edited differently.
        assert_eq!(classify(true, true, true, true, true, true, true), Same);
        assert_eq!(classify(true, true, true, true, false, true, false), Left);
        assert_eq!(classify(true, true, true, true, true, false, false), Right);
        assert_eq!(classify(true, true, true, true, false, false, true), Both);
        assert_eq!(classify(true, true, true, true, false, false, false), Conflict);
        // Added on one side, deleted on one side, deleted on both, added differently on both.
        assert_eq!(classify(true, true, false, false, false, false, false), Left);
        assert_eq!(classify(true, true, false, true, true, false, false), Right);
        assert_eq!(classify(true, false, false, true, false, false, false), Both);
        assert_eq!(classify(true, true, true, false, false, false, false), Conflict);
        // Deleted on the left, edited on the right.
        assert_eq!(classify(true, false, true, true, false, false, false), Conflict);
        // Two-way.
        assert_eq!(classify(false, true, false, false, false, false, false), Left);
        assert_eq!(classify(false, true, true, false, false, false, false), Conflict);
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn merges_folders() {
        let t = std::env::temp_dir().join(format!("cc-fmerge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&t);
        let (l, r, b) = (t.join("l"), t.join("r"), t.join("b"));
        for d in [&l, &r, &b] {
            write(d, "same.txt", "x");
            write(d, "sub/both.txt", "base");
        }
        write(&b, "left.txt", "base");
        write(&l, "left.txt", "left edit");
        write(&r, "left.txt", "base");
        write(&r, "right-new.txt", "new");
        write(&b, "conflict.txt", "base");
        write(&l, "conflict.txt", "one");
        write(&r, "conflict.txt", "two");
        fs::write(l.join("sub/both.txt"), "same edit").unwrap();
        fs::write(r.join("sub/both.txt"), "same edit").unwrap();
        let mut o = FolderOptions::default();
        o.criteria = "binary".into();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let res = compare_merge(&s(&l), &s(&r), Some(&s(&b)), Some(&s(&l)), &o).unwrap();
        let st: BTreeMap<_, _> = res.items.iter().map(|i| (i.rel.as_str(), i.status)).collect();
        assert_eq!(st["same.txt"], MergeStatus::Same);
        assert_eq!(st["left.txt"], MergeStatus::Left);
        assert_eq!(st["right-new.txt"], MergeStatus::Right);
        assert_eq!(st["sub/both.txt"], MergeStatus::Both);
        assert_eq!(st["conflict.txt"], MergeStatus::Conflict);
        assert!(res.items.iter().find(|i| i.rel == "left.txt").unwrap().output.is_some());
        assert!(res.items.iter().find(|i| i.rel == "right-new.txt").unwrap().output.is_none());
        let _ = fs::remove_dir_all(&t);
    }
}
