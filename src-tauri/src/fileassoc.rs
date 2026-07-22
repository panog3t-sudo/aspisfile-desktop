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
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

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

/// Parse a v2 (ciphertext-bearing) .afs and STAGE it into the app-data
/// cache, so the JS render flow re-supplies it as the recipient's held copy
/// (matches the JS BaseDirectory.AppData + `afs/<file_id>.afs` location that
/// loadStoredAfs() reads). Returns a v1-shaped link carrying the token so the
/// existing open path (openLink → session → primeAfsRender) can run unchanged.
///
/// v2 layout: "AFS2"(4) ‖ headerLen u32-BE(4) ‖ header JSON ‖ ciphertext.
/// The header exposes only link/handshake fields (token/sig/env/file_id) +
/// metadata — no key material — so reading it here leaks nothing.
fn parse_and_stage_afs_v2(app: &AppHandle, path: &str) -> Option<AfsLink> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() < 8 || &bytes[0..4] != b"AFS2" {
        return None;
    }
    let header_len = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    let header_end = 8usize.checked_add(header_len)?;
    if bytes.len() < header_end {
        return None;
    }
    let header: serde_json::Value = serde_json::from_slice(&bytes[8..header_end]).ok()?;

    let token = header.get("token")?.as_str()?.to_string();
    let file_id = header.get("file_id")?.as_str()?.to_string();
    if token.is_empty() || file_id.is_empty() {
        return None;
    }
    let str_field = |k: &str| header.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());

    // Stage the file into the app-data cache. Best-effort: if it fails the
    // open still proceeds via /afs fetch (transition) or durable S3.
    if let Ok(dir) = app.path().app_data_dir() {
        let afs_dir = dir.join("afs");
        let _ = fs::create_dir_all(&afs_dir);
        let _ = fs::write(afs_dir.join(format!("{}.afs", file_id)), &bytes);
    }

    Some(AfsLink {
        v: 1,
        type_: "aspisfile-link".to_string(),
        token,
        sig: str_field("sig"),
        env: str_field("env"),
        share_url: None,
        file_name: str_field("file_name"),
        sender_name: str_field("sender_name"),
    })
}

/// Read an .afs path, parse it, and emit `open-afs-link` to the React
/// side. Called from drag-and-drop, cold-start argv, and macOS Apple
/// Events. Non-fatal — silently no-ops on parse failure to avoid
/// spamming popups for malformed files.
pub fn try_open_afs(app: &AppHandle, path: &str) {
    // DIAGNOSTIC (v1.9.35): surface each step to the in-app debug overlay so we
    // can see WHERE a Windows .afs double-click stops, instead of guessing.
    let _ = app.emit("afs-debug", format!("try_open_afs path={}", path));
    // Try v2 (binary, ciphertext-bearing) first — it stages the held copy;
    // fall back to the v1 JSON link descriptor.
    let v2 = parse_and_stage_afs_v2(app, path);
    let _ = app.emit("afs-debug", format!("parse_v2={}", if v2.is_some() { "ok" } else { "none" }));
    let link = match v2.or_else(|| parse_afs_path(path)) {
        Some(l) => l,
        None => { let _ = app.emit("afs-debug", "parse FAILED (v2+v1 both none) → no link".to_string()); return; }
    };
    let _ = app.emit("afs-debug", format!("link ok token={}… v={} type={}", &link.token.chars().take(8).collect::<String>(), link.v, link.type_));
    // Buffer first, emit second. Cold-start: React is not yet listening,
    // the emit is lost, drain on mount picks it up via take_pending_afs.
    // Warm-start: React is listening, the emit fires immediately.
    if let Some(state) = app.try_state::<PendingAfs>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(link.clone());
        }
    }
    let _ = app.emit("open-afs-link", &link);
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
    state.0.lock().ok().and_then(|mut g| g.take())
}

pub fn register_handler(app: AppHandle) {
    // macOS: drag-drop on running window handled in lib.rs's RunEvent
    // arm via WindowEvent::DragDrop. Cold-start file-open arrives via
    // RunEvent::Opened, also in lib.rs.
    // Windows/Linux: cold-start file path arrives as argv[1].
    let argv: Vec<String> = std::env::args().collect();
    if let Some(arg) = std::env::args().nth(1) {
        if arg.ends_with(".afs") {
            let app_cold = app.clone();
            let arg2 = arg.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                // DIAGNOSTIC: confirm the argv path reached try_open_afs.
                let _ = app_cold.emit("afs-debug", format!("register_handler argv[1]={} → try_open_afs", arg2));
                try_open_afs(&app_cold, &arg2);
            });
        } else {
            // DIAGNOSTIC: argv[1] present but not a .afs (delayed so JS is listening).
            let app_c = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                let _ = app_c.emit("afs-debug", format!("register_handler argv[1] not .afs: {:?}", argv.get(1)));
            });
        }
    } else {
        let app_c = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let _ = app_c.emit("afs-debug", format!("register_handler NO argv[1] (argv len={})", argv.len()));
        });
    }
}
