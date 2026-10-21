use std::path::PathBuf;

fn main() {
    let actions: Vec<_> = comparecraft_menu::ACTIONS.iter().map(|action| serde_json::json!({
        "id": action.id, "enabled": true,
    })).collect();
    let destination = PathBuf::from(std::env::args_os().nth(1).expect("fixture output path required"));
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("shell-integration.json"), serde_json::to_vec(&actions).unwrap()).unwrap();
    let snapshot = comparecraft_menu::finder_snapshot(root.path(), PathBuf::from("/Applications/CompareCraft.app/Contents/MacOS/comparecraft"));
    std::fs::write(destination, serde_json::to_vec_pretty(&snapshot).unwrap()).unwrap();
}