fn main() {
    // Release builds get the GitHub release version (scripts/version.mjs); other builds are marked "-dev".
    println!("cargo:rerun-if-env-changed=COMPARECRAFT_VERSION");
    let version = std::env::var("COMPARECRAFT_VERSION")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}-dev", std::env::var("CARGO_PKG_VERSION").unwrap()));
    println!("cargo:rustc-env=COMPARECRAFT_APP_VERSION={version}");
    tauri_build::build()
}
