import { invoke } from "@tauri-apps/api/core";
import { sessionStore } from "./sessionStore";

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
};

export type RecipientInfo = {
  id: string;
  email: string;
  legal_accepted: boolean;
  one_time_used: boolean;
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
  if (data.session?.key) {
    sessionStore.set(data.session.key);
  }
  return { file: data.file, recipient: data.recipient };
}
