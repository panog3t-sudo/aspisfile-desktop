// Native WebAuthn bridge for macOS via Apple AuthenticationServices.
//
// Replaces Path B browser-redirect with in-window Touch ID. We use
// objc2 for the typed bits (NSData/NSString/NSArray helpers, the
// custom delegate via declare_class!) and raw msg_send! for the
// AuthenticationServices framework calls — the typed
// objc2-authentication-services crate has gaps that fight us more
// than direct ObjC messaging does.
//
// Two commands:
//   passkey_register(options_json)     → RegistrationResponseJSON
//   passkey_authenticate(options_json) → AssertionResponseJSON
//
// Both consume the WebAuthn options JSON the server returned and
// produce the WebAuthn response JSON the server expects. JS layer
// (lib/passkey.ts) treats any Err as a signal to fall back to
// Path B browser flow.

use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64URL};

use objc2::rc::{Retained, Allocated};
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
use objc2::{class, declare_class, extern_protocol, msg_send, msg_send_id, mutability,
            ClassType, DeclaredClass, ProtocolType};
use objc2_foundation::{NSData, NSError, NSString};

// We don't pull NSWindow through objc2-app-kit (the typed binding has
// version conflicts with our other deps). The presentation anchor is
// just an NSWindow* — we hold it as Retained<AnyObject> and pass it
// to the AS framework via msg_send!, which doesn't care about Rust
// typing on the other side.

// ─── JSON shapes (server-facing) ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RegistrationOptions {
    challenge: String,
    rp: RegistrationOptionsRp,
    user: RegistrationOptionsUser,
    #[serde(rename = "pubKeyCredParams", default)]
    #[allow(dead_code)]
    pub_key_cred_params: Vec<serde_json::Value>,
    #[serde(rename = "excludeCredentials", default)]
    #[allow(dead_code)]
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
    allow_credentials: Vec<CredDescriptor>,
}

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

// ─── Result piping (delegate → command) ─────────────────────────────

enum BridgeResult {
    Register(Result<RegistrationResponse, String>),
    Assert(Result<AssertionResponse, String>),
}

// ─── Protocols we declare extern (so our delegate can conform) ─────
//
// objc2 needs the protocol type to exist before declare_class! can
// conform to it. We declare just enough surface for the protocols we
// actually implement on the delegate — three methods total.

extern_protocol!(
    unsafe trait ASAuthorizationControllerDelegate: NSObjectProtocol {
        #[method(authorizationController:didCompleteWithAuthorization:)]
        unsafe fn authorization_controller_did_complete_with_authorization(
            &self,
            controller: &AnyObject,
            authorization: &AnyObject,
        );

        #[method(authorizationController:didCompleteWithError:)]
        unsafe fn authorization_controller_did_complete_with_error(
            &self,
            controller: &AnyObject,
            error: &NSError,
        );
    }

    unsafe impl ProtocolType for dyn ASAuthorizationControllerDelegate {
        const NAME: &'static str = "ASAuthorizationControllerDelegate";
    }
);

extern_protocol!(
    unsafe trait ASAuthorizationControllerPresentationContextProviding: NSObjectProtocol {
        #[method_id(presentationAnchorForAuthorizationController:)]
        unsafe fn presentation_anchor_for_authorization_controller(
            &self,
            controller: &AnyObject,
        ) -> Retained<AnyObject>;
    }

    unsafe impl ProtocolType for dyn ASAuthorizationControllerPresentationContextProviding {
        const NAME: &'static str = "ASAuthorizationControllerPresentationContextProviding";
    }
);

// ─── Custom delegate class ─────────────────────────────────────────

#[derive(Clone, Copy)]
enum PasskeyOp {
    Register,
    Assert,
}

struct DelegateIvars {
    sender: Mutex<Option<tokio::sync::oneshot::Sender<BridgeResult>>>,
    kind:   PasskeyOp,
    anchor: Mutex<Option<Retained<AnyObject>>>,
}

declare_class!(
    struct PasskeyDelegate;

    unsafe impl ClassType for PasskeyDelegate {
        type Super = NSObject;
        type Mutability = mutability::InteriorMutable;
        const NAME: &'static str = "AspisFilePasskeyDelegate";
    }

    impl DeclaredClass for PasskeyDelegate {
        type Ivars = DelegateIvars;
    }

    unsafe impl PasskeyDelegate {
        #[method_id(init)]
        fn init(this: Allocated<Self>) -> Option<Retained<Self>> {
            let this = this.set_ivars(DelegateIvars {
                sender: Mutex::new(None),
                kind:   PasskeyOp::Register,
                anchor: Mutex::new(None),
            });
            unsafe { msg_send_id![super(this), init] }
        }
    }

    unsafe impl NSObjectProtocol for PasskeyDelegate {}

    unsafe impl ASAuthorizationControllerDelegate for PasskeyDelegate {
        #[method(authorizationController:didCompleteWithAuthorization:)]
        unsafe fn authorization_controller_did_complete_with_authorization(
            &self,
            _controller: &AnyObject,
            authorization: &AnyObject,
        ) {
            // Pull the typed credential off authorization.
            let credential: *mut AnyObject = msg_send![authorization, credential];
            let result = if credential.is_null() {
                match self.ivars().kind {
                    PasskeyOp::Register => BridgeResult::Register(Err("no credential".into())),
                    PasskeyOp::Assert   => BridgeResult::Assert(Err("no credential".into())),
                }
            } else {
                match self.ivars().kind {
                    PasskeyOp::Register => BridgeResult::Register(marshal_registration(credential)),
                    PasskeyOp::Assert   => BridgeResult::Assert(marshal_assertion(credential)),
                }
            };
            if let Ok(mut g) = self.ivars().sender.lock() {
                if let Some(tx) = g.take() { let _ = tx.send(result); }
            }
        }

        #[method(authorizationController:didCompleteWithError:)]
        unsafe fn authorization_controller_did_complete_with_error(
            &self,
            _controller: &AnyObject,
            error: &NSError,
        ) {
            let domain  = error.domain().to_string();
            let code    = error.code();
            let localized = error.localizedDescription().to_string();
            let msg = format!("AS error: {} (code {}): {}", domain, code, localized);
            let result = match self.ivars().kind {
                PasskeyOp::Register => BridgeResult::Register(Err(msg)),
                PasskeyOp::Assert   => BridgeResult::Assert(Err(msg)),
            };
            if let Ok(mut g) = self.ivars().sender.lock() {
                if let Some(tx) = g.take() { let _ = tx.send(result); }
            }
        }
    }

    unsafe impl ASAuthorizationControllerPresentationContextProviding for PasskeyDelegate {
        #[method_id(presentationAnchorForAuthorizationController:)]
        unsafe fn presentation_anchor_for_authorization_controller(
            &self,
            _controller: &AnyObject,
        ) -> Retained<AnyObject> {
            // declare_class! turns the tail expression into IdReturnValue;
            // `return` statements bypass that conversion. Funnel through one
            // Option<Retained<AnyObject>> so there's a single tail expression.
            let stored = self
                .ivars()
                .anchor
                .lock()
                .ok()
                .and_then(|g| g.as_ref().cloned());
            stored.unwrap_or_else(|| {
                let app: *mut AnyObject =
                    msg_send![class!(NSApplication), sharedApplication];
                let win: *mut AnyObject = msg_send![app, keyWindow];
                Retained::retain(win).expect("no keyWindow available")
            })
        }
    }
);

// ─── Result marshallers ────────────────────────────────────────────

unsafe fn nsdata_to_b64url(data: *mut AnyObject) -> String {
    if data.is_null() { return String::new(); }
    let bytes_ptr: *const std::ffi::c_void = msg_send![data, bytes];
    let length: usize = msg_send![data, length];
    if bytes_ptr.is_null() || length == 0 { return String::new(); }
    let bytes = std::slice::from_raw_parts(bytes_ptr as *const u8, length);
    B64URL.encode(bytes)
}

unsafe fn marshal_registration(credential: *mut AnyObject) -> Result<RegistrationResponse, String> {
    let cred_id: *mut AnyObject = msg_send![credential, credentialID];
    let raw_id  = nsdata_to_b64url(cred_id);
    if raw_id.is_empty() {
        return Err("empty credentialID".into());
    }
    let client_data: *mut AnyObject     = msg_send![credential, rawClientDataJSON];
    let attestation: *mut AnyObject     = msg_send![credential, rawAttestationObject];
    let client_data_json   = nsdata_to_b64url(client_data);
    let attestation_object = nsdata_to_b64url(attestation);

    Ok(RegistrationResponse {
        id: raw_id.clone(),
        raw_id,
        response: RegistrationResponseInner {
            client_data_json,
            attestation_object,
            transports: vec!["internal".to_string(), "hybrid".to_string()],
        },
        cred_type: "public-key".to_string(),
        client_extension_results: serde_json::json!({}),
    })
}

unsafe fn marshal_assertion(credential: *mut AnyObject) -> Result<AssertionResponse, String> {
    let cred_id: *mut AnyObject = msg_send![credential, credentialID];
    let raw_id  = nsdata_to_b64url(cred_id);
    if raw_id.is_empty() {
        return Err("empty credentialID".into());
    }
    let client_data: *mut AnyObject = msg_send![credential, rawClientDataJSON];
    let auth_data:   *mut AnyObject = msg_send![credential, rawAuthenticatorData];
    let signature:   *mut AnyObject = msg_send![credential, signature];
    let user_id:     *mut AnyObject = msg_send![credential, userID];

    let client_data_json   = nsdata_to_b64url(client_data);
    let authenticator_data = nsdata_to_b64url(auth_data);
    let signature_b64      = nsdata_to_b64url(signature);
    let user_handle        = if user_id.is_null() { None }
                              else { Some(nsdata_to_b64url(user_id)) };

    Ok(AssertionResponse {
        id: raw_id.clone(),
        raw_id,
        response: AssertionResponseInner {
            client_data_json,
            authenticator_data,
            signature: signature_b64,
            user_handle,
        },
        cred_type: "public-key".to_string(),
        client_extension_results: serde_json::json!({}),
    })
}

// ─── ObjC helpers — build NSData / NSString / AS objects ──────────

unsafe fn ns_data_from_bytes(bytes: &[u8]) -> Retained<NSData> {
    NSData::with_bytes(bytes)
}

unsafe fn ns_string(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

// Build an ASAuthorizationPlatformPublicKeyCredentialDescriptor from
// a base64url credential ID. Returns the retained ObjC object as a
// raw pointer (caller wraps in NSArray manually since the array helper
// expects typed objects).
unsafe fn build_descriptor(cred_id_b64: &str) -> Option<*mut AnyObject> {
    let bytes = B64URL.decode(cred_id_b64).ok()?;
    let id_ns = ns_data_from_bytes(&bytes);
    let cls = class!(ASAuthorizationPlatformPublicKeyCredentialDescriptor);
    let alloc: *mut AnyObject = msg_send![cls, alloc];
    let desc: *mut AnyObject = msg_send![alloc, initWithCredentialID: &*id_ns];
    Some(desc)
}

// Wraps a slice of raw ObjC object pointers in an NSArray. AS APIs
// expect typed NSArray<ASAuthorizationPlatformPublicKeyCredentialDescriptor *>
// but Objective-C is dynamic — any NSArray works.
unsafe fn ns_array_of_objects(objs: &[*mut AnyObject]) -> *mut AnyObject {
    let cls = class!(NSArray);
    let arr: *mut AnyObject = msg_send![cls, arrayWithObjects: objs.as_ptr() count: objs.len()];
    arr
}

// ─── Lifetime retention ────────────────────────────────────────────
//
// AS performRequests is async — without strong refs the delegate gets
// dropped before the OS UI fires its callbacks. Apple's docs require
// the caller to "maintain a strong reference to the controller object
// until performRequests completes."
//
// We Box::leak the holder per call. Each ceremony allocates ~32 bytes
// of pure Rust leak + the underlying ObjC objects. Recipient
// enrolment runs a handful of times per install, so this is well
// under any threshold worth tracking. Cleaner than Tauri-managed
// state (which is type-keyed and breaks on the second call).

struct KeepAlivePasskey {
    _controller: *mut AnyObject,
    _delegate:   Retained<PasskeyDelegate>,
}
unsafe impl Send for KeepAlivePasskey {}
unsafe impl Sync for KeepAlivePasskey {}

// ─── Commands ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn passkey_register(app: AppHandle, options_json: String) -> Result<String, String> {
    let opts: RegistrationOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid registration options JSON: {}", e))?;

    let challenge = B64URL.decode(&opts.challenge).map_err(|e| format!("bad challenge: {}", e))?;
    let user_id   = B64URL.decode(&opts.user.id).map_err(|e| format!("bad user.id: {}", e))?;
    let rp_id     = opts.rp.id;
    let user_name = opts.user.name;

    let (tx, rx) = tokio::sync::oneshot::channel::<BridgeResult>();
    let app_handle = app.clone();

    app.run_on_main_thread(move || unsafe {
        // Build provider: ASAuthorizationPlatformPublicKeyCredentialProvider
        let rp_id_ns = ns_string(&rp_id);
        let provider_cls = class!(ASAuthorizationPlatformPublicKeyCredentialProvider);
        let provider_alloc: *mut AnyObject = msg_send![provider_cls, alloc];
        let provider: *mut AnyObject = msg_send![provider_alloc, initWithRelyingPartyIdentifier: &*rp_id_ns];

        // Build registration request
        let challenge_ns = ns_data_from_bytes(&challenge);
        let user_id_ns   = ns_data_from_bytes(&user_id);
        let user_name_ns = ns_string(&user_name);
        let request: *mut AnyObject = msg_send![
            provider,
            createCredentialRegistrationRequestWithChallenge: &*challenge_ns
            name: &*user_name_ns
            userID: &*user_id_ns
        ];

        // Wrap into NSArray<ASAuthorizationRequest *>
        let req_arr = ns_array_of_objects(&[request]);

        // Build the controller
        let ctrl_cls = class!(ASAuthorizationController);
        let ctrl_alloc: *mut AnyObject = msg_send![ctrl_cls, alloc];
        let controller: *mut AnyObject = msg_send![ctrl_alloc, initWithAuthorizationRequests: req_arr];

        // Build our delegate, then plumb sender + kind + anchor in.
        let delegate: Retained<PasskeyDelegate> = msg_send_id![PasskeyDelegate::alloc(), init];
        *delegate.ivars().sender.lock().unwrap() = Some(tx);
        // ivars are init-only via DeclaredClass; we mutate via raw
        // pointer for the kind field since rebuilding ivars after
        // init is non-trivial. Safe because we own the only ref.
        {
            let ivars_ptr = delegate.ivars() as *const DelegateIvars as *mut DelegateIvars;
            (*ivars_ptr).kind = PasskeyOp::Register;
        }
        if let Some(win) = app_handle.get_webview_window("main") {
            if let Ok(ns_win_ptr) = win.ns_window() {
                if let Some(ns_win) = Retained::retain(ns_win_ptr as *mut AnyObject) {
                    *delegate.ivars().anchor.lock().unwrap() = Some(ns_win);
                }
            }
        }

        // setDelegate + setPresentationContextProvider
        let delegate_obj: &PasskeyDelegate = &delegate;
        let _: () = msg_send![controller, setDelegate: delegate_obj];
        let _: () = msg_send![controller, setPresentationContextProvider: delegate_obj];

        // Retain controller + delegate until callback fires. See
        // KeepAlivePasskey comment above for why Box::leak instead
        // of Tauri-managed state.
        let _: &'static mut KeepAlivePasskey = Box::leak(Box::new(KeepAlivePasskey {
            _controller: controller,
            _delegate:   delegate,
        }));

        // Kick off the AS UI.
        let _: () = msg_send![controller, performRequests];
    }).map_err(|e| format!("run_on_main_thread failed: {}", e))?;

    match rx.await.map_err(|e| format!("register channel closed: {}", e))? {
        BridgeResult::Register(r) => match r {
            Ok(resp) => serde_json::to_string(&resp).map_err(|e| e.to_string()),
            Err(msg) => Err(msg),
        },
        BridgeResult::Assert(_) => Err("internal: assert result from register flow".into()),
    }
}

#[tauri::command]
pub async fn passkey_authenticate(app: AppHandle, options_json: String) -> Result<String, String> {
    let opts: AssertionOptions = serde_json::from_str(&options_json)
        .map_err(|e| format!("Invalid assertion options JSON: {}", e))?;

    let challenge = B64URL.decode(&opts.challenge).map_err(|e| format!("bad challenge: {}", e))?;
    let rp_id     = opts.rp_id;
    let allowed_ids: Vec<String> = opts.allow_credentials.into_iter().map(|c| c.id).collect();

    let (tx, rx) = tokio::sync::oneshot::channel::<BridgeResult>();
    let app_handle = app.clone();

    app.run_on_main_thread(move || unsafe {
        let rp_id_ns     = ns_string(&rp_id);
        let provider_cls = class!(ASAuthorizationPlatformPublicKeyCredentialProvider);
        let provider_alloc: *mut AnyObject = msg_send![provider_cls, alloc];
        let provider: *mut AnyObject = msg_send![provider_alloc, initWithRelyingPartyIdentifier: &*rp_id_ns];

        let challenge_ns = ns_data_from_bytes(&challenge);
        let request: *mut AnyObject = msg_send![
            provider,
            createCredentialAssertionRequestWithChallenge: &*challenge_ns
        ];

        // setAllowedCredentials — wire the descriptor list
        if !allowed_ids.is_empty() {
            let descriptors: Vec<*mut AnyObject> = allowed_ids.iter()
                .filter_map(|id| build_descriptor(id))
                .collect();
            if !descriptors.is_empty() {
                let arr = ns_array_of_objects(&descriptors);
                let _: () = msg_send![request, setAllowedCredentials: arr];
            }
        }

        let req_arr = ns_array_of_objects(&[request]);

        let ctrl_cls = class!(ASAuthorizationController);
        let ctrl_alloc: *mut AnyObject = msg_send![ctrl_cls, alloc];
        let controller: *mut AnyObject = msg_send![ctrl_alloc, initWithAuthorizationRequests: req_arr];

        let delegate: Retained<PasskeyDelegate> = msg_send_id![PasskeyDelegate::alloc(), init];
        *delegate.ivars().sender.lock().unwrap() = Some(tx);
        {
            let ivars_ptr = delegate.ivars() as *const DelegateIvars as *mut DelegateIvars;
            (*ivars_ptr).kind = PasskeyOp::Assert;
        }
        if let Some(win) = app_handle.get_webview_window("main") {
            if let Ok(ns_win_ptr) = win.ns_window() {
                if let Some(ns_win) = Retained::retain(ns_win_ptr as *mut AnyObject) {
                    *delegate.ivars().anchor.lock().unwrap() = Some(ns_win);
                }
            }
        }

        let delegate_obj: &PasskeyDelegate = &delegate;
        let _: () = msg_send![controller, setDelegate: delegate_obj];
        let _: () = msg_send![controller, setPresentationContextProvider: delegate_obj];

        let _: &'static mut KeepAlivePasskey = Box::leak(Box::new(KeepAlivePasskey {
            _controller: controller,
            _delegate:   delegate,
        }));

        let _: () = msg_send![controller, performRequests];
    }).map_err(|e| format!("run_on_main_thread failed: {}", e))?;

    match rx.await.map_err(|e| format!("authenticate channel closed: {}", e))? {
        BridgeResult::Assert(r) => match r {
            Ok(resp) => serde_json::to_string(&resp).map_err(|e| e.to_string()),
            Err(msg) => Err(msg),
        },
        BridgeResult::Register(_) => Err("internal: register result from assert flow".into()),
    }
}
