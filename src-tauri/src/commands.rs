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

/// Whether a LOCAL device authenticator can actually verify the user right now.
///
/// The lock screen used to assume "platform is Windows" meant Windows Hello was
/// usable, and offered a biometric button that then hard-failed on machines
/// with no Hello configured — common on managed/corporate PCs, which is exactly
/// our market (reported 2026-07-22: "Authentication failed — try again", no way
/// past the lock). This lets the UI fall back to passkey re-auth instead of
/// offering something that cannot work.
///
/// - Windows: UserConsentVerifier::CheckAvailabilityAsync — true only when a
///   Hello PIN/biometric is actually enrolled and available.
/// - macOS: always true — LAPolicyDeviceOwnerAuthentication includes a password
///   fallback, so a local authenticator always exists.
/// Read the persisted "Lock when idle" setting for the LockContext to respect.
#[tauri::command]
pub fn get_autolock(app: AppHandle) -> bool {
    crate::autolock::is_enabled(&app)
}

#[tauri::command]
pub async fn biometric_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::Security::Credentials::UI::{UserConsentVerifierAvailability, UserConsentVerifier};
        match UserConsentVerifier::CheckAvailabilityAsync() {
            Ok(op) => match op.get() {
                Ok(a) => a == UserConsentVerifierAvailability::Available,
                Err(_) => false,
            },
            Err(_) => false,
        }
    }
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
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

    // The windows crate v0.58's IAsyncOperation doesn't implement Future,
    // so .get() (blocking) is used instead of .await. This is acceptable
    // because the call is blocked on user biometric input anyway.
    let result = UserConsentVerifier::RequestVerificationAsync(
        &HSTRING::from("Unlock AspisFile Viewer"),
    )
    .map_err(|e| e.to_string())?
    .get()
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

// Dedicated screen-capture / recording tools. The first field is matched
// against the process EXECUTABLE NAME (see process_matches); the second is the
// display name shown to the sender.
//
// Matching is anchored, NOT a bare substring. A substring match on the 3-char
// needle "kap" false-positived against a background Windows process (Kap is a
// macOS-only recorder — it can't be running on Windows) and paused a legitimate
// Windows view (2026-07-22). process_matches requires the needle to be the
// executable name, optionally followed by a version/space (obs → obs64,
// cleanshot → "cleanshot x"), so a needle buried mid-name no longer matches.
//
// We deliberately DO NOT list always-on conferencing apps (Zoom, Teams,
// Webex, Discord): they launch at login and run in the background all day
// whether or not anyone is sharing, so matching them on mere presence
// would black out the document constantly. Their screen-share is already
// defeated by the window's `contentProtected` flag (the AspisFile window
// shows up black in any shared/recorded stream). Dedicated capture tools,
// by contrast, are only running when someone intends to capture — so
// presence is a high-signal event worth blacking out + alerting on.
const CAPTURE_APPS: &[(&str, &str)] = &[
    ("obs", "OBS"),
    ("snagit", "Snagit"),
    ("sharex", "ShareX"),
    ("loom", "Loom"),
    ("cleanshot", "CleanShot"),
    ("camtasia", "Camtasia"),
    ("screenflow", "ScreenFlow"),
    ("bandicam", "Bandicam"),
    ("fraps", "Fraps"),
    ("kap", "Kap"),
    ("screenstudio", "Screen Studio"),
];

/// Scan running processes for dedicated screen-capture / recording tools.
/// Returns the deduped display names of any detected. The JS viewer polls
/// this during an active session and, on detection, blacks out the tiles
/// and reports a (soft, non-revoking) `screen_share_detected` violation.
///
/// SCOPE IS DELIBERATELY MINIMAL — reads process NAMES and nothing else.
///
/// Enumerating processes is a legitimate need here (we cannot block a
/// recorder we can't see) but it also resembles reconnaissance, and EDR
/// products score on behaviour as well as signature. `refresh_processes()`
/// would additionally pull memory, CPU, disk usage and executable paths, and
/// its siblings can pull command lines, environment variables, cwd and owning
/// user — none of which we use, and command lines/environments in particular
/// are where credential-harvesting malware looks. `ProcessRefreshKind::new()`
/// starts with every field false, so we read the bare minimum to match a name
/// against CAPTURE_APPS.
///
/// This narrows what we touch without weakening detection at all: the match is
/// on the name either way. The caller already restricts WHEN this runs — the
/// poll in SecureViewer is gated on an open document, so nothing scans at
/// launch or while idle.
/// Anchored match of a capture-tool needle against a process name.
///
/// True when the process's executable name (minus a trailing ".exe") IS the
/// needle, or begins with the needle followed by a non-letter — so "obs"
/// matches "obs" and "obs64.exe" (version digit) and "cleanshot" matches
/// "cleanshot x.exe" (space), but a needle sitting mid-name (e.g. "kap" inside
/// a "mpkslkap…" Defender driver) does NOT match. Kills the substring false
/// positive without weakening real detection.
fn process_matches(name_lower: &str, needle: &str) -> bool {
    let stem = name_lower.strip_suffix(".exe").unwrap_or(name_lower);
    if stem == needle {
        return true;
    }
    match stem.strip_prefix(needle) {
        Some(rest) => rest.chars().next().map_or(true, |c| !c.is_ascii_alphabetic()),
        None => false,
    }
}

#[tauri::command]
pub fn detect_capture_processes() -> Vec<String> {
    use sysinfo::{ProcessRefreshKind, System};

    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessRefreshKind::new());

    let mut found = std::collections::BTreeSet::new();
    for process in sys.processes().values() {
        let name = process.name().to_lowercase();
        for (needle, display) in CAPTURE_APPS {
            if process_matches(&name, needle) {
                found.insert((*display).to_string());
            }
        }
    }
    found.into_iter().collect()
}

#[cfg(test)]
mod capture_match_tests {
    use super::process_matches;
    #[test]
    fn matches_real_recorders() {
        assert!(process_matches("obs", "obs"));
        assert!(process_matches("obs64.exe", "obs"));
        assert!(process_matches("sharex.exe", "sharex"));
        assert!(process_matches("cleanshot x.exe", "cleanshot"));
        assert!(process_matches("screenstudio", "screenstudio"));
    }
    #[test]
    fn rejects_substring_false_positives() {
        // the "kap" incident: needle buried in an unrelated process name
        assert!(!process_matches("mpkslkap9a2b.sys", "kap"));
        assert!(!process_matches("backup.exe", "kap")); // 'kap' not even a prefix
        assert!(!process_matches("obsidian.exe", "obs")); // obs + letter → no
        assert!(!process_matches("loompanel.exe", "loom")); // loom + letter → no
    }
}
