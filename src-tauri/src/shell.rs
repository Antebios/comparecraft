//! Per-user file-manager context-menu integration.

use serde::{Deserialize, Serialize};
use std::io;

#[cfg(any(target_os = "macos", test))]
mod finder;

pub fn state_changed() -> io::Result<()> {
    #[cfg(target_os = "macos")]
    if load_preferences().is_some_and(|items| items.iter().any(|item| item.enabled)) { return finder::publish(); }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    /// Action ID from the shared menu catalog.
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub supported: bool,
    pub items: Vec<ShellItem>,
    pub warnings: Vec<String>,
}

fn preferences_path() -> std::path::PathBuf {
    crate::sessions::config_dir().join("shell-integration.json")
}

fn load_preferences() -> Option<Vec<ShellItem>> {
    std::fs::read(preferences_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

#[cfg(any(target_os = "windows", test))]
fn reg_file_key(key: &str) -> String {
    key.replacen("HKCU\\", "HKEY_CURRENT_USER\\", 1)
}

#[cfg(any(target_os = "windows", test))]
fn drop_target_clsid(id: &str) -> Option<&'static str> {
    match id {
        "compare" => Some("{5E8A1F31-92B3-4B16-A421-724E3F8C1001}"),
        "sync" => Some("{5E8A1F32-92B3-4B16-A421-724E3F8C1002}"),
        "merge" => Some("{5E8A1F33-92B3-4B16-A421-724E3F8C1003}"),
        _ => None,
    }
}

fn apply_preferences(
    items: &[ShellItem],
    apply: impl FnOnce(&[ShellItem]) -> io::Result<()>,
) -> io::Result<()> {
    let items = normalized_items(items);
    let executable = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from)
        .filter(|path| path.is_file()).unwrap_or(std::env::current_exe()?).to_string_lossy().into_owned();
    crate::sessions::write_json_atomic(&crate::sessions::config_dir().join("shell-executable.json"), &executable).map_err(io::Error::other)?;
    apply(&items)?;
    crate::sessions::write_json_atomic(&preferences_path(), &items).map_err(io::Error::other)
}

fn normalized_items(items: &[ShellItem]) -> Vec<ShellItem> {
    ITEMS.iter().map(|(id, _, _)| ShellItem {
        id: (*id).into(),
        enabled: items.iter().any(|item| item.id == *id && item.enabled),
    }).collect()
}

#[cfg(any(target_os = "windows", test))]
fn windows_registration(items: &[ShellItem], extension: Option<&str>) -> String {
    let mut registration = String::from("Windows Registry Editor Version 5.00\n\n");
    for (index, action) in comparecraft_menu::ACTIONS.iter().enumerate() {
        let preference = match action.id { "clearLeft" => "selectLeft", "clearLeftFolder" => "selectLeftFolder", other => other };
        let enabled = items.iter().any(|item| item.id == preference && item.enabled);
        let class = format!("{{{:08X}-92B3-4B16-A421-724E3F8C2001}}", 0x5e8a1f40 + index);
        let class_key = format!("HKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{class}");
        registration.push_str(&format!("[-{class_key}]\n\n"));
        for root in ["*", "Directory"] {
            let key = format!("HKEY_CURRENT_USER\\Software\\Classes\\{root}\\shell\\CompareCraft.{}", action.id);
            registration.push_str(&format!("[-{key}]\n\n"));
            let folder_action = matches!(action.id, "selectLeftFolder" | "compareStagedFolder" | "clearLeftFolder" | "sync");
            let applies = action.id == "compare" || (root == "Directory") == folder_action;
            if enabled && applies && extension.is_some() {
                registration.push_str(&format!("[{key}]\n\"MUIVerb\"=\"{}\"\n\"ExplorerCommandHandler\"=\"{class}\"\n\"MultiSelectModel\"=\"Player\"\n\n", action.label));
            }
        }
        if enabled {
            if let Some(extension) = extension {
                let extension = extension.replace('\\', "\\\\").replace('"', "\\\"");
                registration.push_str(&format!("[{class_key}\\InprocServer32]\n@=\"{extension}\"\n\"ThreadingModel\"=\"Apartment\"\n\n"));
            }
        }
    }
    for id in ["compare", "sync", "merge"] {
        let class = drop_target_clsid(id).unwrap();
        registration.push_str(&format!("[-HKEY_CURRENT_USER\\Software\\Classes\\CLSID\\{class}]\n\n"));
    }
    registration.push_str("[-HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\CompareCraft.edit]\n\n");
    registration
}

fn refresh_preferences(
    status: impl FnOnce() -> ShellStatus,
    apply: impl FnOnce(&[ShellItem]) -> io::Result<()>,
) -> io::Result<()> {
    let current = load_preferences().unwrap_or_else(|| status().items);
    apply_preferences(&current, apply)
}

#[cfg(target_os = "windows")]
fn install_preferences(
    status: impl FnOnce() -> ShellStatus,
    apply: impl FnOnce(&[ShellItem]) -> io::Result<()>,
) -> io::Result<()> {
    install_preferences_with_preferences(load_preferences(), status, apply)
}

#[cfg(target_os = "windows")]
fn install_preferences_with_preferences(
    preferences: Option<Vec<ShellItem>>,
    status: impl FnOnce() -> ShellStatus,
    apply: impl FnOnce(&[ShellItem]) -> io::Result<()>,
) -> io::Result<()> {
    let current = initial_preferences(preferences, status());
    apply_preferences(&current, apply)
}

#[cfg(any(target_os = "windows", test))]
fn initial_preferences(
    preferences: Option<Vec<ShellItem>>,
    detected: ShellStatus,
) -> Vec<ShellItem> {
    preferences.unwrap_or_else(|| {
        if detected.items.iter().any(|item| item.enabled) {
            detected.items
        } else {
            ITEMS
                .iter()
                .map(|(id, _, _)| ShellItem {
                    id: (*id).to_string(),
                    enabled: true,
                })
                .collect()
        }
    })
}

/// (id, menu label, extra command-line arguments)
const ITEMS: &[(&str, &str, &[&str])] = &[
    ("compare", "Compare", &["-cc-compare"]),
    (
        "selectLeft",
        "Select Left File for Compare",
        &["-cc-select-left"],
    ),
    (
        "compareStaged",
        "Compare to Selected Left File",
        &["-cc-compare-staged"],
    ),
    ("sync", "Sync", &["-cc-sync"]),
    ("merge", "Merge", &["-cc-merge"]),
    ("selectLeftFolder", "Select Left Folder for Compare", &["-cc-select-left-folder"]),
    ("compareStagedFolder", "Compare to Selected Left Folder", &["-cc-compare-staged-folder"]),
];

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn data_dir() -> io::Result<PathBuf> {
        if let Ok(p) = std::env::var("COMPARECRAFT_DATA_DIR") {
            return Ok(PathBuf::from(p));
        }
        dirs::data_dir().ok_or_else(|| io::Error::other("no user data directory"))
    }

    fn config_dir() -> Option<PathBuf> {
        std::env::var_os("COMPARECRAFT_CONFIG_DIR")
            .map(PathBuf::from)
            .or_else(dirs::config_dir)
    }

    fn scripts_dir(data: &Path) -> PathBuf {
        data.join("nautilus/scripts/CompareCraft")
    }

    fn service_menu(data: &Path, id: &str) -> PathBuf {
        data.join(format!("kio/servicemenus/comparecraft-{id}.desktop"))
    }

    fn thunar_config(config: &Path) -> PathBuf {
        config.join("Thunar/uca.xml")
    }

    /// Single-quotes a word for sh.
    fn sh_quote(s: &str) -> String {
        format!("'{}'", s.replace('\'', r"'\''"))
    }

    fn remove_if_exists(p: &Path) -> io::Result<()> {
        match fs::remove_file(p) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn thunar_actions(exe: &str, items: &[ShellItem]) -> String {
        let mut xml = String::from("  <!-- CompareCraft context menu start -->\n");
        for (index, (id, label, args)) in ITEMS.iter().enumerate() {
            if !items.iter().any(|item| item.id == *id && item.enabled) {
                continue;
            }
            let file_arg = if *id == "selectLeft" || *id == "compareStaged" {
                "%f"
            } else {
                "%F"
            };
            let command = format!(
                "{} {} {file_arg}",
                sh_quote(exe),
                args.iter()
                    .map(|arg| sh_quote(arg))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            xml.push_str(&format!(
                "  <action>\n    <icon>comparecraft</icon>\n    <name>{}</name>\n    <command>{}</command>\n    <description>{}</description>\n    <patterns>*</patterns>\n    <startup-notify>false</startup-notify>\n    <unique-id>comparecraft-{}</unique-id>\n    <directories/>\n    <audio-files/>\n    <image-files/>\n    <other-files/>\n  </action>\n",
                xml_escape(label),
                xml_escape(&command),
                xml_escape(&format!("Open selected item(s) with CompareCraft: {label}")),
                index
            ));
        }
        xml.push_str("  <!-- CompareCraft context menu end -->\n");
        xml
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    fn set_thunar(config: &Path, exe: &str, items: &[ShellItem]) -> io::Result<()> {
        const START: &str = "  <!-- CompareCraft context menu start -->";
        const END: &str = "  <!-- CompareCraft context menu end -->";
        let path = thunar_config(config);
        let enabled = items.iter().any(|item| item.enabled);
        let previous = fs::read_to_string(&path).ok();
        if previous.is_none() && !enabled { return Ok(()); }
        let mut content = previous.clone().unwrap_or_else(|| {
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<actions>\n</actions>\n".into()
        });
        if let (Some(start), Some(end)) = (content.find(START), content.find(END)) {
            if start < end {
                content.replace_range(start..end + END.len(), "");
            }
        }
        if enabled {
            let Some(end) = content.find("</actions>") else {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Thunar custom actions file has no </actions> element",
                ));
            };
            content.insert_str(end, &thunar_actions(exe, items));
        }
        if previous.as_deref() == Some(content.as_str()) {
            return Ok(());
        }
        if let Some(old) = previous {
            fs::write(path.with_extension("xml.bak"), old)?;
        }
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, content)
    }

    pub fn status() -> ShellStatus {
        let data = data_dir().ok();
        let config = config_dir();
        let items = ITEMS
            .iter()
            .map(|(id, label, _)| {
                let index = ITEMS.iter().position(|item| item.0 == *id).unwrap();
                let nautilus = data
                    .as_ref()
                    .is_some_and(|d| scripts_dir(d).join(label).is_file());
                let dolphin = data.as_ref().is_some_and(|d| service_menu(d, id).is_file());
                let thunar = config.as_ref().is_some_and(|d| {
                    fs::read_to_string(thunar_config(d))
                        .ok()
                        .is_some_and(|content| {
                            content.contains(&format!("unique-id>comparecraft-{index}"))
                        })
                });
                ShellItem {
                    id: id.to_string(),
                    enabled: nautilus || dolphin || thunar,
                }
            })
            .collect();
        ShellStatus {
            supported: true,
            items,
            warnings: Vec::new(),
        }
    }

    pub fn set(items: &[ShellItem]) -> io::Result<()> {
        let data = data_dir()?;
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let config = config_dir().ok_or_else(|| io::Error::other("no user config directory"))?;
        let scripts = scripts_dir(&data);
        remove_if_exists(&scripts.join("Edit"))?;
        remove_if_exists(&data.join("kio/servicemenus/comparecraft.desktop"))?;
        for (id, label, _) in ITEMS {
            let script = scripts.join(label);
            remove_if_exists(&script)?;
            remove_if_exists(&service_menu(&data, id))?;
        }
        if scripts.is_dir() && fs::read_dir(&scripts)?.next().is_none() {
            fs::remove_dir(&scripts)?;
        }
        let provider = data.join("nautilus-python/extensions/comparecraft.py");
        if items.iter().any(|item| item.enabled) {
            let executable = std::env::current_exe()?;
            let parent = executable.parent().ok_or_else(|| io::Error::other("Missing executable directory"))?;
            let library = [
                parent.join("libcomparecraft_menu.so"),
                parent.join("../libcomparecraft_menu.so"),
                parent.join("resources/libcomparecraft_menu.so"),
                parent.join("../lib/comparecraft/libcomparecraft_menu.so"),
                PathBuf::from("/usr/lib/comparecraft/libcomparecraft_menu.so"),
                PathBuf::from("/usr/lib64/comparecraft/libcomparecraft_menu.so"),
            ].into_iter().find(|path| path.is_file())
                .ok_or_else(|| io::Error::other("Native menu library missing; rebuild or reinstall CompareCraft"))?;
            let native = data.join("comparecraft/native");
            fs::create_dir_all(&native)?;
            let installed_library = native.join("libcomparecraft_menu.so");
            let temporary = native.join(format!("menu-{}.tmp", std::process::id()));
            fs::copy(&library, &temporary)?;
            fs::rename(&temporary, &installed_library)?;
            let source = include_str!("../../packaging/linux/nautilus/comparecraft.py").replace(
                "\"@COMPARECRAFT_MENU_LIBRARY@\"",
                &serde_json::to_string(&installed_library.to_string_lossy()).map_err(io::Error::other)?,
            );
            if let Some(parent) = provider.parent() { fs::create_dir_all(parent)?; }
            fs::write(provider, source)?;
        } else {
            remove_if_exists(&provider)?;
            remove_if_exists(&data.join("comparecraft/native/libcomparecraft_menu.so"))?;
        }
        set_thunar(&config, &exe, &[])?;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn installs_and_removes_menu_items() {
            let d = tempfile::tempdir().unwrap();
            let old_data_dir = std::env::var_os("COMPARECRAFT_DATA_DIR");
            let old_config_dir = std::env::var_os("COMPARECRAFT_CONFIG_DIR");
            let old_context_file = std::env::var_os("COMPARECRAFT_CONTEXT_LEFT_FILE");
            std::env::set_var("COMPARECRAFT_DATA_DIR", d.path());
            std::env::set_var("COMPARECRAFT_CONFIG_DIR", d.path());
            std::env::remove_var("COMPARECRAFT_CONTEXT_LEFT_FILE");
            let item = |id: &str, enabled: bool| ShellItem {
                id: id.into(),
                enabled,
            };
            set(&[
                item("compare", true),
                item("selectLeft", true),
                item("sync", true),
                item("merge", false),
            ])
            .unwrap();
            let st = status();
            assert!(st.supported);
            assert!(st.supported);
            let provider = fs::read_to_string(d.path().join("nautilus-python/extensions/comparecraft.py")).unwrap();
            assert!(!provider.contains("@COMPARECRAFT_MENU_LIBRARY@"));
            assert!(!d.path().join("kio/servicemenus/comparecraft-compare.desktop").exists());
            assert!(!d.path().join("Thunar/uca.xml").exists());
            set(&[]).unwrap();
            assert!(status().items.iter().all(|i| !i.enabled));
            assert!(!d.path().join("nautilus/scripts/CompareCraft").exists());
            assert!(!d
                .path()
                .join("kio/servicemenus/comparecraft-compare.desktop")
                .exists());
            assert!(!d
                .path()
                .join("kio/servicemenus/comparecraft-sync.desktop")
                .exists());
            assert!(!d.path().join("nautilus-python/extensions/comparecraft.py").exists());
            if let Some(value) = old_data_dir {
                std::env::set_var("COMPARECRAFT_DATA_DIR", value);
            } else {
                std::env::remove_var("COMPARECRAFT_DATA_DIR");
            }
            if let Some(value) = old_config_dir {
                std::env::set_var("COMPARECRAFT_CONFIG_DIR", value);
            } else {
                std::env::remove_var("COMPARECRAFT_CONFIG_DIR");
            }
            if let Some(value) = old_context_file {
                std::env::set_var("COMPARECRAFT_CONTEXT_LEFT_FILE", value);
            } else {
                std::env::remove_var("COMPARECRAFT_CONTEXT_LEFT_FILE");
            }
        }

    }
}

#[cfg(target_os = "linux")]
pub fn status() -> ShellStatus {
    let detected = imp::status();
    let items = normalized_items(&load_preferences().unwrap_or(detected.items));
    let mut warnings = Vec::new();
    if items.iter().any(|item| item.enabled) {
        let available = |paths: &[&str]| paths.iter().any(|path| std::path::Path::new(path).is_file());
        if !available(&["/usr/lib/nautilus/extensions-4/libnautilus-python.so", "/usr/lib64/nautilus/extensions-4/libnautilus-python.so", "/usr/lib/x86_64-linux-gnu/nautilus/extensions-4/libnautilus-python.so"]) {
            warnings.push("GNOME Files provider unavailable: install nautilus-python (python3-nautilus on Debian), then restart Files.".into());
        }
        if !available(&["/usr/lib/thunarx-3/libcomparecraft-thunar.so", "/usr/lib64/thunarx-3/libcomparecraft-thunar.so", "/usr/lib/x86_64-linux-gnu/thunarx-3/libcomparecraft-thunar.so"]) {
            warnings.push("Thunar provider unavailable: install the updated CompareCraft package, then restart Thunar.".into());
        }
        if !available(&["/usr/lib/qt6/plugins/kf6/kfileitemaction/comparecraft-dolphin.so", "/usr/lib64/qt6/plugins/kf6/kfileitemaction/comparecraft-dolphin.so", "/usr/lib/x86_64-linux-gnu/qt6/plugins/kf6/kfileitemaction/comparecraft-dolphin.so"]) {
            warnings.push("Dolphin provider unavailable: install the updated CompareCraft package, then restart Dolphin.".into());
        }
    }
    ShellStatus { supported: detected.supported, items, warnings }
}

#[cfg(target_os = "linux")]
pub fn set(items: &[ShellItem]) -> io::Result<()> {
    apply_preferences(items, imp::set)
}

#[cfg(target_os = "linux")]
pub fn refresh() -> io::Result<()> {
    refresh_preferences(imp::status, imp::set)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Output};
    use std::{collections::HashSet, fs};

    pub(super) const FILE_ROOT: &str = r"HKCU\Software\Classes\*\shell";
    pub(super) const DIRECTORY_ROOT: &str = r"HKCU\Software\Classes\Directory\shell";
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    pub(super) fn roots(id: &str) -> &'static [&'static str] {
        match id {
            "compare" => &[FILE_ROOT, DIRECTORY_ROOT],
            "sync" | "selectLeftFolder" | "compareStagedFolder" => &[DIRECTORY_ROOT],
            _ => &[FILE_ROOT],
        }
    }

    pub(super) fn key(root: &str, id: &str) -> String {
        format!("{root}\\CompareCraft.{id}")
    }

    fn run(args: &[&str]) -> io::Result<Output> {
        Command::new("reg.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    fn installed_at(root: &str) -> HashSet<String> {
        let Ok(output) = run(&["query", root]) else {
            return HashSet::new();
        };
        if !output.status.success() {
            return HashSet::new();
        }
        let suffixes: Vec<(String, &str)> = ITEMS
            .iter()
            .filter(|(id, _, _)| roots(id).contains(&root))
            .map(|(id, _, _)| (format!(r"\CompareCraft.{id}").to_ascii_lowercase(), *id))
            .collect();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let key = line.trim().to_ascii_lowercase();
                suffixes
                    .iter()
                    .find(|(suffix, _)| key.ends_with(suffix))
                    .map(|(_, id)| (*id).to_string())
            })
            .collect()
    }

    fn installed() -> HashSet<String> {
        let files = installed_at(FILE_ROOT);
        let directories = installed_at(DIRECTORY_ROOT);
        ITEMS
            .iter()
            .filter(|(id, _, _)| {
                roots(id).iter().any(|root| match *root {
                    FILE_ROOT => files.contains(*id),
                    DIRECTORY_ROOT => directories.contains(*id),
                    _ => false,
                })
            })
            .map(|(id, _, _)| (*id).to_string())
            .collect()
    }

    pub fn status() -> ShellStatus {
        let installed = installed();
        ShellStatus {
            supported: true,
            warnings: Vec::new(),
            items: ITEMS
                .iter()
                .map(|(id, _, _)| ShellItem {
                    id: id.to_string(),
                    enabled: installed.contains(*id),
                })
                .collect(),
        }
    }

    pub fn set(items: &[ShellItem]) -> io::Result<()> {
        let extension = if items
            .iter()
            .any(|item| item.enabled)
        {
            let exe_dir = std::env::current_exe()?
                .parent()
                .ok_or_else(|| io::Error::other("application executable has no parent directory"))?
                .to_path_buf();
            Some(
                [
                    exe_dir.join("comparecraft_shell_extension.dll"),
                    exe_dir
                        .join("resources")
                        .join("comparecraft_shell_extension.dll"),
                ]
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::NotFound,
                        "CompareCraft's Windows shell extension is missing; reinstall the application",
                    )
                })?
                .to_string_lossy()
                .into_owned(),
            )
        } else {
            None
        };
        let registration = windows_registration(items, extension.as_deref());
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let import_file = std::env::temp_dir().join(format!(
            "comparecraft-shell-{}-{nonce}.reg",
            std::process::id()
        ));
        let mut encoded = vec![0xff, 0xfe];
        encoded.extend(registration.encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&import_file, encoded)?;
        let result = run(&["import", import_file.to_string_lossy().as_ref()]);
        let _ = fs::remove_file(&import_file);
        let output = result?;
        if !output.status.success() {
            return Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }
        unsafe {
            SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null());
        }
        Ok(())
    }

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHChangeNotify(
            event_id: i32,
            flags: u32,
            item1: *const std::ffi::c_void,
            item2: *const std::ffi::c_void,
        );
    }
}

#[cfg(target_os = "windows")]
pub fn status() -> ShellStatus {
    let detected = imp::status();
    ShellStatus { supported: detected.supported, items: normalized_items(&load_preferences().unwrap_or(detected.items)), warnings: Vec::new() }
}

#[cfg(target_os = "windows")]
pub fn set(items: &[ShellItem]) -> io::Result<()> {
    apply_preferences(items, imp::set)
}

#[cfg(target_os = "windows")]
pub fn refresh() -> io::Result<()> {
    refresh_preferences(imp::status, imp::set)
}

#[cfg(target_os = "windows")]
pub fn install() -> io::Result<()> {
    install_preferences(imp::status, imp::set)
}

#[cfg(target_os = "linux")]
pub fn install() -> io::Result<()> {
    refresh()
}

#[cfg(target_os = "macos")]
pub fn status() -> ShellStatus { finder::status() }

#[cfg(target_os = "macos")]
pub fn set(items: &[ShellItem]) -> io::Result<()> { finder::set(items) }

#[cfg(target_os = "macos")]
pub fn refresh() -> io::Result<()> {
    finder::set(&load_preferences().unwrap_or_default())
}

#[cfg(target_os = "macos")]
pub fn install() -> io::Result<()> { refresh() }

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn status() -> ShellStatus {
    ShellStatus {
        supported: false,
        warnings: Vec::new(),
        items: ITEMS
            .iter()
            .map(|(id, _, _)| ShellItem {
                id: id.to_string(),
                enabled: false,
            })
            .collect(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn set(_items: &[ShellItem]) -> io::Result<()> {
    Err(io::Error::other(
        "File manager integration is not supported on this platform",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn refresh() -> io::Result<()> {
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn install() -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::imp::{key, roots, DIRECTORY_ROOT, FILE_ROOT};
    use super::reg_file_key;
    use super::{drop_target_clsid, initial_preferences, ShellItem, ShellStatus};

    #[test]
    fn dynamic_windows_verbs_include_folder_and_clear_actions() {
        let items = super::ITEMS.iter().map(|(id, _, _)| ShellItem { id: (*id).into(), enabled: true }).collect::<Vec<_>>();
        let registration = super::windows_registration(&items, Some(r"C:\CompareCraft\menu.dll"));
        assert!(registration.contains("ExplorerCommandHandler"));
        assert!(!registration.contains("\\DropTarget]"));
        assert!(registration.contains("[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\CompareCraft.selectLeftFolder]"));
        assert!(!registration.contains("\n[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\CompareCraft.selectLeftFolder]"));
        assert!(registration.contains("CompareCraft.clearLeftFolder]"));
        assert!(super::windows_registration(&[], None).lines().filter(|line| line.starts_with('[')).all(|line| line.starts_with("[-")));
    }

    #[test]
    fn registry_import_uses_full_current_user_hive_name() {
        assert_eq!(
            reg_file_key(r"HKCU\Software\Classes\*\shell\CompareCraft.compare"),
            r"HKEY_CURRENT_USER\Software\Classes\*\shell\CompareCraft.compare"
        );
        assert_eq!(
            reg_file_key(r"HKCU\Software\Classes\Directory\shell\CompareCraft.sync"),
            r"HKEY_CURRENT_USER\Software\Classes\Directory\shell\CompareCraft.sync"
        );
    }

    #[test]
    fn fresh_install_enables_verbs_but_existing_preferences_are_preserved() {
        let status = || ShellStatus {
            supported: true,
            warnings: Vec::new(),
            items: vec![ShellItem {
                id: "compare".into(),
                enabled: false,
            }],
        };
        let defaults = initial_preferences(None, status());
        assert_eq!(defaults.len(), super::ITEMS.len());
        assert!(defaults.iter().all(|item| item.enabled));

        let saved = vec![ShellItem {
            id: "compare".into(),
            enabled: false,
        }];
        let no_verbs = ShellStatus {
            supported: true,
            warnings: Vec::new(),
            items: Vec::new(),
        };
        assert_eq!(initial_preferences(Some(saved.clone()), no_verbs), saved);

        let existing = ShellStatus {
            supported: true,
            warnings: Vec::new(),
            items: vec![ShellItem {
                id: "compare".into(),
                enabled: true,
            }],
        };
        assert_eq!(initial_preferences(None, existing.clone()), existing.items);
    }

    #[test]
    fn multi_selection_actions_use_distinct_drop_target_classes() {
        assert!(drop_target_clsid("compare").is_some());
        assert!(drop_target_clsid("sync").is_some());
        assert!(drop_target_clsid("merge").is_some());
        assert!(drop_target_clsid("selectLeft").is_none());
        assert!(drop_target_clsid("compareStaged").is_none());
        assert_ne!(drop_target_clsid("compare"), drop_target_clsid("sync"));
        assert_ne!(drop_target_clsid("compare"), drop_target_clsid("merge"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_verbs_target_file_and_folder_selections() {
        assert_eq!(roots("compare"), &[FILE_ROOT, DIRECTORY_ROOT]);
        assert_eq!(roots("sync"), &[DIRECTORY_ROOT]);
        assert_eq!(roots("merge"), &[FILE_ROOT]);
        assert_eq!(
            key(DIRECTORY_ROOT, "compare"),
            r"HKCU\Software\Classes\Directory\shell\CompareCraft.compare"
        );
    }
}
