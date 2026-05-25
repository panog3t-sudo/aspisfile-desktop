import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { supabase } from "../lib/supabase";
import type { StepUpCreds } from "./StepUpScreen";

declare const __API_BASE__: string;

// Phase 1 Day 9.4 — desktop delegation confirmation gate.
//
// Rendered when /resolve-otp returned { status: 'delegation_required' }
// — the recipient verified on a different device than the one currently
// trying to view (Brief §3.4, path B). Companion to the mobile
// DelegationScreen and the web variant in ViewerClient.tsx. Same
// /acknowledge-delegation endpoint, same Bearer pattern.

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

export function DelegationScreen({
  approvalId,
  fileName,
  recipientEmail,
  onApproved,
  onCancel,
}: {
  approvalId:     string;
  fileName:       string;
  recipientEmail: string;
  onApproved:     (creds: StepUpCreds) => void;
  onCancel:       () => void;
}) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState("");

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const accessToken = (await supabase.auth.getSession()).data.session?.access_token;
      const fp = await getFingerprint();

      const res = await fetch(`${__API_BASE__}/api/v1/approvals/${approvalId}/acknowledge-delegation`, {
        method: "POST",
        headers: {
          "Content-Type":   "application/json",
          "X-App-Platform": "desktop",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ deviceFingerprint: fp }),
      });
      const json = await res.json();
      if (!res.ok || json.status !== "approved") {
        setError(json.detail || json.error || "Could not confirm.");
        return;
      }
      onApproved({
        session_id:   json.session_id,
        session_key:  json.session_key,
        device_share: json.device_share ?? null,
        file_id:      json.file_id,
        expires_at:   json.expires_at,
      });
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.card}>
        <div style={styles.iconAmber}>
          <span style={{ fontSize: 24, color: "#FCD34D" }}>⚠︎</span>
        </div>
        <p style={styles.title}>Cross-device approval detected</p>
        <p style={styles.body}>
          You verified your identity on a different device than the one you're using to view <span style={styles.emph}>{fileName || "this file"}</span>.
        </p>
        <p style={styles.body}>Confirm this is intentional to continue.</p>

        <button
          onClick={confirm}
          disabled={busy}
          style={{
            ...styles.primaryBtn,
            ...(busy ? styles.primaryBtnDisabled : {}),
          }}
        >
          {busy ? "Confirming…" : "Yes, this is me"}
        </button>

        {error && <p style={styles.error}>{error}</p>}

        <button onClick={onCancel} disabled={busy} style={styles.secondaryBtn}>
          Not me · close
        </button>

        <p style={styles.foot}>
          {recipientEmail || "this account"} · If this was not you, close and contact the sender.
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay:            { position: "fixed", inset: 0, zIndex: 9999, background: "#111111", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" },
  card:               { width: "100%", maxWidth: 380, background: "#1A1A1A", border: "0.5px solid #2A2A2A", borderRadius: 12, padding: 28 },
  iconAmber:          { width: 44, height: 44, borderRadius: 11, background: "rgba(252,211,77,0.12)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" },
  title:              { color: "#fff", fontSize: 14, fontWeight: 500, textAlign: "center", margin: "0 0 6px" },
  body:               { color: "rgba(255,255,255,0.55)", fontSize: 12, lineHeight: 1.6, textAlign: "center", margin: "0 0 6px" },
  emph:               { color: "#fff" },
  primaryBtn:         { width: "100%", padding: "11px 14px", borderRadius: 8, marginTop: 14, marginBottom: 8, background: "#3B82F6", color: "#fff", border: "none", fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" },
  primaryBtnDisabled: { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.35)", cursor: "not-allowed" },
  secondaryBtn:       { width: "100%", padding: "11px 14px", borderRadius: 8, background: "transparent", color: "rgba(255,255,255,0.55)", border: "0.5px solid rgba(255,255,255,0.08)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", marginTop: 4 },
  error:              { color: "#FCA5A5", fontSize: 11, textAlign: "center", marginBottom: 8 },
  foot:               { color: "rgba(255,255,255,0.25)", fontSize: 10, textAlign: "center", marginTop: 14, lineHeight: 1.6 },
};
