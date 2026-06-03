// Native WebAuthn bridge for macOS — IMPLEMENTATION IN PROGRESS.
//
// Phase 1 (this commit): JSON shapes + tauri::command stubs that
// compile cleanly. Both commands currently return a not-implemented
// error so the JS layer can detect and fall back to Path B.
//
// Phases 2-4 (next sessions): ObjC bridge via objc2 — delegate class
// declare_class!, NSWindow presentation anchor, performRequests on
// main thread, result marshalling.
//
// Path B browser-redirect remains the active flow until this bridge
// is complete and tested on-device. JS layer (lib/passkey.ts) tries
// invoke('passkey_register') first; falls back to openUrl(/enroll/
// desktop) on any error including this stub's "not_implemented".

use serde::{Deserialize, Serialize};

// ─── JSON shapes (server-facing) ────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RegistrationOptions {
    challenge: String,
    rp: RegistrationOptionsRp,
    user: RegistrationOptionsUser,
    #[serde(rename = "pubKeyCredParams")]
    pub_key_cred_params: Vec<serde_json::Value>,
    #[serde(rename = "excludeCredentials", default)]
    exclude_credentials: Vec<CredDescriptor>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default)]
    attestation: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RegistrationOptionsRp {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct RegistrationOptionsUser {
    id: String,
    name: String,
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct CredDescriptor {
    id: String,
    #[serde(default)]
    transports: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct AssertionOptions {
    challenge: String,
    #[serde(rename = "rpId")]
    rp_id: String,
    #[serde(rename = "allowCredentials", default)]
    allow_credentials: Vec<CredDescriptor>,
    #[serde(default)]
    timeout: Option<u64>,
    #[serde(default, rename = "userVerification")]
    user_verification: Option<String>,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct RegistrationResponse {
    id: String,
    #[serde(rename = "rawId")]
    raw_id: String,
    response: RegistrationResponseInner,
    #[serde(rename = "type")]
    cred_type: String,
    #[serde(rename = "clientExtensionResults")]
    client_extension_results: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct RegistrationResponseInner {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    #[serde(rename = "attestationObject")]
    attestation_object: String,
    transports: Vec<String>,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct AssertionResponse {
    id: String,
    #[serde(rename = "rawId")]
    raw_id: String,
    response: AssertionResponseInner,
    #[serde(rename = "type")]
    cred_type: String,
    #[serde(rename = "clientExtensionResults")]
    client_extension_results: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct AssertionResponseInner {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    #[serde(rename = "authenticatorData")]
    authenticator_data: String,
    signature: String,
    #[serde(rename = "userHandle")]
    user_handle: Option<String>,
}

// ─── Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn passkey_register(options_json: String) -> Result<String, String> {
    let _: RegistrationOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid registration options JSON: {}", e))?;
    Err("not_implemented".to_string())
}

#[tauri::command]
pub async fn passkey_authenticate(options_json: String) -> Result<String, String> {
    let _: AssertionOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid assertion options JSON: {}", e))?;
    Err("not_implemented".to_string())
}
