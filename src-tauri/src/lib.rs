// Engine modules shared by every build: the desktop app, the console programs, the headless helper and
// the WebAssembly engine. They work on in-memory data or plain files and never depend on Tauri.
pub mod align;
pub mod diff;
pub mod fileio;
pub mod hex;
pub mod merge;
pub mod pix;
pub mod protocol;
pub mod quick;
pub mod table;

// File-system and OS integration modules (feature `native`): folders, reports, scripts,
// sessions, settings, shell integration, the CLI and the headless helper.
#[cfg(feature = "native")]
pub mod backend;
#[cfg(feature = "native")]
pub mod cli;
#[cfg(feature = "native")]
pub mod folder;
#[cfg(feature = "native")]
pub mod folder_merge;
#[cfg(feature = "native")]
pub mod report;
#[cfg(feature = "native")]
pub mod script;
#[cfg(feature = "native")]
pub mod sessions;
#[cfg(feature = "native")]
pub mod settings;
#[cfg(feature = "native")]
pub mod shell;
#[cfg(feature = "native")]
pub mod snapshot;

// The Tauri desktop app (feature `desktop`).
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub mod fonts;
#[cfg(feature = "desktop")]
pub use desktop::run;

// The WebAssembly engine's exported functions.
#[cfg(target_arch = "wasm32")]
pub mod wasm;

/// Application version: the release version for release builds, otherwise `<Cargo version>-dev`.
pub const APP_VERSION: &str = env!("COMPARECRAFT_APP_VERSION");
