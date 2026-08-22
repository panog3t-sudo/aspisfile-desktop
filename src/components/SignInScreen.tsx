import { useState, useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { registerPasskey, PasskeyError } from "../lib/passkey";
import { saveRecipientSession } from "../lib/recipient-session";
import { passkeyIsFrictiony } from "../lib/signin-hints";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

// Native AS bridge enrolment (macOS in-window Touch ID) with Path B
// browser-redirect fallback for non-macOS or when the bridge fails.
//
// macOS happy path:
//   1. User enters email + enrolment code, clicks Continue.
//   2. POST /api/v1/enrollment-codes/redeem → registration_token (JWT, 10min).
//   3. lib/passkey.ts registerPasskey() → native AS bridge fires
//      ASAuthorizationController with the AspisFile window as anchor →
//      Touch ID prompt appears INSIDE the AspisFile window.
//   4. Server verify succeeds → authenticatePasskey() runs immediately
//      to mint a recipient session.
//   5. saveRecipientSession + onComplete().
//
// Fallback (Windows, or macOS bridge failure):
//   - openUrl(/enroll/desktop?email=…&code=…) → default browser handles
//     the ceremony and redirects back via aspisfile:// custom scheme.
//   - App.tsx's deep-link handler picks it up, calls saveRecipientSession,
//     dismisses this screen.

type Phase = "input" | "running" | "waiting_browser" | "bridge_failed";

type Props = {
  onComplete?:  () => void;
  onCancel?:    () => void;
  // Pre-fills + LOCKS the email field — passed when the viewer routed here from
  // a file (CODE_REQUIRED, or the browser-enrolment fallback) so the address
  // can't be mistyped. Absent for the idle "I have a code" path (editable).
  initialEmail?: string;
  // Access token for the file, if we came from one. Enables the "Email me a
  // code" self-service action (request-fresh-code). Absent from the idle path.
  token?: string;
  // COLD SIGN-IN — the viewer opened with no token AND no passkey (fresh install,
  // or a fallback from a failed deep-link). The recipient signs in by typing their
  // email → we email a code (the token-less /recipient/signin-code endpoint) →
  // code + Touch ID/Windows Hello → passkey → Home lists their files. This is the
  // universal "not signed in" screen; it never leaves the user in limbo.
  coldSignIn?: boolean;
  // Layer B (native consolidation): when a returning recipient CANCELLED the
  // native passkey sheet, this provides a one-tap "Sign in with your passkey"
  // retry (re-runs the sign-in). Absent for every other entry (fresh cold
  // sign-in, code-required, error fallback) — where there's no passkey to retry.
  onRetryPasskey?: () => void;
  // CODE_REQUIRED entry: the server already auto-emailed the one-time code, so
  // skip the "Email me a code" gate and open straight on "enter your code"
  // (with a "we've emailed it to you" confirmation) — no duplicate request.
  initialCodeSent?: boolean;
};

export function SignInScreen({ onComplete, onCancel, initialEmail, token, coldSignIn, onRetryPasskey, initialCodeSent }: Props) {
  // Locked when we know the recipient from the file — the code is bound to this
  // exact address, so editing it could only ever produce a mismatch.
  const emailLocked = !!initialEmail;
  const [phase, setPhase] = useState<Phase>("input");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code,  setCode]  = useState("");
  const [error, setError] = useState("");
  // "Email me a code" (request-fresh-code) state + a 60s cooldown so a stuck
  // recipient can self-serve a code without hammering the endpoint.
  // Seed "sent" state when the server already emailed the code (CODE_REQUIRED),
  // so the screen shows the "✓ emailed to you" confirmation instead of inviting
  // a fresh request.
  const [resendState,   setResendState]   = useState<"idle" | "sending" | "sent" | "error">(initialCodeSent ? "sent" : "idle");
  const [resendMsg,     setResendMsg]     = useState(initialCodeSent && initialEmail ? `Sent to ${initialEmail} — check your inbox (and spam).` : "");
  const [cooldown,      setCooldown]      = useState(0);
  const [showWrongAddr, setShowWrongAddr] = useState(false);
  // Gate: "Do you have a setup code?" — null = ask; non-null = show the entry
  // form. Only asked when we can actually send one (token present); the idle
  // path (a recipient who already has a code from their email) skips straight
  // to entry so a code-holder isn't slowed by an extra question.
  // Skip the "Email me a code" gate when the server already sent one
  // (initialCodeSent) — go straight to the code-entry screen.
  const [hasCode, setHasCode] = useState<boolean | null>(token && !initialCodeSent ? null : true);
  // Stash the registration token after a successful redeem so that
  // a bridge failure can fall back to the browser using the SAME rt
  // — the original code is single-use and already consumed by the
  // time we know the bridge failed.
  const [pendingRt, setPendingRt] = useState<string | null>(null);
  // True once we have waited long enough that the protocol handoff is very
  // unlikely to arrive — flips the waiting copy from "hang tight" to
  // actionable rather than spinning forever.
  const [handoffSlow, setHandoffSlow] = useState(false);
  // OS for copy — Touch ID (macOS) vs Windows Hello. Read once on mount so the
  // sign-in copy is correct on both (the old screen hard-coded "Mac"/"Touch ID").
  const [platform, setPlatform] = useState<"macos" | "windows" | "unknown">("unknown");
  useEffect(() => {
    invoke<string>("get_platform").then((p) => setPlatform(p === "macos" ? "macos" : p === "windows" ? "windows" : "unknown")).catch(() => {});
  }, []);
  const bio = platform === "macos" ? "Touch ID" : platform === "windows" ? "Windows Hello" : "Touch ID or Windows Hello";
  // #5 — smart emphasis. When a passkey retry is on offer (the user just
  // cancelled a native sheet) we normally lead with it. But once they've
  // cancelled it a couple of times on this device, stop pushing the same wall:
  // the email-code path becomes the primary and the passkey retry demotes to a
  // quiet link. Read once at mount — the counter only changes between mounts.
  const [preferCode] = useState(() => !!onRetryPasskey && passkeyIsFrictiony());

  // ── Poll fallback for the browser handoff ────────────────────────────
  // The browser is supposed to fire aspisfile://enrol-complete when the
  // WebAuthn ceremony finishes. That protocol handoff was the ONLY way back
  // into the app: no fallback, no timeout. Managed machines routinely block
  // custom protocol handlers (same class of policy that blocks Windows Hello
  // PIN setup), and when blocked the recipient completes enrolment, the
  // server stores a valid passkey, and this screen spins forever.
  //
  // So while we wait, ask the server directly. Auth is the same registration
  // token the browser is using, so this grants nothing extra — the token
  // already authorises creating a credential, which is strictly more than
  // being handed a session for one.
  //
  // Whichever arrives first wins; the deep link stays the fast path.
  const pollingRef = useRef(false);
  useEffect(() => {
    if (phase !== "waiting_browser" || !pendingRt) return;
    let cancelled = false;
    pollingRef.current = true;

    const slowTimer = window.setTimeout(() => { if (!cancelled) setHandoffSlow(true); }, 25_000);

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`${BASE}/api/v1/recipient-passkeys/enrol-status`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${pendingRt}` },
        });
        if (res.status === 401) {
          // Registration token expired — stop; retrying a dead token forever
          // is exactly the failure this exists to remove.
          if (!cancelled) {
            setError("That took too long. Enter your email and a new code to start again.");
            setPhase("input");
          }
          return;
        }
        if (res.ok) {
          const j = await res.json().catch(() => ({} as any));
          if (j?.status === "complete" && j.session_token && j.email && j.passkey_id) {
            if (cancelled) return;
            saveRecipientSession({
              email:     j.email,
              token:     j.session_token,
              passkeyId: j.passkey_id,
              expiresIn: Number.isFinite(j.expires_in) && j.expires_in > 0 ? j.expires_in : 28800,
            });
            onComplete?.();
            return;
          }
        }
      } catch {
        // Offline or transient — keep polling; the interval handles retry.
      }
      if (!cancelled) window.setTimeout(tick, 2_000);
    };
    window.setTimeout(tick, 2_000);

    return () => {
      cancelled = true;
      pollingRef.current = false;
      window.clearTimeout(slowTimer);
      setHandoffSlow(false);
    };
  }, [phase, pendingRt, onComplete]);

  // Cooldown ticker for the "Email me a code" button.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  // Self-service: email a fresh one-time code to the file's BOUND recipient.
  // request-fresh-code always sends to the token's recipient_email (never an
  // address typed here), so this can't be used to redirect a code to a
  // forwarder — it only ever helps the real invitee.
  async function handleResend() {
    if (resendState === "sending" || cooldown > 0) return;
    // Cold sign-in (no token): email a code to the typed address via the
    // token-less endpoint. Requires a valid email first.
    const cleanEmail = email.trim().toLowerCase();
    if (!token && coldSignIn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setResendState("error");
      setResendMsg("Enter the email your file was sent to, then request a code.");
      return;
    }
    if (!token && !coldSignIn) return;   // no way to send without a token or cold mode
    setResendState("sending");
    setError("");
    try {
      const res = token
        ? await fetch(`${BASE}/api/v1/access/${token}/request-fresh-code`, { method: "POST" })
        : await fetch(`${BASE}/api/v1/recipient/signin-code`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: cleanEmail }),
          });
      if (res.ok) {
        setResendState("sent");
        // Cold sign-in (no token) hits /recipient/signin-code, which only emails
        // an address that actually has files — and returns the SAME generic 200
        // either way (enumeration-safe). So we must NOT claim a code was sent;
        // use a non-revealing message that never leaks whether files exist.
        if (!token) {
          setResendMsg(
            cleanEmail
              ? `If ${cleanEmail} has files shared with it, we've sent a code — check your inbox and spam. No code? Make sure it's the exact address the file was shared to.`
              : "If that address has files shared with it, we've sent a code — check your inbox and spam.",
          );
        } else {
          setResendMsg(
            cleanEmail
              ? `Sent to ${cleanEmail} — check your inbox (and spam).`
              : "Sent — check your inbox (and spam).",
          );
        }
        setCooldown(60);
      } else if (res.status === 429) {
        setResendState("error");
        setResendMsg("You've asked for a few codes already. Check your inbox, or wait a minute and try again.");
        setCooldown(60);
      } else {
        setResendState("error");
        setResendMsg("Couldn't send a code right now. Please try again in a moment.");
      }
    } catch {
      setResendState("error");
      setResendMsg("Network error — check your connection and try again.");
    }
  }

  // "No — email me a code": send one, then drop straight onto the entry form
  // (the "✓ Sent" banner shows there) so the recipient never faces an empty
  // code field with no way to get a code.
  async function handleNoCode() {
    if (resendState === "sending") return;
    await handleResend();
    setHasCode(true);
  }

  async function openBrowserWith(params: Record<string, string>) {
    const url = new URL(`${BASE}/enroll/desktop`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      await openUrl(url.toString());
      setPhase("waiting_browser");
    } catch {
      setError("Could not open your browser. Copy and open this link manually: " + url.toString());
      setPhase("input");
    }
  }

  // Windows / non-macOS enrolment.
  //
  // The app redeems the code ITSELF to get a registration token, then hands
  // the browser that `rt` (not the raw code). Two reasons this matters:
  //
  //  1. The poll fallback (above) is gated on `pendingRt`. If we open the
  //     browser with the raw code, the token is minted inside the browser and
  //     the app never has it — so polling silently never runs, and the ONLY
  //     way back is the aspisfile:// deep link. On a machine that blocks
  //     custom protocol handlers the viewer then hangs on "Complete in your
  //     browser" forever (observed on a school-managed Windows PC 2026-07-22).
  //     Redeeming here gives us the rt, so polling works even if the deep link
  //     never fires.
  //  2. /enroll/desktop accepts `rt` and skips redemption when present, so the
  //     already-consumed one-time code is never re-submitted.
  async function fallbackToBrowser(cleanEmail: string, cleanCode: string) {
    // If we already hold an rt (e.g. a macOS bridge failure fell through with
    // pendingRt set), reuse it rather than burning a second code.
    let rt = pendingRt;
    if (!rt) {
      try {
        const redeemRes = await fetch(`${BASE}/api/v1/enrollment-codes/redeem`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ email: cleanEmail, code: cleanCode }),
        });
        const redeemJson = await redeemRes.json().catch(() => ({} as any));
        if (!redeemRes.ok || !redeemJson.success) {
          setError("That code didn't work. Check it or ask the sender to resend.");
          setPhase("input");
          return;
        }
        rt = redeemJson.registration_token;
        setPendingRt(rt);
      } catch {
        setError("Network error. Try again.");
        setPhase("input");
        return;
      }
    }
    // Hand the browser the rt (not the code) — it uses it directly.
    await openBrowserWith({ email: cleanEmail, rt: rt! });
  }

  async function handleSubmit() {
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode  = code.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError("Enter a valid email.");
      return;
    }
    if (!cleanCode) {
      setError("Enter the setup code.");
      return;
    }
    // Fast client-side format check — codes look like "word-word-1234". Catches
    // a typo or a half-pasted code before the round-trip; the server still
    // validates the code authoritatively.
    if (!/^[a-z]+-[a-z]+-\d{4}$/.test(cleanCode)) {
      setError("That doesn't look like a full setup code — it should be two words + 4 digits (like word-word-1234). Check your email.");
      return;
    }

    setError("");
    setPhase("running");

    // Native bridge attempt — macOS only. On non-macOS, get_platform
    // returns "windows" and we skip straight to the browser path.
    let platform = "unknown";
    try { platform = await invoke<string>("get_platform"); } catch {}

    if (platform !== "macos") {
      await fallbackToBrowser(cleanEmail, cleanCode);
      return;
    }

    // 1. Redeem the code for a registration token.
    let registrationToken: string;
    try {
      const redeemRes = await fetch(`${BASE}/api/v1/enrollment-codes/redeem`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email: cleanEmail, code: cleanCode }),
      });
      const redeemJson = await redeemRes.json().catch(() => ({} as any));
      if (!redeemRes.ok || !redeemJson.success) {
        setError("That code didn't work. Check it or ask the sender to resend.");
        setPhase("input");
        return;
      }
      registrationToken = redeemJson.registration_token;
      setPendingRt(registrationToken);
    } catch (err: any) {
      setError("Network error. Try again.");
      setPhase("input");
      return;
    }

    // 2. Native AS bridge → in-window Touch ID, then server verify.
    try {
      await registerPasskey({
        email:             cleanEmail,
        registrationToken,
        deviceLabel:       "AspisFile Mac",
      });
    } catch (err: any) {
      // Cancelled by user — back to the form, keep pendingRt so they
      // can retry in-app or switch to browser without re-redeeming.
      if (err instanceof PasskeyError && err.kind === "cancelled") {
        setError("");
        setPhase("input");
        return;
      }
      // Bridge failed for any other reason. Show the underlying error
      // and offer the browser fallback using the same registration
      // token (the code is consumed but the rt is still valid for 10min).
      const detail = err instanceof PasskeyError
        ? `${err.kind}: ${err.message}`
        : String(err?.message ?? err ?? "unknown error");
      // Log for support; the recipient sees only the friendly fallback copy.
      console.error("[enrolment] native bridge failed:", detail);
      setPhase("bridge_failed");
      return;
    }

    // registerPasskey already saved the recipient session (server
    // returns session_token at register-verify), so no second AS
    // ceremony is needed.
    onComplete?.();
  }

  function handleRestart() {
    setPhase("input");
    setError("");
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0F172A",
        color: "#E2E8F0",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        padding: 32,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "rgba(255,255,255,0.03)",
          border: "0.5px solid rgba(255,255,255,0.12)",
          borderRadius: 14,
          padding: 32,
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 8 }}>🔒</div>

        {/* Gate — "Do you have a setup code?" Only shown with a token (file
            context); the idle path skips straight to entry. */}
        {phase === "input" && hasCode === null && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px", color: "#F1F5F9" }}>
              Sign in to AspisFile Viewer
            </h1>

            {/* Cancel context (onRetryPasskey), first attempts: lead with a
                one-tap passkey retry — the user just fumbled the native sheet, so
                this is the fastest way back in. The email-code path sits below as
                the fallback. #5: once they've cancelled a few times, `preferCode`
                flips and we DON'T lead with the passkey wall (handled below). */}
            {onRetryPasskey && !preferCode && (
              <>
                <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 12px" }}>
                  The sign-in prompt closed or timed out — that&apos;s easy to fix.
                </p>
                <button onClick={onRetryPasskey} style={btnPrimary}>
                  Sign in with your passkey
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px" }}>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.10)" }} />
                  <span style={{ fontSize: 11, color: "#64748B" }}>or use an email code</span>
                  <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.10)" }} />
                </div>
              </>
            )}

            {/* #5 escalated: the passkey sheet keeps getting cancelled on this
                device, so lead with the code path instead of the same wall. */}
            {onRetryPasskey && preferCode && (
              <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 12px" }}>
                Passkey not working on this device? Get a one-time code by email instead.
              </p>
            )}

            <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 14px" }}>
              We&apos;ll email a one-time code {emailLocked ? "to the address below" : "to the address this file was shared with"}, then confirm with {bio}.
            </p>

            {emailLocked && (
              <>
                <div style={lockedEmailRow}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
                  <span aria-hidden style={{ fontSize: 12, color: "#64748B", flexShrink: 0 }}>🔒</span>
                </div>
                <button onClick={() => setShowWrongAddr((v) => !v)} style={linkBtn}>Wrong address?</button>
                {showWrongAddr && (
                  <p style={{ fontSize: 11.5, color: "#94A3B8", lineHeight: 1.5, margin: "6px 0 0" }}>
                    This file was shared with {email}. If that isn&apos;t you, ask the sender to resend it to your
                    correct address — the code only works for the invited email.
                  </p>
                )}
              </>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 20 }}>
              <button
                onClick={handleNoCode}
                disabled={resendState === "sending"}
                style={onRetryPasskey && !preferCode ? btnSecondary : btnPrimary}
              >
                {resendState === "sending" ? "Sending…" : "Email me a code"}
              </button>
              <button onClick={() => { setError(""); setHasCode(true); }} style={linkBtn}>
                I already have a code
              </button>
              {/* #5 escalated: passkey retry is still available, just demoted. */}
              {onRetryPasskey && preferCode && (
                <button onClick={onRetryPasskey} style={{ ...linkBtn, marginTop: 4 }}>
                  Or try your passkey again
                </button>
              )}
            </div>

            {onCancel && (
              <button onClick={onCancel} style={{ ...linkBtn, marginTop: 16 }}>Cancel</button>
            )}
          </>
        )}

        {/* Entry — enter the code + confirm with Touch ID. */}
        {phase === "input" && hasCode !== null && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 6px", color: "#F1F5F9" }}>
              {coldSignIn && !emailLocked ? "Sign in to AspisFile Viewer" : "Enter your setup code"}
            </h1>

            {/* The "Sign in with your passkey" retry now lives on the first
                (gate) screen above, so a cancelled user sees it immediately
                rather than behind the code choice. */}

            {emailLocked ? (
              <>
                <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 8px" }}>
                  Your setup code is emailed to:
                </p>
                <div style={lockedEmailRow}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</span>
                  <span aria-hidden style={{ fontSize: 12, color: "#64748B", flexShrink: 0 }}>🔒</span>
                </div>
                <button onClick={() => setShowWrongAddr((v) => !v)} style={linkBtn}>Wrong address?</button>
                {showWrongAddr && (
                  <p style={{ fontSize: 11.5, color: "#94A3B8", lineHeight: 1.5, margin: "6px 0 0" }}>
                    This file was shared with {email}. If that isn&apos;t you, ask the sender to resend it to your
                    correct address — the code only works for the invited email.
                  </p>
                )}
                <p style={{ fontSize: 13, color: resendState === "sent" ? "#86EFAC" : "#94A3B8", lineHeight: 1.6, margin: "16px 0 0" }}>
                  {resendState === "sent"
                    ? `✓ ${resendMsg} Enter it below — we'll ask for ${bio} to finish.`
                    : <>Check your inbox (and spam) for your code, then enter it below. We&apos;ll ask for {bio} to finish.</>}
                </p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 16px" }}>
                  {coldSignIn
                    ? <>Sign in with the email your files were shared to, and we&apos;ll open them here. Enter a code you already have, or tap &ldquo;Email me a code&rdquo;.</>
                    : <>Enter your email and the setup code from your inbox. We&apos;ll ask for {bio} to finish.</>}
                </p>
                {coldSignIn && (
                  <p style={{ fontSize: 12, color: "#64748B", lineHeight: 1.7, margin: "0 0 18px" }}>
                    <b style={{ color: "#94A3B8" }}>1.</b> Enter your email &nbsp;·&nbsp; <b style={{ color: "#94A3B8" }}>2.</b> Enter a code you have, or email yourself one &nbsp;·&nbsp; <b style={{ color: "#94A3B8" }}>3.</b> Confirm with {bio}
                  </p>
                )}
                <Label>Email address</Label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value.toLowerCase()); setError(""); }}
                  placeholder="Enter your email address"
                  style={inputStyle}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
                {coldSignIn && (
                  <>
                    <button
                      onClick={handleResend}
                      disabled={resendState === "sending" || cooldown > 0}
                      // Progressive emphasis: this is the primary (blue) action while
                      // it's the user's real next step — no code emailed yet AND none
                      // typed. Once a code is sent or entered, it steps back to muted
                      // and "Continue" becomes the primary instead.
                      style={{ ...(resendState !== "sent" && code.trim().length === 0 ? btnPrimary : btnSecondary), marginTop: 10, opacity: (resendState === "sending" || cooldown > 0) ? 0.5 : 1 }}
                    >
                      {resendState === "sending" ? "Sending…" : cooldown > 0 ? `Email me a code (${cooldown}s)` : "Email me a code"}
                    </button>
                    {resendMsg && (
                      <p style={{ fontSize: 12, color: resendState === "sent" ? "#86EFAC" : "#FCA5A5", lineHeight: 1.5, margin: "8px 0 0" }}>
                        {resendState === "sent" ? "✓ " : ""}{resendMsg}
                      </p>
                    )}
                    <p style={{ fontSize: 11.5, color: "#64748B", margin: "10px 0 0", lineHeight: 1.5 }}>
                      Use the same address the sender shared the file with. The code expires in 15 minutes.
                    </p>
                  </>
                )}
              </>
            )}

            <Label>Setup code</Label>
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\s+/g, "").toLowerCase()); setError(""); }}
              placeholder="Add your code here"
              style={{ ...inputStyle, fontFamily: "Menlo, Monaco, 'Courier New', monospace", letterSpacing: 1 }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={emailLocked}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
            />

            {error ? <p style={{ color: "#FCA5A5", fontSize: 12, marginTop: 14, lineHeight: 1.5 }}>{error}</p> : null}

            <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
              {onCancel && (
                <button onClick={onCancel} style={btnSecondary}>Cancel</button>
              )}
              {/* Progressive emphasis: "Continue" only lights up (blue) once a code
                  has been entered — before that there's nothing to continue with, so
                  it stays muted and the eye goes to "Email me a code" above. Still
                  clickable when empty so handleSubmit can show the "enter a code"
                  hint if the user jumps ahead. */}
              <button onClick={handleSubmit} style={code.trim().length > 0 ? btnPrimary : btnSecondary}>Continue</button>
            </div>

            {/* Re-request — only when we have a token to scope it. The gate
                already asked; this covers "the code never arrived". */}
            {token && (
              <div style={{ marginTop: 18, paddingTop: 16, borderTop: "0.5px solid rgba(255,255,255,0.08)" }}>
                {resendState === "error" && (
                  <p style={{ fontSize: 12, color: "#FCA5A5", lineHeight: 1.5, margin: "0 0 6px" }}>{resendMsg}</p>
                )}
                {(resendState === "idle" || resendState === "sent") && (
                  <p style={{ fontSize: 12, color: "#94A3B8", margin: "0 0 6px" }}>Didn&apos;t get the code?</p>
                )}
                <button
                  onClick={handleResend}
                  disabled={resendState === "sending" || cooldown > 0}
                  style={{ ...linkBtn, opacity: (resendState === "sending" || cooldown > 0) ? 0.5 : 1 }}
                >
                  {resendState === "sending" ? "Sending…"
                    : cooldown > 0 ? `Resend in ${cooldown}s`
                    : resendState === "sent" ? "Send another code"
                    : "Email me a code"}
                </button>
              </div>
            )}

            <p style={{ fontSize: 11, color: "#64748B", marginTop: 18, lineHeight: 1.5 }}>
              Codes expire 15 minutes after they&apos;re emailed, or 24 hours after the sender shows them. Single-use.
            </p>
          </>
        )}

        {phase === "running" && (
          <div style={{ textAlign: "center", padding: "8px 0 0" }}>
            <div
              style={{
                width: 32, height: 32, borderRadius: 16,
                border: "3px solid rgba(255,255,255,0.12)",
                borderTopColor: "#86EFAC",
                margin: "0 auto 18px",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>
              Confirm with Touch ID
            </h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 20px" }}>
              Approve the system prompt to finish signing in.
            </p>
          </div>
        )}

        {phase === "bridge_failed" && (
          <div style={{ padding: "8px 0 0" }}>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>
              In-window Touch ID didn&apos;t work
            </h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 18px" }}>
              We&apos;ll finish in your browser instead — your code is still valid.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={handleRestart} style={btnSecondary}>Use a different code</button>
              <button
                onClick={async () => {
                  if (pendingRt) {
                    await openBrowserWith({ email: email.trim().toLowerCase(), rt: pendingRt });
                  } else {
                    await fallbackToBrowser(email.trim().toLowerCase(), code.trim());
                  }
                }}
                style={btnPrimary}
              >
                Continue in browser
              </button>
            </div>
          </div>
        )}

        {phase === "waiting_browser" && (
          <div style={{ textAlign: "center", padding: "8px 0 0" }}>
            <div
              style={{
                width: 32, height: 32, borderRadius: 16,
                border: "3px solid rgba(255,255,255,0.12)",
                borderTopColor: "#86EFAC",
                margin: "0 auto 18px",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#F1F5F9", margin: "0 0 8px" }}>
              Complete in your browser
            </h2>
            <p style={{ fontSize: 12, color: "#94A3B8", lineHeight: 1.6, margin: "0 0 20px" }}>
              {handoffSlow
                ? "Still waiting. If you\u2019ve already confirmed in the browser, this will finish on its own in a few seconds \u2014 we\u2019re checking with the server directly. Your browser may also be asking permission to reopen AspisFile Viewer; allow it if so."
                : <>We&apos;ve opened a secure sign-in page in your default browser. Confirm there using Touch ID, Windows Hello, your phone or a security key &mdash; AspisFile Viewer will take over automatically when you&apos;re done.</>}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={handleRestart} style={btnSecondary}>Use a different code</button>
              {onCancel && (
                <button onClick={onCancel} style={btnSecondary}>Cancel</button>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <p style={{ fontSize: 10, fontWeight: 500, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.6, margin: "12px 0 6px" }}>
      {children}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)",
  background: "rgba(255,255,255,0.04)",
  color: "#E2E8F0",
  fontSize: 14,
  outline: "none",
  fontFamily: "inherit",
};

const btnPrimary: React.CSSProperties = {
  flex: 1,
  padding: "10px 16px",
  borderRadius: 8,
  border: "none",
  background: "#185FA5",
  color: "#fff",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const lockedEmailRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.02)",
  color: "#CBD5E1",
  fontSize: 14,
};

const linkBtn: React.CSSProperties = {
  padding: 0,
  border: "none",
  background: "transparent",
  color: "#7DB1E8",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  textAlign: "left",
};

const btnSecondary: React.CSSProperties = {
  flex: 1,
  padding: "10px 16px",
  borderRadius: 8,
  border: "0.5px solid rgba(255,255,255,0.18)",
  background: "transparent",
  color: "#E2E8F0",
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};
