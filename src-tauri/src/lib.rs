mod security;
mod commands;
mod fileassoc;
mod updater;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            security::apply_window_security(&window);
            fileassoc::register_handler(app.handle().clone());
            // Deep-link delivery now handled directly in the frontend via
            // @tauri-apps/plugin-deep-link's getCurrent() + onOpenUrl() —
            // see src/App.tsx. This avoids the cold-start race where the
            // Rust-side emit fires before React has registered a listener.

            // Skip the auto-updater in dev builds — the /api/releases endpoint
            // doesn't exist yet, and the failed check pollutes dev logs with
            // "error decoding response body". Production builds still check.
            if !cfg!(debug_assertions) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    updater::check_and_apply(handle).await;
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::open_external,
            commands::log_security_event,
            commands::authenticate_biometric,
        ])
        .run(tauri::generate_context!())
        .expect("AspisFile Viewer failed to start");
}
