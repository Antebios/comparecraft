//! Per-user file-manager context-menu integration.

use serde::{Deserialize, Serialize};
use std::io;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    /// "compare" | "selectLeft" | "compareStaged" | "sync" | "merge"
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub supported: bool,
    pub items: Vec<ShellItem>,
}

fn preferences_path() -> std::path::PathBuf {
    crate::sessions::config_dir().join("shell-integration.json")
}

fn load_preferences() -> Option<Vec<ShellItem>> {
    std::fs::read(preferences_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn effective_items(items: &[ShellItem]) -> Vec<ShellItem> {
    let staged_path = std::env::var_os("COMPARECRAFT_CONTEXT_LEFT_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::sessions::config_dir().join("context-left.json"));
    let has_staged_left = std::fs::read(staged_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok())
        .is_some_and(|path| std::path::Path::new(&path).is_file());
    effective_items_for_state(items, has_staged_left)
}

fn effective_items_for_state(items: &[ShellItem], has_staged_left: bool) -> Vec<ShellItem> {
    items
        .iter()
        .map(|item| {
            let mut item = item.clone();
            match item.id.as_str() {
                "selectLeft" => item.enabled &= !has_staged_left,
                "compareStaged" => item.enabled &= has_staged_left,
                _ => {}
            }
            item
        })
        .collect()
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
    crate::sessions::write_json_atomic(&preferences_path(), &items).map_err(io::Error::other)?;
    apply(&effective_items(items))
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
];

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
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

    /// Quotes an argument for a desktop entry Exec key (including the string-value escaping of backslashes).
    fn exec_quote(s: &str) -> String {
        if !s.is_empty() && !s.chars().any(|c| " \t\n\"'\\><~|&;$*?#()`".contains(c)) {
            return s.to_string();
        }
        let mut out = String::from("\"");
        for c in s.chars() {
            match c {
                '"' | '`' | '$' => {
                    out.push('\\');
                    out.push(c);
                }
                '\\' => out.push_str(r"\\\\"),
                _ => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn write_exec(p: &Path, content: &str) -> io::Result<()> {
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(p, content)?;
        fs::set_permissions(p, fs::Permissions::from_mode(0o755))
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
        }
    }

    pub fn set(items: &[ShellItem]) -> io::Result<()> {
        let data = data_dir()?;
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let config = config_dir().ok_or_else(|| io::Error::other("no user config directory"))?;
        let enabled = |id: &str| items.iter().any(|i| i.id == id && i.enabled);
        let scripts = scripts_dir(&data);
        remove_if_exists(&scripts.join("Edit"))?;
        remove_if_exists(&data.join("kio/servicemenus/comparecraft.desktop"))?;
        for (id, label, args) in ITEMS {
            let script = scripts.join(label);
            if !enabled(id) {
                remove_if_exists(&script)?;
                remove_if_exists(&service_menu(&data, id))?;
                continue;
            }
            let sh_args: String = args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
            write_exec(
                &script,
                &format!("#!/bin/sh\nexec {}{sh_args} \"$@\"\n", sh_quote(&exe)),
            )?;
            let exec_args: String = args.iter().map(|a| format!(" {}", exec_quote(a))).collect();
            let selection = if *id == "selectLeft" || *id == "compareStaged" {
                "%f"
            } else {
                "%F"
            };
            let required_args = if matches!(*id, "selectLeft" | "compareStaged") {
                1
            } else {
                2
            };
            let menu = format!(
                "[Desktop Entry]\nType=Service\nServiceTypes=KonqPopupMenu/Plugin\nMimeType=all/all;\nX-KDE-RequiredNumberOfArguments={required_args}\nName={label}\nExec={}{exec_args} {selection}\n",
                exec_quote(&exe)
            );
            write_exec(&service_menu(&data, id), &menu)?;
        }
        if scripts.is_dir() && fs::read_dir(&scripts)?.next().is_none() {
            fs::remove_dir(&scripts)?;
        }
        set_thunar(&config, &exe, items)?;
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
                item("sync", true),
                item("merge", false),
            ])
            .unwrap();
            let st = status();
            assert!(st.supported);
            let on: Vec<&str> = st
                .items
                .iter()
                .filter(|i| i.enabled)
                .map(|i| i.id.as_str())
                .collect();
            assert_eq!(on, vec!["compare", "sync"]);
            let sync =
                fs::read_to_string(d.path().join("nautilus/scripts/CompareCraft/Sync")).unwrap();
            assert!(
                sync.starts_with("#!/bin/sh\nexec '") && sync.ends_with(" '-cc-sync' \"$@\"\n"),
                "{sync}"
            );
            let mode = fs::metadata(d.path().join("nautilus/scripts/CompareCraft/Sync"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
            let menu = fs::read_to_string(
                d.path()
                    .join("kio/servicemenus/comparecraft-compare.desktop"),
            )
            .unwrap();
            assert!(
                menu.contains("X-KDE-RequiredNumberOfArguments=2\nName=Compare\n")
                    && menu.contains("\"-cc-compare\" %F"),
                "{menu}"
            );
            let left_menu = fs::read_to_string(
                d.path()
                    .join("kio/servicemenus/comparecraft-selectLeft.desktop"),
            )
            .unwrap();
            assert!(
                left_menu.contains("X-KDE-RequiredNumberOfArguments=1"),
                "{left_menu}"
            );
            let thunar = fs::read_to_string(d.path().join("Thunar/uca.xml")).unwrap();
            assert!(
                thunar.contains("<name>Compare</name>") && thunar.contains("'-cc-compare' %F"),
                "{thunar}"
            );
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
            assert!(!fs::read_to_string(d.path().join("Thunar/uca.xml"))
                .unwrap()
                .contains("CompareCraft context menu"));
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

        #[test]
        fn staged_file_switches_left_context_action() {
            let items = vec![
                ShellItem {
                    id: "selectLeft".into(),
                    enabled: true,
                },
                ShellItem {
                    id: "compareStaged".into(),
                    enabled: true,
                },
            ];
            let staged = effective_items_for_state(&items, true);
            assert!(
                !staged
                    .iter()
                    .find(|item| item.id == "selectLeft")
                    .unwrap()
                    .enabled
            );
            assert!(
                staged
                    .iter()
                    .find(|item| item.id == "compareStaged")
                    .unwrap()
                    .enabled
            );
            let stale = effective_items_for_state(&items, false);
            assert!(
                stale
                    .iter()
                    .find(|item| item.id == "selectLeft")
                    .unwrap()
                    .enabled
            );
            assert!(
                !stale
                    .iter()
                    .find(|item| item.id == "compareStaged")
                    .unwrap()
                    .enabled
            );
        }
    }
}

#[cfg(target_os = "linux")]
pub fn status() -> ShellStatus {
    imp::status()
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
            "sync" => &[DIRECTORY_ROOT],
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

    fn reg_escape(value: &str) -> String {
        value.replace('\\', "\\\\").replace('"', "\\\"")
    }

    pub fn status() -> ShellStatus {
        let installed = installed();
        ShellStatus {
            supported: true,
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
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let extension = if items
            .iter()
            .any(|item| item.enabled && matches!(item.id.as_str(), "compare" | "sync" | "merge"))
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
        let mut registration = String::from("Windows Registry Editor Version 5.00\n\n");
        for (id, label, args) in ITEMS {
            let selected = items.iter().any(|item| item.id == *id && item.enabled);
            for context_root in roots(id) {
                let file_root = reg_file_key(&key(context_root, id));
                if !selected {
                    registration.push_str(&format!("[-{file_root}]\n\n"));
                    continue;
                }
                if let Some(class_id) = drop_target_clsid(id) {
                    registration.push_str(&format!(
                        "[{file_root}]\n\"MUIVerb\"=\"{}\"\n\"MultiSelectModel\"=-\n\n[{file_root}\\DropTarget]\n@=\"{class_id}\"\n\n[-{file_root}\\command]\n\n",
                        reg_escape(label)
                    ));
                    continue;
                }
                let flags = args
                    .iter()
                    .map(|arg| {
                        if arg.chars().any(char::is_whitespace) {
                            format!("\"{arg}\"")
                        } else {
                            (*arg).to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let command = format!("\"{exe}\" {flags} \"%1\"");
                registration.push_str(&format!(
                    "[{file_root}]\n\"MUIVerb\"=\"{}\"\n",
                    reg_escape(label)
                ));
                registration.push_str(&format!(
                    "\n[{file_root}\\command]\n@=\"{}\"\n\n",
                    reg_escape(&command)
                ));
            }
        }
        for id in ["compare", "sync", "merge"] {
            let class_id = drop_target_clsid(id).expect("multi-select verbs have a CLSID");
            let class_key = reg_file_key(&format!(r"HKCU\Software\Classes\CLSID\{class_id}"));
            registration.push_str(&format!("[-{class_key}]\n\n"));
            if items.iter().any(|item| item.id == id && item.enabled) {
                let extension = extension.as_deref().ok_or_else(|| {
                    io::Error::other("the Windows shell extension path was not resolved")
                })?;
                registration.push_str(&format!(
                    "[{class_key}]\n@=\"CompareCraft Shell Extension\"\n\n[{class_key}\\InprocServer32]\n@=\"{}\"\n\"ThreadingModel\"=\"Apartment\"\n\n",
                    reg_escape(extension)
                ));
            }
        }
        registration.push_str(
            r"[-HKEY_CURRENT_USER\Software\Classes\*\shell\CompareCraft.edit]
[-HKEY_CURRENT_USER\Software\Classes\*\shell\CompareCraft.sync]

",
        );
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
    imp::status()
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

#[cfg(not(target_os = "linux"))]
#[cfg(not(target_os = "windows"))]
pub fn status() -> ShellStatus {
    ShellStatus {
        supported: false,
        items: ITEMS
            .iter()
            .map(|(id, _, _)| ShellItem {
                id: id.to_string(),
                enabled: false,
            })
            .collect(),
    }
}

#[cfg(not(target_os = "linux"))]
#[cfg(not(target_os = "windows"))]
pub fn set(_items: &[ShellItem]) -> io::Result<()> {
    Err(io::Error::other(
        "File manager integration is not supported on this platform",
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn refresh() -> io::Result<()> {
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
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
            items: Vec::new(),
        };
        assert_eq!(initial_preferences(Some(saved.clone()), no_verbs), saved);

        let existing = ShellStatus {
            supported: true,
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
