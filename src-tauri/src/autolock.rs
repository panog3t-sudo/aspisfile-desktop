// Persisted "Lock when idle" setting, toggled from the app menu.
//
// The app presence-lock (cold-start + idle/blur re-lock) is defence-in-depth
// on top of the always-on core protections (watermark, no-copy,
// capture-block, revocation). Users on machines where re-unlocking is
// expensive (no local authenticator → browser+phone QR each time) want to turn
// the recurring lock off. This stores that choice so it survives restarts and
// so the Rust-built menu can show the right checkmark at launch.
//
// Stored as a one-byte file ("1"/"0") in the app config dir. Absent = enabled
// (the secure default).

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("autolock"))
}

pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    match path(app).and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(s) => s.trim() != "0",
        None => true, // default: locked (secure default)
    }
}

pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    if let Some(p) = path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, if enabled { "1" } else { "0" });
    }
}
