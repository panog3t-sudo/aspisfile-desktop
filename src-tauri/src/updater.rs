use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub async fn check_and_apply(app: AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            println!("[updater] not configured: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            println!("[updater] update available: {}", update.version);
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(_)  => println!("[updater] installed — applies on next launch"),
                Err(e) => println!("[updater] install failed: {}", e),
            }
        }
        Ok(None)   => println!("[updater] up to date"),
        Err(e)     => println!("[updater] check failed: {}", e),
    }
}
