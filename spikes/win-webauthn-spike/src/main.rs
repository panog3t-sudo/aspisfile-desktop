//! Windows Win32 WebAuthn de-risking spike for the unified native sign-in.
//!
//! GOAL (see aspisfile/docs/native-signin-design.md → "Feasibility review"):
//! prove the two Windows assumptions the whole native project rests on, with
//! REAL code against the REAL server, before building the production bridge.
//!
//!   Claim 1 — a NON-BROWSER process can emit `origin: "https://aspisfile.com"`
//!             in its own clientDataJSON and have our EXISTING
//!             register-verify / authenticate-verify accept it unchanged.
//!             (macOS gets the origin stamped by the OS via associated-domains;
//!              on Windows the *caller* builds clientDataJSON, so this is the
//!              make-or-break question.)
//!
//!   Claim 2 — with dwAuthenticatorAttachment = ANY the NATIVE Windows dialog
//!             offers Windows Hello + "use a phone or tablet" (QR/hybrid) +
//!             security key, in-app, with NO Edge and NO Microsoft Password
//!             Manager. (Watch the dialog when it appears — that's the visual
//!             half of the proof; screenshot it.)
//!
//! This is a THROWAWAY. It hardcodes, prints everything, frees nothing (the
//! process exits), and is deliberately NOT wired into the Tauri app.
//!
//! Run: see README.md. You supply ASPIS_EMAIL + ASPIS_RT (register) via env.

use base64::Engine;
use serde_json::json;

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Tolerant base64url decode (server strings are no-pad, but be forgiving).
fn b64url_dec(s: &str) -> Vec<u8> {
    let trimmed = s.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .unwrap_or_else(|e| panic!("bad base64url {s:?}: {e}"))
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn base_url() -> String {
    env("ASPIS_BASE").unwrap_or_else(|| "https://aspisfile.com".to_string())
}

// ── HTTP against the REAL recipient-passkeys endpoints ─────────────────────

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client")
}

fn register_options(rt: &str) -> serde_json::Value {
    let res = http()
        .post(format!("{}/api/v1/recipient-passkeys/register-options", base_url()))
        .header("Authorization", format!("Bearer {rt}"))
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .expect("register-options request");
    let status = res.status();
    let body = res.text().unwrap_or_default();
    if !status.is_success() {
        panic!("register-options {status}: {body}");
    }
    serde_json::from_str(&body).expect("register-options json")
}

fn register_verify(rt: &str, email: &str, credential: serde_json::Value) {
    let body = json!({
        "response": credential,
        "device_label": "Win spike",
        "device_fingerprint": format!("Windows|{email}|Win spike"),
        "sync_status": "single_device",
        "transports": ["internal"],
    });
    let res = http()
        .post(format!("{}/api/v1/recipient-passkeys/register-verify", base_url()))
        .header("Authorization", format!("Bearer {rt}"))
        .json(&body)
        .send()
        .expect("register-verify request");
    let status = res.status();
    let text = res.text().unwrap_or_default();
    println!("\n=== register-verify → {status} ===\n{text}\n");
    if status.is_success() && text.contains("\"success\":true") {
        println!(">>> CLAIM 1 (register) PROVEN: native origin accepted by the real server. <<<");
    } else {
        println!(">>> CLAIM 1 (register) FAILED — read the error above (origin? UV? attestation?). <<<");
    }
}

fn authenticate_options(email: &str) -> serde_json::Value {
    let res = http()
        .post(format!("{}/api/v1/recipient-passkeys/authenticate-options", base_url()))
        .json(&json!({ "email": email }))
        .send()
        .expect("authenticate-options request");
    let status = res.status();
    let body = res.text().unwrap_or_default();
    if !status.is_success() {
        panic!("authenticate-options {status}: {body}");
    }
    serde_json::from_str(&body).expect("authenticate-options json")
}

fn authenticate_verify(email: &str, credential: serde_json::Value) {
    let res = http()
        .post(format!("{}/api/v1/recipient-passkeys/authenticate-verify", base_url()))
        .json(&json!({ "email": email, "response": credential }))
        .send()
        .expect("authenticate-verify request");
    let status = res.status();
    let text = res.text().unwrap_or_default();
    println!("\n=== authenticate-verify → {status} ===\n{text}\n");
    if status.is_success() && text.contains("\"success\":true") {
        println!(">>> CLAIM 1 (authenticate) PROVEN: native assertion accepted by the real server. <<<");
    } else {
        println!(">>> CLAIM 1 (authenticate) FAILED — read the error above. <<<");
    }
}

/// The clientDataJSON WE construct. `origin` is the whole point: a non-browser
/// process asserting it is `https://aspisfile.com`. Build the bytes ONCE and
/// reuse them for both the OS call and the base64url we send to the server, so
/// the hash the authenticator signed matches what the server recomputes.
fn client_data(ceremony_type: &str, challenge_b64url: &str) -> Vec<u8> {
    // Compact, no spaces — must be byte-identical between the OS call and the
    // value posted to the server.
    format!(
        r#"{{"type":"{ceremony_type}","challenge":"{challenge_b64url}","origin":"https://aspisfile.com","crossOrigin":false}}"#
    )
    .into_bytes()
}

fn main() {
    let mode = env("ASPIS_MODE").unwrap_or_else(|| "both".to_string());
    let email = env("ASPIS_EMAIL").expect("set ASPIS_EMAIL=<recipient email>");
    println!("AspisFile Windows WebAuthn spike");
    println!("  base  = {}", base_url());
    println!("  email = {email}");
    println!("  mode  = {mode}\n");

    #[cfg(not(windows))]
    {
        let _ = (mode, email);
        eprintln!("This spike calls the Win32 WebAuthn API — run it on Windows 10 1903+ / 11.");
        eprintln!("(It compiles on other OSes only so you can `cargo check`.)");
        std::process::exit(2);
    }

    #[cfg(windows)]
    win::run(&mode, &email);
}

// ── Windows-only: the actual Win32 WebAuthn ceremonies ─────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HWND, TRUE};
    use windows::Win32::Networking::WindowsWebServices::*;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    /// Null-terminated UTF-16 for PCWSTR. Caller must keep the Vec alive for as
    /// long as the pointer is used.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn err_to_string(e: windows::core::Error) -> String {
        let hr = e.code();
        // WebAuthNGetErrorName maps the HRESULT to a WebAuthn error name
        // (e.g. "NotAllowedError" for user-cancel).
        let name = unsafe { WebAuthNGetErrorName(hr).to_string() }.unwrap_or_default();
        format!("HRESULT {hr:?} ({name}) — {}", e.message())
    }

    pub fn run(mode: &str, email: &str) {
        // API version — sanity check that webauthn.dll is present & modern.
        let api = unsafe { WebAuthNGetApiVersionNumber() };
        println!("WebAuthNGetApiVersionNumber() = {api}");
        if api == 0 {
            eprintln!("webauthn.dll unavailable / too old. Need Win10 1903+.");
            std::process::exit(3);
        }

        if mode == "register" || mode == "both" {
            let rt = env("ASPIS_RT")
                .expect("set ASPIS_RT=<registration token from the enrollment deep-link> for register mode");
            match do_register(email, &rt) {
                Ok(()) => println!("register ceremony completed."),
                Err(e) => println!(">>> register OS ceremony error: {e}"),
            }
        }

        if mode == "authenticate" || mode == "both" {
            match do_authenticate(email) {
                Ok(()) => println!("authenticate ceremony completed."),
                Err(e) => println!(">>> authenticate OS ceremony error: {e}"),
            }
        }
    }

    fn window() -> HWND {
        // A throwaway needs *some* top-level window to anchor the modal WebAuthn
        // UI. Run from a focused terminal and GetForegroundWindow() is that
        // terminal. The production bridge will pass the real Tauri window hWnd.
        unsafe { GetForegroundWindow() }
    }

    // ── REGISTER: WebAuthNAuthenticatorMakeCredential ──────────────────────
    fn do_register(email: &str, rt: &str) -> Result<(), String> {
        let opts = register_options(rt);
        let challenge = opts["challenge"].as_str().ok_or("options.challenge missing")?;
        let rp_id = opts["rp"]["id"].as_str().unwrap_or("aspisfile.com");
        let user_name = opts["user"]["name"].as_str().unwrap_or(email);
        let user_id = b64url_dec(opts["user"]["id"].as_str().ok_or("options.user.id missing")?);
        println!("register-options ok: rp.id={rp_id}, challenge len={}", challenge.len());

        let cd = client_data("webauthn.create", challenge);

        // Keep all wide strings + buffers alive until after the OS call.
        let rp_id_w = wide(rp_id);
        let rp_name_w = wide("AspisFile");
        let user_name_w = wide(user_name);
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

        let mut make_opts = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS::default();
        make_opts.dwVersion = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION;
        make_opts.dwTimeoutMilliseconds = 90_000;
        make_opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY; // <- Hello + QR + key
        make_opts.bRequireResidentKey = TRUE; // discoverable, matches residentKey:'preferred'
        make_opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        make_opts.dwAttestationConveyancePreference = WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE;

        println!("→ WebAuthNAuthenticatorMakeCredential (watch for the NATIVE dialog: Hello / phone-QR / key)…");
        let result = unsafe {
            WebAuthNAuthenticatorMakeCredential(
                window(),
                &rp,
                &user,
                &cose_params,
                &client,
                Some(&make_opts as *const _),
            )
        };

        let att_ptr = result.map_err(err_to_string)?;
        if att_ptr.is_null() {
            return Err("null WEBAUTHN_CREDENTIAL_ATTESTATION".into());
        }
        let att = unsafe { &*att_ptr };
        let att_obj = unsafe {
            std::slice::from_raw_parts(att.pbAttestationObject, att.cbAttestationObject as usize)
        }
        .to_vec();
        let cred_id = unsafe {
            std::slice::from_raw_parts(att.pbCredentialId, att.cbCredentialId as usize)
        }
        .to_vec();
        let fmt = unsafe { att.pwszFormatType.to_string() }.unwrap_or_default();
        println!("attestation format = {fmt}, credId {} bytes, attObj {} bytes", cred_id.len(), att_obj.len());
        // NB: intentionally not calling WebAuthNFreeCredentialAttestation — the
        // process exits; skipping it dodges a version-specific free signature.

        let credential = json!({
            "id": b64url(&cred_id),
            "rawId": b64url(&cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(&cd),
                "attestationObject": b64url(&att_obj),
                "transports": ["internal"],
            },
            "clientExtensionResults": {},
        });

        register_verify(rt, email, credential);
        Ok(())
    }

    // ── AUTHENTICATE: WebAuthNAuthenticatorGetAssertion ────────────────────
    fn do_authenticate(email: &str) -> Result<(), String> {
        let opts = authenticate_options(email);
        let challenge = opts["challenge"].as_str().ok_or("options.challenge missing")?;
        let rp_id = opts["rpId"].as_str().unwrap_or("aspisfile.com");
        println!("authenticate-options ok: rpId={rp_id}, challenge len={}", challenge.len());

        let cd = client_data("webauthn.get", challenge);

        let rp_id_w = wide(rp_id);
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
        get_opts.dwTimeoutMilliseconds = 90_000;
        get_opts.dwAuthenticatorAttachment = WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY;
        get_opts.dwUserVerificationRequirement = WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED;
        // No allow-list → exercises the DISCOVERABLE (resident) credential path,
        // exactly like the returning-user flow.

        println!("→ WebAuthNAuthenticatorGetAssertion (native dialog again)…");
        let result = unsafe {
            WebAuthNAuthenticatorGetAssertion(
                window(),
                PCWSTR(rp_id_w.as_ptr()),
                &client,
                Some(&get_opts as *const _),
            )
        };

        let asrt_ptr = result.map_err(err_to_string)?;
        if asrt_ptr.is_null() {
            return Err("null WEBAUTHN_ASSERTION".into());
        }
        let asrt = unsafe { &*asrt_ptr };
        let auth_data = unsafe {
            std::slice::from_raw_parts(asrt.pbAuthenticatorData, asrt.cbAuthenticatorData as usize)
        }
        .to_vec();
        let signature = unsafe {
            std::slice::from_raw_parts(asrt.pbSignature, asrt.cbSignature as usize)
        }
        .to_vec();
        let cred_id = unsafe {
            std::slice::from_raw_parts(asrt.Credential.pbId, asrt.Credential.cbId as usize)
        }
        .to_vec();
        let user_handle = if asrt.cbUserId > 0 && !asrt.pbUserId.is_null() {
            let uid = unsafe {
                std::slice::from_raw_parts(asrt.pbUserId, asrt.cbUserId as usize)
            }
            .to_vec();
            serde_json::Value::String(b64url(&uid))
        } else {
            serde_json::Value::Null
        };
        println!("assertion: credId {} bytes, sig {} bytes", cred_id.len(), signature.len());

        let credential = json!({
            "id": b64url(&cred_id),
            "rawId": b64url(&cred_id),
            "type": "public-key",
            "response": {
                "clientDataJSON": b64url(&cd),
                "authenticatorData": b64url(&auth_data),
                "signature": b64url(&signature),
                "userHandle": user_handle,
            },
            "clientExtensionResults": {},
        });

        authenticate_verify(email, credential);
        Ok(())
    }
}
