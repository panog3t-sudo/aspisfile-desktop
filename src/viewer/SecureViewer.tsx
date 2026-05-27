import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { sessionStore } from "../lib/sessionStore";
import { supabase } from "../lib/supabase";
import { getActiveSessionToken } from "../lib/recipient-session";
import { authenticateDesktop, FileInfo, RecipientInfo } from "../lib/desktopAuth";
import {
  sendEvent,
  startPageTracking,
  recordPageView,
  stopPageTracking,
  type AccessMethod,
} from "../lib/audit";
import { TileRenderer } from "./TileRenderer";
import { AuthLoadingScreen } from "../components/AuthLoadingScreen";
import { RevokedScreen } from "../components/RevokedScreen";
import { LegalOverlay } from "../components/LegalOverlay";
import { LockScreen } from "../components/LockScreen";
import { StepUpScreen, type StepUpCreds } from "../components/StepUpScreen";
import { DelegationScreen } from "../components/DelegationScreen";
import { DownloadModal } from "../components/DownloadModal";
import { DownloadDeletedScreen } from "../components/DownloadDeletedScreen";
import { runDownload, DownloadError } from "../lib/download";
import { CoViewingBanner }            from "../coviewing/CoViewingBanner";
import { CoViewingRecipient }         from "../coviewing/CoViewingRecipient";
import { PresenterToolbar }           from "../coviewing/PresenterToolbar";
import { PresenterParticipantPanel }  from "../coviewing/PresenterParticipantPanel";
import { StartSessionModal }          from "../coviewing/StartSessionModal";
import { SessionEndedScreen }         from "../coviewing/SessionEndedScreen";
import { broadcastScroll, broadcastZoom, type ScrollChangePayload } from "../lib/coviewing-realtime";
import type { RealtimeChannel } from "@supabase/supabase-js";

const IDLE_MS   = 2 * 60 * 1000; // lock after 2 min inactivity
// Phase 1 Day 9 — bumped from 30s to 60s to match mobile and the brief's
// "uniform auth model" guidance. Brief 60s threshold balances "person
// stepped away" detection against legitimate window-switching during
// multi-app workflow. v1.5 and earlier shipped 30s.
const BLUR_MS   = 60 * 1000;

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
  // Phase 1 Day 9 — pre-approval gate state (suspicious tier).
  // pendingApprovalId is set when /mobile/access returns status:
  // 'pending_approval' with mechanism: null. The StepUpScreen overlay
  // takes over until the recipient resolves via OTP (OAuth deferred).
  // delegationApprovalId fires when /resolve-otp returns delegation_
  // required — recipient must explicitly confirm cross-device approval.
  const [pendingApprovalId, setPendingApprovalId]       = useState<string | null>(null);
  const [delegationApprovalId, setDelegationApprovalId] = useState<string | null>(null);
  const startedRef                    = useRef(false);

  // ─── Sprint 3 — Unified Tracking: per-session telemetry ──────────
  // accessMethod is currently always 'link' (native app opened via share
  // link). Phase B will pass 'afs_local' when opening a locally-stored
  // .afs file — flip this const at that integration point. page_views_batch
  // only fires for 'afs_local' sessions per Unified Tracking Brief §1.2
  // (link sessions already log every page turn via tile requests).
  // Widened cast keeps TypeScript from narrowing accessMethod down to
  // the literal 'link' — which would make trackPages a dead-code false
  // and trip TS2367 on the comparison. Phase B flips the cast value to
  // 'afs_local' for local-file opens.
  const accessMethod = 'link' as AccessMethod;
  const trackPages = accessMethod === 'afs_local';

  // ─── Sprint 2 — .afs download state machine ─────────────────────
  // Derived from recipient.download_* fields after authenticateDesktop
  // resolves. Owner tokens skip the button entirely via canDownload.
  const [downloadState,      setDownloadState]      = useState<'available' | 'in_progress' | 'confirmed'>('available');
  const [downloadModalOpen,  setDownloadModalOpen]  = useState(false);
  const [blobDeleted,        setBlobDeleted]        = useState(false);
  const [downloadError,      setDownloadError]      = useState<string | null>(null);
  const [savedFileName,      setSavedFileName]      = useState<string>('');

  const sessionStartTsRef    = useRef<number>(Date.now());
  const endReasonRef         = useRef<'user_close' | 'revoked' | 'app_close' | 'session_expired'>('user_close');
  const uniquePagesRef       = useRef<Set<number>>(new Set());
  const fileOpenedFiredRef   = useRef(false);
  const sessionEndedFiredRef = useRef(false);

  // Phase 1 Day 9 — applied by StepUpScreen and DelegationScreen
  // after their resolve calls land. Mirrors the post-/mobile/access
  // success block (sessionStore.set → setSessionId → fetch pages →
  // file_opened audit) so a step-up unlock produces the same client
  // state as a clean-tier access.
  const applyStepUpCredentials = useCallback(async (creds: StepUpCreds) => {
    if (!file) return;
    sessionStore.set(creds.session_key, creds.device_share);
    setSessionId(creds.session_id);

    const platform = await invoke<string>("get_platform");
    const fingerprint = await getDesktopFingerprint(platform);

    const pageHeaders: Record<string, string> = {
      "X-App-Platform": "desktop",
      Authorization: `Bearer ${creds.session_key}`,
      "X-Device-Fingerprint": fingerprint,
    };
    if (creds.device_share) pageHeaders["X-Device-Share"] = creds.device_share;

    const pagesRes = await fetch(
      `${__API_BASE__}/api/v1/viewer/${file.id}/pages?session=${creds.session_id}`,
      { headers: pageHeaders }
    );
    if (pagesRes.ok) {
      const pagesData = await pagesRes.json();
      setTotalPages(pagesData.count ?? 1);
    }

    if (!fileOpenedFiredRef.current) {
      fileOpenedFiredRef.current = true;
      sessionStartTsRef.current = Date.now();
      await sendEvent({
        event_type:    'file_opened',
        file_id:       file.id,
        session_id:    creds.session_id,
        access_method: accessMethod,
        payload:       { device_fingerprint: fingerprint, step_up: true },
      }, token);
      if (trackPages) startPageTracking(creds.session_id, file.id, token);
    }
  }, [file, token, accessMethod, trackPages]);

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
  // ISO captured when /join succeeded — drives the recipient's presence
  // joined_at metadata so the presenter's panel can show "viewing for Xm".
  const [coViewingJoinedAt, setCoViewingJoinedAt] = useState<string | null>(null);

  // Co-viewing presenter state
  const [showStartModal, setShowStartModal] = useState(false);
  // Participant panel — open by default whenever a presentation starts.
  // Auto-collapses below 900px window width.
  const [participantPanelOpen, setParticipantPanelOpen] = useState(true);
  const [presenterSession, setPresenterSession] = useState<{
    sessionId: string; channel: string;
    mode: 'synchronized' | 'free'; context: 'standalone' | 'teams' | 'zoom';
  } | null>(null);

  // Zoom level (shared between presenter and recipient). Index into
  // TileRenderer's ZOOM_STEPS — 2 = 100% default. Same shape as
  // currentPage: locally controlled, optionally driven by an external
  // broadcast (recipient receives zoom_change from presenter).
  const [currentZoom, setCurrentZoom] = useState(2);

  // Latest scroll position broadcast received from the presenter. Only
  // populated on the recipient side; passed to TileRenderer as
  // subscribedScroll where it's applied programmatically in follow mode.
  const [subscribedScroll, setSubscribedScroll] = useState<ScrollChangePayload | null>(null);

  // Presenter publishing channel — subscribed for the lifetime of the
  // presenter session so broadcastScroll / broadcastZoom can fire
  // immediately. Send-only (no listeners attached) and `broadcast.self:
  // false` so we don't receive our own publishes back as events.
  const presenterPubChannelRef = useRef<RealtimeChannel | null>(null);
  useEffect(() => {
    if (!presenterSession) return;
    const ch = supabase.channel(presenterSession.channel, {
      config: { broadcast: { self: false } },
    });
    ch.subscribe();
    presenterPubChannelRef.current = ch;
    return () => {
      presenterPubChannelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [presenterSession?.channel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 10d — lifted from TileRenderer so the presenter toolbar / recipient
  // page sync can read and control it.
  const [currentPage, setCurrentPage] = useState(1);
  // Step 10d — channel returned by /co-viewing/join, used by CoViewingRecipient.
  const [coViewingChannel, setCoViewingChannel] = useState<string | null>(null);

  const canPresent = file?.is_owner === true;

  const isViewing = !!(sessionId && totalPages > 0 && !locked);
  useLockGuard(isViewing, useCallback(() => setLocked(true), []));

  // ─── Sprint 2 — derive initial download state from recipient fields ─
  // recipient comes from authenticateDesktop. Stale in-progress lock
  // (older than 1h) means an aborted prior session — treat as available.
  useEffect(() => {
    if (!recipient) return;
    const initiated = recipient.download_initiated_at;
    const stale     = initiated && (Date.now() - new Date(initiated).getTime()) > 60 * 60 * 1000;

    if (recipient.download_confirmed_at)              setDownloadState('confirmed');
    else if (recipient.download_in_progress && !stale) setDownloadState('in_progress');
    else                                              setDownloadState('available');
  }, [recipient]);

  // Effective gate for showing the download button. The button is also
  // hidden for the duration of any joined co-viewing session so that
  // recipients can't exfiltrate the file mid-presentation. The
  // hide-during-co-view rule applies in both follow mode and free roam
  // — the presenter is actively sharing throughout the session.
  const canDownload = !!file
    && !file.is_owner
    && file.allow_download
    && !!recipient
    && recipient.recipient_allow_download
    && !blobDeleted
    && !activeCoViewSessionId;

  async function handleDownload() {
    if (!file) return;
    setDownloadState('in_progress');
    setDownloadError(null);
    try {
      await runDownload(file.id, token);
      setSavedFileName(file.name + '.afs');
      setDownloadState('confirmed');
      setDownloadModalOpen(true);
    } catch (e) {
      const err = e instanceof DownloadError ? e : new DownloadError('UNKNOWN', String(e));
      // Already-downloaded race → silently jump to confirmed state
      setDownloadState(err.code === 'ALREADY_DOWNLOADED' ? 'confirmed' : 'available');
      if (err.code === 'BLOB_DELETED')                                       setBlobDeleted(true);
      else if (err.code === 'USER_CANCELLED' || err.code === 'WRITE_FAILED') { /* silent — user retries */ }
      else                                                                    setDownloadError(err.message);
    }
  }

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

      // Phase A+ Rule 5 — attach the recipient passkey session token
      // from lib/recipient-session.ts. The server's /mobile/access
      // route verifies the JWT via verifySessionToken and rejects
      // (RECIPIENT_MISMATCH 403) if the authenticated email doesn't
      // match the file's intended recipient.
      //
      // Pre-Phase-A+ this slot carried the Supabase access_token
      // (magic-link / OAuth artifact). That secret is signed with a
      // different key than JWT_SECRET, so the server now rejects it
      // as INVALID_SESSION_TOKEN. Using the passkey session token
      // here is both correct and required for the binding check.
      //
      // No bearer (no enrolled identity on this device) still works:
      // the server skips the binding check in that case until Stage 7
      // cleanup makes it mandatory across all native clients.
      const sessionToken = getActiveSessionToken();

      const res = await fetch(`${__API_BASE__}/api/v1/mobile/access/${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Platform": "desktop",
          "X-Desktop-OS": platform,
          "User-Agent": navigator.userAgent,
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ sig, env, deviceFingerprint: fingerprint }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Session start failed (${res.status})`);
        return;
      }

      const data = await res.json();

      // Suspicious-tier pre-approval gate (Brief §4) — recipient must
      // step up via OTP. StepUpScreen overlay calls /request-otp +
      // /resolve-otp with Bearer; on success it'll deliver session
      // credentials and we re-mount this step via startedRef reset.
      if (data.status === "pending_approval") {
        setPendingApprovalId(data.approval_id);
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

      // ─── Sprint 3 — file_opened audit event ──────────────────────
      // Fires once per viewer mount, after the session key has been
      // issued AND page count fetched (i.e., the viewer is genuinely
      // ready to render). Idempotent via fileOpenedFiredRef.
      if (!fileOpenedFiredRef.current) {
        fileOpenedFiredRef.current = true;
        sessionStartTsRef.current = Date.now();
        const deviceFingerprint = await getDesktopFingerprint(platform);
        await sendEvent({
          event_type:    'file_opened',
          file_id:       file.id,
          session_id:    data.session_id,
          access_method: accessMethod,
          payload:       { device_fingerprint: deviceFingerprint },
        }, token);
        if (trackPages) startPageTracking(data.session_id, file.id, token);
      }
    })().catch((e: Error) => setError(e.message));
  }, [legalAccepted, file, token, sig, env]);

  // Sprint 3 — track unique pages seen for session_ended.pages_viewed_count.
  // recordPageView only fires when trackPages is true (Phase B); the Set
  // accumulates regardless because last_page_seen / pages_viewed_count
  // remain useful even when page_views_batch is dormant.
  useEffect(() => {
    if (!sessionId) return;
    uniquePagesRef.current.add(currentPage);
    if (trackPages) recordPageView(currentPage);
  }, [currentPage, sessionId, trackPages]);

  // Sprint 3 — session_ended audit event. Fires once on unmount. The
  // endReasonRef is mutated by the paths that lead to teardown —
  // revocation listener sets 'revoked'; default is 'user_close' (close
  // button or nav). 'app_close' would be wired via a Tauri close event
  // listener — deferred to a follow-up since Tauri's window close
  // sequence already destroys this component (cleanup runs naturally).
  useEffect(() => {
    if (!sessionId || !file) return;
    return () => {
      if (sessionEndedFiredRef.current) return;
      sessionEndedFiredRef.current = true;
      const finalSessionId = sessionId;
      const finalFileId    = file.id;
      const lastPage       = currentPage;
      const uniqueCount    = uniquePagesRef.current.size;
      const duration       = Math.floor((Date.now() - sessionStartTsRef.current) / 1000);
      const reason         = endReasonRef.current;

      (async () => {
        if (trackPages) await stopPageTracking(finalSessionId, finalFileId);
        await sendEvent({
          event_type:    'session_ended',
          file_id:       finalFileId,
          session_id:    finalSessionId,
          access_method: accessMethod,
          payload: {
            duration_seconds:   duration,
            pages_viewed_count: uniqueCount,
            last_page_seen:     lastPage,
            end_reason:         reason,
          },
        }, token);
      })().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, file?.id]);

  // Realtime revocation listener
  useEffect(() => {
    if (!sessionId || !file) return;

    const channel = supabase
      .channel(`file-${file.id}`)
      .on("broadcast", { event: "revocation" }, (payload: { payload?: { reason?: string } }) => {
        setRevokeReason(payload.payload?.reason);
        endReasonRef.current = 'revoked';
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

  // Phase 2 — recipient publishes its current page to the server so the
  // presenter's participant list shows each viewer's actual page. Only
  // active when joined to a co-viewing session as a recipient (not the
  // presenter — they're the source of truth for the synchronized page).
  useEffect(() => {
    if (!activeCoViewSessionId) return;
    if (presenterSession) return; // skip on presenter side
    fetch(`${__API_BASE__}/api/v1/co-viewing/${activeCoViewSessionId}/my-page`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-App-Platform': 'desktop',
        'X-Access-Token': token,
      },
      body: JSON.stringify({ page: currentPage }),
    }).catch(() => {});
  }, [activeCoViewSessionId, presenterSession, currentPage, token]);

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
      setCoViewingJoinedAt(new Date().toISOString());
      if (typeof data.current_page === 'number') setCurrentPage(data.current_page);
    } catch {
      setCoViewingBanner(null);
    }
  }

  // Open the participant panel whenever a presentation starts. Auto-
  // collapse on narrow windows so the document isn't squeezed.
  useEffect(() => {
    if (!presenterSession) return;
    setParticipantPanelOpen(window.innerWidth >= 900);
  }, [!!presenterSession]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-way auto-collapse: cross below 900px → close the panel. Crossing
  // back up doesn't auto-open — presenter can toggle if they want.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 900) {
        setParticipantPanelOpen(open => (open ? false : open));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Broadcast presenter's current page to recipients on EVERY page
  // change — not just clicks on PresenterToolbar's arrow buttons.
  // Previously the broadcast was wired into PresenterToolbar.changePage,
  // which meant the TileRenderer's bottom Prev/Next buttons updated
  // local state but never reached recipients (silent sync gap).
  // This effect fires whenever currentPage changes while a presenter
  // session is active in synchronized mode — covers any page-change
  // path that updates state.
  const lastBroadcastPageRef = useRef<number | null>(null);
  useEffect(() => {
    if (!presenterSession || presenterSession.mode !== 'synchronized') return;
    if (lastBroadcastPageRef.current === currentPage) return;
    lastBroadcastPageRef.current = currentPage;
    fetch(`${__API_BASE__}/api/v1/co-viewing/${presenterSession.sessionId}/page`, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-App-Platform': 'desktop',
        'X-Access-Token': token,
      },
      body: JSON.stringify({ page: currentPage }),
    }).catch(() => {});
  }, [currentPage, presenterSession?.sessionId, presenterSession?.mode, token]);

  // Broadcast presenter's current zoom whenever it changes. Recipients
  // in follow mode receive zoom_change and update their own zoomIndex
  // via the targetZoom prop, so visual size stays in sync.
  const lastBroadcastZoomRef = useRef<number | null>(null);
  useEffect(() => {
    if (!presenterSession || presenterSession.mode !== 'synchronized') return;
    const ch = presenterPubChannelRef.current;
    if (!ch) return;
    if (lastBroadcastZoomRef.current === currentZoom) return;
    lastBroadcastZoomRef.current = currentZoom;
    broadcastZoom(ch, { zoomIndex: currentZoom });
  }, [currentZoom, presenterSession?.sessionId, presenterSession?.mode]);

  // Scroll-publish callback for TileRenderer — fires (throttled inside
  // TileRenderer) when the presenter scrolls. No-op when no presenter
  // pub channel is available (i.e., recipient side).
  const handlePublishScroll = useCallback((s: { v: number; h: number }) => {
    const ch = presenterPubChannelRef.current;
    if (!ch) return;
    broadcastScroll(ch, s);
  }, []);

  if (blobDeleted)                    return <DownloadDeletedScreen onClose={() => { sessionStore.clear(); onClose(); }} />;
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

      {/* Flex row: document on the left, participant panel on the right
          (presenter only, when toggled open). The panel pushes the
          document width instead of overlaying it.
          When the presenter session is active, the PresenterToolbar
          (fixed, 44px) overlays the top — push this row down by 44px
          and shrink its height to compensate so the TileRenderer
          toolbar (close, lock, zoom) and the panel header sit BELOW
          the PresenterToolbar instead of being hidden behind it. */}
      <div style={{
        display:    'flex',
        height:     presenterSession ? 'calc(100vh - 44px)' : '100vh',
        marginTop:  presenterSession ? 44 : 0,
      }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <TileRenderer
            sessionId={sessionId}
            fileId={file.id}
            file={file}
            totalPages={totalPages}
            onClose={onClose}
            onLock={() => setLocked(true)}
            targetPage={currentPage}
            onCurrentPageChange={setCurrentPage}
            targetZoom={currentZoom}
            onCurrentZoomChange={setCurrentZoom}
            // Owner-only entry point for co-viewing. Hidden while a
            // presenter session is already active (PresenterToolbar
            // takes over in the top overlay).
            onPresent={canPresent && !presenterSession ? () => setShowStartModal(true) : undefined}
            // Co-viewing recipient + Follow → mirror the presenter
            // exactly (no zoom controls, no manual scroll, no page
            // navigation; subscribedScroll drives the scroll position).
            followMode={!!activeCoViewSessionId && followingPresenter}
            // Presenter side: publish scroll on user interaction.
            // Recipient side: this is undefined → TileRenderer's onScroll
            // is a no-op for publish purposes.
            onPublishScroll={presenterSession ? handlePublishScroll : undefined}
            // Recipient side: apply scroll programmatically when the
            // presenter publishes.
            subscribedScroll={activeCoViewSessionId && followingPresenter ? subscribedScroll : null}
            // Sprint 2 — recipient .afs download. Prop omitted entirely
            // for owners / disabled / already-deleted-blob so the button
            // does not render at all (per state-machine §1.2).
            onDownload={canDownload ? handleDownload : undefined}
            downloadState={canDownload ? downloadState : undefined}
          />
        </div>
        {presenterSession && participantPanelOpen && (
          <PresenterParticipantPanel
            sessionId={presenterSession.sessionId}
            channel={presenterSession.channel}
            token={token}
            currentPage={currentPage}
            onClose={() => setParticipantPanelOpen(false)}
          />
        )}
      </div>

      {presenterSession && (
        <PresenterToolbar
          sessionId={presenterSession.sessionId}
          channel={presenterSession.channel}
          fileId={file.id}
          token={token}
          mode={presenterSession.mode}
          context={presenterSession.context}
          currentPage={currentPage}
          pageCount={totalPages}
          onPageChange={setCurrentPage}
          onStop={() => setPresenterSession(null)}
          panelOpen={participantPanelOpen}
          onTogglePanel={() => setParticipantPanelOpen(o => !o)}
        />
      )}

      {activeCoViewSessionId && coViewingChannel && coViewingJoinedAt && recipient && (
        <CoViewingRecipient
          channel={coViewingChannel}
          mode="synchronized"
          following={followingPresenter}
          email={recipient.email}
          currentPage={currentPage}
          joinedAt={coViewingJoinedAt}
          onPageChange={(page) => setCurrentPage(page)}
          onSessionEnd={() => setSessionEnded(true)}
          onSetFollowing={setFollowingPresenter}
          onScrollChange={(s) => setSubscribedScroll(s)}
          onZoomChange={(z) => setCurrentZoom(z.zoomIndex)}
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
        // Hard close the file when the session ends. Permanent recipients
        // re-open via their email link or the recipient portal — no
        // possibility of a lingering open file after the presenter is done.
        <SessionEndedScreen onCloseFile={onClose} />
      )}

      {locked && (
        <LockScreen
          fileName={file.name}
          onUnlock={() => setLocked(false)}
        />
      )}

      {/* Phase 1 Day 9 — suspicious-tier step-up gate. Mounts as a
          fullscreen overlay; on resolve the parent state is updated
          with the session credentials and the page-load effects
          continue from where /mobile/access left off. */}
      {pendingApprovalId && !delegationApprovalId && (
        <StepUpScreen
          approvalId={pendingApprovalId}
          fileName={file.name}
          recipientEmail={recipient?.email ?? ""}
          onApproved={(creds: StepUpCreds) => {
            applyStepUpCredentials(creds);
            setPendingApprovalId(null);
          }}
          onDelegationRequired={(id) => {
            setPendingApprovalId(null);
            setDelegationApprovalId(id);
          }}
        />
      )}

      {delegationApprovalId && (
        <DelegationScreen
          approvalId={delegationApprovalId}
          fileName={file.name}
          recipientEmail={recipient?.email ?? ""}
          onApproved={(creds: StepUpCreds) => {
            applyStepUpCredentials(creds);
            setDelegationApprovalId(null);
          }}
          onCancel={() => {
            setDelegationApprovalId(null);
            setError("Cancelled. Close this window and contact the sender if this was unexpected.");
          }}
        />
      )}

      {downloadModalOpen && (
        <DownloadModal
          fileName={savedFileName}
          onDone={() => setDownloadModalOpen(false)}
        />
      )}

      {downloadError && (
        // Non-blocking error banner for codes that don't justify a
        // full-screen takeover (DOWNLOAD_DISABLED, RECIPIENT_REVOKED on
        // race, generic). BLOB_DELETED takes priority via the
        // DownloadDeletedScreen early-return above.
        <div style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 999,
          background: '#A32D2D', color: '#fff',
          padding: '10px 14px', borderRadius: 6,
          fontSize: 12, maxWidth: 320,
          fontFamily: 'system-ui',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ flex: 1 }}>{downloadError}</span>
          <button
            onClick={() => setDownloadError(null)}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >×</button>
        </div>
      )}
    </>
  );
}
