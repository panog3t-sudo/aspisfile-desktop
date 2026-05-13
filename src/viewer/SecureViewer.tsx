import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sessionStore } from "../lib/sessionStore";
import { supabase } from "../lib/supabase";
import {
  authenticateDesktop,
  FileInfo,
  RecipientInfo,
} from "../lib/desktopAuth";
import { TileRenderer } from "./TileRenderer";
import { AuthLoadingScreen } from "../components/AuthLoadingScreen";
import { RevokedScreen } from "../components/RevokedScreen";
import { LegalOverlay } from "../components/LegalOverlay";

declare const __API_BASE__: string;

type Props = {
  token: string;
  sig: string | null;
  env: string | null;
};

export function SecureViewer({ token, sig, env }: Props) {
  const [file, setFile] = useState<FileInfo | null>(null);
  const [recipient, setRecipient] = useState<RecipientInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [revokeReason, setRevokeReason] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  // Authenticate on mount
  useEffect(() => {
    authenticateDesktop(token, sig, env)
      .then(({ file: f, recipient: r }) => {
        setFile(f);
        setRecipient(r);
        if (r.legal_accepted) setLegalAccepted(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, sig, env]);

  // Start session after legal acceptance
  useEffect(() => {
    if (!legalAccepted || !file || sessionId) return;

    const platform = invoke<string>("get_platform");
    platform.then(async (p) => {
      const res = await fetch(
        `${__API_BASE__}/api/v1/access/${token}/start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-App-Platform": "desktop",
            "X-Desktop-OS": p,
          },
          body: JSON.stringify({ deviceFingerprint: null }),
        }
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Failed to start session");
        return;
      }

      const data = await res.json();
      const sid: string = data.session_id;
      setSessionId(sid);
      if (data.session?.key) sessionStore.set(data.session.key);

      // Fetch page count
      const pagesRes = await fetch(
        `${__API_BASE__}/api/v1/viewer/${file.id}/pages?session=${sid}`,
        {
          headers: {
            "X-App-Platform": "desktop",
            Authorization: `Bearer ${sessionStore.get() ?? ""}`,
          },
        }
      );
      if (pagesRes.ok) {
        const pagesData = await pagesRes.json();
        setTotalPages(pagesData.pages ?? 1);
      }
    });
  }, [legalAccepted, file, sessionId, token]);

  // Realtime revocation listener
  useEffect(() => {
    if (!sessionId || !file) return;

    const channel = supabase
      .channel(`file-${file.id}`)
      .on("broadcast", { event: "revocation" }, (payload: { payload: { reason?: string } }) => {
        setRevokeReason(payload.payload?.reason);
        setRevoked(true);
        sessionStore.clear();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [sessionId, file]);

  if (revoked) return <RevokedScreen reason={revokeReason} />;
  if (error)   return <RevokedScreen reason={error} />;
  if (!file || !recipient) return <AuthLoadingScreen />;
  if (!legalAccepted)
    return <LegalOverlay file={file} onAccept={() => setLegalAccepted(true)} />;
  if (!sessionId || totalPages === 0) return <AuthLoadingScreen />;

  return (
    <TileRenderer
      sessionId={sessionId}
      fileId={file.id}
      file={file}
      totalPages={totalPages}
    />
  );
}
