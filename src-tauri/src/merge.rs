//! Three-way text merge (diff3 style).

use crate::diff::{normalize, Rules};
use serde::Serialize;
use similar::{capture_diff_slices, DiffTag};
use std::ops::Range;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChunkKind {
    Stable,
    Left,
    Right,
    Both,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub kind: ChunkKind,
    pub base: Vec<String>,
    pub left: Vec<String>,
    pub right: Vec<String>,
    pub base_start: u32,
    pub left_start: u32,
    pub right_start: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub chunks: Vec<Chunk>,
    pub conflicts: u32,
    pub changes: u32,
}

struct H {
    base: Range<usize>,
    side: Range<usize>,
    left: bool,
}

fn hunks(base: &[String], side: &[String], rules: &Rules, left: bool) -> Vec<H> {
    let bk: Vec<String> = base.iter().map(|s| normalize(s, rules)).collect();
    let sk: Vec<String> = side.iter().map(|s| normalize(s, rules)).collect();
    let ops = capture_diff_slices(rules.algo(), &bk, &sk);
    let mut out: Vec<H> = Vec::new();
    for op in ops {
        let (tag, o, n) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        if let Some(last) = out.last_mut() {
            if last.base.end == o.start && last.side.end == n.start {
                last.base.end = o.end;
                last.side.end = n.end;
                continue;
            }
        }
        out.push(H { base: o, side: n, left });
    }
    out
}

fn eq_lines(a: &[String], b: &[String], rules: &Rules) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| normalize(x, rules) == normalize(y, rules))
}

pub fn merge3(base: &[String], left: &[String], right: &[String], rules: &Rules) -> MergeResult {
    let mut all = hunks(base, left, rules, true);
    all.extend(hunks(base, right, rules, false));
    all.sort_by_key(|h| (h.base.start, h.base.end, !h.left));

    let mut chunks = Vec::new();
    let mut conflicts = 0u32;
    let mut changes = 0u32;
    let mut cur = 0usize; // base cursor
    let mut ldelta: isize = 0; // left index = base index + ldelta (outside hunks)
    let mut rdelta: isize = 0;
    let mut i = 0;
    while i < all.len() {
        let rs = all[i].base.start;
        let mut re = all[i].base.end;
        let mut j = i + 1;
        // Hunks from the same side never touch in base (they would have been merged),
        // so overlapping/adjacent joins only happen across sides (git-like).
        while j < all.len() && all[j].base.start <= re {
            re = re.max(all[j].base.end);
            j += 1;
        }
        let region = &all[i..j];
        if cur < rs {
            chunks.push(Chunk {
                kind: ChunkKind::Stable,
                base: base[cur..rs].to_vec(),
                left: base[cur..rs].to_vec(),
                right: base[cur..rs].to_vec(),
                base_start: cur as u32,
                left_start: (cur as isize + ldelta) as u32,
                right_start: (cur as isize + rdelta) as u32,
            });
        }
        let side_range = |is_left: bool| -> Option<Range<usize>> {
            let hs: Vec<&H> = region.iter().filter(|h| h.left == is_left).collect();
            if hs.is_empty() {
                return None;
            }
            let first = hs[0];
            let last = hs[hs.len() - 1];
            let s = first.side.start as isize - (first.base.start as isize - rs as isize);
            let e = last.side.end as isize + (re as isize - last.base.end as isize);
            Some(s.max(0) as usize..e.max(0) as usize)
        };
        let lr = side_range(true);
        let rr = side_range(false);
        let lstart = lr.as_ref().map(|r| r.start).unwrap_or((rs as isize + ldelta) as usize);
        let rstart = rr.as_ref().map(|r| r.start).unwrap_or((rs as isize + rdelta) as usize);
        let lc: Vec<String> = match &lr {
            Some(r) => left[r.clone()].to_vec(),
            None => base[rs..re].to_vec(),
        };
        let rc: Vec<String> = match &rr {
            Some(r) => right[r.clone()].to_vec(),
            None => base[rs..re].to_vec(),
        };
        let kind = match (lr.is_some(), rr.is_some()) {
            (true, false) => ChunkKind::Left,
            (false, true) => ChunkKind::Right,
            _ => {
                if eq_lines(&lc, &rc, rules) {
                    ChunkKind::Both
                } else {
                    ChunkKind::Conflict
                }
            }
        };
        if kind == ChunkKind::Conflict {
            conflicts += 1;
        } else {
            changes += 1;
        }
        if let Some(r) = &lr {
            ldelta = r.end as isize - re as isize;
        }
        if let Some(r) = &rr {
            rdelta = r.end as isize - re as isize;
        }
        chunks.push(Chunk {
            kind,
            base: base[rs..re].to_vec(),
            left: lc,
            right: rc,
            base_start: rs as u32,
            left_start: lstart as u32,
            right_start: rstart as u32,
        });
        cur = re;
        i = j;
    }
    if cur < base.len() {
        chunks.push(Chunk {
            kind: ChunkKind::Stable,
            base: base[cur..].to_vec(),
            left: base[cur..].to_vec(),
            right: base[cur..].to_vec(),
            base_start: cur as u32,
            left_start: (cur as isize + ldelta) as u32,
            right_start: (cur as isize + rdelta) as u32,
        });
    }
    MergeResult { chunks, conflicts, changes }
}

/// Produces merged output; conflicts are written with CVS-style markers.
pub fn render(result: &MergeResult, left_label: &str, right_label: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in &result.chunks {
        match c.kind {
            ChunkKind::Stable => out.extend(c.base.iter().cloned()),
            ChunkKind::Left | ChunkKind::Both => out.extend(c.left.iter().cloned()),
            ChunkKind::Right => out.extend(c.right.iter().cloned()),
            ChunkKind::Conflict => {
                out.push(format!("<<<<<<< {left_label}"));
                out.extend(c.left.iter().cloned());
                out.push("=======".into());
                out.extend(c.right.iter().cloned());
                out.push(format!(">>>>>>> {right_label}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Vec<String> {
        s.split(',').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect()
    }
    fn strict() -> Rules {
        Rules {
            ignore_leading_ws: false,
            ignore_trailing_ws: false,
            ignore_embedded_ws: false,
            ignore_blank_lines: false,
            ..Rules::default()
        }
    }

    #[test]
    fn clean_merge_of_independent_changes() {
        let base = v("a,b,c,d,e,f");
        let left = v("a,B,c,d,e,f");
        let right = v("a,b,c,d,E,f,g");
        let m = merge3(&base, &left, &right, &strict());
        assert_eq!(m.conflicts, 0);
        assert_eq!(render(&m, "L", "R"), v("a,B,c,d,E,f,g"));
    }

    #[test]
    fn detects_conflict() {
        let base = v("a,b,c");
        let left = v("a,X,c");
        let right = v("a,Y,c");
        let m = merge3(&base, &left, &right, &strict());
        assert_eq!(m.conflicts, 1);
        assert_eq!(render(&m, "L", "R"), v("a,<<<<<<< L,X,=======,Y,>>>>>>> R,c"));
    }

    #[test]
    fn identical_change_on_both_sides() {
        let base = v("a,b,c");
        let both = v("a,Z,c");
        let m = merge3(&base, &both, &both, &strict());
        assert_eq!(m.conflicts, 0);
        assert_eq!(m.chunks.iter().filter(|c| c.kind == ChunkKind::Both).count(), 1);
        assert_eq!(render(&m, "L", "R"), both);
    }

    #[test]
    fn deletions_and_insertions() {
        let base = v("1,2,3,4,5,6,7,8");
        let left = v("1,3,4,5,6,7,8"); // delete 2
        let right = v("1,2,3,4,5,6,7,7.5,8"); // insert 7.5
        let m = merge3(&base, &left, &right, &strict());
        assert_eq!(m.conflicts, 0);
        assert_eq!(render(&m, "L", "R"), v("1,3,4,5,6,7,7.5,8"));
    }

    #[test]
    fn start_offsets_track_sides() {
        let base = v("a,b,c,d");
        let left = v("x,y,a,b,c,d");
        let right = v("a,b,c,D");
        let m = merge3(&base, &left, &right, &strict());
        let last = m.chunks.last().unwrap();
        assert_eq!(last.kind, ChunkKind::Right);
        assert_eq!(last.left_start, 5);
        assert_eq!(last.right_start, 3);
    }
}
