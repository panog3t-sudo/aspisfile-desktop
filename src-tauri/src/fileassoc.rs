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
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

// Diagnostic file logger. eprintln! is swallowed by signed/notarised
// macOS bundles (stderr → /dev/null). Writes to /tmp/aspisfile-diag.log
// so React can fetch via read_diag_log() for the HUD overlay.
pub fn diag(msg: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let ms   = now.subsec_millis();
    let line = format!("{:02}:{:02}:{:02}.{:03} [rust] {}\n",
        (secs / 3600) % 24, (secs / 60) % 60, secs % 60, ms, msg);
    let _ = fs::OpenOptions::new()
        .create(true).append(true)
        .open("/tmp/aspisfile-diag.log")
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

pub fn diag_reset() {
    let _ = fs::write("/tmp/aspisfile-diag.log", "");
}

#[tauri::command]
pub fn read_diag_log() -> String {
    fs::read_to_string("/tmp/aspisfile-diag.log").unwrap_or_default()
}

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

// Managed state buffer for the cold-start race. macOS Apple Events
// (RunEvent::Opened) fire within the first few hundred ms of launch —
// often before React mounts and registers listen("open-afs-link", ...).
// Tauri events have no replay, so the emit is lost. We stash the parsed
// link here; React drains via take_pending_afs() on mount.
pub struct PendingAfs(pub Mutex<Option<AfsLink>>);

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
    diag(&format!("try_open_afs called: path={}", path));
    match parse_afs_path(path) {
        Some(link) => {
            diag(&format!("parsed ok: token={} sig={} env={}", link.token, link.sig.is_some(), link.env.is_some()));
            if let Some(state) = app.try_state::<PendingAfs>() {
                match state.0.lock() {
                    Ok(mut guard) => {
                        *guard = Some(link.clone());
                        diag("buffered link in PendingAfs state");
                    }
                    Err(e) => diag(&format!("FAILED to lock PendingAfs: {:?}", e)),
                }
            } else {
                diag("WARNING: PendingAfs state NOT managed — buffer skipped");
            }
            match app.emit("open-afs-link", &link) {
                Ok(_)  => diag("emitted open-afs-link"),
                Err(e) => diag(&format!("emit FAILED: {:?}", e)),
            }
        }
        None => {
            diag(&format!("failed to parse .afs at {}", path));
        }
    }
}

#[tauri::command]
pub fn read_afs(path: String) -> Result<AfsLink, String> {
    parse_afs_path(&path).ok_or_else(|| "Invalid .afs file".to_string())
}

/// Drain the cold-start buffer. React invokes this once on mount; the
/// returned link (if any) is routed through openLink() the same as a
/// runtime event. Always returns None after the first call.
#[tauri::command]
pub fn take_pending_afs(state: tauri::State<PendingAfs>) -> Option<AfsLink> {
    let result = state.0.lock().ok().and_then(|mut g| g.take());
    diag(&format!("take_pending_afs called → returning: {}", if result.is_some() { "Some(link)" } else { "None" }));
    result
}

pub fn register_handler(app: AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    diag(&format!("register_handler: argv={:?}", args));

    // Drag-and-drop onto a running window is handled in lib.rs via
    // RunEvent::WindowEvent { event: WindowEvent::DragDrop(...) }.
    // Tauri 2 renamed the Tauri 1 `tauri://file-drop` event to
    // `tauri://drag-drop` and exposes it via the typed WindowEvent
    // enum — listening to the old name silently no-oped.

    // Cold-start argv path — Windows / Linux deliver .afs paths via
    // argv; macOS uses Apple Events (RunEvent::Opened) handled in
    // lib.rs's run callback.
    if let Some(arg) = std::env::args().nth(1) {
        if arg.ends_with(".afs") {
            diag(&format!("argv .afs detected: {}", arg));
            let app_cold = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                try_open_afs(&app_cold, &arg);
            });
        }
    }
}
