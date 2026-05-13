use tauri::AppHandle;

#[tauri::command]
pub fn get_platform() -> String {
    #[cfg(target_os = "windows")]
    return "windows".to_string();
    #[cfg(target_os = "macos")]
    return "macos".to_string();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return "unknown".to_string();
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn log_security_event(
    _handle: AppHandle,
    event_type: String,
    session_id: String,
    _payload: serde_json::Value,
) -> Result<(), String> {
    // JS layer handles the actual API call. This command exists as a
    // fallback to ensure events are logged even if JS is degraded.
    println!("[security] {} session={}", event_type, session_id);
    Ok(())
}
