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
pub async fn authenticate_biometric(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos_authenticate(app).await;

    #[cfg(target_os = "windows")]
    return windows_authenticate().await;

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Biometric authentication not supported on this platform".to_string())
}

#[cfg(target_os = "macos")]
async fn macos_authenticate(app: AppHandle) -> Result<(), String> {
    use std::sync::mpsc;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let (tx, rx) = mpsc::channel::<bool>();

    app.run_on_main_thread(move || {
        unsafe {
            // Create LAContext
            let context: *mut Object = msg_send![class!(LAContext), new];

            // Reason string
            let reason: *mut Object = msg_send![
                class!(NSString),
                stringWithUTF8String: b"Unlock AspisFile Viewer\0".as_ptr()
            ];

            // LAPolicyDeviceOwnerAuthentication = 2 (Touch ID + password fallback)
            use block::ConcreteBlock;
            let reply = ConcreteBlock::new(move |success: bool, _error: *mut Object| {
                let _ = tx.send(success);
            });
            let reply = reply.copy();

            let _: () = msg_send![context,
                evaluatePolicy: 2_isize
                localizedReason: reason
                reply: &*reply
            ];
        }
    })
    .map_err(|e| e.to_string())?;

    // Wait for the biometric reply on a dedicated blocking thread
    let success = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
        .await
        .map_err(|e| e.to_string())?;

    if success {
        Ok(())
    } else {
        Err("Authentication failed or cancelled".to_string())
    }
}

#[cfg(target_os = "windows")]
async fn windows_authenticate() -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};

    let result = UserConsentVerifier::RequestVerificationAsync(
        &HSTRING::from("Unlock AspisFile Viewer"),
    )
    .map_err(|e| e.to_string())?
    .await
    .map_err(|e| e.to_string())?;

    if result == UserConsentVerificationResult::Verified {
        Ok(())
    } else {
        Err("Authentication failed or cancelled".to_string())
    }
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
