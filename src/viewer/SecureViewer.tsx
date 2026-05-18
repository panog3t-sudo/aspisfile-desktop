import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sessionStore } from "../lib/sessionStore";
import { supabase } from "../lib/supabase";
import { authenticateDesktop, FileInfo, RecipientInfo } from "../lib/desktopAuth";
import { TileRenderer } from "./TileRenderer";
import { AuthLoadingScreen } from "../components/AuthLoadingScreen";
import { RevokedScreen } from "../components/RevokedScreen";
import { LegalOverlay } from "../components/LegalOverlay";
import { LockScreen } from "../components/LockScreen";
import { CoViewingBanner }    from "../coviewing/CoViewingBanner";
import { CoViewingRecipient } from "../coviewing/CoViewingRecipient";
import { PresenterToolbar }   from "../coviewing/PresenterToolbar";
import { StartSessionModal }  from "../coviewing/StartSessionModal";
import { SessionEndedScreen } from "../coviewing/SessionEndedScreen";

const IDLE_MS   = 2 * 60 * 1000; // lock after 2 min inactivity
const BLUR_MS   = 30 * 1000;      // lock 30s after window loses focus

function useLockGuard(enabled: boolean, onLock: () => void) {
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  useEffect(() => {
    if (!enabled) return;

    let idleTimer: number;
    let blurTimer: number;

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => onLockRef.current(), IDLE_MS);
    };
    const handleBlur  = () => { blurTimer = window.setTimeout(() => onLockRef.current(), BLUR_MS); };
    const handleFocus = () => clearTimeout(blurTimer);

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;
    events.forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));
    window.addEventListener("blur",  handleBlur);
    window.addEventListener("focus", handleFocus);
    resetIdle();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(blurTimer);
      events.forEach((e) => document.removeEventListener(e, resetIdle));
      window.removeEventListener("blur",  handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled]);
}

declare const __API_BASE__: string;

async function getDesktopFingerprint(platform: string): Promise<string> {
  const raw = `${platform}:${screen.width}x${screen.height}:${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  }`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Props = {
  token: string;
  sig: string | null;
  env: string | null;
  onClose: () => void;
  present?: boolean;                  // deep link wants presenter modal
  coviewSessionId?: string | null;    // deep link wants auto-join
};

export function SecureViewer({ token, sig, env, onClose, present, coviewSessionId }: Props) {
  const [file, setFile]               = useState<FileInfo | null>(null);
  const [recipient, setRecipient]     = useState<RecipientInfo | null>(null);
  const [sessionId, setSessionId]     = useState<string | null>(null);
  const [totalPages, setTotalPages]   = useState(0);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [revoked, setRevoked]         = useState(false);
  const [revokeReason, setRevokeReason] = useState<string | undefined>();
  const [error, setError]             = useState<string | null>(null);
  const [locked, setLocked]           = useState(false);
  const startedRef                    = useRef(false);

  // Co-viewing recipient state
  const [coViewingBanner, setCoViewingBanner] = useState<{
    sessionId:     string;
    presenterName: string;
    currentPage:   number;
    channel:       string;
  } | null>(null);
  const [activeCoViewSessionId, setActiveCoViewSessionId] = useState<string | null>(null);
  const [followingPresenter, setFollowingPresenter] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);

  // Co-viewing presenter state
  const [showStartModal, setShowStartModal] = useState(false);
  const [presenterSession, setPresenterSession] = useState<{
    sessionId: string; channel: string;
    mode: 'synchronized' | 'free'; context: 'standalone' | 'teams' | 'zoom';
  } | null>(null);

  // Step 10d — lifted from TileRenderer so the presenter toolbar / recipient
  // page sync can read and control it.
  const [currentPage, setCurrentPage] = useState(1);
  // Step 10d — channel returned by /co-viewing/join, used by CoViewingRecipient.
  const [coViewingChannel, setCoViewingChannel] = useState<string | null>(null);

  const canPresent = file?.is_owner === true;

  const isViewing = !!(sessionId && totalPages > 0 && !locked);
  useLockGuard(isViewing, useCallback(() => setLocked(true), []));

  // Step 1: fetch file + recipient info (no auth required)
  useEffect(() => {
    authenticateDesktop(token, sig, env)
      .then(({ file: f, recipient: r }) => {
        setFile(f);
        setRecipient(r);
        if (r.legal_accepted) setLegalAccepted(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, sig, env]);

  // Step 2: start session after legal acceptance — uses mobile/desktop token-auth route
  useEffect(() => {
    if (!legalAccepted || !file || startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const platform = await invoke<string>("get_platform");
      const fingerprint = await getDesktopFingerprint(platform);

      const res = await fetch(`${__API_BASE__}/api/v1/mobile/access/${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Platform": "desktop",
          "X-Desktop-OS": platform,
          "User-Agent": navigator.userAgent,
        },
        body: JSON.stringify({ sig, env, deviceFingerprint: fingerprint }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Session start failed (${res.status})`);
        return;
      }

      const data = await res.json();

      if (data.status === "pending_approval") {
        setError("Access pending sender approval. Please try again shortly.");
        startedRef.current = false;
        return;
      }

      sessionStore.set(data.session_key, data.device_share ?? null);
      setSessionId(data.session_id);

      // Fetch page count
      const pageHeaders: Record<string, string> = {
        "X-App-Platform": "desktop",
        Authorization: `Bearer ${data.session_key}`,
        "X-Device-Fingerprint": fingerprint,
      };
      if (data.device_share) pageHeaders["X-Device-Share"] = data.device_share;

      const pagesRes = await fetch(
        `${__API_BASE__}/api/v1/viewer/${file.id}/pages?session=${data.session_id}`,
        { headers: pageHeaders }
      );
      if (pagesRes.ok) {
        const pagesData = await pagesRes.json();
        setTotalPages(pagesData.count ?? 1);
      }
    })().catch((e: Error) => setError(e.message));
  }, [legalAccepted, file, token, sig, env]);

  // Realtime revocation listener
  useEffect(() => {
    if (!sessionId || !file) return;

    const channel = supabase
      .channel(`file-${file.id}`)
      .on("broadcast", { event: "revocation" }, (payload: { payload?: { reason?: string } }) => {
        setRevokeReason(payload.payload?.reason);
        setRevoked(true);
        sessionStore.clear();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [sessionId, file]);

  // Co-viewing recipient subscription — email-based channel because desktop has
  // no Supabase auth → no user.id. Server broadcasts to both user-id and email
  // channels (app/api/v1/co-viewing/start/route.ts).
  useEffect(() => {
    if (!recipient?.email || !file?.id) return;

    const channel = supabase
      .channel(`notifications-${recipient.email}`)
      .on('broadcast', { event: 'co_viewing_started' }, ({ payload }: { payload: any }) => {
        if (payload.file_id !== file.id) return;
        setCoViewingBanner({
          sessionId:     payload.session_id,
          presenterName: payload.presenter_name,
          currentPage:   payload.current_page,
          channel:       payload.channel,
        });
      })
      .on('broadcast', { event: 'co_viewing_ended' }, ({ payload }: { payload: any }) => {
        if (payload.session_id !== activeCoViewSessionId) return;
        setActiveCoViewSessionId(null);
        setCoViewingBanner(null);
        setSessionEnded(true);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [recipient?.email, file?.id, activeCoViewSessionId]);

  // Auto-open presenter modal when arriving from a "Present this file" deep link
  useEffect(() => {
    if (present && canPresent && !presenterSession) {
      setShowStartModal(true);
    }
  }, [present, canPresent, presenterSession]);

  // Auto-join when arriving from a co-viewing session deep link
  useEffect(() => {
    if (!coviewSessionId) return;
    if (!recipient || !file || !sessionId) return;
    if (activeCoViewSessionId) return;
    joinCoViewingSession(coviewSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coviewSessionId, recipient, file, sessionId, activeCoViewSessionId]);

  async function joinCoViewingSession(sessId: string) {
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessId}/join`, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': token,
        },
      });

      if (!res.ok) {
        setCoViewingBanner(null);
        return;
      }

      const data = await res.json();
      setActiveCoViewSessionId(sessId);
      setCoViewingChannel(data.channel ?? null);
      setFollowingPresenter(true);
      setCoViewingBanner(null);
      if (typeof data.current_page === 'number') setCurrentPage(data.current_page);
    } catch {
      setCoViewingBanner(null);
    }
  }

  if (revoked)                        return <RevokedScreen reason={revokeReason} />;
  if (error)                          return <RevokedScreen reason={error} isError />;
  if (!file || !recipient)            return <AuthLoadingScreen />;
  if (!legalAccepted)                 return <LegalOverlay file={file} onAccept={() => setLegalAccepted(true)} />;
  if (!sessionId || totalPages === 0) return <AuthLoadingScreen />;

  return (
    <>
      {coViewingBanner && !canPresent && !presenterSession && (
        <CoViewingBanner
          presenterName={coViewingBanner.presenterName}
          currentPage={coViewingBanner.currentPage}
          onFollow={() => joinCoViewingSession(coViewingBanner.sessionId)}
          onDismiss={() => setCoViewingBanner(null)}
        />
      )}

      <TileRenderer
        sessionId={sessionId}
        fileId={file.id}
        file={file}
        totalPages={totalPages}
        onClose={onClose}
        onLock={() => setLocked(true)}
        targetPage={currentPage}
        onCurrentPageChange={setCurrentPage}
      />

      {presenterSession && (
        <PresenterToolbar
          sessionId={presenterSession.sessionId}
          channel={presenterSession.channel}
          fileId={file.id}
          mode={presenterSession.mode}
          context={presenterSession.context}
          currentPage={currentPage}
          pageCount={totalPages}
          onPageChange={setCurrentPage}
          onStop={() => setPresenterSession(null)}
        />
      )}

      {activeCoViewSessionId && coViewingChannel && (
        <CoViewingRecipient
          channel={coViewingChannel}
          mode="synchronized"
          following={followingPresenter}
          onPageChange={(page) => setCurrentPage(page)}
          onSessionEnd={() => setSessionEnded(true)}
          onToggleFollow={() => setFollowingPresenter(f => !f)}
        />
      )}

      {showStartModal && (
        <StartSessionModal
          fileId={file.id}
          fileName={file.name}
          token={token}
          onStart={(sessionId, channel, mode, context) => {
            setPresenterSession({ sessionId, channel, mode, context });
            setShowStartModal(false);
          }}
          onClose={() => setShowStartModal(false)}
        />
      )}

      {sessionEnded && (
        <SessionEndedScreen onClose={() => setSessionEnded(false)} />
      )}

      {locked && (
        <LockScreen
          fileName={file.name}
          onUnlock={() => setLocked(false)}
        />
      )}
    </>
  );
}
