//! Picture comparison goldens: statistics and rendered tolerance-mode difference pictures.
//! Each case holds a.*, b.*, expected.txt ("tolerance same unimportant important
//! left_orphan right_orphan" per line) and diff_t<tolerance>.png.

use comparecraft_lib::pix::{load_picture, pix_stats, render, PixOptions};
use std::fs;
use std::path::Path;

#[test]
fn pix_goldens() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pix");
    let mut cases: Vec<_> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).collect();
    cases.sort();
    let mut failures = Vec::new();
    let mut checked = 0;
    for dir in &cases {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let mut inputs: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_stem().is_some_and(|s| s == "a" || s == "b"))
            .collect();
        inputs.sort();
        let a = load_picture(inputs[0].to_str().unwrap()).unwrap();
        let b = load_picture(inputs[1].to_str().unwrap()).unwrap();
        for line in fs::read_to_string(dir.join("expected.txt")).unwrap().lines() {
            let v: Vec<u64> = line.split_whitespace().map(|t| t.parse().unwrap()).collect();
            let tol = v[0] as u8;
            let o = PixOptions { tolerance: tol, background: [46, 46, 35, 255], ..Default::default() };
            let c = pix_stats(&a, &b, &o);
            let got = [c.same, c.unimportant, c.important, c.left_orphan, c.right_orphan];
            if got[..] != v[1..] {
                failures.push(format!("{name} t{tol}: counts {got:?} != {:?}", &v[1..]));
            }
            let (w, h, rgba) = render(&a, &b, &o);
            let exp = image::open(dir.join(format!("diff_t{tol}.png"))).unwrap().to_rgb8();
            if exp.dimensions() != (w, h) {
                failures.push(format!("{name} t{tol}: size {w}x{h} != {:?}", exp.dimensions()));
            } else {
                let bad = exp
                    .pixels()
                    .zip(rgba.chunks_exact(4))
                    .enumerate()
                    .filter(|(_, (e, g))| e.0[..] != g[..3])
                    .map(|(i, (e, g))| format!("({},{}) {:?}!={:?}", i as u32 % w, i as u32 / w, &g[..3], e.0))
                    .collect::<Vec<_>>();
                if !bad.is_empty() {
                    failures.push(format!("{name} t{tol}: {} pixels differ, e.g. {}", bad.len(), bad[..bad.len().min(3)].join(" ")));
                }
            }
            checked += 1;
        }
    }
    assert!(failures.is_empty(), "{} of {checked} failed:\n{}", failures.len(), failures.join("\n"));
    assert!(checked >= 80, "only {checked} golden runs found");
}
