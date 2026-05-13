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
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            security::apply_window_security(&window);
            fileassoc::register_handler(app.handle().clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                updater::check_and_apply(handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::open_external,
            commands::log_security_event,
        ])
        .run(tauri::generate_context!())
        .expect("AspisFile Viewer failed to start");
}
