import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";

declare const __API_BASE__: string;

async function getDesktopFingerprint(): Promise<string> {
  const platform = await invoke<string>("get_platform");
  const raw = `${platform}:${screen.width}x${screen.height}:${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }`;
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type FileInfo = {
  id: string;
  name: string;
  file_type: string;
  file_size: number;
  allow_download: boolean;
  allow_print: boolean;
  watermark: boolean;
  one_time: boolean;
  personal_message: string | null;
  sender: { full_name: string | null; email: string } | null;
  is_owner: boolean;
};

export type RecipientInfo = {
  id: string;
  email: string;
  legal_accepted: boolean;
  one_time_used: boolean;
  // Sprint 2 — download state machine. Owner tokens come back with
  // recipient_allow_download:false → button hidden for owners (combined
  // with FileInfo.is_owner check in SecureViewer).
  recipient_allow_download: boolean;
  download_confirmed_at:    string | null;
  download_in_progress:     boolean;
  download_initiated_at:    string | null;
};

export async function authenticateDesktop(
  token: string,
  sig: string | null,
  env: string | null
): Promise<{ file: FileInfo; recipient: RecipientInfo }> {
  const platform = await invoke<string>("get_platform");
  const fingerprint = await getDesktopFingerprint();

  const url =
    sig && env
      ? `${__API_BASE__}/api/v1/access/${token}?sig=${sig}&env=${env}`
      : `${__API_BASE__}/api/v1/access/${token}`;

  const res = await fetch(url, {
    headers: {
      "X-App-Platform": "desktop",
      "X-Desktop-OS": platform,
      "X-Device-Fingerprint": fingerprint,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Access denied (${res.status})`);
  }

  const data = await res.json();
  // Note: /api/v1/access/<token> returns file + recipient metadata only.
  // Session credentials are minted later by /api/v1/mobile/access/<token>
  // (called from SecureViewer post-legal-acceptance), where the actual
  // viewer_sessions row is created. The previous `data.session?.key`
  // block here was dead code from an older single-call design.
  return { file: data.file, recipient: data.recipient };
}
