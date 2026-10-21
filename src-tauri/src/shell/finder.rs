use super::*;
use std::path::{Path, PathBuf};

pub(super) fn extension_path(executable: &Path) -> Option<PathBuf> {
    let contents = executable.parent()?.parent()?;
    let extension = contents.join("PlugIns/CompareCraftFinder.appex");
    extension.join("Contents/Info.plist").is_file().then_some(extension)
}

pub(super) fn publish_to(config: &Path, executable: PathBuf, group: &Path) -> io::Result<()> {
    std::fs::create_dir_all(group)?;
    let lock = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(group.join("finder-menu.lock"))?;
    lock.lock()?;
    let snapshot = comparecraft_menu::finder_snapshot(config, executable);
    crate::sessions::write_json_atomic(&group.join("finder-menu.json"), &snapshot)
}

#[cfg(target_os = "macos")]
fn group_container() -> io::Result<PathBuf> {
    use std::ffi::{c_char, c_void, CStr, CString, OsString};
    use std::os::unix::ffi::OsStringExt;

    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    unsafe {
        let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_argument: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_string: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_path: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *const c_char = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let send_void: unsafe extern "C" fn(*mut c_void, *mut c_void) = std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let pool = send(objc_getClass(c"NSAutoreleasePool".as_ptr()), sel_registerName(c"new".as_ptr()));
        let result = (|| {
            let manager = send(objc_getClass(c"NSFileManager".as_ptr()), sel_registerName(c"defaultManager".as_ptr()));
            let identifier = CString::new(comparecraft_menu::FINDER_GROUP).map_err(io::Error::other)?;
            let group = send_string(objc_getClass(c"NSString".as_ptr()), sel_registerName(c"stringWithUTF8String:".as_ptr()), identifier.as_ptr());
            let url = send_argument(manager, sel_registerName(c"containerURLForSecurityApplicationGroupIdentifier:".as_ptr()), group);
            if url.is_null() {
                return Err(io::Error::other("Finder App Group unavailable; sign the app and extension with matching App Group entitlements"));
            }
            let path = send_path(url, sel_registerName(c"fileSystemRepresentation".as_ptr()));
            if path.is_null() { return Err(io::Error::other("Finder App Group has no filesystem path")); }
            Ok(PathBuf::from(OsString::from_vec(CStr::from_ptr(path).to_bytes().to_vec())))
        })();
        send_void(pool, sel_registerName(c"drain".as_ptr()));
        result
    }
}

#[cfg(target_os = "macos")]
pub(super) fn publish() -> io::Result<()> {
    publish_to(&crate::sessions::config_dir(), std::env::current_exe()?, &group_container()?)
}

#[cfg(target_os = "macos")]
pub(super) fn set(items: &[ShellItem]) -> io::Result<()> {
    if items.iter().any(|item| item.enabled) {
        let extension = extension_path(&std::env::current_exe()?)
            .ok_or_else(|| io::Error::other("Finder extension is missing; install the complete CompareCraft.app bundle in Applications"))?;
        let output = std::process::Command::new("/usr/bin/pluginkit").arg("-a").arg(extension).output()?;
        if !output.status.success() {
            return Err(io::Error::other(format!("Finder extension registration failed: {}", String::from_utf8_lossy(&output.stderr))));
        }
    }
    apply_preferences(items, |_| Ok(()))?;
    publish()
}

#[cfg(target_os = "macos")]
pub(super) fn status() -> ShellStatus {
    let items = normalized_items(&load_preferences().unwrap_or_default());
    let mut warnings = Vec::new();
    if std::env::current_exe().ok().and_then(|path| extension_path(&path)).is_none() {
        warnings.push("Finder extension is missing. Install the complete CompareCraft.app bundle; tauri dev and bare binaries do not embed it.".into());
    }
    if items.iter().any(|item| item.enabled) {
        match group_container() {
            Ok(group) if group.join("finder-menu.json").is_file() => {}
            Ok(_) => warnings.push("Finder preferences are not published yet. Apply integration settings again.".into()),
            Err(error) => warnings.push(error.to_string()),
        }
        let enabled = std::process::Command::new("/usr/bin/pluginkit")
            .args(["-m", "-i", comparecraft_menu::FINDER_EXTENSION]).output().ok()
            .is_some_and(|output| output.status.success() && String::from_utf8_lossy(&output.stdout).lines().any(|line| line.trim_start().starts_with('+')));
        if !enabled {
            warnings.push("Enable CompareCraft in System Settings > General > Login Items & Extensions > Finder Extensions (location varies by macOS version). Finder Sync is experimental and requires macOS 12 or later.".into());
        }
    }
    ShellStatus { supported: true, items, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_embedded_extension_and_publishes_only_menu_state() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("CompareCraft.app/Contents/MacOS/comparecraft");
        assert!(extension_path(&executable).is_none());
        let extension = root.path().join("CompareCraft.app/Contents/PlugIns/CompareCraftFinder.appex/Contents");
        std::fs::create_dir_all(&extension).unwrap();
        std::fs::write(extension.join("Info.plist"), "fixture").unwrap();
        assert_eq!(extension_path(&executable), Some(extension.parent().unwrap().to_path_buf()));
        let config = root.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("shell-integration.json"), r#"[{"id":"selectLeftFolder","enabled":true}]"#).unwrap();
        let group = root.path().join("group");
        publish_to(&config, executable, &group).unwrap();
        let snapshot: serde_json::Value = serde_json::from_slice(&std::fs::read(group.join("finder-menu.json")).unwrap()).unwrap();
        assert_eq!(snapshot["version"], 1);
        assert_eq!(snapshot["actions"].as_array().unwrap().len(), comparecraft_menu::ACTIONS.len());
        assert!(snapshot.get("sessions").is_none());
        assert!(!snapshot["roots"].as_array().unwrap().is_empty());
        std::fs::write(config.join("shell-integration.json"), "[]").unwrap();
        publish_to(&config, PathBuf::from("comparecraft"), &group).unwrap();
        let disabled: serde_json::Value = serde_json::from_slice(&std::fs::read(group.join("finder-menu.json")).unwrap()).unwrap();
        assert!(disabled["actions"].as_array().unwrap().iter().all(|action| action["enabled"] == false));
        assert!(disabled["roots"].as_array().unwrap().is_empty());
    }

    #[test]
    fn concurrent_publishers_do_not_share_an_unlocked_temporary_file() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let group = root.path().join("group");
        let publishers: Vec<_> = (0..8).map(|_| {
            let config = config.clone();
            let group = group.clone();
            std::thread::spawn(move || publish_to(&config, PathBuf::from("comparecraft"), &group).unwrap())
        }).collect();
        for publisher in publishers { publisher.join().unwrap(); }
        let snapshot: serde_json::Value = serde_json::from_slice(&std::fs::read(group.join("finder-menu.json")).unwrap()).unwrap();
        assert_eq!(snapshot["version"], 1);
        assert!(!group.join("finder-menu.json.tmp").exists());
    }
}