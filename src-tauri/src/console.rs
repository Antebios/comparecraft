//! `ccomp`: the console version of CompareCraft.
//!
//! It takes the same arguments as `comparecraft`, but is always a console program (also on Windows, where
//! the main executable is a GUI program without a console):
//! - scripts (`@script.txt`), quick compare (`-qc`), `-automerge` and `-h` run here and write to the
//!   console; the exit code is the result;
//! - every other request opens a new CompareCraft window, and `ccomp` waits until it is closed. This makes
//!   it suitable for batch files and version control tools that wait for the comparison to finish.

use comparecraft_lib::{cli, quick};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The GUI executable next to this program, or `comparecraft` on the PATH.
fn gui_exe() -> PathBuf {
    if let Some(p) = std::env::var_os("COMPARECRAFT_GUI") {
        return PathBuf::from(p);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        for name in ["comparecraft", "CompareCraft"] {
            let p = dir.join(format!("{name}{suffix}"));
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from(format!("comparecraft{suffix}"))
}

/// Opens a new window with the given arguments and waits for it to close.
fn launch_and_wait(argv: &[String], solo: bool) -> i32 {
    let exe = gui_exe();
    let mut cmd = Command::new(&exe);
    cmd.args(argv);
    // A new instance is needed: a running instance would take the request and return immediately.
    if !solo {
        cmd.arg("-solo");
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("ccomp: unable to start {}: {e}", exe.display());
            return quick::GUI_NOT_FOUND;
        }
    };
    match child.wait() {
        Ok(s) => s.code().unwrap_or(quick::UNKNOWN_ERROR),
        Err(e) => {
            eprintln!("ccomp: unable to wait for {}: {e}", exe.display());
            quick::GUI_WAIT_FAILED
        }
    }
}

fn main() {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    // Read stdin ("-") once, so a window opened later gets the same content.
    let mut temps = vec![];
    for a in argv.iter_mut().filter(|a| *a == "-") {
        match cli::stdin_to_temp() {
            Ok(t) => {
                temps.push(t.clone());
                *a = t;
            }
            Err(e) => {
                eprintln!("ccomp: {e}");
                std::process::exit(quick::UNKNOWN_ERROR);
            }
        }
    }
    let args = match cli::parse(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("ccomp: {e}\n\n{}", cli::USAGE);
            std::process::exit(quick::UNKNOWN_ERROR);
        }
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    let code = match cli::resolve(&args, &cwd) {
        cli::Outcome::Exit(code) => code,
        cli::Outcome::Gui(_) => launch_and_wait(&argv, args.solo),
    };
    for t in temps {
        let _ = std::fs::remove_file(t);
    }
    std::process::exit(code);
}
