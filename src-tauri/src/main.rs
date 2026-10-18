// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use comparecraft_lib::cli;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match cli::parse(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("comparecraft: {e}\n\n{}", cli::USAGE);
            std::process::exit(comparecraft_lib::quick::UNKNOWN_ERROR);
        }
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    match cli::resolve(&args, &cwd) {
        cli::Outcome::Exit(code) => std::process::exit(code),
        cli::Outcome::Gui(spec) => comparecraft_lib::run(spec, args.solo),
    }
}
