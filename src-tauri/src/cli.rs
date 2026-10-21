//! Command-line handling. Switch names follow the conventions documented for the
//! reference application (see docs/REVERSE_ENGINEERING.md): `-switch[=value]`
//! on every platform and additionally `/switch[=value]` on Windows.

use crate::diff::Rules;
use crate::fileio::{self, detect_kind};
use crate::merge::{merge3, render};
use crate::quick::{self, QcMode};
use crate::snapshot;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    /// "home" | "text" | "edit" | "patch" | "folder" | "sync" | "fmerge" | "merge" | "hex" | "table" | "picture" | "session"
    pub kind: String,
    pub paths: Vec<String>,
    pub titles: Vec<Option<String>>,
    pub read_only: Vec<bool>,
    pub filters: Option<String>,
    pub expand_all: bool,
    pub output: Option<String>,
    pub save_target: Option<String>,
    pub no_backups: bool,
    pub session: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Args {
    pub help: bool,
    pub qc: Option<QcMode>,
    pub fv: Option<String>,
    pub automerge: bool,
    pub force: bool,
    pub ignore_unimportant: bool,
    pub review_conflicts: bool,
    pub merge_output: Option<String>,
    pub center: Option<String>,
    pub titles: [Option<String>; 4],
    pub vcs: [Option<String>; 4],
    pub ro: [bool; 4],
    pub filters: Option<String>,
    pub expand_all: bool,
    pub sync: bool,
    pub edit: bool,
    pub no_backups: bool,
    pub save_target: Option<String>,
    pub silent: bool,
    pub solo: bool,
    pub context_select_left: bool,
    pub context_select_left_folder: bool,
    pub context_compare_staged_folder: bool,
    pub context_clear_left: bool,
    pub context_clear_left_folder: bool,
    pub context_compare: bool,
    pub context_compare_staged: bool,
    pub context_sync: bool,
    pub context_merge: bool,
    pub context_install_shell: bool,
    pub context_refresh_shell: bool,
    pub positional: Vec<String>,
}

#[derive(Debug)]
pub enum Outcome {
    /// Finished without a GUI; exit with this code.
    Exit(i32),
    Gui(LaunchSpec),
}

pub const USAGE: &str = "CompareCraft - compare, merge and synchronize files and folders

Usage:
  comparecraft [options] [left] [right] [center] [output]

Positional arguments:
  (none)              open the home view
  <folder> <folder>   folder compare (with -sync: folder sync); a snapshot file
                      (.ccsnap) can stand in for either folder
  <file> <file>       file compare in the viewer associated with the file type
  <l> <r> <center>    3-way text merge, <center> is the common ancestor
  <l> <r> <c> <out>   3-way text merge writing to <out>
  <session name>      open a saved session
  -                   read stdin into a temporary file
  @<script> [params]  run a script without the GUI; params are %1..%9 in the
                      script (add -silent to suppress console output)

Options (prefix with '-' ; on Windows '/' is also accepted):
  -h, -?, -help                 show this help
  -qc[=size|crc|binary]         quick compare of two files, exit code only
  -fv=<type>, -fileviewer=      Text Compare | Text Merge | Text Edit | Text Patch |
                                Hex Compare | Table Compare | Picture Compare |
                                Folder Compare | Folder Sync
  -automerge                    merge without UI unless conflicts are found
  -force                        with -automerge, write conflicts with markers
  -iu, -ignoreunimportant       with -automerge, ignore whitespace-only conflicts
  -reviewconflicts              with -automerge, open the merge view on conflicts
  -mergeoutput=<file>           merge output file
  -center=<file>                merge center (ancestor) file
  -title1..4=<t>, -lefttitle=, -righttitle=, -centertitle=, -outputtitle=
  -vcs1..4=<path>               display path for the respective side
  -ro, -readonly                read-only on all sides
  -ro1, -lro, -leftreadonly     read-only left; -ro2/-rro/-rightreadonly for right
  -filters=<masks>              folder compare name filter, e.g. \"*.rs;-target/\"
  -expandall                    expand all folders
  -sync                         open folder sync
  -savetarget=<file>            save the right side to <file> instead
  -nobackups                    do not create .bak files when saving
  -solo                         force a new application instance
  -silent                       suppress interaction
  -cc-select-left <file>        store a file as the left side for a later comparison
    -cc-select-left-folder <dir>  store a folder independently of the selected file
    -cc-compare-staged-folder <dir> compare a folder to the staged left folder
    -cc-clear-left               clear the selected left file
    -cc-clear-left-folder        clear the selected left folder
  -cc-compare <left> <right>    compare two files or folders selected in a file manager
  -cc-compare-staged <right>    compare a file to the staged left file
  -cc-sync <left> <right>       sync two selected folders
  -cc-merge <left> <right>      merge two selected files
  -cc-install-shell             install file-manager actions (installer)
  -cc-refresh-shell             refresh registered file-manager actions

Console version:
  ccomp [options] [left] [right] [center] [output]
  Takes the same arguments. Scripts, -qc and -automerge run in the console and
  print there; other requests open a new CompareCraft window and ccomp waits
  until it is closed (for batch files and version control tools).

Exit codes (quick compare / automerge):
  0 success, 1 binary same, 2 rules-based same, 11 binary differences,
  12 similar, 13 rules-based differences, 14 conflicts detected,
  100 unknown error, 101 conflicts detected (merge output not written)

Exit codes (scripts):
  0 success, 100 error with \"option stop-on-error\", 105 script file could not be
  loaded, 106 unknown command or invalid arguments, 107 comparison could not be loaded
";

fn split_switch(arg: &str) -> Option<(String, Option<String>)> {
    let body = if let Some(b) = arg.strip_prefix("--") {
        b
    } else if let Some(b) = arg.strip_prefix('-') {
        b
    } else if cfg!(windows) {
        arg.strip_prefix('/')?
    } else {
        return None;
    };
    if body.is_empty() {
        return None;
    }
    let (name, val) = match body.find(['=', ':']) {
        Some(i) => (
            &body[..i],
            Some(body[i + 1..].trim_matches('"').to_string()),
        ),
        None => (body, None),
    };
    Some((name.to_ascii_lowercase(), val))
}

pub fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut positional_only = false;
    for arg in argv {
        if positional_only {
            a.positional.push(arg.clone());
            continue;
        }
        if arg == "--" {
            positional_only = true;
            continue;
        }
        if arg == "-" {
            a.positional.push(arg.clone());
            continue;
        }
        let Some((name, val)) = split_switch(arg) else {
            a.positional.push(arg.clone());
            continue;
        };
        let side = |n: &str| -> Option<usize> {
            Some(match n {
                "1" | "left" => 0,
                "2" | "right" => 1,
                "3" | "center" => 2,
                "4" | "output" => 3,
                _ => return None,
            })
        };
        match name.as_str() {
            "?" | "h" | "help" => a.help = true,
            "qc" | "quickcompare" => {
                a.qc = Some(QcMode::parse(val.as_deref().unwrap_or("")).ok_or("invalid -qc type")?)
            }
            "fv" | "fileviewer" => a.fv = val,
            "automerge" => a.automerge = true,
            "force" => a.force = true,
            "iu" | "ignoreunimportant" => a.ignore_unimportant = true,
            "reviewconflicts" => a.review_conflicts = true,
            "mergeoutput" => a.merge_output = val,
            "center" => a.center = val,
            "ro" | "readonly" => a.ro = [true; 4],
            "ro1" | "lro" | "leftreadonly" => a.ro[0] = true,
            "ro2" | "rro" | "rightreadonly" => a.ro[1] = true,
            "ro3" => a.ro[2] = true,
            "ro4" => a.ro[3] = true,
            "filters" => a.filters = val,
            "expandall" => a.expand_all = true,
            "sync" => a.sync = true,
            "edit" => a.edit = true,
            "nobackups" => a.no_backups = true,
            "savetarget" => a.save_target = val,
            "silent" => a.silent = true,
            "solo" => a.solo = true,
            "cc-select-left" => a.context_select_left = true,
            "cc-select-left-folder" => a.context_select_left_folder = true,
            "cc-compare-staged-folder" => a.context_compare_staged_folder = true,
            "cc-clear-left" => a.context_clear_left = true,
            "cc-clear-left-folder" => a.context_clear_left_folder = true,
            "cc-compare" => a.context_compare = true,
            "cc-compare-staged" => a.context_compare_staged = true,
            "cc-sync" => a.context_sync = true,
            "cc-merge" => a.context_merge = true,
            "cc-install-shell" => a.context_install_shell = true,
            "cc-refresh-shell" => a.context_refresh_shell = true,
            "closescript" | "favorleft" | "favorright" => {}
            n => {
                if let Some(rest) = n.strip_prefix("title").or_else(|| n.strip_suffix("title")) {
                    let i = side(rest).ok_or_else(|| format!("unknown switch -{n}"))?;
                    a.titles[i] = val;
                } else if let Some(rest) = n.strip_prefix("vcs") {
                    let i = side(rest).ok_or_else(|| format!("unknown switch -{n}"))?;
                    a.vcs[i] = val;
                } else {
                    return Err(format!("unknown switch -{n}"));
                }
            }
        }
    }
    Ok(a)
}

fn absolutize(p: &str, cwd: &Path) -> String {
    let pb = PathBuf::from(p);
    let abs = if pb.is_absolute() { pb } else { cwd.join(pb) };
    std::fs::canonicalize(&abs)
        .unwrap_or(abs)
        .to_string_lossy()
        .into_owned()
}

/// Saves stdin to a temporary file and returns its path.
pub fn stdin_to_temp() -> Result<String, String> {
    let mut buf = Vec::new();
    std::io::stdin()
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let p = std::env::temp_dir().join(format!("comparecraft-stdin-{}.txt", std::process::id()));
    std::fs::write(&p, buf).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into_owned())
}

/// A folder, or a snapshot file standing in for one.
fn folderish(p: &str) -> bool {
    let p = Path::new(p);
    p.is_dir() || snapshot::is_snapshot(p)
}

fn viewer_kind(fv: &str) -> Option<&'static str> {
    let k = fv.to_ascii_lowercase().replace([' ', '-', '_'], "");
    Some(match k.as_str() {
        "textcompare" | "text" => "text",
        "textmerge" | "merge" => "merge",
        "textedit" | "edit" => "edit",
        "textpatch" | "patch" => "patch",
        "hexcompare" | "hex" => "hex",
        "tablecompare" | "table" | "datacompare" => "table",
        "picturecompare" | "picture" | "mediacompare" => "picture",
        "foldercompare" | "folder" => "folder",
        "foldermerge" | "fmerge" => "fmerge",
        "foldersync" | "sync" => "sync",
        _ => return None,
    })
}

/// Resolves arguments into either a headless result or a GUI launch spec.
pub fn resolve(a: &Args, cwd: &Path) -> Outcome {
    if a.context_install_shell {
        return match crate::shell::install() {
            Ok(()) => Outcome::Exit(0),
            Err(e) => {
                eprintln!("comparecraft: could not install file-manager actions: {e}");
                Outcome::Exit(quick::UNKNOWN_ERROR)
            }
        };
    }
    if a.context_refresh_shell {
        return match crate::shell::refresh() {
            Ok(()) => Outcome::Exit(0),
            Err(e) => {
                eprintln!("comparecraft: could not refresh file-manager actions: {e}");
                Outcome::Exit(quick::UNKNOWN_ERROR)
            }
        };
    }
    if a.help {
        println!("{USAGE}");
        return Outcome::Exit(0);
    }
    if let Some(script) = a.positional.first().and_then(|p| p.strip_prefix('@')) {
        return Outcome::Exit(crate::script::run(
            script,
            &a.positional[1..],
            a.silent,
            cwd,
        ));
    }
    let context_actions = [
        a.context_select_left,
        a.context_select_left_folder,
        a.context_compare_staged_folder,
        a.context_clear_left,
        a.context_clear_left_folder,
        a.context_compare,
        a.context_compare_staged,
        a.context_sync,
        a.context_merge,
    ]
    .into_iter()
    .filter(|v| *v)
    .count();
    if context_actions > 1 {
        return Outcome::Gui(context_notice("Context-menu actions cannot be combined."));
    }
    if a.context_clear_left || a.context_clear_left_folder {
        if !a.positional.is_empty() {
            return Outcome::Gui(context_notice("Clear Selected Left does not accept paths."));
        }
        let state = context_stage_path(a.context_clear_left_folder);
        let _guard = match stage_lock(a.context_clear_left_folder) {
            Ok(guard) => guard,
            Err(error) => return Outcome::Gui(context_notice(format!("Could not lock selected left: {error}"))),
        };
        if let Err(error) = std::fs::remove_file(state) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Outcome::Gui(context_notice(format!("Could not clear selected left: {error}")));
            }
        }
        if let Err(error) = crate::shell::state_changed() {
            return Outcome::Gui(context_notice(format!("The selection was cleared, but Finder could not be updated: {error}")));
        }
        return Outcome::Exit(0);
    }
    if a.context_select_left || a.context_select_left_folder {
        let folder = a.context_select_left_folder;
        let kind = if folder { "folder" } else { "file" };
        if a.positional.len() != 1 {
            return Outcome::Gui(context_notice(format!("Select Left requires exactly one {kind}.")));
        }
        let path = absolutize(&a.positional[0], cwd);
        if !stage_kind_matches(Path::new(&path), folder) {
            return Outcome::Gui(context_notice(format!("Not a {kind}:\n{path}")));
        }
        let _guard = match stage_lock(folder) {
            Ok(guard) => guard,
            Err(error) => return Outcome::Gui(context_notice(format!("Could not lock selected left: {error}"))),
        };
        let result = crate::sessions::write_json_atomic(&context_stage_path(folder), &path)
            .map_err(|e| format!("could not save the selected left {kind}: {e}"))
            .and_then(|()| crate::shell::state_changed().map_err(|error| format!("The {kind} was selected, but Finder could not be updated: {error}")));
        return match result {
            Ok(()) => Outcome::Exit(0),
            Err(e) => Outcome::Gui(context_notice(e)),
        };
    }
    if a.context_compare || a.context_compare_staged || a.context_compare_staged_folder {
        let staged = a.context_compare_staged || a.context_compare_staged_folder;
        let folder = a.context_compare_staged_folder;
        let kind = if folder { "folder" } else { "file" };
        let expected = if a.context_compare { 2 } else { 1 };
        if a.positional.len() != expected {
            let action = if a.context_compare {
                "Compare requires exactly two files or two folders."
            } else {
                if folder { "Compare to Selected Left Folder requires exactly one folder." } else { "Compare to Selected Left File requires exactly one file." }
            };
            return Outcome::Gui(context_notice(action));
        }
        let mut selected: Vec<String> = a.positional.iter().map(|p| absolutize(p, cwd)).collect();
        let mut consumed_left = None;
        if staged {
            let left = std::fs::read(context_stage_path(folder))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok());
            let Some(left) = left else {
                return Outcome::Gui(context_notice(format!("No left {kind} is selected yet. Select a left {kind} first.")));
            };
            if !stage_kind_matches(Path::new(&left), folder) {
                return Outcome::Gui(context_notice(format!(
                    "The selected left {kind} is no longer available:\n{left}"
                )));
            }
            if !stage_kind_matches(Path::new(&selected[0]), folder) {
                return Outcome::Gui(context_notice(format!("Select a right {kind}, not another item type.")));
            }
            if std::fs::canonicalize(&left).ok() == std::fs::canonicalize(&selected[0]).ok() {
                return Outcome::Gui(context_notice("Select a different right item from the selected left."));
            }
            consumed_left = Some(left.clone());
            selected.insert(0, left);
        }
        if let Some(missing) = selected.iter().find(|p| !Path::new(p).exists()) {
            return Outcome::Gui(context_notice(format!(
                "The selected item is no longer available:\n{missing}"
            )));
        }
        let both_files = selected.iter().all(|p| Path::new(p).is_file());
        let both_folders = selected.iter().all(|p| Path::new(p).is_dir());
        if !both_files && !both_folders {
            return Outcome::Gui(context_notice(
                "Compare is available for two files or two folders only.",
            ));
        }
        let mut normal_args = a_without_context(a);
        normal_args.positional = selected;
        let mut comparison = match resolve(&normal_args, cwd) {
            Outcome::Gui(spec) => spec,
            other => return other,
        };
        let _guard = if staged {
            match stage_lock(folder) {
                Ok(guard) => Some(guard),
                Err(error) => {
                    comparison.message = Some(format!("The comparison opened, but the selection could not be locked for clearing: {error}"));
                    return Outcome::Gui(comparison);
                }
            }
        } else { None };
        if staged && std::fs::read(context_stage_path(folder)).ok()
            .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok()) == consumed_left {
            match std::fs::remove_file(context_stage_path(folder)) {
                Ok(()) => {
                    if let Err(error) = crate::shell::state_changed() {
                        comparison.message = Some(format!("The comparison opened, but Finder could not be updated: {error}"));
                    }
                }
                Err(e) => {
                    comparison.message = Some(format!(
                        "The comparison opened, but the selected left {kind} could not be cleared: {e}"
                    ));
                }
            }
        }
        return Outcome::Gui(comparison);
    }
    if a.context_sync || a.context_merge {
        let action = if a.context_sync { "Sync" } else { "Merge" };
        let selected: Vec<String> = a.positional.iter().map(|p| absolutize(p, cwd)).collect();
        if selected.len() != 2 {
            return Outcome::Gui(context_notice(format!(
                "{action} requires exactly two selected items."
            )));
        }
        if a.context_sync && selected.iter().any(|p| !Path::new(p).is_dir()) {
            return Outcome::Gui(context_notice(
                "Sync is available for two selected folders only.",
            ));
        }
        if a.context_merge && selected.iter().any(|p| !Path::new(p).is_file()) {
            return Outcome::Gui(context_notice(
                "Merge is available for two selected files only.",
            ));
        }
        let mut normal_args = a_without_context(a);
        normal_args.positional = selected;
        if a.context_sync {
            normal_args.sync = true;
        } else {
            normal_args.fv = Some("Text Merge".into());
        }
        return resolve(&normal_args, cwd);
    }
    let mut paths: Vec<String> = Vec::new();
    for p in &a.positional {
        if p == "-" {
            match stdin_to_temp() {
                Ok(t) => paths.push(t),
                Err(e) => {
                    eprintln!("comparecraft: {e}");
                    return Outcome::Exit(quick::UNKNOWN_ERROR);
                }
            }
        } else {
            paths.push(p.clone());
        }
    }
    // Named session: a single argument that is not an existing path.
    if paths.len() == 1
        && !Path::new(&cwd.join(&paths[0])).exists()
        && !paths[0].contains(['/', '\\'])
    {
        return Outcome::Gui(LaunchSpec {
            kind: "session".into(),
            session: Some(paths[0].clone()),
            ..Default::default()
        });
    }
    let mut paths: Vec<String> = paths.iter().map(|p| absolutize(p, cwd)).collect();
    if let Some(c) = &a.center {
        if paths.len() == 2 {
            paths.push(absolutize(c, cwd));
        }
    }

    if let Some(mode) = a.qc {
        if paths.len() != 2 {
            eprintln!("comparecraft: -qc requires exactly two files");
            return Outcome::Exit(quick::UNKNOWN_ERROR);
        }
        return Outcome::Exit(quick::quick_compare(
            Path::new(&paths[0]),
            Path::new(&paths[1]),
            mode,
        ));
    }

    let output = a
        .merge_output
        .as_ref()
        .map(|o| absolutize(o, cwd))
        .or_else(|| paths.get(3).cloned());

    if a.automerge && paths.len() >= 3 {
        match automerge(&paths[0], &paths[1], &paths[2], output.as_deref(), a) {
            Ok(code) if code == quick::CONFLICTS_NOT_WRITTEN && a.review_conflicts => {}
            Ok(code) => return Outcome::Exit(code),
            Err(e) => {
                eprintln!("comparecraft: {e}");
                return Outcome::Exit(quick::UNKNOWN_ERROR);
            }
        }
    }

    let kind: String = if let Some(fv) = &a.fv {
        match viewer_kind(fv) {
            Some(k) => k.into(),
            None => {
                eprintln!("comparecraft: unknown viewer type {fv:?}");
                "text".into()
            }
        }
    } else {
        match paths.len() {
            0 => "home".into(),
            1 if Path::new(&paths[0]).is_dir() => "folder".into(),
            1 => detect_kind(&paths[0]),
            2 if folderish(&paths[0]) || folderish(&paths[1]) => {
                if a.sync {
                    "sync".into()
                } else {
                    "folder".into()
                }
            }
            2 => {
                let k = detect_kind(&paths[0]);
                if Path::new(&paths[0]).exists() {
                    k
                } else {
                    detect_kind(&paths[1])
                }
            }
            _ if folderish(&paths[0]) => "fmerge".into(),
            _ => "merge".into(),
        }
    };
    let kind = if kind == "folder" && a.sync {
        "sync".into()
    } else {
        kind
    };

    let titles = (0..4)
        .map(|i| a.titles[i].clone().or_else(|| a.vcs[i].clone()))
        .collect();
    Outcome::Gui(LaunchSpec {
        kind,
        paths,
        titles,
        read_only: a.ro.to_vec(),
        filters: a.filters.clone(),
        expand_all: a.expand_all,
        output,
        save_target: a.save_target.as_ref().map(|s| absolutize(s, cwd)),
        no_backups: a.no_backups,
        session: None,
        message: None,
    })
}

fn context_left_path() -> PathBuf {
    std::env::var_os("COMPARECRAFT_CONTEXT_LEFT_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::sessions::config_dir().join("context-left.json"))
}

pub(crate) fn context_stage_path(folder: bool) -> PathBuf {
    if folder {
        std::env::var_os("COMPARECRAFT_CONTEXT_LEFT_FOLDER")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::sessions::config_dir().join("context-left-folder.json"))
    } else {
        context_left_path()
    }
}

fn stage_kind_matches(path: &Path, folder: bool) -> bool {
    if folder { path.is_dir() } else { path.is_file() }
}

fn stage_lock(folder: bool) -> std::io::Result<std::fs::File> {
    let state = context_stage_path(folder).with_extension("lock");
    if let Some(parent) = state.parent() { std::fs::create_dir_all(parent)?; }
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(state)?;
    lock.lock()?;
    Ok(lock)
}

fn context_notice(message: impl Into<String>) -> LaunchSpec {
    LaunchSpec {
        kind: "home".into(),
        message: Some(message.into()),
        ..Default::default()
    }
}

fn a_without_context(a: &Args) -> Args {
    let mut copy = a.clone();
    copy.context_select_left = false;
    copy.context_select_left_folder = false;
    copy.context_compare_staged_folder = false;
    copy.context_clear_left = false;
    copy.context_clear_left_folder = false;
    copy.context_compare = false;
    copy.context_compare_staged = false;
    copy.context_sync = false;
    copy.context_merge = false;
    copy.context_refresh_shell = false;
    copy.positional.clear();
    copy
}

fn automerge(
    left: &str,
    right: &str,
    center: &str,
    output: Option<&str>,
    a: &Args,
) -> Result<i32, String> {
    let out = output.ok_or("-automerge requires -mergeoutput=<file> or a 4th path")?;
    let lf = fileio::load_text(left).map_err(|e| format!("{left}: {e}"))?;
    let rf = fileio::load_text(right).map_err(|e| format!("{right}: {e}"))?;
    let cf = fileio::load_text(center).map_err(|e| format!("{center}: {e}"))?;
    let rules = if a.ignore_unimportant {
        Rules {
            ignore_blank_lines: false,
            ..Rules::default()
        }
    } else {
        Rules {
            ignore_case: false,
            ignore_leading_ws: false,
            ignore_trailing_ws: false,
            ignore_embedded_ws: false,
            ignore_blank_lines: false,
            algorithm: "patience".into(),
            ..Rules::default()
        }
    };
    let m = merge3(&cf.lines, &lf.lines, &rf.lines, &rules);
    if m.conflicts > 0 && !a.force {
        return Ok(quick::CONFLICTS_NOT_WRITTEN);
    }
    // Observed: the reference tool labels conflict markers with file names only, ignoring -titleN.
    let label = |p: &str| {
        Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string())
    };
    let lines = render(&m, &label(left), &label(right));
    let final_nl = lf.final_newline || rf.final_newline || cf.final_newline;
    fileio::save_text(out, &lines, &cf.encoding, cf.bom, &cf.eol, final_nl, None)
        .map_err(|e| e.to_string())?;
    Ok(if m.conflicts > 0 { quick::CONFLICTS } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_switches() {
        let a = parse(&s(&[
            "-qc=crc",
            "-title1=Old",
            "-righttitle=New",
            "-ro2",
            "-filters=*.rs",
            "a",
            "b",
        ]))
        .unwrap();
        assert_eq!(a.qc, Some(QcMode::Crc));
        assert_eq!(a.titles[0].as_deref(), Some("Old"));
        assert_eq!(a.titles[1].as_deref(), Some("New"));
        assert_eq!(a.ro, [false, true, false, false]);
        assert_eq!(a.filters.as_deref(), Some("*.rs"));
        assert_eq!(a.positional, s(&["a", "b"]));
        assert!(parse(&s(&["-bogus"])).is_err());
        assert_eq!(
            parse(&s(&["-qc", "a", "b"])).unwrap().qc,
            Some(QcMode::Rules)
        );
    }

    #[test]
    fn resolves_views_and_automerge() {
        let d = tempfile::tempdir().unwrap();
        let p = |n: &str| d.path().join(n).to_string_lossy().into_owned();
        std::fs::write(p("base"), "a\nb\nc\n").unwrap();
        std::fs::write(p("left"), "A\nb\nc\n").unwrap();
        std::fs::write(p("right"), "a\nb\nC\n").unwrap();
        std::fs::write(p("img.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::create_dir(p("dir1")).unwrap();
        std::fs::create_dir(p("dir2")).unwrap();

        let go = |args: &[&str]| resolve(&parse(&s(args)).unwrap(), d.path());
        match go(&["dir1", "dir2"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "folder"),
            o => panic!("{o:?}"),
        }
        match go(&["-sync", "dir1", "dir2"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "sync"),
            o => panic!("{o:?}"),
        }
        match go(&["img.png", "img.png"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "picture"),
            o => panic!("{o:?}"),
        }
        match go(&["left", "right", "base"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "merge"),
            o => panic!("{o:?}"),
        }
        match go(&["-automerge", "-mergeoutput=out", "left", "right", "base"]) {
            Outcome::Exit(c) => assert_eq!(c, 0),
            o => panic!("{o:?}"),
        }
        assert_eq!(std::fs::read_to_string(p("out")).unwrap(), "A\nb\nC\n");
        std::fs::write(p("right2"), "Z\nb\nc\n").unwrap();
        match go(&["-automerge", "left", "right2", "base", "out2"]) {
            Outcome::Exit(c) => assert_eq!(c, 101),
            o => panic!("{o:?}"),
        }
        assert!(!Path::new(&p("out2")).exists());
        match go(&["-automerge", "-force", "left", "right2", "base", "out2"]) {
            Outcome::Exit(c) => assert_eq!(c, 14),
            o => panic!("{o:?}"),
        }
        let merged = std::fs::read_to_string(p("out2")).unwrap();
        assert!(
            merged.contains("<<<<<<< left\n") && merged.contains(">>>>>>> right2\n"),
            "{merged}"
        );
        match go(&["-qc=binary", "left", "left"]) {
            Outcome::Exit(c) => assert_eq!(c, 1),
            o => panic!("{o:?}"),
        }
        match go(&["-fv=Text Edit", "left"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "edit"),
            o => panic!("{o:?}"),
        }
        match go(&["-fv=patch", "left"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "patch"),
            o => panic!("{o:?}"),
        }
        std::fs::write(p("old.ccsnap"), "{}").unwrap();
        match go(&["dir1", "old.ccsnap"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "folder"),
            o => panic!("{o:?}"),
        }
        match go(&["MySession"]) {
            Outcome::Gui(spec) => assert_eq!(spec.session.as_deref(), Some("MySession")),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn runs_scripts_headless() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("s.txt"), "log normal out.log\nbogus %1\n").unwrap();
        let a = parse(&s(&["@s.txt", "x", "-silent"])).unwrap();
        assert!(a.silent);
        assert!(matches!(resolve(&a, d.path()), Outcome::Exit(106)));
        let log = std::fs::read_to_string(d.path().join("out.log")).unwrap();
        assert!(
            log.contains(">> bogus x") && log.contains("Unknown command \"bogus\""),
            "{log}"
        );
        let a = parse(&s(&["@missing.txt", "-silent"])).unwrap();
        assert!(matches!(resolve(&a, d.path()), Outcome::Exit(105)));
    }

    #[test]
    fn resolves_file_manager_context_actions() {
        let d = tempfile::tempdir().unwrap();
        let left = d.path().join("left.txt");
        let right = d.path().join("right.txt");
        let left_dir = d.path().join("left-dir");
        let right_dir = d.path().join("right-dir");
        std::fs::write(&left, "left").unwrap();
        std::fs::write(&right, "right").unwrap();
        std::fs::create_dir(&left_dir).unwrap();
        std::fs::create_dir(&right_dir).unwrap();
        let staged = d.path().join("staged.json");
        let isolated_variables = ["COMPARECRAFT_CONFIG_DIR", "COMPARECRAFT_DATA_DIR", "COMPARECRAFT_CONTEXT_LEFT_FOLDER"];
        let previous_variables: Vec<_> = isolated_variables.iter().map(std::env::var_os).collect();
        std::env::set_var("COMPARECRAFT_CONFIG_DIR", d.path());
        std::env::set_var("COMPARECRAFT_DATA_DIR", d.path());
        let staged_folder = d.path().join("staged-folder.json");
        std::env::set_var("COMPARECRAFT_CONTEXT_LEFT_FOLDER", &staged_folder);
        let previous = std::env::var_os("COMPARECRAFT_CONTEXT_LEFT_FILE");
        std::env::set_var("COMPARECRAFT_CONTEXT_LEFT_FILE", &staged);

        let go = |args: &[&str]| resolve(&parse(&s(args)).unwrap(), d.path());
        assert!(matches!(
            go(&["-cc-select-left", "left.txt"]),
            Outcome::Exit(0)
        ));
        assert_eq!(
            serde_json::from_slice::<String>(&std::fs::read(&staged).unwrap()).unwrap(),
            absolutize("left.txt", d.path())
        );

        assert!(matches!(go(&["-cc-select-left-folder", "left-dir"]), Outcome::Exit(0)));
        assert!(staged.exists() && staged_folder.exists());
        match go(&["-cc-compare-staged-folder", "right.txt"]) {
            Outcome::Gui(spec) => assert!(spec.message.unwrap().contains("right folder")),
            other => panic!("{other:?}"),
        }
        assert!(staged_folder.exists());
        match go(&["-cc-compare-staged-folder", "left-dir"]) {
            Outcome::Gui(spec) => assert!(spec.message.unwrap().contains("different right")),
            other => panic!("{other:?}"),
        }
        match go(&["-cc-compare-staged-folder", "right-dir"]) {
            Outcome::Gui(spec) => {
                assert_eq!(spec.kind, "folder");
                assert_eq!(spec.paths, [absolutize("left-dir", d.path()), absolutize("right-dir", d.path())]);
            }
            other => panic!("{other:?}"),
        }
        assert!(staged.exists() && !staged_folder.exists());
        assert!(matches!(go(&["-cc-select-left-folder", "right-dir"]), Outcome::Exit(0)));
        assert!(matches!(go(&["-cc-clear-left-folder"]), Outcome::Exit(0)));
        assert!(staged.exists() && !staged_folder.exists());
        let literal = parse(&s(&["-cc-select-left", "--", "-literal.txt"])).unwrap();
        assert_eq!(literal.positional, ["-literal.txt"]);

        assert!(matches!(
            go(&["-cc-compare", "left.txt", "right.txt"]),
            Outcome::Gui(_)
        ));
        assert!(staged.exists());
        match go(&["-cc-compare-staged", "right.txt"]) {
            Outcome::Gui(spec) => assert_eq!(
                spec.paths,
                vec![
                    absolutize("left.txt", d.path()),
                    absolutize("right.txt", d.path())
                ]
            ),
            other => panic!("{other:?}"),
        }
        assert!(!staged.exists());
        match go(&["-cc-compare", "left.txt", "right.txt"]) {
            Outcome::Gui(spec) => assert_eq!(
                spec.paths,
                vec![
                    absolutize("left.txt", d.path()),
                    absolutize("right.txt", d.path())
                ]
            ),
            other => panic!("{other:?}"),
        }
        match go(&["-cc-compare", "left-dir", "right-dir"]) {
            Outcome::Gui(spec) => {
                assert_eq!(spec.kind, "folder");
                assert_eq!(
                    spec.paths,
                    vec![
                        absolutize("left-dir", d.path()),
                        absolutize("right-dir", d.path())
                    ]
                );
            }
            other => panic!("{other:?}"),
        }
        match go(&["-cc-merge", "left.txt", "right.txt"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "merge"),
            other => panic!("{other:?}"),
        }
        match go(&["-cc-sync", "left-dir", "right-dir"]) {
            Outcome::Gui(spec) => assert_eq!(spec.kind, "sync"),
            other => panic!("{other:?}"),
        }
        match go(&["-cc-sync", "left.txt", "right.txt"]) {
            Outcome::Gui(spec) => assert!(spec
                .message
                .as_deref()
                .unwrap()
                .contains("two selected folders")),
            other => panic!("{other:?}"),
        }
        match go(&["-cc-compare", "left.txt"]) {
            Outcome::Gui(spec) => {
                assert!(spec
                    .message
                    .as_deref()
                    .unwrap()
                    .contains("two files or two folders"))
            }
            other => panic!("{other:?}"),
        }
        match go(&["-cc-compare", "left.txt", "left-dir"]) {
            Outcome::Gui(spec) => assert!(spec
                .message
                .as_deref()
                .unwrap()
                .contains("two files or two folders only")),
            other => panic!("{other:?}"),
        }

        assert!(matches!(
            go(&["-cc-select-left", "left.txt"]),
            Outcome::Exit(0)
        ));
        std::fs::remove_file(&left).unwrap();
        match go(&["-cc-compare-staged", "right.txt"]) {
            Outcome::Gui(spec) => assert!(spec
                .message
                .as_deref()
                .unwrap()
                .contains("no longer available")),
            other => panic!("{other:?}"),
        }

        if let Some(value) = previous {
            std::env::set_var("COMPARECRAFT_CONTEXT_LEFT_FILE", value);
        } else {
            std::env::remove_var("COMPARECRAFT_CONTEXT_LEFT_FILE");
        }
        for (variable, previous) in isolated_variables.iter().zip(previous_variables) {
            if let Some(previous) = previous { std::env::set_var(variable, previous); }
            else { std::env::remove_var(variable); }
        }
    }
}
