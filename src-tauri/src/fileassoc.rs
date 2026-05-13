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

    // Share link opened while app is running (deep link / protocol handler)
    let app_link = app.clone();
    app.listen("tauri://deep-link", move |event| {
        let url = event.payload().to_string();
        let _ = app_link.emit("open-share-link", url);
    });
}
