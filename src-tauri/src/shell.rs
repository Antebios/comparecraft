//! Per-user file-manager context-menu integration.

use serde::{Deserialize, Serialize};
use std::io;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    /// "compare" | "selectLeft" | "compareStaged" | "sync" | "merge" | "edit"
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellStatus {
    pub supported: bool,
    pub items: Vec<ShellItem>,
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
    ("sync", "Sync", &["-sync"]),
    ("merge", "Merge", &["-fv=Text Merge"]),
    ("edit", "Edit", &["-fv=Text Edit"]),
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

    fn service_menu(data: &Path) -> PathBuf {
        data.join("kio/servicemenus/comparecraft.desktop")
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
            let file_arg = if *id == "selectLeft" || *id == "compareStaged" || *id == "edit" {
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
                let dolphin = data.as_ref().is_some_and(|d| {
                    fs::read_to_string(service_menu(d))
                        .ok()
                        .is_some_and(|content| content.contains(&format!("[Desktop Action {id}]")))
                });
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
        let mut actions = vec![];
        let mut desktop_actions = String::new();
        for (id, label, args) in ITEMS {
            let script = scripts.join(label);
            if !enabled(id) {
                remove_if_exists(&script)?;
                continue;
            }
            let sh_args: String = args.iter().map(|a| format!(" {}", sh_quote(a))).collect();
            write_exec(
                &script,
                &format!("#!/bin/sh\nexec {}{sh_args} \"$@\"\n", sh_quote(&exe)),
            )?;
            let exec_args: String = args.iter().map(|a| format!(" {}", exec_quote(a))).collect();
            actions.push(*id);
            let selection = if *id == "selectLeft" || *id == "compareStaged" || *id == "edit" {
                "%f"
            } else {
                "%F"
            };
            desktop_actions.push_str(&format!(
                "\n[Desktop Action {id}]\nName={label}\nExec={}{exec_args} {selection}\n",
                exec_quote(&exe)
            ));
        }
        if scripts.is_dir() && fs::read_dir(&scripts)?.next().is_none() {
            fs::remove_dir(&scripts)?;
        }
        let menu = service_menu(&data);
        if actions.is_empty() {
            remove_if_exists(&menu)?;
        } else {
            let content = format!(
                "[Desktop Entry]\nType=Service\nMimeType=all/all;\nX-KDE-ServiceTypes=KonqPopupMenu/Plugin\nActions={};\nX-KDE-Submenu=CompareCraft\n{desktop_actions}",
                actions.join(";")
            );
            write_exec(&menu, &content)?;
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
            std::env::set_var("COMPARECRAFT_DATA_DIR", d.path());
            std::env::set_var("COMPARECRAFT_CONFIG_DIR", d.path());
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
                sync.starts_with("#!/bin/sh\nexec '") && sync.ends_with(" '-sync' \"$@\"\n"),
                "{sync}"
            );
            let mode = fs::metadata(d.path().join("nautilus/scripts/CompareCraft/Sync"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
            let menu =
                fs::read_to_string(d.path().join("kio/servicemenus/comparecraft.desktop")).unwrap();
            assert!(
                menu.contains("Actions=compare;sync;")
                    && menu.contains("[Desktop Action sync]\nName=Sync\n"),
                "{menu}"
            );
            assert!(
                menu.contains("\"-cc-compare\" %F") && menu.contains("\"-cc-compare-staged\" %f"),
                "{menu}"
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
                .join("kio/servicemenus/comparecraft.desktop")
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
        }
    }
}

#[cfg(target_os = "linux")]
pub fn status() -> ShellStatus {
    imp::status()
}

#[cfg(target_os = "linux")]
pub fn set(items: &[ShellItem]) -> io::Result<()> {
    imp::set(items)
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Output};
    use std::{collections::HashSet, fs};

    const ROOT: &str = r"HKCU\Software\Classes\*\shell";
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    fn key(id: &str) -> String {
        format!(r"{ROOT}\CompareCraft.{id}")
    }

    fn run(args: &[&str]) -> io::Result<Output> {
        Command::new("reg.exe")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    }

    fn installed() -> HashSet<String> {
        let Ok(output) = run(&["query", ROOT]) else {
            return HashSet::new();
        };
        if !output.status.success() {
            return HashSet::new();
        }
        let suffixes: Vec<String> = ITEMS
            .iter()
            .map(|(id, _, _)| format!(r"\CompareCraft.{id}").to_ascii_lowercase())
            .collect();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let key = line.trim().to_ascii_lowercase();
                suffixes
                    .iter()
                    .position(|suffix| key.ends_with(suffix))
                    .map(|index| ITEMS[index].0.to_string())
            })
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
        let mut registration = String::from("Windows Registry Editor Version 5.00\n\n");
        for (id, label, args) in ITEMS {
            let root = key(id);
            let selected = items.iter().any(|item| item.id == *id && item.enabled);
            if !selected {
                registration.push_str(&format!("[-{root}]\n\n"));
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
            let command = format!(
                "\"{exe}\" {flags} {}",
                if matches!(*id, "compare" | "sync" | "merge") {
                    "%*"
                } else {
                    "\"%1\""
                }
            );
            registration.push_str(&format!(
                "[{root}]\n\"MUIVerb\"=\"{}\"\n",
                reg_escape(label)
            ));
            if matches!(*id, "compare" | "sync" | "merge") {
                registration.push_str("\"MultiSelectModel\"=\"Document\"\n");
            }
            registration.push_str(&format!(
                "\n[{root}\\command]\n@=\"{}\"\n\n",
                reg_escape(&command)
            ));
        }
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
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub fn status() -> ShellStatus {
    imp::status()
}

#[cfg(target_os = "windows")]
pub fn set(items: &[ShellItem]) -> io::Result<()> {
    imp::set(items)
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
