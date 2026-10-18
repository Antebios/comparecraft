//! File manager context-menu integration (Linux: Nautilus scripts and a Dolphin service menu).

use serde::{Deserialize, Serialize};
use std::io;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellItem {
    /// "compare" | "sync" | "merge" | "edit"
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
    ("compare", "Compare", &[]),
    ("sync", "Sync", &["-fv=Folder Sync"]),
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

    fn scripts_dir(data: &Path) -> PathBuf {
        data.join("nautilus/scripts/CompareCraft")
    }

    fn service_menu(data: &Path) -> PathBuf {
        data.join("kio/servicemenus/comparecraft.desktop")
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

    pub fn status() -> ShellStatus {
        let dir = data_dir().map(|d| scripts_dir(&d)).ok();
        let items = ITEMS
            .iter()
            .map(|(id, label, _)| ShellItem { id: id.to_string(), enabled: dir.as_ref().is_some_and(|d| d.join(label).is_file()) })
            .collect();
        ShellStatus { supported: true, items }
    }

    pub fn set(items: &[ShellItem]) -> io::Result<()> {
        let data = data_dir()?;
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
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
            write_exec(&script, &format!("#!/bin/sh\nexec {}{sh_args} \"$@\"\n", sh_quote(&exe)))?;
            let exec_args: String = args.iter().map(|a| format!(" {}", exec_quote(a))).collect();
            actions.push(*id);
            desktop_actions.push_str(&format!("\n[Desktop Action {id}]\nName={label}\nExec={}{exec_args} %F\n", exec_quote(&exe)));
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
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn installs_and_removes_menu_items() {
            let d = tempfile::tempdir().unwrap();
            std::env::set_var("COMPARECRAFT_DATA_DIR", d.path());
            let item = |id: &str, enabled: bool| ShellItem { id: id.into(), enabled };
            set(&[item("compare", true), item("sync", true), item("merge", false)]).unwrap();
            let st = status();
            assert!(st.supported);
            let on: Vec<&str> = st.items.iter().filter(|i| i.enabled).map(|i| i.id.as_str()).collect();
            assert_eq!(on, vec!["compare", "sync"]);
            let sync = fs::read_to_string(d.path().join("nautilus/scripts/CompareCraft/Sync")).unwrap();
            assert!(sync.starts_with("#!/bin/sh\nexec '") && sync.ends_with(" '-fv=Folder Sync' \"$@\"\n"), "{sync}");
            let mode = fs::metadata(d.path().join("nautilus/scripts/CompareCraft/Sync")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
            let menu = fs::read_to_string(d.path().join("kio/servicemenus/comparecraft.desktop")).unwrap();
            assert!(menu.contains("Actions=compare;sync;") && menu.contains("[Desktop Action sync]\nName=Sync\n"), "{menu}");
            assert!(menu.contains("\"-fv=Folder Sync\" %F"), "{menu}");
            set(&[]).unwrap();
            assert!(status().items.iter().all(|i| !i.enabled));
            assert!(!d.path().join("nautilus/scripts/CompareCraft").exists());
            assert!(!d.path().join("kio/servicemenus/comparecraft.desktop").exists());
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

#[cfg(not(target_os = "linux"))]
pub fn status() -> ShellStatus {
    ShellStatus { supported: false, items: ITEMS.iter().map(|(id, _, _)| ShellItem { id: id.to_string(), enabled: false }).collect() }
}

#[cfg(not(target_os = "linux"))]
pub fn set(_items: &[ShellItem]) -> io::Result<()> {
    Err(io::Error::other("File manager integration is not supported on this platform"))
}
