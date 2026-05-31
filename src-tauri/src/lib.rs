mod security;
mod commands;
mod fileassoc;
mod updater;

use tauri::{
    Manager,
    menu::{Menu, MenuBuilder, SubmenuBuilder, PredefinedMenuItem},
};

// Minimal macOS menu bar: App + Window only.
//
// The default Tauri/macOS menu includes File / Edit / View / Help with
// Cut / Copy / Paste / Select-All / Find. None of those make sense in a
// tile-based secure viewer — there is no text selection (the document is
// rasterised JPEGs), no editable surface, and offering Copy implies a
// capability we explicitly don't provide. App + Window are required by
// the macOS Human Interface Guidelines (About, Quit, Hide, Minimize,
// Zoom); everything else is stripped.
fn build_minimal_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_submenu = SubmenuBuilder::new(app, "AspisFile Viewer")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let window_submenu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_submenu, &window_submenu])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(fileassoc::PendingAfs(std::sync::Mutex::new(None)))
        .setup(|app| {
            // Reset the diag log at the start of every launch so users
            // see only the current session's events. v1.7.17 only.
            fileassoc::diag_reset();
            fileassoc::diag(&format!("setup() running, app version {}", env!("CARGO_PKG_VERSION")));
            let window = app.get_webview_window("main").unwrap();

            security::apply_window_security(&window);
            fileassoc::register_handler(app.handle().clone());

            // Replace the default macOS menu with the minimal App + Window
            // structure. Strips Edit (Copy/Paste/Select All), File, View
            // (Find), and Help — none of which apply to a rasterised
            // secure document viewer.
            if let Ok(menu) = build_minimal_menu(app.handle()) {
                let _ = app.set_menu(menu);
            }
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
            fileassoc::read_afs,
            fileassoc::take_pending_afs,
            fileassoc::read_diag_log,
        ])
        .build(tauri::generate_context!())
        .expect("AspisFile Viewer failed to start")
        .run(|_app, _event| {
            // macOS routes .afs double-clicks through Apple Events
            // (NSApplicationDelegate openURLs) which Tauri 2 surfaces as
            // RunEvent::Opened. Same convergence point as the cold-start
            // argv path on Windows/Linux — handed to fileassoc::try_open_afs.
            // The Opened variant is macOS/mobile-only — cfg-guard so this
            // still compiles for Windows/Linux targets.
            // Log every RunEvent variant on macOS so we can see if the
            // .afs cold-start arrives via Opened (expected), Reopen,
            // WebviewEvent, or something else entirely. Reopen is
            // macOS-only so this whole match needs the cfg-guard.
            #[cfg(target_os = "macos")]
            match &_event {
                tauri::RunEvent::Ready                  => fileassoc::diag("RunEvent::Ready"),
                tauri::RunEvent::Exit                   => fileassoc::diag("RunEvent::Exit"),
                tauri::RunEvent::ExitRequested { .. }   => fileassoc::diag("RunEvent::ExitRequested"),
                tauri::RunEvent::Resumed                => fileassoc::diag("RunEvent::Resumed"),
                tauri::RunEvent::MainEventsCleared      => { /* fires constantly, skip */ }
                tauri::RunEvent::Reopen { has_visible_windows, .. } =>
                    fileassoc::diag(&format!("RunEvent::Reopen has_visible={}", has_visible_windows)),
                tauri::RunEvent::WindowEvent { label, event, .. } => {
                    // Tauri 2 drag-drop arrives through the typed
                    // WindowEvent enum. Old Tauri 1 listener on
                    // `tauri://file-drop` silently no-oped — diagnosed
                    // via v1.7.17 HUD: drag-drop produced WindowEvent
                    // lines but no file-drop event.
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        fileassoc::diag(&format!("WindowEvent::DragDrop::Drop on {} with {} path(s)", label, paths.len()));
                        for path in paths {
                            let path_str = path.to_string_lossy().to_string();
                            if path_str.ends_with(".afs") {
                                fileassoc::try_open_afs(_app, &path_str);
                            }
                        }
                    } else {
                        fileassoc::diag(&format!("RunEvent::WindowEvent label={}", label));
                    }
                }
                tauri::RunEvent::WebviewEvent { label, .. } =>
                    fileassoc::diag(&format!("RunEvent::WebviewEvent label={}", label)),
                _ => fileassoc::diag("RunEvent::<other>"),
            }
            #[cfg(any(target_os = "macos", mobile))]
            if let tauri::RunEvent::Opened { urls } = _event {
                fileassoc::diag(&format!("RunEvent::Opened fired with {} url(s)", urls.len()));
                for url in urls {
                    fileassoc::diag(&format!("Opened url={}", url));
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().to_string();
                        if path_str.ends_with(".afs") {
                            fileassoc::try_open_afs(_app, &path_str);
                        } else {
                            fileassoc::diag("non-.afs url ignored");
                        }
                    } else {
                        fileassoc::diag(&format!("url has no file path: {}", url));
                    }
                }
            }
        });
}
