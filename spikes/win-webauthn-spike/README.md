# Windows Win32 WebAuthn — de-risking spike

Throwaway proof for the unified native sign-in project
(`aspisfile/docs/native-signin-design.md` → **Feasibility review**).
It is **not** part of the Viewer build — a standalone Cargo crate with an empty
`[workspace]` table so `src-tauri` never absorbs it.

## What it proves (the only two questions)

1. **A non-browser process can claim `origin: "https://aspisfile.com"`.**
   The spike builds its own `clientDataJSON`, calls the Win32 WebAuthn API, and
   POSTs the result to the **real** `register-verify` / `authenticate-verify`.
   Green = our server accepts a native-built response with **zero changes**.
2. **The native dialog replaces Edge/Password-Manager.** With
   `dwAuthenticatorAttachment = ANY`, watch the OS dialog: it must offer
   **Windows Hello + "use a phone or tablet" (QR) + security key**, in-app, with
   **no Edge and no "Set up a PIN for Microsoft Password Manager."**
   **Screenshot it** — that image is half the deliverable.

## Requirements
- **Windows 10 1903+ or Windows 11**, on the **real HP machine** (Hello + real
  Bluetooth for the phone/QR path — a VM won't do).
- Rust (`rustup` → stable MSVC toolchain).
- Run from a **focused terminal window**: the modal WebAuthn UI anchors to the
  foreground window (`GetForegroundWindow()`). The production bridge will pass
  the real Tauri `hWnd` instead.

## The one manual input: `ASPIS_RT` (register only)
`register-options` is authorized by a recipient **registration token (`rt`)**.
Easiest way to get one:

1. From the dashboard, send a test file to your recipient test address
   (e.g. `panog3t+winspike@gmail.com`).
2. Open the recipient email and copy the **enrollment link** — it looks like
   `https://aspisfile.com/enroll/desktop?email=...&rt=XXXXXXXX`.
3. The value after `rt=` is your token. It is short-lived — run the spike
   promptly (and the server challenge itself has a 120s TTL once options are
   fetched, so don't dawdle at the dialog).

`authenticate` mode needs no `rt` — it signs in with the passkey you just made.

## Run

```powershell
# from spikes/win-webauthn-spike
$env:ASPIS_EMAIL = "panog3t+winspike@gmail.com"
$env:ASPIS_RT    = "<paste rt from the enrollment link>"
$env:ASPIS_MODE  = "both"          # register | authenticate | both
# $env:ASPIS_BASE = "http://localhost:3000"   # optional; defaults to prod

cargo run
```

Register creates the passkey (Hello/QR/key), then immediately re-authenticates
with it. Run `ASPIS_MODE=authenticate` later to test returning-user sign-in on
its own (discoverable credential, no allow-list).

## Reading the result

- `>>> CLAIM 1 (register) PROVEN ... <<<` and the same for authenticate →
  **origin round-trip works; the design is fully greenlit.**
- A non-2xx from verify, or `success:false` → read the error:
  - origin/rpId mismatch → the make-or-break assumption is wrong (find out now).
  - UV error → authenticator didn't perform user verification.
  - attestation parse error → set/keep `ATTESTATION_CONVEYANCE_PREFERENCE_NONE`
    (already the default here); note the `attestation format =` line printed.
- **Dialog showed Edge or Password-Manager, or no QR option** → Claim 2 fails on
  this Windows build; capture what it showed.

## Caveats
- I authored this on macOS; it is written against **windows-rs 0.58**. If a
  struct field or version-constant name differs in your pinned version, the
  compiler points right at it — the shapes match `webauthn.h`. Adjust and re-run.
- Frees are intentionally skipped (process exits) to avoid version-specific
  free-function signatures. Fine for a spike; the real bridge will free.
- Throwaway: do **not** wire any of this into `App.tsx` / `src-tauri`. Green on
  both claims → build the real module mirroring the macOS bridge's contract.
