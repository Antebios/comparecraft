// Console subsystem on purpose: the extension spawns it with windowsHide, and --version must print in a terminal.
use comparecraft_lib::backend::{serve, Logger, PROTOCOL_VERSION};
use std::io::{self, Write};

const USAGE: &str = "usage: comparecraft-backend --stdio | --version";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--stdio"] => serve(io::stdin().lock(), Box::new(io::stdout()), Logger::from_env()),
        ["--version"] => {
            let _ = writeln!(io::stdout(), "comparecraft-backend {} (protocol {PROTOCOL_VERSION})", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            let _ = writeln!(io::stderr(), "{USAGE}");
            2
        }
    };
    std::process::exit(code);
}
