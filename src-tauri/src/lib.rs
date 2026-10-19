pub mod align;
pub mod cli;
pub mod diff;
pub mod fileio;
pub mod folder;
pub mod hex;
pub mod merge;
pub mod pix;
pub mod quick;
pub mod report;
pub mod script;
pub mod sessions;
pub mod settings;
pub mod shell;
pub mod snapshot;
pub mod table;

use base64::Engine;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

struct Launch(Mutex<Option<cli::LaunchSpec>>);

type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn s<E: ToString>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn take_launch_spec(state: tauri::State<Launch>) -> Option<cli::LaunchSpec> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn path_info(path: String) -> fileio::PathInfo {
    fileio::path_info(&path)
}

#[tauri::command]
async fn load_text(path: String) -> CmdResult<fileio::TextFile> {
    blocking(move || fileio::load_text(&path).map_err(s)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn save_text(
    path: String,
    lines: Vec<String>,
    encoding: String,
    bom: bool,
    eol: String,
    final_newline: bool,
    backup: bool,
    backup_kind: Option<String>,
    backup_dir: Option<String>,
) -> CmdResult<fileio::PathInfo> {
    blocking(move || {
        let spec = backup.then(|| fileio::BackupSpec { kind: backup_kind.unwrap_or_default(), dir: backup_dir });
        fileio::save_text(&path, &lines, &encoding, bom, &eol, final_newline, spec.as_ref()).map_err(s)?;
        Ok(fileio::path_info(&path))
    })
    .await
}

#[tauri::command]
async fn diff_texts(left: Vec<String>, right: Vec<String>, rules: diff::Rules) -> CmdResult<diff::DiffResult> {
    blocking(move || Ok(diff::diff_lines(&left, &right, &rules))).await
}

#[tauri::command]
async fn merge_texts(
    base: Vec<String>,
    left: Vec<String>,
    right: Vec<String>,
    rules: diff::Rules,
) -> CmdResult<merge::MergeResult> {
    blocking(move || Ok(merge::merge3(&base, &left, &right, &rules))).await
}

#[tauri::command]
async fn compare_folders(left: String, right: String, options: folder::FolderOptions) -> CmdResult<folder::FolderResult> {
    blocking(move || folder::compare_folders(&left, &right, &options).map_err(s)).await
}

#[tauri::command]
async fn plan_sync(
    left: String,
    right: String,
    options: folder::FolderOptions,
    mode: String,
) -> CmdResult<Vec<folder::Action>> {
    blocking(move || folder::plan_sync_folders(&left, &right, &options, &mode).map_err(s)).await
}

/// Re-compares individual items; `None` marks an item that no longer exists or is filtered out.
#[tauri::command]
async fn compare_items(left: String, right: String, rels: Vec<String>, options: folder::FolderOptions) -> CmdResult<Vec<Option<folder::Node>>> {
    blocking(move || Ok(folder::compare_items(&left, &right, &rels, &options))).await
}

/// File Compare Report in patch (unified diff) form for pairs of files.
#[tauri::command]
async fn file_report(pairs: Vec<(String, String)>, context: usize) -> CmdResult<String> {
    blocking(move || {
        let mut out = String::new();
        for (l, r) in pairs {
            let read = |p: &str| std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            let (a, b) = (read(&l), read(&r));
            if a == b {
                out.push_str(&format!("Files {l} and {r} are identical\n\n"));
                continue;
            }
            let diff = similar::TextDiff::from_lines(&a, &b);
            out.push_str(&diff.unified_diff().context_radius(context).header(&l, &r).to_string());
            if !out.ends_with('\n') {
                out.push_str("\n\\ No newline at end of file\n");
            }
            out.push('\n');
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn item_info(paths: Vec<String>) -> CmdResult<Vec<folder::ItemInfo>> {
    blocking(move || Ok(paths.iter().map(|p| folder::item_info(std::path::Path::new(p))).collect())).await
}

#[tauri::command]
async fn execute_actions(
    actions: Vec<folder::Action>,
    use_trash: bool,
    backup: Option<fileio::BackupSpec>,
) -> CmdResult<Vec<folder::ActionResult>> {
    blocking(move || Ok(folder::execute(&actions, use_trash, backup.as_ref()))).await
}

/// Writes a snapshot of `dir` to `out`; returns the number of entries written.
#[tauri::command]
async fn save_snapshot(
    dir: String,
    out: String,
    crc: bool,
    empty_dirs: bool,
    options: Option<folder::FolderOptions>,
) -> CmdResult<usize> {
    blocking(move || snapshot::save_snapshot(&dir, &out, crc, empty_dirs, options.as_ref()).map_err(s)).await
}

#[tauri::command]
async fn is_snapshot(path: String) -> CmdResult<bool> {
    blocking(move || Ok(snapshot::is_snapshot(std::path::Path::new(&path)))).await
}

#[tauri::command]
async fn read_bytes(path: String, offset: u64, len: usize) -> CmdResult<String> {
    blocking(move || {
        let b = hex::read_bytes(&path, offset, len.min(4 << 20)).map_err(s)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(b))
    })
    .await
}

#[tauri::command]
async fn hex_align(left: String, right: String, align: hex::HexAlign) -> CmdResult<hex::HexAlignment> {
    blocking(move || hex::hex_align(&left, &right, align).map_err(s)).await
}

#[tauri::command]
async fn pix_compare(
    left: String,
    right: String,
    options: pix::PixOptions,
    left_data: Option<String>,
    right_data: Option<String>,
) -> CmdResult<pix::PixResult> {
    blocking(move || pix::pix_compare(&left, &right, &options, left_data.as_deref(), right_data.as_deref())).await
}

#[tauri::command]
async fn pix_image(path: String) -> CmdResult<String> {
    blocking(move || pix::pix_image(&path)).await
}

#[tauri::command]
async fn compare_tables(left: String, right: String, options: table::TableOptions) -> CmdResult<table::TableResult> {
    blocking(move || table::compare_tables(&left, &right, &options).map_err(s)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataUrl {
    url: String,
    size: u64,
}

#[tauri::command]
async fn read_data_url(path: String) -> CmdResult<DataUrl> {
    blocking(move || {
        let bytes = std::fs::read(&path).map_err(s)?;
        let ext = std::path::Path::new(&path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg",
            "gif" => "image/gif",
            "bmp" | "dib" => "image/bmp",
            "webp" => "image/webp",
            "ico" => "image/x-icon",
            "svg" => "image/svg+xml",
            "avif" => "image/avif",
            _ => "application/octet-stream",
        };
        Ok(DataUrl {
            url: format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
            size: bytes.len() as u64,
        })
    })
    .await
}

#[tauri::command]
async fn quick_compare(left: String, right: String, mode: String) -> CmdResult<i32> {
    blocking(move || {
        let m = quick::QcMode::parse(&mode).ok_or("invalid mode")?;
        Ok(quick::quick_compare(std::path::Path::new(&left), std::path::Path::new(&right), m))
    })
    .await
}

#[tauri::command]
fn list_sessions() -> Vec<sessions::Session> {
    sessions::list()
}

#[tauri::command]
fn save_session(session: sessions::Session) -> CmdResult<()> {
    sessions::upsert(session).map_err(s)
}

#[tauri::command]
fn delete_session(id: String) -> CmdResult<()> {
    sessions::remove(&id).map_err(s)
}

#[tauri::command]
fn find_session(name: String) -> Option<sessions::Session> {
    sessions::find_by_name(&name)
}

#[tauri::command]
async fn load_settings() -> CmdResult<serde_json::Value> {
    blocking(|| Ok(settings::load())).await
}

#[tauri::command]
async fn save_settings(settings: serde_json::Value) -> CmdResult<()> {
    blocking(move || settings::save(&settings).map_err(s)).await
}

#[tauri::command]
async fn reset_settings() -> CmdResult<()> {
    blocking(|| settings::reset().map_err(s)).await
}

#[tauri::command]
async fn export_settings(
    path: String,
    settings: Option<serde_json::Value>,
    session_ids: Option<Vec<String>>,
) -> CmdResult<()> {
    blocking(move || settings::export(std::path::Path::new(&path), settings, session_ids.as_deref()).map_err(s)).await
}

#[tauri::command]
async fn read_settings_file(path: String) -> CmdResult<settings::ImportData> {
    blocking(move || settings::read_file(std::path::Path::new(&path))).await
}

#[tauri::command]
async fn import_sessions(sessions: Vec<sessions::Session>, replace: bool) -> CmdResult<()> {
    blocking(move || settings::import_sessions(sessions, replace).map_err(s)).await
}

/// Starts a program without waiting for it.
#[tauri::command]
fn spawn_command(program: String, args: Vec<String>) -> CmdResult<()> {
    use std::process::{Command, Stdio};
    let mut child = Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;
    // Reap the child when it exits so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
async fn shell_integration_status() -> CmdResult<shell::ShellStatus> {
    blocking(|| Ok(shell::status())).await
}

#[tauri::command]
async fn set_shell_integration(items: Vec<shell::ShellItem>) -> CmdResult<()> {
    blocking(move || shell::set(&items).map_err(s)).await
}

#[tauri::command]
fn usage() -> &'static str {
    cli::USAGE
}

/// Runs the GUI. `spec` is the initial launch request resolved from the command line.
pub fn run(spec: cli::LaunchSpec, solo: bool) {
    let mut builder = tauri::Builder::default();
    if !solo {
        // Like the reference app, a second launch hands its request to the running instance.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let args: Vec<String> = argv.into_iter().skip(1).collect();
            let cwd = std::path::PathBuf::from(cwd);
            if let Ok(parsed) = cli::parse(&args) {
                if let cli::Outcome::Gui(spec) = cli::resolve(&parsed, &cwd) {
                    let _ = app.emit("launch", spec);
                }
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Launch(Mutex::new(Some(spec))))
        .invoke_handler(tauri::generate_handler![
            take_launch_spec,
            path_info,
            load_text,
            save_text,
            diff_texts,
            merge_texts,
            compare_folders,
            plan_sync,
            execute_actions,
            compare_items,
            item_info,
            file_report,
            read_bytes,
            hex_align,
            pix_compare,
            pix_image,
            compare_tables,
            read_data_url,
            quick_compare,
            list_sessions,
            save_session,
            delete_session,
            find_session,
            save_snapshot,
            is_snapshot,
            load_settings,
            save_settings,
            reset_settings,
            export_settings,
            read_settings_file,
            import_sessions,
            spawn_command,
            shell_integration_status,
            set_shell_integration,
            usage
        ])
        .run(tauri::generate_context!())
        .expect("error while running CompareCraft");
}
