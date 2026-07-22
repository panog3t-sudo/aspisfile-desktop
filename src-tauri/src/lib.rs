mod security;
mod commands;
mod fileassoc;
mod updater;
mod passkey;

use tauri::{
    Manager,
    menu::{Menu, MenuBuilder, SubmenuBuilder, PredefinedMenuItem, AboutMetadata},
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
    // Explicit AboutMetadata — required on Windows. With `None`, the
    // predefined About item auto-populates from the bundle on macOS but shows
    // nothing on Windows (clicking About did nothing — reported 2026-07-22).
    // Passing name + version makes the dialog appear on both platforms.
    let about = AboutMetadata {
        name:    Some("AspisFile Viewer".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    };
    let app_submenu = SubmenuBuilder::new(app, "AspisFile Viewer")
        .item(&PredefinedMenuItem::about(app, Some("About AspisFile Viewer"), Some(about))?)
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
            let window = app.get_webview_window("main").unwrap();

            security::apply_window_security(&window);
            fileassoc::register_handler(app.handle().clone());

            // Windows portable build: claim `aspisfile://` at runtime.
            //
            // The installers register the scheme for us, but the portable
            // AspisFile.exe has no installer — and without the scheme the
            // browser → viewer handoff (/access → aspisfile://…) dead-ends,
            // which is the whole flow. register_all() writes to
            // CURRENT_USER\Software\Classes, so it needs NO admin rights;
            // the plugin documents it for exactly this "user did not install
            // the app properly" case.
            //
            // Idempotent, so running it on installed builds too is harmless —
            // it just re-points the scheme at the running exe, which is the
            // behaviour you want when someone runs a portable copy anyway.
            // Windows-only: register() returns UnsupportedPlatform on macOS,
            // where LaunchServices reads the scheme from Info.plist instead.
            #[cfg(windows)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    // Non-fatal: an installed build already has the scheme, and
                    // a portable one degrades to .afs double-click.
                    eprintln!("[deep-link] scheme registration failed: {e}");
                }
            }

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
            commands::detect_capture_processes,
            fileassoc::read_afs,
            fileassoc::take_pending_afs,
            passkey::passkey_register,
            passkey::passkey_authenticate,
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
            // Drag-and-drop of .afs files onto a running window. Tauri 2
            // exposes drag-drop through the typed WindowEvent enum (the
            // Tauri 1 `tauri://file-drop` event no longer exists).
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::WindowEvent { event, .. } = &_event {
                if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                    for path in paths {
                        let path_str = path.to_string_lossy().to_string();
                        if path_str.ends_with(".afs") {
                            fileassoc::try_open_afs(_app, &path_str);
                        }
                    }
                }
            }
            // Cold-start .afs double-click. macOS routes file opens via
            // NSApplicationDelegate openURLs: which Tauri surfaces as
            // RunEvent::Opened. Requires UTExportedTypeDeclarations in
            // Info.plist for macOS to fire openURLs at all — that patch
            // lives in .github/workflows/release.yml.
            #[cfg(any(target_os = "macos", mobile))]
            if let tauri::RunEvent::Opened { urls } = _event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let path_str = path.to_string_lossy().to_string();
                        if path_str.ends_with(".afs") {
                            fileassoc::try_open_afs(_app, &path_str);
                        }
                    }
                }
            }
        });
}
