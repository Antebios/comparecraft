//! Application settings persisted as JSON in the user config directory, plus settings export/import.

use crate::sessions::{self, Session};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const EXPORT_FORMAT: &str = "comparecraft-settings";

fn settings_path() -> PathBuf {
    sessions::config_dir().join("settings.json")
}

/// The stored settings object; `{}` when missing or invalid.
pub fn load() -> Value {
    fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save(settings: &Value) -> io::Result<()> {
    sessions::write_json_atomic(&settings_path(), settings)
}

pub fn reset() -> io::Result<()> {
    match fs::remove_file(settings_path()) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    #[serde(default)]
    format: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    exported: i64,
    #[serde(default)]
    settings: Option<Value>,
    #[serde(default)]
    sessions: Vec<Session>,
}

/// Contents of an exported settings file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportData {
    pub settings: Option<Value>,
    pub sessions: Vec<Session>,
}

/// Exports `settings` and the stored sessions whose ids are listed in `session_ids`.
pub fn export(path: &Path, settings: Option<Value>, session_ids: Option<&[String]>) -> io::Result<()> {
    let sessions = match session_ids {
        Some(ids) => sessions::list().into_iter().filter(|s| ids.contains(&s.id)).collect(),
        None => vec![],
    };
    let exported = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let file = ExportFile { format: EXPORT_FORMAT.into(), version: 1, exported, settings, sessions };
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir)?;
        }
    }
    fs::write(path, serde_json::to_vec_pretty(&file)?)
}

pub fn read_file(path: &Path) -> Result<ImportData, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let file: ExportFile = serde_json::from_slice(&bytes).map_err(|_| "Not a CompareCraft settings file".to_string())?;
    if file.format != EXPORT_FORMAT {
        return Err("Not a CompareCraft settings file".into());
    }
    Ok(ImportData { settings: file.settings, sessions: file.sessions })
}

/// Adds sessions, optionally replacing all existing ones.
pub fn import_sessions(list: Vec<Session>, replace: bool) -> io::Result<()> {
    if replace {
        sessions::clear()?;
    }
    for s in list {
        sessions::upsert(s)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests touching the config directory share one environment variable, so they run in one test.
    #[test]
    fn settings_round_trip_and_export() {
        let d = tempfile::tempdir().unwrap();
        std::env::set_var("COMPARECRAFT_CONFIG_DIR", d.path());
        assert_eq!(load(), serde_json::json!({}));
        save(&serde_json::json!({"theme": "dark"})).unwrap();
        assert_eq!(load()["theme"], "dark");
        let mk = |id: &str| Session { id: id.into(), name: id.into(), kind: "text".into(), paths: vec![id.into()], options: Value::Null, modified: 1, saved: true, locked: false };
        import_sessions(vec![mk("a"), mk("b")], false).unwrap();
        let out = d.path().join("export.json");
        export(&out, Some(load()), Some(&["b".to_string()])).unwrap();
        let data = read_file(&out).unwrap();
        assert_eq!(data.settings.unwrap()["theme"], "dark");
        assert_eq!(data.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        import_sessions(data.sessions, true).unwrap();
        assert_eq!(sessions::list().len(), 1);
        reset().unwrap();
        reset().unwrap();
        assert_eq!(load(), serde_json::json!({}));
        fs::write(d.path().join("bad.json"), "{\"format\":\"other\"}").unwrap();
        assert_eq!(read_file(&d.path().join("bad.json")).unwrap_err(), "Not a CompareCraft settings file");
    }
}
