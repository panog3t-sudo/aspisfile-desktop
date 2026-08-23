//! Native Windows WebAuthn bridge via the Win32 WebAuthn API (webauthn.dll).
//!
//! Mirrors the macOS AS bridge's contract (passkey/macos.rs) so the JS layer
//! (lib/passkey.ts) is unchanged: same two commands, same options-JSON in, same
//! RegistrationResponseJSON / AssertionResponseJSON out.
//!
//!   passkey_register(options_json)     → RegistrationResponseJSON
//!   passkey_authenticate(options_json) → AssertionResponseJSON
//!
//! The ceremony (params, structs, origin round-trip) is a faithful port of the
//! de-risking spike PROVEN end-to-end on real HP Win11 hardware
//! (spikes/win-webauthn-spike/ — register-verify AND authenticate-verify both
//! returned 200 {success:true} for a native-built origin=https://aspisfile.com,
//! via the native Windows dialog offering Hello + phone-QR + security key, NO
//! Edge, NO Microsoft Password Manager, even on a Hello-less box).
//!
//! Production adaptations vs the spike:
//!   1. does NOT call the server — returns the response JSON; JS does verify.
//!   2. anchors the modal to the real Tauri window hWnd (not GetForegroundWindow).
//!   3. maps user-cancel (NotAllowedError) to a `CANCELLED:` prefix so the JS
//!      `normaliseWebAuthnError` routes it to 'cancelled' (Layer A/B parity).
//!   4. honours the server-populated excludeCredentials via pExcludeCredentialList
//!      on register (WS1 of the Kobus fix, docs/kobus-fix-and-telemetry-plan.md):
//!      without it the authenticator mints a SECOND discoverable credential for a
//!      device that already has one, the server discards it on the (email,
//!      device_fingerprint) unique violation, and the device is then signing with
//!      a credential the server never stored → permanent AUTH_FAILED. Passing the
//!      recipient's existing credential IDs makes the OS refuse the duplicate.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ─── Options (deserialized from the server's *-options JSON) ─────────
// Field-for-field identical to passkey/macos.rs so both bridges accept the
// exact same input the JS layer hands them.

#[derive(Debug, Deserialize)]
struct RegistrationOptions {
    challenge: String,
    rp: RegistrationOptionsRp,
    user: RegistrationOptionsUser,
    #[serde(rename = "pubKeyCredParams", default)]
    #[allow(dead_code)]
    pub_key_cred_params: Vec<serde_json::Value>,
    #[serde(rename = "excludeCredentials", default)]
    exclude_credentials: Vec<CredDescriptor>,
}

#[derive(Debug, Deserialize)]
struct RegistrationOptionsRp {
    id: String,
    #[allow(dead_code)]
    name: String,
}

#[derive(Debug, Deserialize)]
struct RegistrationOptionsUser {
    id: String,
    name: String,
    #[serde(rename = "displayName")]
    #[allow(dead_code)]
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
struct AssertionOptions {
    challenge: String,
    #[serde(rename = "rpId")]
    rp_id: String,
    #[serde(rename = "allowCredentials", default)]
    #[allow(dead_code)]
    allow_credentials: Vec<CredDescriptor>,
}

// ─── Response (serialized back to the JS layer) ─────────────────────

#[derive(Debug, Serialize)]
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
struct RegistrationResponseInner {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    #[serde(rename = "attestationObject")]
    attestation_object: String,
    transports: Vec<String>,
}

#[derive(Debug, Serialize)]
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
struct AssertionResponseInner {
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    #[serde(rename = "authenticatorData")]
    authenticator_data: String,
    signature: String,
    #[serde(rename = "userHandle")]
    user_handle: Option<String>,
}

// ─── clientDataJSON we construct (origin is the whole point) ─────────
// Build the bytes ONCE and reuse them for the OS call and the base64url we
// return, so the hash the authenticator signed matches what the server
// recomputes. The challenge is the server's base64url string, used verbatim.
fn client_data(ceremony_type: &str, challenge_b64url: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"{ceremony_type}","challenge":"{challenge_b64url}","origin":"https://aspisfile.com","crossOrigin":false}}"#
    )
    .into_bytes()
}

fn b64url(bytes: &[u8]) -> String {
    B64URL.encode(bytes)
}

// ─── Win32 ceremonies ───────────────────────────────────────────────

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, TRUE};
use windows::Win32::Networking::WindowsWebServices::*;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// Map a Win32 WebAuthn HRESULT to our error string. User-cancel surfaces as
// "NotAllowedError" from WebAuthNGetErrorName — prefix it CANCELLED so the JS
// layer treats it as a cancel (stay native, retry) rather than a hard failure.
fn err_to_string(e: windows::core::Error) -> String {
    let hr = e.code();
    let name = unsafe { WebAuthNGetErrorName(hr).to_string() }.unwrap_or_default();
    if name == "NotAllowedError" {
        format!("CANCELLED: user cancelled (NotAllowedError): {}", e.message())
    } else {
        format!("AS error: HRESULT {hr:?} ({name}): {}", e.message())
    }
}

// Resolve the Tauri main window's native HWND to anchor the modal WebAuthn UI.
// Tauri pulls a NEWER `windows` crate (0.61) than our bridge (0.58), so its
// HWND is a distinct type — bridge it via the raw *mut c_void so our WebAuthn
// calls receive an HWND of our own crate version.
fn main_hwnd(app: &AppHandle) -> Result<HWND, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no 'main' window to anchor the passkey dialog".to_string())?;
    let raw = win.hwnd().map_err(|e| format!("window hwnd unavailable: {e}"))?;
    Ok(HWND(raw.0))
}

// ─── Command: register (WebAuthNAuthenticatorMakeCredential) ─────────
#[tauri::command]
pub async fn passkey_register(app: AppHandle, options_json: String) -> Result<String, String> {
    let opts: RegistrationOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid registration options JSON: {}", e))?;

    let api = unsafe { WebAuthNGetApiVersionNumber() };
    if api == 0 {
        return Err("webauthn.dll unavailable (needs Windows 10 1903+)".into());
    }

    let hwnd = main_hwnd(&app)?;
    let user_id = B64URL
        .decode(opts.user.id.trim_end_matches('='))
        .map_err(|e| format!("bad user.id: {}", e))?;
    let cd = client_data("webauthn.create", &opts.challenge);

    // Keep every wide string + buffer alive until after the OS call returns.
    let rp_id_w = wide(&opts.rp.id);
    let rp_name_w = wide("AspisFile");
    let user_name_w = wide(&opts.user.name);
    let hash_w = wide("SHA-256");
    let cred_type_w = wide("public-key");
    let mut user_id_buf = user_id.clone();
    let mut cd_buf = cd.clone();

    let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
        pwszId: PCWSTR(rp_id_w.as_ptr()),
        pwszName: PCWSTR(rp_name_w.as_ptr()),
        pwszIcon: PCWSTR::null(),
    };
    let user = WEBAUTHN_USER_ENTITY_INFORMATION {
        dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
        cbId: user_id_buf.len() as u32,
        pbId: user_id_buf.as_mut_ptr(),
        pwszName: PCWSTR(user_name_w.as_ptr()),
        pwszIcon: PCWSTR::null(),
        pwszDisplayName: PCWSTR(user_name_w.as_ptr()),
    };
    let mut cose = [
        WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: PCWSTR(cred_type_w.as_ptr()),
            lAlg: -7, // ES256
        },
        WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: PCWSTR(cred_type_w.as_ptr()),
            lAlg: -257, // RS256
        },
    ];
    let cose_params = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
        cCredentialParameters: cose.len() as u32,
        pCredentialParameters: cose.as_mut_ptr(),
    };
    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: cd_buf.len() as u32,
        pbClientDataJSON: cd_buf.as_mut_ptr(),
        pwszHashAlgId: PCWSTR(hash_w.as_ptr()),
    };

    // ── Exclude list (WS1 Kobus fix) ──
    // Decode each server-supplied excludeCredentials.id (base64url) and hand the
    // OS a pExcludeCredentialList so the authenticator refuses to create a second
    // credential for a device that already holds one. Every buffer/struct here
    // must outlive the WebAuthNAuthenticatorMakeCredential call below, so they're
    // bound in this scope (dropped only at function end).
    let mut exclude_id_bufs: Vec<Vec<u8>> = opts
        .exclude_credentials
        .iter()
        .filter_map(|c| B64URL.decode(c.id.trim_end_matches('=')).ok())
        .filter(|b| !b.is_empty())
        .collect();
    let mut exclude_ex: Vec<WEBAUTHN_CREDENTIAL_EX> = exclude_id_bufs
        .iter_mut()
        .map(|buf| WEBAUTHN_CREDENTIAL_EX {
            dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
            cbId: buf.len() as u32,
            pbId: buf.as_mut_ptr(),
            pwszCredentialType: PCWSTR(cred_type_w.as_ptr()),
            dwTransports: 0, // no transport constraint — match any authenticator
        })
        .collect();
    // WEBAUTHN_CREDENTIAL_LIST holds an array of POINTERS to the EX structs.
    let mut exclude_ptrs: Vec<*mut WEBAUTHN_CREDENTIAL_EX> =
        exclude_ex.iter_mut().map(|e| e as *mut _).collect();
    let mut exclude_list = WEBAUTHN_CREDENTIAL_LIST {
        cCredentials: exclude_ptrs.len() as u32,
        ppCredentials: exclude_ptrs.as_mut_ptr(),
    };

    let mut make_opts = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS::default();
    make_opts.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION;
    make_opts.dwTimeoutMilliseconds = 120_000; // cover a slow phone-QR ceremony
    make_opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY; // Hello + QR + key
    make_opts.bRequireResidentKey = TRUE; // discoverable — matches the proven spike
    make_opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
    make_opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE;
    // Attach the exclude list only when non-empty (an empty list's dangling
    // ppCredentials pointer must never reach the OS). First-time registrants
    // have no existing credentials → null → no behaviour change.
    if !exclude_ptrs.is_empty() {
        make_opts.pExcludeCredentialList = &mut exclude_list as *mut _;
    }

    let att_ptr = unsafe {
        WebAuthNAuthenticatorMakeCredential(
            hwnd,
            &rp,
            &user,
            &cose_params,
            &client,
            Some(&make_opts as *const _),
        )
    }
    .map_err(err_to_string)?;

    if att_ptr.is_null() {
        return Err("null WEBAUTHN_CREDENTIAL_ATTESTATION".into());
    }

    // Copy everything out BEFORE freeing the OS-owned struct.
    let (att_obj, cred_id) = unsafe {
        let att = &*att_ptr;
        let att_obj = std::slice::from_raw_parts(
            att.pbAttestationObject,
            att.cbAttestationObject as usize,
        )
        .to_vec();
        let cred_id =
            std::slice::from_raw_parts(att.pbCredentialId, att.cbCredentialId as usize).to_vec();
        (att_obj, cred_id)
    };
    unsafe { WebAuthNFreeCredentialAttestation(Some(att_ptr as *const _)) };

    let out = RegistrationResponse {
        id: b64url(&cred_id),
        raw_id: b64url(&cred_id),
        response: RegistrationResponseInner {
            client_data_json: b64url(&cd),
            attestation_object: b64url(&att_obj),
            transports: vec!["internal".to_string(), "hybrid".to_string()],
        },
        cred_type: "public-key".to_string(),
        client_extension_results: serde_json::json!({}),
    };
    serde_json::to_string(&out).map_err(|e| format!("serialize registration response: {}", e))
}

// ─── Command: authenticate (WebAuthNAuthenticatorGetAssertion) ───────
#[tauri::command]
pub async fn passkey_authenticate(app: AppHandle, options_json: String) -> Result<String, String> {
    let opts: AssertionOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid assertion options JSON: {}", e))?;

    let api = unsafe { WebAuthNGetApiVersionNumber() };
    if api == 0 {
        return Err("webauthn.dll unavailable (needs Windows 10 1903+)".into());
    }

    let hwnd = main_hwnd(&app)?;
    let cd = client_data("webauthn.get", &opts.challenge);

    let rp_id_w = wide(&opts.rp_id);
    let hash_w = wide("SHA-256");
    let mut cd_buf = cd.clone();

    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: cd_buf.len() as u32,
        pbClientDataJSON: cd_buf.as_mut_ptr(),
        pwszHashAlgId: PCWSTR(hash_w.as_ptr()),
    };

    let mut get_opts = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS::default();
    get_opts.dwVersion = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION;
    get_opts.dwTimeoutMilliseconds = 120_000;
    get_opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY;
    get_opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
    // No allow-list → discoverable (resident) credential path, the returning-
    // user flow the server expects (email→discoverable lookup, no allow-list).

    let asrt_ptr = unsafe {
        WebAuthNAuthenticatorGetAssertion(
            hwnd,
            PCWSTR(rp_id_w.as_ptr()),
            &client,
            Some(&get_opts as *const _),
        )
    }
    .map_err(err_to_string)?;

    if asrt_ptr.is_null() {
        return Err("null WEBAUTHN_ASSERTION".into());
    }

    let (auth_data, signature, cred_id, user_handle) = unsafe {
        let a = &*asrt_ptr;
        let auth_data =
            std::slice::from_raw_parts(a.pbAuthenticatorData, a.cbAuthenticatorData as usize)
                .to_vec();
        let signature =
            std::slice::from_raw_parts(a.pbSignature, a.cbSignature as usize).to_vec();
        let cred_id =
            std::slice::from_raw_parts(a.Credential.pbId, a.Credential.cbId as usize).to_vec();
        let user_handle = if a.cbUserId > 0 && !a.pbUserId.is_null() {
            Some(b64url(
                &std::slice::from_raw_parts(a.pbUserId, a.cbUserId as usize).to_vec(),
            ))
        } else {
            None
        };
        (auth_data, signature, cred_id, user_handle)
    };
    unsafe { WebAuthNFreeAssertion(asrt_ptr) };

    let out = AssertionResponse {
        id: b64url(&cred_id),
        raw_id: b64url(&cred_id),
        response: AssertionResponseInner {
            client_data_json: b64url(&cd),
            authenticator_data: b64url(&auth_data),
            signature: b64url(&signature),
            user_handle,
        },
        cred_type: "public-key".to_string(),
        client_extension_results: serde_json::json!({}),
    };
    serde_json::to_string(&out).map_err(|e| format!("serialize assertion response: {}", e))
}
