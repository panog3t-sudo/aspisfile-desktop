// Phase A close-out — .afs file double-click handler.
//
// An .afs file is a v1 JSON link container produced by the dashboard's
// "Download .afs file" action. It carries the same params as the share
// URL (token + sig + env) plus a fallback share_url for web. The native
// viewer reads the file content, validates the v/type header, and emits
// `open-afs-link` to the React side so App.tsx can call openLink() with
// the parsed params via the existing deep-link pathway.
//
// Three entry points need to be handled:
//   1. Drag-and-drop onto a running window  — tauri://file-drop event
//   2. Cold-start command-line argument     — std::env::args (Windows/Linux)
//   3. macOS Apple Events                   — RunEvent::Opened in lib.rs
//
// All three converge on try_open_afs() which reads + parses + emits.

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Emitter, Listener};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct AfsLink {
    pub v: u8,
    #[serde(rename = "type")]
    pub type_: String,
    pub token: String,
    #[serde(default)]
    pub sig: Option<String>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub share_url: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub sender_name: Option<String>,
}

fn parse_afs_path(path: &str) -> Option<AfsLink> {
    let contents = fs::read_to_string(path).ok()?;
    let link: AfsLink = serde_json::from_str(&contents).ok()?;
    if link.v != 1 || link.type_ != "aspisfile-link" {
        return None;
    }
    if link.token.is_empty() {
        return None;
    }
    Some(link)
}

/// Read an .afs path, parse it, and emit `open-afs-link` to the React
/// side. Called from drag-and-drop, cold-start argv, and macOS Apple
/// Events. Non-fatal — silently no-ops on parse failure to avoid
/// spamming popups for malformed files.
pub fn try_open_afs(app: &AppHandle, path: &str) {
    match parse_afs_path(path) {
        Some(link) => {
            let _ = app.emit("open-afs-link", &link);
        }
        None => {
            eprintln!("[afs] failed to parse .afs at {}", path);
        }
    }
}

#[tauri::command]
pub fn read_afs(path: String) -> Result<AfsLink, String> {
    parse_afs_path(&path).ok_or_else(|| "Invalid .afs file".to_string())
}

pub fn register_handler(app: AppHandle) {
    // 1. Drag-and-drop onto a running app window.
    let app_drop = app.clone();
    app.listen("tauri://file-drop", move |event| {
        if let Ok(paths) = serde_json::from_str::<Vec<String>>(event.payload()) {
            for path in paths {
                if path.ends_with(".afs") {
                    try_open_afs(&app_drop, &path);
                }
            }
        }
    });

    // 2. Cold-start argv on Windows/Linux. macOS routes file-open through
    //    Apple Events instead (handled in lib.rs's RunEvent::Opened arm).
    //    Defer a short moment so the React side has time to register the
    //    `open-afs-link` listener before we emit.
    if let Some(arg) = std::env::args().nth(1) {
        if arg.ends_with(".afs") {
            let app_cold = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                try_open_afs(&app_cold, &arg);
            });
        }
    }
}
