use tauri::{AppHandle, Emitter, Listener};

pub fn register_handler(app: AppHandle) {
    // .afs file double-clicked or dragged onto app icon
    let app_file = app.clone();
    app.listen("tauri://file-drop", move |event| {
        if let Ok(paths) = serde_json::from_str::<Vec<String>>(event.payload()) {
            for path in paths {
                if path.ends_with(".afs") {
                    let _ = app_file.emit("open-afs-file", &path);
                }
            }
        }
    });
    // aspisfile:// URL scheme is handled by deeplink::register_handler — it
    // routes through tauri-plugin-deep-link, which the framework's built-in
    // `tauri://deep-link` event does not emit on its own.
}
