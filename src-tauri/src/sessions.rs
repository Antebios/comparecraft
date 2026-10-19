//! Saved and recent sessions, persisted as JSON in the user config directory.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    /// "text" | "folder" | "merge" | "hex" | "table" | "picture"
    pub kind: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub options: serde_json::Value,
    pub modified: i64,
    /// Named sessions are kept; auto-saved ones are pruned.
    #[serde(default)]
    pub saved: bool,
    /// Locked sessions are not overwritten by Save Session.
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    sessions: Vec<Session>,
}

const MAX_AUTO: usize = 50;

pub fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("COMPARECRAFT_CONFIG_DIR") {
        return PathBuf::from(p);
    }
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("comparecraft")
}

fn store_path() -> PathBuf {
    config_dir().join("sessions.json")
}

fn load() -> Store {
    fs::read(store_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Store { version: 1, sessions: vec![] })
}

/// Writes a JSON file via a temporary file and rename, keeping the previous version as `.json.bak`.
pub fn write_json_atomic<T: Serialize>(p: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    if p.exists() {
        let _ = fs::copy(p, p.with_extension("json.bak"));
    }
    fs::rename(tmp, p)
}

fn store(s: &Store) -> io::Result<()> {
    write_json_atomic(&store_path(), s)
}

pub fn list() -> Vec<Session> {
    let mut s = load().sessions;
    s.sort_by(|a, b| b.modified.cmp(&a.modified));
    s
}

pub fn upsert(session: Session) -> io::Result<()> {
    let mut st = load();
    st.version = 1;
    // Auto-saved sessions with identical specs are refreshed instead of duplicated.
    st.sessions.retain(|x| {
        x.id != session.id && !(!session.saved && !x.saved && x.kind == session.kind && x.paths == session.paths)
    });
    st.sessions.push(session);
    st.sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    let mut auto = 0;
    st.sessions.retain(|x| {
        if x.saved {
            return true;
        }
        auto += 1;
        auto <= MAX_AUTO
    });
    store(&st)
}

pub fn remove(id: &str) -> io::Result<()> {
    let mut st = load();
    st.sessions.retain(|x| x.id != id);
    store(&st)
}

pub fn find_by_name(name: &str) -> Option<Session> {
    load().sessions.into_iter().find(|s| s.saved && s.name.eq_ignore_ascii_case(name))
}

/// Deletes all sessions.
pub fn clear() -> io::Result<()> {
    store(&Store { version: 1, sessions: vec![] })
}
