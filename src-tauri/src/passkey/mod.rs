// Native WebAuthn bridge for macOS via Apple AuthenticationServices.
// Replaces the Path B browser-redirect flow (the WKWebView WebAuthn
// limitation forced us to open the default browser for Touch ID).
// With this bridge, the Touch ID prompt anchors directly to the
// AspisFile Viewer window — no browser swap.
//
// macOS only. Windows continues to use Path B browser redirect (no
// equivalent native WebAuthn API outside of Edge's WebView2 which we
// don't ship).
//
// Two commands:
//   passkey_register(options_json)     → AttestationResponseJSON
//   passkey_authenticate(options_json) → AssertionResponseJSON
//
// Both take the same WebAuthn options JSON shape that
// @simplewebauthn/server hands back, and return the same response
// shape simplewebauthn/browser would have produced. So the server
// side (register-verify, authenticate-verify) doesn't change.

#[cfg(target_os = "macos")]
mod macos;

// pub use macos::* re-exports the #[tauri::command]-generated helper
// symbols (__cmd__passkey_register etc.) alongside the bare command
// functions. The invoke_handler! macro expects both at the path you
// hand it — passkey::passkey_register has to resolve passkey::__cmd__
// passkey_register too.
#[cfg(target_os = "macos")]
pub use macos::*;

// Non-macOS stubs — Windows + Linux fall back to the existing Path B
// browser flow in the JS layer (lib/passkey.ts decides which path
// to use based on get_platform()).
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn passkey_register(_options_json: String) -> Result<String, String> {
    Err("Native AS bridge is macOS-only — use Path B browser flow on Windows".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn passkey_authenticate(_options_json: String) -> Result<String, String> {
    Err("Native AS bridge is macOS-only — use Path B browser flow on Windows".to_string())
}
