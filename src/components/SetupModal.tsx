import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "../lib/supabase";
import { useLock } from "../contexts/LockContext";

declare const __API_BASE__: string;

// Phase 1 Day 9.5 — first-time biometric / PIN setup.
//
// Rendered when useLock().setupComplete === false AND there is a
// Supabase session. Three options:
//   - Biometric (Touch ID / Windows Hello)
//   - 6-digit PIN
//   - Skip — no auto-lock
//
// On save, POSTs to /api/v1/recipient-devices/me/setup which upserts
// the recipient_devices row (biometric_enabled + pin_hash). The Skip
// path doesn't hit the server (backend rejects "no mechanism") — it
// just marks setup complete locally so LockScreen never renders.
// Mirrors the mobile SetupModal pattern.

async function getFingerprint(): Promise<string> {
  const platform = await invoke<string>("get_platform");
  const raw = `${platform}:${screen.width}x${screen.height}:${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Step = "choose" | "pin_setup" | "submitting";

export function SetupModal() {
  const { markSetupComplete } = useLock();

  const [step,          setStep]          = useState<Step>("choose");
  const [bioChose,      setBioChose]      = useState(false);
  const [pinChose,      setPinChose]      = useState(false);
  const [pin,           setPin]           = useState("");
  const [pinConfirm,    setPinConfirm]    = useState("");
  const [error,         setError]         = useState("");

  const submit = async (opts: { biometricEnabled: boolean; pinValue?: string }) => {
    setStep("submitting");
    setError("");
    try {
      const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
      const fp = await getFingerprint();

      const res = await fetch(`${__API_BASE__}/api/v1/recipient-devices/me/setup`, {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "X-App-Platform": "desktop",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          deviceFingerprint: fp,
          biometricEnabled:  opts.biometricEnabled,
          pin:               opts.pinValue,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "ok") {
        setError(json.detail || json.error || "Could not save setup.");
        setStep(opts.pinValue ? "pin_setup" : "choose");
        return;
      }
      await markSetupComplete({
        biometricEnabled: opts.biometricEnabled,
        pinSet:           !!opts.pinValue,
      });
    } catch {
      setError("Network error — try again.");
      setStep(opts.pinValue ? "pin_setup" : "choose");
    }
  };

  const proceedFromChoose = () => {
    if (!bioChose && !pinChose) {
      setError("Pick at least one option, or use Skip.");
      return;
    }
    setError("");
    if (pinChose) {
      setStep("pin_setup");
    } else {
      submit({ biometricEnabled: bioChose, pinValue: undefined });
    }
  };

  const submitPin = () => {
    if (!/^\d{6}$/.test(pin)) {
      setError("PIN must be 6 digits.");
      return;
    }
    if (pin !== pinConfirm) {
      setError("PINs do not match.");
      return;
    }
    submit({ biometricEnabled: bioChose, pinValue: pin });
  };

  const skip = () => {
    // Skip doesn't hit the server — the backend rejects no-mechanism
    // setup. We just mark setup complete locally so the LockScreen
    // never renders. Users can revisit setup later (when a manage-
    // devices UI exists; for Phase 1 this is one-way).
    markSetupComplete({ biometricEnabled: false, pinSet: false });
  };

  if (step === "submitting") {
    return (
      <div style={styles.overlay}>
        <div style={{ ...styles.card, alignItems: "center" }}>
          <p style={{ color: "#94A3B8", fontSize: 13 }}>Saving setup…</p>
        </div>
      </div>
    );
  }

  if (step === "pin_setup") {
    return (
      <div style={styles.overlay}>
        <div style={styles.card}>
          <p style={styles.title}>Set a 6-digit PIN</p>
          <p style={styles.body}>
            You will use this PIN to unlock AspisFile when {bioChose ? "biometric is unavailable" : "the app is locked"}.
          </p>

          <input
            value={pin}
            onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
            placeholder="••••••"
            type="password"
            inputMode="numeric"
            maxLength={6}
            autoFocus
            style={styles.pinInput}
          />
          <input
            value={pinConfirm}
            onChange={e => { setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
            placeholder="Confirm PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            style={styles.pinInput}
          />

          {error && <p style={styles.error}>{error}</p>}

          <button
            onClick={submitPin}
            disabled={pin.length !== 6 || pinConfirm.length !== 6}
            style={{
              ...styles.primaryBtn,
              ...(pin.length !== 6 || pinConfirm.length !== 6 ? styles.primaryBtnDisabled : {}),
            }}
          >
            Save PIN
          </button>

          <button
            onClick={() => { setStep("choose"); setPin(""); setPinConfirm(""); setError(""); }}
            style={styles.secondaryBtn}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // ── Choose-mechanism view ──
  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <p style={styles.title}>Secure AspisFile</p>
        <p style={styles.body}>
          Choose how to unlock the viewer when it's locked.
          We lock automatically after 60 seconds in the background.
        </p>

        <button
          onClick={() => setBioChose(b => !b)}
          style={{ ...styles.optionBtn, ...(bioChose ? styles.optionBtnSelected : {}) }}
        >
          <div style={styles.checkbox}>{bioChose && <span style={{ color: "#3B82F6", fontWeight: 700 }}>✓</span>}</div>
          <div style={{ flex: 1 }}>
            <div style={styles.optionTitle}>Touch ID / Windows Hello</div>
            <div style={styles.optionSub}>Fastest. Uses your device's biometric.</div>
          </div>
        </button>

        <button
          onClick={() => setPinChose(p => !p)}
          style={{ ...styles.optionBtn, ...(pinChose ? styles.optionBtnSelected : {}) }}
        >
          <div style={styles.checkbox}>{pinChose && <span style={{ color: "#3B82F6", fontWeight: 700 }}>✓</span>}</div>
          <div style={{ flex: 1 }}>
            <div style={styles.optionTitle}>6-digit PIN</div>
            <div style={styles.optionSub}>Fallback when biometric is unavailable.</div>
          </div>
        </button>

        {error && <p style={styles.error}>{error}</p>}

        <button
          onClick={proceedFromChoose}
          disabled={!bioChose && !pinChose}
          style={{
            ...styles.primaryBtn,
            ...(!bioChose && !pinChose ? styles.primaryBtnDisabled : {}),
          }}
        >
          Continue
        </button>

        <button onClick={skip} style={styles.skipBtn}>
          Skip — no auto-lock
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay:           { position: "fixed", inset: 0, zIndex: 10000, background: "#0F172A", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" },
  card:              { width: "100%", maxWidth: 380 },
  title:             { color: "#F1F5F9", fontSize: 17, fontWeight: 600, marginBottom: 8, textAlign: "center" },
  body:              { color: "#94A3B8", fontSize: 13, lineHeight: 1.6, textAlign: "center", marginBottom: 22 },
  optionBtn:         { width: "100%", display: "flex", alignItems: "center", gap: 12, padding: 14, borderRadius: 10, border: "0.5px solid rgba(255,255,255,0.12)", background: "transparent", cursor: "pointer", marginBottom: 10, textAlign: "left", fontFamily: "inherit" },
  optionBtnSelected: { borderColor: "#3B82F6", background: "rgba(59,130,246,0.08)" },
  checkbox:          { width: 22, height: 22, borderRadius: 6, border: "1px solid rgba(255,255,255,0.25)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  optionTitle:       { color: "#F1F5F9", fontSize: 13, fontWeight: 500, marginBottom: 2 },
  optionSub:         { color: "#64748B", fontSize: 11, lineHeight: 1.5 },
  pinInput:          { width: "100%", padding: "14px", borderRadius: 8, background: "rgba(255,255,255,0.05)", color: "#fff", border: "0.5px solid rgba(255,255,255,0.12)", fontSize: 20, letterSpacing: "0.4em", textAlign: "center", fontFamily: "'SF Mono','Menlo',monospace", outline: "none", boxSizing: "border-box", marginBottom: 10 },
  error:             { color: "#FCA5A5", fontSize: 11, textAlign: "center", margin: "8px 0" },
  primaryBtn:        { width: "100%", padding: "13px 14px", borderRadius: 8, marginTop: 14, marginBottom: 10, background: "#3B82F6", color: "#fff", border: "none", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" },
  primaryBtnDisabled: { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.35)", cursor: "not-allowed" },
  secondaryBtn:      { width: "100%", padding: 8, background: "transparent", color: "#94A3B8", border: "none", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
  skipBtn:           { width: "100%", padding: 8, background: "transparent", color: "rgba(255,255,255,0.35)", border: "none", fontSize: 11, cursor: "pointer", fontFamily: "inherit", marginTop: 4 },
};
