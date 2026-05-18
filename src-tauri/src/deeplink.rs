use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

// Bridges aspisfile:// URL scheme delivery from the OS into a Tauri event
// (`open-share-link`) the frontend already listens for. Both the cold-start
// case (URL that launched the app) and the warm case (URL delivered while
// the app is running) are forwarded so App.tsx has a single code path.
pub fn register_handler(app: AppHandle) {
    let app_runtime = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            let _ = app_runtime.emit("open-share-link", url.to_string());
        }
    });

    // Cold-start URLs — present when macOS/Windows launched the app via
    // `open aspisfile://...`. on_open_url above does not always replay these,
    // so check explicitly and emit once.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            let _ = app.emit("open-share-link", url.to_string());
        }
    }
}
