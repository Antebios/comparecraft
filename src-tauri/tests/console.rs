//! The console version (`ccomp`): headless requests run in-process, others start the GUI and wait.

use std::fs;
use std::process::{Command, Stdio};

fn ccomp() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ccomp"))
}

#[test]
fn help_and_bad_switch() {
    let out = ccomp().arg("-h").output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("ccomp [options]"));
    let out = ccomp().arg("-bogus").output().unwrap();
    assert_eq!(out.status.code(), Some(100));
    assert!(String::from_utf8_lossy(&out.stderr).contains("unknown switch"));
}

#[test]
fn quick_compare_exit_codes() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("a"), "x\n").unwrap();
    fs::write(d.path().join("b"), "x\n").unwrap();
    fs::write(d.path().join("c"), "y\n").unwrap();
    let qc = |l: &str, r: &str| ccomp().current_dir(d.path()).args(["-qc", l, r]).status().unwrap().code();
    assert_eq!(qc("a", "b"), Some(1));
    assert_eq!(qc("a", "c"), Some(13));
}

#[test]
fn stdin_is_read_once_for_quick_compare() {
    let d = tempfile::tempdir().unwrap();
    fs::write(d.path().join("a"), "x\n").unwrap();
    let mut child = ccomp()
        .current_dir(d.path())
        .args(["-qc", "-", "a"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(b"x\n").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(1));
}

#[test]
fn script_prints_log_to_console() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join("L")).unwrap();
    fs::create_dir_all(d.path().join("R")).unwrap();
    fs::write(d.path().join("L/f.txt"), "1").unwrap();
    fs::write(d.path().join("s.txt"), "load \"%1\" \"%2\"\nselect all\n").unwrap();
    let out = ccomp().current_dir(d.path()).args(["@s.txt", "L", "R"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains(">> load \"L\" \"R\""), "{stdout}");
    assert!(stdout.contains("Script completed"), "{stdout}");

    let out = ccomp().current_dir(d.path()).args(["@s.txt", "L", "R", "-silent"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty());

    let out = ccomp().current_dir(d.path()).arg("@missing.txt").output().unwrap();
    assert_eq!(out.status.code(), Some(105));
}

#[cfg(unix)]
#[test]
fn gui_requests_start_a_new_instance_and_wait() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    fs::create_dir_all(d.path().join("L")).unwrap();
    fs::create_dir_all(d.path().join("R")).unwrap();
    let gui = d.path().join("gui.sh");
    let log = d.path().join("gui.log");
    fs::write(&gui, format!("#!/bin/sh\nsleep 0.3\necho \"$@\" > '{}'\nexit 7\n", log.display())).unwrap();
    fs::set_permissions(&gui, fs::Permissions::from_mode(0o755)).unwrap();

    let status = ccomp().current_dir(d.path()).env("COMPARECRAFT_GUI", &gui).args(["L", "R", "-ro"]).status().unwrap();
    // The fake GUI's exit code proves ccomp waited for it.
    assert_eq!(status.code(), Some(7));
    assert_eq!(fs::read_to_string(&log).unwrap().trim(), "L R -ro -solo");

    let status = ccomp().current_dir(d.path()).env("COMPARECRAFT_GUI", d.path().join("nope")).args(["L", "R"]).status().unwrap();
    assert_eq!(status.code(), Some(103));
}
