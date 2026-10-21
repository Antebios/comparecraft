use serde::Deserialize;
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub struct Action {
    pub id: &'static str,
    pub label: &'static str,
    pub flag: &'static str,
    pub icon: &'static str,
}

pub const ACTIONS: &[Action] = &[
    Action { id: "compare", label: "Compare", flag: "-cc-compare", icon: "view-split-left-right" },
    Action { id: "selectLeft", label: "Select Left File for Compare", flag: "-cc-select-left", icon: "document-open" },
    Action { id: "compareStaged", label: "Compare to Selected Left File", flag: "-cc-compare-staged", icon: "document-properties" },
    Action { id: "sync", label: "Sync", flag: "-cc-sync", icon: "folder-sync" },
    Action { id: "merge", label: "Merge", flag: "-cc-merge", icon: "document-save-as" },
    Action { id: "selectLeftFolder", label: "Select Left Folder for Compare", flag: "-cc-select-left-folder", icon: "folder-open" },
    Action { id: "compareStagedFolder", label: "Compare to Selected Left Folder", flag: "-cc-compare-staged-folder", icon: "folder-compare" },
    Action { id: "clearLeft", label: "Clear Selected Left File", flag: "-cc-clear-left", icon: "edit-clear" },
    Action { id: "clearLeftFolder", label: "Clear Selected Left Folder", flag: "-cc-clear-left-folder", icon: "edit-clear" },
];

#[derive(Deserialize)]
struct Preference {
    id: String,
    enabled: bool,
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("COMPARECRAFT_CONFIG_DIR").map(PathBuf::from)
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("comparecraft"))
}

pub fn staged_path(config: &Path, folder: bool) -> Option<PathBuf> {
    let variable = if folder { "COMPARECRAFT_CONTEXT_LEFT_FOLDER" } else { "COMPARECRAFT_CONTEXT_LEFT_FILE" };
    let name = if folder { "context-left-folder.json" } else { "context-left.json" };
    let state = std::env::var_os(variable).map(PathBuf::from).unwrap_or_else(|| config.join(name));
    let value = std::fs::read(state).ok()?;
    let path = PathBuf::from(serde_json::from_slice::<String>(&value).ok()?);
    if if folder { path.is_dir() } else { path.is_file() } { Some(path) } else { None }
}

pub fn visible(config: &Path, paths: &[PathBuf]) -> u32 {
    let preferences: Vec<Preference> = std::fs::read(config.join("shell-integration.json")).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
    let enabled = |id: &str| preferences.iter().any(|item| item.id == id && item.enabled);
    let file_stage = staged_path(config, false);
    let folder_stage = staged_path(config, true);
    let mut mask = 0;
    for (index, action) in ACTIONS.iter().enumerate() {
        let preference = match action.id { "clearLeft" => "selectLeft", "clearLeftFolder" => "selectLeftFolder", other => other };
        if enabled(preference) && applicable(action.id, paths, file_stage.as_deref(), folder_stage.as_deref()) {
            mask |= 1 << index;
        }
    }
    mask
}

pub fn applicable(id: &str, paths: &[PathBuf], file_stage: Option<&Path>, folder_stage: Option<&Path>) -> bool {
    if paths.is_empty() || paths.len() > 2 { return false; }
    let files = paths.iter().all(|path| path.is_file());
    let folders = paths.iter().all(|path| path.is_dir());
    if paths.len() == 2 {
        return match id { "compare" => files || folders, "merge" => files, "sync" => folders, _ => false };
    }
    let distinct = |stage: Option<&Path>| stage.is_some_and(|left| {
        match (left.canonicalize(), paths[0].canonicalize()) {
            (Ok(left), Ok(right)) => left != right,
            _ => false,
        }
    });
    match id {
        "selectLeft" => files,
        "selectLeftFolder" => folders,
        "compareStaged" => files && file_stage.is_some_and(Path::is_file) && distinct(file_stage),
        "compareStagedFolder" => folders && folder_stage.is_some_and(Path::is_dir) && distinct(folder_stage),
        "clearLeft" => files && file_stage.is_some_and(Path::is_file),
        "clearLeftFolder" => folders && folder_stage.is_some_and(Path::is_dir),
        _ => false,
    }
}

#[no_mangle]
pub unsafe extern "C" fn comparecraft_menu_mask(count: usize, paths: *const *const c_char) -> u32 {
    if paths.is_null() || count == 0 || count > 2 { return 0; }
    let mut selected = Vec::new();
    for index in 0..count {
        let path = *paths.add(index);
        if path.is_null() { return 0; }
        let Ok(path) = CStr::from_ptr(path).to_str() else { return 0; };
        selected.push(PathBuf::from(path));
    }
    visible(&config_dir(), &selected)
}

#[no_mangle]
pub extern "C" fn comparecraft_menu_text(index: usize, field: usize) -> *const c_char {
    static TEXT: OnceLock<Vec<[CString; 3]>> = OnceLock::new();
    let values = TEXT.get_or_init(|| ACTIONS.iter().map(|action| [
        CString::new(action.id).unwrap(), CString::new(action.label).unwrap(), CString::new(action.icon).unwrap(),
    ]).collect());
    values.get(index).and_then(|value| value.get(field)).map_or(std::ptr::null(), |value| value.as_ptr())
}

pub fn activate(index: usize, paths: &[PathBuf]) -> std::io::Result<()> {
    let config = config_dir();
    let action = ACTIONS.get(index).ok_or_else(|| std::io::Error::other("Unknown context action"))?;
    if visible(&config, paths) & (1 << index) == 0 {
        return Err(std::io::Error::other("Selection or staged item changed; reopen the context menu"));
    }
    let executable: String = serde_json::from_slice(&std::fs::read(config.join("shell-executable.json"))?)?;
    let mut command = std::process::Command::new(executable);
    command.arg(action.flag);
    if !matches!(action.id, "clearLeft" | "clearLeftFolder") {
        command.arg("--").args(paths);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(target_os = "linux")]
    {
        let arguments: Vec<CString> = std::iter::once(command.get_program()).chain(command.get_args())
            .map(|value| CString::new(value.as_encoded_bytes()).map_err(std::io::Error::other)).collect::<Result<_, _>>()?;
        let mut pointers: Vec<*const c_char> = arguments.iter().map(|value| value.as_ptr()).collect();
        pointers.push(std::ptr::null());
        let mut error = std::ptr::null_mut();
        let launched = unsafe { g_spawn_async(std::ptr::null(), pointers.as_ptr(), std::ptr::null(), 0,
            None, std::ptr::null_mut(), std::ptr::null_mut(), &mut error) };
        if !error.is_null() { unsafe { g_error_free(error); } }
        if launched == 0 { return Err(std::io::Error::other("Could not launch CompareCraft")); }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    command.spawn().map(|_| ())
}

#[cfg(target_os = "linux")]
#[link(name = "glib-2.0")]
extern "C" {
    fn g_spawn_async(directory: *const c_char, arguments: *const *const c_char,
        environment: *const *const c_char, flags: i32, setup: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
        data: *mut std::ffi::c_void, process: *mut i32, error: *mut *mut std::ffi::c_void) -> i32;
    fn g_error_free(error: *mut std::ffi::c_void);
}

#[no_mangle]
pub unsafe extern "C" fn comparecraft_menu_activate(index: usize, count: usize, paths: *const *const c_char) -> i32 {
    if paths.is_null() || count == 0 || count > 2 { return -1; }
    let mut selected = Vec::new();
    for offset in 0..count {
        let path = *paths.add(offset);
        if path.is_null() { return -1; }
        let Ok(path) = CStr::from_ptr(path).to_str() else { return -1; };
        selected.push(PathBuf::from(path));
    }
    if activate(index, &selected).is_ok() { 0 } else { -1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_matrix_preserves_left_actions_and_independent_stages() {
        let root = tempfile::tempdir().unwrap();
        let left = root.path().join("left.txt");
        let right = root.path().join("right.txt");
        let left_folder = root.path().join("left folder");
        let right_folder = root.path().join("right folder");
        std::fs::write(&left, "left").unwrap();
        std::fs::write(&right, "right").unwrap();
        std::fs::create_dir(&left_folder).unwrap();
        std::fs::create_dir(&right_folder).unwrap();
        let actions = |paths: &[PathBuf], staged_file, staged_folder| ACTIONS.iter()
            .filter(|action| applicable(action.id, paths, staged_file, staged_folder))
            .map(|action| action.id).collect::<Vec<_>>();
        assert!(actions(&[], None, None).is_empty());
        assert_eq!(actions(&[right.clone()], None, None), ["selectLeft"]);
        assert_eq!(actions(&[right_folder.clone()], None, None), ["selectLeftFolder"]);
        assert_eq!(actions(&[right.clone()], Some(left.as_path()), Some(left_folder.as_path())), ["selectLeft", "compareStaged", "clearLeft"]);
        assert_eq!(actions(&[right_folder.clone()], Some(left.as_path()), Some(left_folder.as_path())), ["selectLeftFolder", "compareStagedFolder", "clearLeftFolder"]);
        assert_eq!(actions(&[left.clone()], Some(left.as_path()), None), ["selectLeft", "clearLeft"]);
        assert_eq!(actions(&[left.clone(), right.clone()], None, None), ["compare", "merge"]);
        assert_eq!(actions(&[left_folder.clone(), right_folder.clone()], None, None), ["compare", "sync"]);
        assert!(actions(&[left.clone(), left_folder.clone()], None, None).is_empty());
        assert!(actions(&[left.clone(), right.clone(), right_folder], None, None).is_empty());
        assert!(!applicable("compareStaged", &[right.clone()], Some(root.path()), None));
        assert_eq!(visible(root.path(), &[right.clone()]), 0);
        std::fs::write(root.path().join("shell-integration.json"), r#"[{"id":"selectLeft","enabled":true}]"#).unwrap();
        assert_eq!(visible(root.path(), &[right]), 1 << 1);
    }
}