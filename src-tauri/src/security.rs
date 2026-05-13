use tauri::WebviewWindow;

// Screenshot prevention is handled via contentProtected: true in tauri.conf.json.
// On Windows this sets WDA_EXCLUDEFROMCAPTURE via SetWindowDisplayAffinity.
// On macOS this sets NSWindowSharingNone.
// This function is reserved for any additional runtime security checks.
pub fn apply_window_security(_window: &WebviewWindow) {}
