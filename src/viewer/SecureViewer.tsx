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
import { CaptureBlackoutScreen, ScreenshotPausedScreen } from "../components/CaptureBlackoutScreen";
import { isAfsRenderEnabled, primeAfsRender, getHeldStatus, exportAfs, hasStoredAfs, type HeldStatus } from "../lib/afs-render";
import { translateAccessError, type FriendlyAccessError } from "../lib/access-errors";
import { debugLog } from "../lib/debug-log";
import { LegalOverlay } from "../components/LegalOverlay";
import { LockScreen } from "../components/LockScreen";
import { useLock } from "../contexts/LockContext";
import { StepUpScreen, type StepUpCreds } from "../components/StepUpScreen";
import { SenderApprovalWaitingScreen } from "../components/SenderApprovalWaitingScreen";
import { DelegationScreen } from "../components/DelegationScreen";
import { DownloadModal } from "../components/DownloadModal";
import { FeedbackMenu, type Decision, type DraftComment, type DraftMarkup, type DraftSignature } from "./FeedbackMenu";
import { SignaturePad, type SignatureData } from "./SignaturePad";
import { downloadAfsLink, DownloadError } from "../lib/download";
import { CoViewingBanner }            from "../coviewing/CoViewingBanner";
import { CoViewingRecipient }         from "../coviewing/CoViewingRecipient";
import { PresenterToolbar }           from "../coviewing/PresenterToolbar";
import { PresenterParticipantPanel }  from "../coviewing/PresenterParticipantPanel";
import { StartSessionModal }          from "../coviewing/StartSessionModal";
import { ControllerCursor }           from "../coviewing/ControllerCursor";
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
  // Recipient feedback (Phase 1) — server tells us whether to show "Respond".
  // Additive + flag-gated server-side; false by default → viewer unchanged.
  const [recipientFeedback, setRecipientFeedback] = useState(false);
  // Owner review — when the OWNER opens their own file, overlay ALL recipients'
  // pins/strokes, read-only (no menu).
  const [ownerReview, setOwnerReview] = useState(false);
  // Draft-then-send feedback. Sent items come from the server; drafts are local
  // (recipient-only, deletable) until "Send". Overlay only.
  const [fbMode, setFbMode] = useState<"none" | "comment" | "draw" | "sign">("none");
  const [drawTool, setDrawTool] = useState<"pen" | "highlight">("pen");
  const [sentComments, setSentComments] = useState<Array<{ id: string; page: number; x: number; y: number; body: string; recipient_email?: string }>>([]);
  const [sentMarkups, setSentMarkups] = useState<Array<{ id: string; page: number; points: Array<{ x: number; y: number }>; color?: string | null; recipient_email?: string; kind?: "pen" | "highlight" }>>([]);
  const [sentSignatures, setSentSignatures] = useState<Array<{ id: string; page: number; x: number; y: number; w: number; h: number; style: "drawn" | "typed"; points?: Array<Array<{ x: number; y: number }>>; typed_name?: string; recipient_email?: string }>>([]);
  const [draftDecision, setDraftDecision] = useState<{ decision: Decision; note: string } | null>(null);
  const [draftComments, setDraftComments] = useState<DraftComment[]>([]);
  const [draftMarkups, setDraftMarkups] = useState<DraftMarkup[]>([]);
  const [draftSignatures, setDraftSignatures] = useState<DraftSignature[]>([]);
  const [pendingSignature, setPendingSignature] = useState<{ page: number; x: number; y: number } | null>(null);
  const [pendingComment, setPendingComment] = useState<{ page: number; x: number; y: number } | null>(null);
  const [pendingText, setPendingText] = useState("");
  const [sending, setSending] = useState(false);
  const tempIdRef = useRef(0);
  const [totalPages, setTotalPages]   = useState(0);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [revoked, setRevoked]         = useState(false);
  const [revokeReason, setRevokeReason] = useState<string | undefined>();
  const [offline, setOffline]         = useState(false);
  const [error, setError]             = useState<FriendlyAccessError | null>(null);
  const [locked, setLocked]           = useState(false);
  // Dedicated screen-capture tools detected running (OBS/Loom/…). When
  // non-empty, the viewer blacks out + a soft screen_share_detected
  // violation is reported. Reversible — clears when the tool closes.
  const [captureApps, setCaptureApps] = useState<string[]>([]);
  // Brief pause + sender alert when a Print Screen keypress is detected.
  const [screenshotPaused, setScreenshotPaused] = useState(false);
  // Phase B (B5) — flagged + additive. When the flag is on, prime the
  // server's render cache from the recipient's .afs before showing tiles;
  // default OFF keeps the durable-S3 tile path unchanged.
  const afsRenderEnabled = isAfsRenderEnabled();
  const [afsPrimed, setAfsPrimed] = useState(false);
  // B+ multi-device (memory `multidevice-recipient-decision`).
  const [sourceExpired, setSourceExpired] = useState(false);
  const [heldStatus,    setHeldStatus]    = useState<HeldStatus | null>(null);
  const [canSend,       setCanSend]       = useState(false);
  const fpRef           = useRef<string>('');
  // Phase 1 Day 9 — pre-approval gate state.
  // pendingApprovalId is set when /mobile/access returns status:
  // 'pending_approval'. mechanism distinguishes which screen handles it:
  //   - 'sender'  → SenderApprovalWaitingScreen (sender must approve via
  //                 dashboard/mobile — recipient just waits, subscribes
  //                 to realtime broadcast)
  //   - null      → StepUpScreen (recipient steps up via OTP/OAuth —
  //                 suspicious-tier coherence path)
  // delegationApprovalId fires when /resolve-otp returns delegation_
  // required — recipient must explicitly confirm cross-device approval.
  const [pendingApprovalId, setPendingApprovalId]       = useState<string | null>(null);
  const [pendingApprovalMechanism, setPendingApprovalMechanism] = useState<'sender' | null>(null);
  const [pendingApprovalExpiresAt, setPendingApprovalExpiresAt] = useState<string | null>(null);
  const [delegationApprovalId, setDelegationApprovalId] = useState<string | null>(null);
  const startedRef                    = useRef(false);

  // ─── Sprint 3 — Unified Tracking: per-session telemetry ──────────
  // accessMethod is currently always 'link' (native app opened via share
  // link). Phase B will pass 'afs_local' when opening a locally-stored
  // .afs file — flip this const at that integration point. page_views_batch
  // only fires for 'afs_local' sessions per Unified Tracking Brief §1.2
  // (link sessions already log every page turn via tile requests).
  // Widened cast keeps TypeScript from narrowing accessMethod down to a
  // literal — which would make the trackPages comparison dead-code and trip
  // TS2367. Phase B B6 Part 1 (2026-06-21): flipped 'link' → 'afs_local' now
  // that the .afs render path is the default (reversible via the kill switch
  // in afs-render.ts). trackPages is therefore active.
  const accessMethod = 'afs_local' as AccessMethod;
  const trackPages = accessMethod === 'afs_local';

  // ─── Sprint 2 — .afs download state machine ─────────────────────
  // Derived from recipient.download_* fields after authenticateDesktop
  // resolves. Owner tokens skip the button entirely via canDownload.
  const [downloadState,      setDownloadState]      = useState<'available' | 'in_progress' | 'confirmed'>('available');
  const [downloadModalOpen,  setDownloadModalOpen]  = useState(false);
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

  // Phase 2 — load this recipient's own comments (for the tile pins) from the
  // feedback thread. Refetched after posting a new one.
  const fetchFeedback = useCallback(async () => {
    if (!sessionId || !file) return;
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${file.id}/feedback?session=${encodeURIComponent(sessionId)}`,
        { headers: { "X-App-Platform": "desktop" } });
      if (res.ok) {
        const entries = (await res.json()).entries ?? [];
        setSentComments(entries.filter((e: { kind: string }) => e.kind === "comment")
          .map((e: { id: string; page: number; x: number; y: number; body: string; recipient_email?: string }) => ({ id: e.id, page: e.page, x: e.x, y: e.y, body: e.body, recipient_email: e.recipient_email })));
        setSentMarkups(entries.filter((e: { kind: string }) => e.kind === "markup")
          .map((e: { id: string; page: number; points: Array<{ x: number; y: number }>; color?: string | null; recipient_email?: string; tool?: "pen" | "highlight" }) => ({ id: e.id, page: e.page, points: e.points, color: e.color, recipient_email: e.recipient_email, kind: e.tool })));
        setSentSignatures(entries.filter((e: { kind: string }) => e.kind === "signature")
          .map((e: { id: string; page: number; x: number; y: number; w: number; h: number; style: "drawn" | "typed"; points?: Array<Array<{ x: number; y: number }>>; typed_name?: string; recipient_email?: string }) => ({ id: e.id, page: e.page, x: e.x, y: e.y, w: e.w, h: e.h, style: e.style, points: e.points, typed_name: e.typed_name, recipient_email: e.recipient_email })));
      }
    } catch { /* keep last */ }
  }, [sessionId, file]);

  useEffect(() => { if ((recipientFeedback || ownerReview) && sessionId) fetchFeedback(); }, [recipientFeedback, ownerReview, sessionId, fetchFeedback]);

  // Tap a spot → open the draft-comment compose (adds a LOCAL draft, not sent).
  const onPlaceComment = useCallback((page: number, x: number, y: number) => { setPendingComment({ page, x, y }); setPendingText(""); }, []);
  const addDraftComment = useCallback(() => {
    setPendingComment((pc) => {
      setPendingText((t) => {
        if (pc && t.trim()) setDraftComments((c) => [...c, { tempId: "d" + (++tempIdRef.current), page: pc.page, x: pc.x, y: pc.y, body: t.trim(), at: new Date().toISOString() }]);
        return "";
      });
      return null;
    });
  }, []);
  // A completed stroke → a LOCAL draft markup (not sent).
  const onStrokeComplete = useCallback((page: number, points: Array<{ x: number; y: number }>) => {
    const at = new Date().toISOString();
    if (drawTool === "highlight") {
      const a = points[0], b = points[points.length - 1];
      const pts = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }];   // snap horizontal at start height
      setDraftMarkups((m) => [...m, { tempId: "d" + (++tempIdRef.current), page, points: pts, color: "#FDE047", kind: "highlight", at }]);
    } else {
      setDraftMarkups((m) => [...m, { tempId: "d" + (++tempIdRef.current), page, points, color: "#E0A54B", kind: "pen", at }]);
    }
  }, [drawTool]);
  const removeDraftComment = useCallback((id: string) => setDraftComments((c) => c.filter((x) => x.tempId !== id)), []);
  const removeDraftMarkup  = useCallback((id: string) => setDraftMarkups((m) => m.filter((x) => x.tempId !== id)), []);

  // Sign mode: tap a spot → open the pad. The tap point becomes the CENTRE of
  // the signature box; we clamp so the default 0.28×0.09 box stays on the page.
  const SIG_W = 0.28, SIG_H = 0.09;
  const onPlaceSignature = useCallback((page: number, x: number, y: number) => {
    const px = Math.min(1 - SIG_W, Math.max(0, x - SIG_W / 2));
    const py = Math.min(1 - SIG_H, Math.max(0, y - SIG_H / 2));
    setPendingSignature({ page, x: px, y: py });
  }, []);
  // Pad returned a signature → add a LOCAL draft at the pending position.
  const addDraftSignature = useCallback((s: SignatureData) => {
    setPendingSignature((ps) => {
      if (!ps) return null;
      const base = { tempId: "d" + (++tempIdRef.current), page: ps.page, x: ps.x, y: ps.y, w: SIG_W, h: SIG_H, signer_name: s.signer_name, at: new Date().toISOString() };
      const draft: DraftSignature = s.style === "drawn"
        ? { ...base, style: "drawn", points: s.points }
        : { ...base, style: "typed", typed_name: s.typed_name };
      setDraftSignatures((d) => [...d, draft]);
      return null;
    });
    setFbMode("none");
  }, []);
  const removeDraftSignature = useCallback((id: string) => setDraftSignatures((d) => d.filter((x) => x.tempId !== id)), []);

  // Send the whole draft bundle (irreversible). Clears drafts + refetches sent.
  const sendBatch = useCallback(async (): Promise<boolean> => {
    if (!sessionId || !file) return false;
    setSending(true);
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/viewer/${file.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Platform": "desktop" },
        body: JSON.stringify({
          session_id: sessionId,
          decision: draftDecision ? { decision: draftDecision.decision, note: draftDecision.note.trim() || undefined } : undefined,
          comments: draftComments.length ? draftComments.map((c) => ({ page: c.page, x: c.x, y: c.y, body: c.body })) : undefined,
          markups:  draftMarkups.length  ? draftMarkups.map((m) => ({ page: m.page, points: m.points, color: m.color })) : undefined,
          signatures: draftSignatures.length ? draftSignatures.map((s) => ({ page: s.page, x: s.x, y: s.y, w: s.w, h: s.h, style: s.style, points: s.points, typed_name: s.typed_name, signer_name: s.signer_name })) : undefined,
        }),
      });
      setSending(false);
      if (!res.ok) return false;
      setDraftDecision(null); setDraftComments([]); setDraftMarkups([]); setDraftSignatures([]);
      await fetchFeedback();
      return true;
    } catch { setSending(false); return false; }
  }, [sessionId, file, draftDecision, draftComments, draftMarkups, draftSignatures, fetchFeedback]);

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
    // Sprint 8 Phase 2a — when a recipient has pointer_control, they
    // publish their page changes; the presenter mirrors. Subscribe
    // here on the presenter's own channel so we apply incoming
    // changes without re-rendering the panel.
    ch.on('broadcast', { event: 'controller_page_change' }, ({ payload }: { payload?: { email?: string; page?: number } }) => {
      const p = payload;
      if (!p) return;
      const page = typeof p.page === 'number' ? p.page : null;
      if (page === null) return;
      setCurrentPage(page);
    });
    // Mirror controller scrolls. Recipient with pointer_control
    // broadcasts on 'scroll_change' (same event the presenter would
    // normally publish on); we subscribe so the presenter view
    // follows the controller. Edge case: if presenter ever scrolls
    // themselves while broadcasting, self=false on this channel
    // suppresses the echo, so we won't fight our own publishes.
    ch.on('broadcast', { event: 'scroll_change' }, ({ payload }: { payload?: { v?: number; h?: number } }) => {
      const p = payload;
      if (!p) return;
      const v = typeof p.v === 'number' ? p.v : 0;
      const h = typeof p.h === 'number' ? p.h : 0;
      setSubscribedScroll({ v, h });
    });
    // Phase 2b — controller cursor stream. Out-of-range ratios mean
    // the cursor is off the page; clear the overlay in that case.
    ch.on('broadcast', { event: 'controller_cursor' }, ({ payload }: { payload?: { email?: string; page?: number; xRatio?: number; yRatio?: number } }) => {
      const p = payload;
      if (!p) return;
      const email   = p.email?.toLowerCase() ?? null;
      const page    = typeof p.page === 'number' ? p.page : null;
      const xRatio  = typeof p.xRatio === 'number' ? p.xRatio : null;
      const yRatio  = typeof p.yRatio === 'number' ? p.yRatio : null;
      if (!email || page === null || xRatio === null || yRatio === null) return;
      if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
        setControllerCursor(null);
        return;
      }
      setControllerCursor({ email, page, xRatio, yRatio, at: Date.now() });
    });
    // Track who currently holds pointer_control so the "Controlled by"
    // chip can render. Server-side mutex guarantees only one
    // recipient at a time, so we can clobber on each event without a
    // stack of holders.
    ch.on('broadcast', { event: 'permission_changed' }, ({ payload }: { payload?: { email?: string; type?: string; granted?: boolean } }) => {
      const p = payload;
      if (!p || p.type !== 'pointer_control') return;
      const email = p.email?.toLowerCase() ?? null;
      if (p.granted && email) {
        setCurrentControllerEmail(email);
      } else if (!p.granted && email) {
        setCurrentControllerEmail(prev => (prev === email ? null : prev));
        // Clear any lingering cursor from the now-revoked controller
        setControllerCursor(prev => prev?.email === email ? null : prev);
      }
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
  // Sprint 8 — per-participant permissions. Initial values come from
  // /co-viewing/<id>/join; live updates from broadcasts arrive inside
  // CoViewingRecipient itself and bubble up via callbacks below.
  const [freeScrollGranted,     setFreeScrollGranted]     = useState(false);
  const [pointerControlGranted, setPointerControlGranted] = useState(false);
  // Presenter side: which recipient is currently driving the doc
  // (Phase 2a pointer-control). null when no one is. Drives the
  // "Controlled by <email>" chip in PresenterToolbar.
  const [currentControllerEmail, setCurrentControllerEmail] = useState<string | null>(null);
  // Phase 2b — latest cursor position from the controller, scoped to
  // the page they were on. Cleared on revoke or after 500ms idle.
  const [controllerCursor, setControllerCursor] = useState<{
    page: number; xRatio: number; yRatio: number; email: string; at: number;
  } | null>(null);
  // Symmetric — latest cursor position from the presenter, surfaced
  // to the recipient when in Follow mode. Same render component
  // (ControllerCursor); same auto-decay rules. Populated by the
  // CoViewingRecipient via onRemoteCursor; CoViewingRecipient itself
  // gates on followingRef so this only fills while we're following.
  const [remoteCursor, setRemoteCursor] = useState<{
    page: number; xRatio: number; yRatio: number; email: string; at: number;
  } | null>(null);

  const canPresent = file?.is_owner === true;

  const isViewing = !!(sessionId && totalPages > 0 && !locked);
  // Only arm the per-file idle/blur re-lock when the machine has a LOCAL
  // authenticator to re-unlock with. On a Windows PC with no Windows Hello,
  // re-locking would force a browser+phone QR round-trip on every idle timeout
  // (reported 2026-07-22) — the same reason the app-level idle lock is disabled
  // there (LockContext). Default true so macOS (which always has Touch ID /
  // password) is unaffected while the async check resolves.
  const [localAuthAvailable, setLocalAuthAvailable] = useState(true);
  useEffect(() => {
    invoke<boolean>("biometric_available")
      .then(setLocalAuthAvailable)
      .catch(() => setLocalAuthAvailable(true));
  }, []);
  useLockGuard(isViewing && localAuthAvailable, useCallback(() => setLocked(true), []));

  // Tell the app-level lock to stand down while this viewer is mounted — the
  // per-file useLockGuard above owns the idle lock here. Without this, both
  // the app-level idle lock and this one fired at the same timeout, stacking
  // two lock screens (the second bailed on the biometric mutex, forcing a
  // second unlock click after Touch ID — trace 2026-07-22).
  const { setViewingActive } = useLock();
  useEffect(() => {
    setViewingActive(true);
    return () => setViewingActive(false);
  }, [setViewingActive]);

  // ─── Sprint 2 — derive initial download state from recipient fields ─
  // recipient comes from authenticateDesktop. Stale in-progress lock
  // (older than 1h) means an aborted prior session — treat as available.
  useEffect(() => {
    // Download is a benign client-side link-container write since
    // v1.7.20 (no S3 ciphertext, no server confirm, no grace-period
    // side effects). The historical download_confirmed_at /
    // download_in_progress flags were set by the old runDownload flow
    // and would lock the button forever for any recipient who'd
    // downloaded a file in an earlier version. Always start available.
    if (!recipient) return;
    setDownloadState('available');
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
    && !activeCoViewSessionId;

  async function handleDownload() {
    if (!file) return;
    setDownloadState('in_progress');
    setDownloadError(null);
    try {
      await downloadAfsLink({
        token,
        sig,
        env,
        fileName:   file.name,
        senderName: file.sender?.full_name ?? file.sender?.email ?? null,
      });
      setSavedFileName(file.name + '.afs');
      setDownloadState('confirmed');
      setDownloadModalOpen(true);
    } catch (e) {
      const err = e instanceof DownloadError ? e : new DownloadError('UNKNOWN', String(e));
      setDownloadState('available');
      if (err.code === 'USER_CANCELLED') { /* silent — user closed dialog */ }
      else                                 setDownloadError(err.message);
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
      .catch((e: Error) => setError(translateAccessError(e.message)));
  }, [token, sig, env]);

  // Step 2: start session after legal acceptance — uses mobile/desktop token-auth route
  useEffect(() => {
    if (!legalAccepted || !file || startedRef.current) return;
    startedRef.current = true;

    (async () => {
      const platform = await invoke<string>("get_platform");
      const fingerprint = await getDesktopFingerprint(platform);

      // Phase A+ Stage 7 (2026-05-29): the server REQUIRES a passkey
      // session token Bearer for non-owner /mobile/access calls and
      // returns BINDING_REQUIRED 403 without one. App.tsx's openLink()
      // gate prevents this case from reaching here by routing
      // un-enrolled link arrivals to EnrolmentScreen first. The
      // error-handling block below catches BINDING_REQUIRED defensively
      // so an expired session (8h TTL) surfaces a useful message.
      const sessionToken = getActiveSessionToken();

      // 15s timeout so a stalled /mobile/access surfaces as an error
      // instead of an infinite "Authenticating…" spinner. Real calls
      // complete in well under a second; anything past 15s is the
      // server being unreachable or genuinely stuck.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);

      const doStart = (forceMove: boolean) => fetch(`${__API_BASE__}/api/v1/mobile/access/${token}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-App-Platform": "desktop",
          "X-Desktop-OS": platform,
          "User-Agent": navigator.userAgent,
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({ sig, env, deviceFingerprint: fingerprint, ...(forceMove ? { forceMove: true } : {}) }),
        signal: controller.signal,
      });

      let res: Response;
      try {
        res = await doStart(false);
        // 409 ALREADY_OPEN — first-opener-wins: a DIFFERENT device of this
        // recipient is actively viewing. We do NOT force-move (that would
        // steal the session); we surface the "close the other viewer first"
        // message below. Same-device close→reopen never 409s — the server
        // recognises the fingerprint and lets this device take over.
      } catch (err: any) {
        clearTimeout(timeoutId);
        if (err?.name === 'AbortError') {
          setError(translateAccessError('TIMEOUT'));
        } else {
          setError(translateAccessError(err?.message ?? 'Network error'));
        }
        return;
      }
      clearTimeout(timeoutId);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Translate the raw server code into a friendly title + body
        // here so RevokedScreen just renders the pre-built shape.
        setError(translateAccessError(body.error || `Session start failed (${res.status})`));
        return;
      }

      const data = await res.json();

      // Suspicious-tier pre-approval gate (Brief §4) — recipient must
      // step up via OTP. StepUpScreen overlay calls /request-otp +
      // /resolve-otp with Bearer; on success it'll deliver session
      // credentials and we re-mount this step via startedRef reset.
      if (data.status === "pending_approval") {
        setPendingApprovalId(data.approval_id);
        setPendingApprovalMechanism(data.mechanism === 'sender' ? 'sender' : null);
        setPendingApprovalExpiresAt(data.expires_at ?? null);
        startedRef.current = false;
        return;
      }

      sessionStore.set(data.session_key, data.device_share ?? null);
      setSessionId(data.session_id);
      setRecipientFeedback(data.recipient_feedback === true);
      setOwnerReview(data.owner_review === true);

      // Fetch page count
      const pageHeaders: Record<string, string> = {
        "X-App-Platform": "desktop",
        Authorization: `Bearer ${data.session_key}`,
        "X-Device-Fingerprint": fingerprint,
      };
      if (data.device_share) pageHeaders["X-Device-Share"] = data.device_share;

      // Fetch page count. RETRY + SURFACE: /pages races the render-prime
      // (/supply) effect. If /pages wins it takes the cache-miss self-decrypt
      // path, which can transiently fail — and the old `if (pagesRes.ok)`
      // SILENTLY swallowed failures, leaving totalPages=0 → an infinite
      // "Authenticating…" spinner. Retry so /supply has time to prime the
      // cache (the retry then hits it); if it still fails, surface the real
      // reason instead of hanging.
      let pagesOk = false;
      let lastPagesErr = 'RENDER_FAILED';
      for (let attempt = 0; attempt < 4; attempt++) {
        const pagesRes = await fetch(
          `${__API_BASE__}/api/v1/viewer/${file.id}/pages?session=${data.session_id}`,
          { headers: pageHeaders }
        );
        if (pagesRes.ok) {
          const pagesData = await pagesRes.json();
          setTotalPages(pagesData.count ?? 1);
          pagesOk = true;
          break;
        }
        lastPagesErr = ((await pagesRes.json().catch(() => ({}))) as any)?.error || `PAGES_${pagesRes.status}`;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 700));
      }
      if (!pagesOk) {
        setError(translateAccessError(lastPagesErr));
        return;
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
    })().catch((e: Error) => setError(translateAccessError(e.message)));
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

  // ── Heartbeat — liveness + authorization revalidation ──
  // Fires every 15s while sessionId is set. Reacts to server response:
  //   - 'active'         → bump online state, clear any miss counter
  //   - anything else    → permanent dark RevokedScreen + clear
  //                        sessionStore (in-memory session key)
  //   - network failure  → after 2 consecutive misses (~30s offline)
  //                        flip to OfflineScreen overlay. Key is NOT
  //                        cleared so reconnect restores rendering
  //                        without re-auth.
  // Enforces the no-offline-viewing rule: recipient who pulls the
  // network cable sees a dark screen within ~30s, and the sender's
  // revoke takes effect within ~15s.
  const missCountRef = useRef(0);
  const OFFLINE_AFTER_MISSES = 2;
  useEffect(() => {
    if (!sessionId || !file || revoked) return;
    let cancelled = false;
    const beat = async () => {
      try {
        const res = await fetch(
          `${__API_BASE__}/api/v1/viewer/${file.id}/heartbeat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-App-Platform': 'desktop' },
            body: JSON.stringify({ session_id: sessionId }),
          }
        );
        if (cancelled) return;
        if (!res.ok) {
          missCountRef.current += 1;
          if (missCountRef.current >= OFFLINE_AFTER_MISSES) setOffline(true);
          return;
        }
        const body = await res.json().catch(() => ({ status: 'active' as const }));
        if (cancelled) return;
        if (body.status === 'active') {
          missCountRef.current = 0;
          if (offline) setOffline(false);
          return;
        }
        // Revocation/expiry — DARK PERMANENTLY + clear in-memory key.
        sessionStore.clear();
        endReasonRef.current = 'revoked';
        setRevokeReason(body.reason ?? body.status);
        setRevoked(true);
      } catch {
        if (cancelled) return;
        missCountRef.current += 1;
        if (missCountRef.current >= OFFLINE_AFTER_MISSES) setOffline(true);
      }
    };
    beat();
    const timer = window.setInterval(beat, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [sessionId, file, revoked, offline]);

  // Screen-capture process detection. While viewing, poll the native
  // process scan every 7s. On the transition into "detected", report a
  // soft screen_share_detected violation (server records + alerts the
  // sender at Notable tier; it never strikes/revokes). The blackout
  // itself is driven by captureApps in the render guard below, and
  // reverses automatically when the tool closes.
  useEffect(() => {
    if (!isViewing || !sessionId || !file) return;
    let cancelled = false;
    let wasDetected = false;
    const poll = async () => {
      let apps: string[] = [];
      try {
        apps = await invoke<string[]>('detect_capture_processes');
      } catch {
        return; // command unavailable (older shell) — fail open, don't blackout
      }
      if (cancelled) return;
      setCaptureApps(apps);
      const detected = apps.length > 0;
      if (detected && !wasDetected) {
        fetch(`${__API_BASE__}/api/v1/viewer/${file.id}/violation`, {
          method: 'POST',
          // X-App-Platform so the server treats this as a native client and
          // skips the browser IP/UA re-check (the native viewer uses two HTTP
          // stacks with different UAs — see the violation route). Every other
          // desktop call already sends this; this one was missing it.
          headers: { 'Content-Type': 'application/json', 'X-App-Platform': 'desktop' },
          body: JSON.stringify({
            session_id: sessionId,
            violation_type: 'screen_share_detected',
            metadata: { apps },
          }),
        }).catch(() => {});
      }
      wasDetected = detected;
    };
    poll();
    const timer = window.setInterval(poll, 7_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isViewing, sessionId, file]);

  // Print Screen detection. The window's contentProtected flag already blanks
  // the viewer in any capture, but a one-off PrtSc leaves no running process
  // for the poll above to catch and sends no signal. Here we catch the key
  // itself: clear the clipboard copy the OS just made, report a `screenshot`
  // violation so the sender is notified, and show a brief on-screen notice.
  //
  // Timing of the notice is the subtle part on Windows 11: PrtSc there opens
  // the Snipping Tool region overlay, which sits ABOVE every app window (ours
  // included) until the user dismisses it, so a notice shown at keypress time
  // is hidden behind it and the 4s timer often elapses before they return.
  // So we show it immediately (covers the silent-clipboard PrtSc case) AND
  // re-show it once when the window next regains focus (i.e. after the snip
  // overlay closes), so the confirmation is actually seen. Detection + sender
  // notification always fire immediately, independent of the notice timing.
  // Reversible — resumes after a few seconds. (Win+Shift+S / Snip is an OS
  // shortcut that doesn't reach the WebView; contentProtected still blanks it.)
  useEffect(() => {
    if (!isViewing || !sessionId || !file) return;
    let cancelled = false;
    let resumeTimer = 0;
    let pendingReshow = false;   // a PrtSc fired that the OS overlay may be hiding
    let reshowDeadline = 0;      // don't re-show for an unrelated later refocus
    const showNotice = () => {
      if (cancelled) return;
      setScreenshotPaused(true);
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => { if (!cancelled) setScreenshotPaused(false); }, 4000);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PrintScreen' && e.code !== 'PrintScreen') return;
      try { navigator.clipboard.writeText(''); } catch { /* best-effort */ }
      fetch(`${__API_BASE__}/api/v1/viewer/${file.id}/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Platform': 'desktop' },
        body: JSON.stringify({ session_id: sessionId, violation_type: 'screenshot', metadata: { key: 'PrintScreen' } }),
      }).catch(() => {});
      showNotice();
      pendingReshow = true;
      reshowDeadline = Date.now() + 30000;
    };
    // First focus-return after a PrtSc → the snip overlay has closed; re-show
    // the notice so it's visible now. Cleared after one re-show so an unrelated
    // alt-tab back doesn't retrigger it.
    const onFocusBack = () => {
      if (document.visibilityState === 'hidden') return;
      if (!pendingReshow) return;
      pendingReshow = false;
      if (Date.now() <= reshowDeadline) showNotice();
    };
    window.addEventListener('keyup', onKey);
    window.addEventListener('focus', onFocusBack);
    document.addEventListener('visibilitychange', onFocusBack);
    return () => {
      cancelled = true;
      window.clearTimeout(resumeTimer);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('focus', onFocusBack);
      document.removeEventListener('visibilitychange', onFocusBack);
    };
  }, [isViewing, sessionId, file]);

  // Phase B (B5) — prime the server-transient render from the recipient's
  // .afs when the flag is on. Fetch + re-supply once per session; on success
  // /tile renders from the primed cache, on failure we fall back to durable
  // S3 (so a prime error never blocks viewing). Flag OFF → skip entirely.
  useEffect(() => {
    if (!afsRenderEnabled || !sessionId || !file || afsPrimed) return;
    let cancelled = false;
    (async () => {
      const platform = /Mac/i.test(navigator.userAgent) ? 'macOS' : 'Windows';
      let fp = '';
      try { fp = await getDesktopFingerprint(platform); } catch { /* best-effort */ }
      fpRef.current = fp;
      const res = await primeAfsRender({ fileId: file.id, sessionId, fingerprint: fp });
      if (cancelled) return;
      if (!res.ok) {
        console.warn('[afs-render] prime failed (falling back to durable S3):', res.error);
        // B+ — no local copy AND the server window elapsed (no durable
        // backstop post-cutover). Fetch device context for the guided message.
        if (res.reason === 'source_expired') {
          const hs = await getHeldStatus(file.id, sessionId, fp);
          if (!cancelled) { setHeldStatus(hs); setSourceExpired(true); }
        }
      }
      // B+ — device context for the Send button + exit-save prompt (best-effort).
      try {
        const [held, hs] = await Promise.all([hasStoredAfs(file.id), getHeldStatus(file.id, sessionId, fp)]);
        if (!cancelled) { setCanSend(held); setHeldStatus(prev => prev ?? hs); }
      } catch { /* button/prompt just won't show */ }
      if (!cancelled) setAfsPrimed(true);
    })();
    return () => { cancelled = true; };
  }, [afsRenderEnabled, sessionId, file, afsPrimed]);

  // B+ — export the held .afs to another of the recipient's devices. Surfaced
  // as an always-visible toolbar button (the desktop viewer closes via the OS
  // window, so there's no in-app close to hang an exit-prompt on — the button
  // lets the recipient send a copy at any time).
  const handleSendToDevice = useCallback(async () => {
    if (!file) return;
    await exportAfs(file.id, file.name);
  }, [file]);

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
      // Doc-X removed in v1.8.18; window close is the only close path
      // now. Clear the in-memory session key here so it doesn't
      // outlive the viewer (matching what the doc-X used to do).
      sessionStore.clear();
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
        // Tell the server the viewer is closed so the viewer_session
        // row gets marked terminated immediately. Without this, the
        // row stays status='active' until cron sweep (~5 min) and the
        // presenter's PresenterParticipantPanel keeps showing this
        // viewer as live because Supabase Realtime presence
        // occasionally lingers past unsubscribe.
        await fetch(`${__API_BASE__}/api/v1/viewer/${finalFileId}/close`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ session_id: finalSessionId }),
        }).catch(() => {});
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
    debugLog('coview', 'SV auto-join effect', {
      coviewSessionId: coviewSessionId?.slice(0,8) ?? null,
      hasRecipient: !!recipient,
      hasFile: !!file,
      sessionId: sessionId?.slice(0,8) ?? null,
      activeCoViewSessionId: activeCoViewSessionId?.slice(0,8) ?? null,
    });
    if (!coviewSessionId) return;
    if (!recipient || !file || !sessionId) return;
    if (activeCoViewSessionId) return;
    debugLog('coview', 'SV → joinCoViewingSession');
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
    debugLog('coview', 'join start', { sessId: sessId.slice(0,8) });
    try {
      const res = await fetch(`${__API_BASE__}/api/v1/co-viewing/${sessId}/join`, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'X-App-Platform': 'desktop',
          'X-Access-Token': token,
        },
      });

      debugLog('coview', 'join response', { status: res.status });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        debugLog('coview', 'join failed', { body: body.slice(0, 200) });
        setCoViewingBanner(null);
        return;
      }

      const data = await res.json();
      setActiveCoViewSessionId(sessId);
      setCoViewingChannel(data.channel ?? null);
      setFollowingPresenter(true);
      setCoViewingBanner(null);
      setCoViewingJoinedAt(new Date().toISOString());
      setFreeScrollGranted(!!data.free_scroll_granted);
      setPointerControlGranted(!!data.pointer_control_granted);
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
  // Phase 2b — cursor auto-decay. Idle the overlay 500ms after the
  // last received broadcast so a stuck cursor doesn't linger forever
  // if the controller's network drops mid-stream.
  useEffect(() => {
    if (!controllerCursor) return;
    const remaining = 500 - (Date.now() - controllerCursor.at);
    if (remaining <= 0) { setControllerCursor(null); return; }
    const t = window.setTimeout(() => {
      setControllerCursor(prev => prev && Date.now() - prev.at >= 500 ? null : prev);
    }, remaining);
    return () => window.clearTimeout(t);
  }, [controllerCursor]);

  // Same auto-decay for the recipient-side remote cursor.
  useEffect(() => {
    if (!remoteCursor) return;
    const remaining = 500 - (Date.now() - remoteCursor.at);
    if (remaining <= 0) { setRemoteCursor(null); return; }
    const t = window.setTimeout(() => {
      setRemoteCursor(prev => prev && Date.now() - prev.at >= 500 ? null : prev);
    }, remaining);
    return () => window.clearTimeout(t);
  }, [remoteCursor]);

  // Drop any cursor on screen as soon as we leave follow mode (e.g.
  // user clicks "Request free scroll" or grabs pointer control). The
  // CoViewingRecipient broadcast listener also filters incoming
  // cursors when not following, but anything already in state needs
  // to be cleared here.
  useEffect(() => {
    if (!followingPresenter) setRemoteCursor(null);
  }, [followingPresenter]);

  // TileRenderer) when the presenter scrolls, OR when a recipient
  // holding pointer_control scrolls. The presenter side has its own
  // channel (presenterPubChannelRef); the recipient side uses the
  // already-mounted CoViewingRecipient channel looked up by topic.
  // Same broadcast event in both cases so every party in follow mode
  // mirrors whoever is currently driving.
  const handlePublishScroll = useCallback((s: { v: number; h: number }) => {
    const presCh = presenterPubChannelRef.current;
    if (presCh) {
      broadcastScroll(presCh, s);
      return;
    }
    if (pointerControlGranted && coViewingChannel) {
      const ch = supabase.getChannels().find(c => c.topic === `realtime:${coViewingChannel}`);
      if (ch) broadcastScroll(ch, s);
    }
  }, [pointerControlGranted, coViewingChannel]);

  // Cursor publish for whoever's currently driving:
  //  - Phase 2b: recipient with pointer_control publishes on the
  //    coview channel
  //  - "Presenter cursor always visible": presenter publishes on
  //    the presenter channel so recipients can render the overlay
  // Same broadcast event in both directions; receivers render
  // whichever email shows up in the payload.
  const handlePublishCursor = useCallback((c: { page: number; xRatio: number; yRatio: number }) => {
    if (!recipient) return;
    const presCh = presenterPubChannelRef.current;
    if (presCh) {
      presCh.send({
        type:    'broadcast',
        event:   'controller_cursor',
        payload: { email: recipient.email, page: c.page, xRatio: c.xRatio, yRatio: c.yRatio },
      }).catch(() => {});
      return;
    }
    if (pointerControlGranted && coViewingChannel) {
      const ch = supabase.getChannels().find(c2 => c2.topic === `realtime:${coViewingChannel}`);
      if (ch) ch.send({
        type:    'broadcast',
        event:   'controller_cursor',
        payload: { email: recipient.email, page: c.page, xRatio: c.xRatio, yRatio: c.yRatio },
      }).catch(() => {});
    }
  }, [pointerControlGranted, coViewingChannel, recipient]);

  if (revoked)                        return <RevokedScreen reason={revokeReason} />;
  if (error)                          return <RevokedScreen friendly={error} />;
  if (!file || !recipient)            return <AuthLoadingScreen />;
  if (sourceExpired) {
    // B+ guided purged-link message. Device labels come from the session-gated
    // held-status endpoint (never shown without a valid session).
    const others = (heldStatus?.devices ?? []).map(d => d.label).filter(Boolean);
    const heldElsewhere = !!heldStatus?.held_by_recipient && others.length > 0;
    const where = others.length > 1 ? `one of your other devices (${others.join(', ')})` : others[0];
    const senderName = file.sender?.full_name ?? file.sender?.email ?? 'the sender';
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#000', zIndex: 10000,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32,
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
      }}>
        <p style={{ color: '#fff', fontSize: 18, fontWeight: 600, margin: '0 0 10px', textAlign: 'center' }}>
          {heldElsewhere ? 'Open it from your other device' : 'This file is no longer available here'}
        </p>
        <p style={{ color: '#94A3B8', fontSize: 14, lineHeight: 1.5, textAlign: 'center', maxWidth: 480, margin: '0 0 24px' }}>
          {heldElsewhere
            ? `For your security, AspisFile no longer keeps this file on its servers. You saved it on ${where} — open it there, then send a copy to this device.`
            : `For your security, AspisFile no longer keeps this file on its servers, and you don't have a saved copy on this device. Ask ${senderName} to re-send it.`}
        </p>
        <button onClick={onClose} style={{
          height: 38, padding: '0 28px', borderRadius: 10, border: 'none',
          background: '#1E293B', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer',
        }}>Done</button>
      </div>
    );
  }
  if (!legalAccepted)                 return <LegalOverlay file={file} onAccept={() => setLegalAccepted(true)} />;
  // Offline overlay — solid black with reconnect copy. session_key is
  // NOT cleared (only on actual revocation) so when heartbeat comes
  // back active, the existing rendered tiles are still painted under
  // the overlay and we can dismiss without re-auth.
  if (offline) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#000',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 32, zIndex: 10000,
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
      }}>
        <p style={{ color: '#fff', fontSize: 18, fontWeight: 600, margin: '0 0 8px', textAlign: 'center' }}>
          Reconnecting…
        </p>
        <p style={{ color: '#94A3B8', fontSize: 14, lineHeight: 1.5, textAlign: 'center', maxWidth: 480 }}>
          AspisFile keeps your document protected by re-checking access every few seconds.
          Restore your network connection to keep reading.
        </p>
      </div>
    );
  }
  // Sender-approval pending — show the waiting screen INSTEAD of the
  // generic AuthLoadingScreen spinner. The bottom-of-tree overlay was
  // unreachable because the AuthLoadingScreen early-return below
  // would fire first (sessionId is null while waiting for approval).
  // Subscribes to the realtime broadcast; on approve, applyStepUp-
  // Credentials hydrates the session and we drop back to normal render.
  if (pendingApprovalId && pendingApprovalMechanism === 'sender' && !delegationApprovalId) {
    return (
      <SenderApprovalWaitingScreen
        approvalId={pendingApprovalId}
        fileName={file.name}
        senderName={file.sender?.full_name ?? file.sender?.email ?? 'The sender'}
        expiresAt={pendingApprovalExpiresAt}
        onApproved={(creds: StepUpCreds) => {
          applyStepUpCredentials(creds);
          setPendingApprovalId(null);
          setPendingApprovalMechanism(null);
          setPendingApprovalExpiresAt(null);
        }}
        onCancel={() => {
          setPendingApprovalId(null);
          setPendingApprovalMechanism(null);
          setPendingApprovalExpiresAt(null);
          onClose();
        }}
      />
    );
  }
  if (!sessionId || totalPages === 0) return <AuthLoadingScreen />;

  // B5 flag on → wait for the .afs prime before rendering, so tiles come
  // from the re-supplied ciphertext rather than durable S3. (No-op when off.)
  if (afsRenderEnabled && !afsPrimed) return <AuthLoadingScreen />;

  // Screen-capture tool running → black out (unmounts the TileRenderer so
  // tiles stop rendering). Reverses when the poll above clears captureApps.
  if (captureApps.length > 0) return <CaptureBlackoutScreen apps={captureApps} />;
  if (screenshotPaused) return <ScreenshotPausedScreen />;

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
          {/* Phase 2b — controller cursor overlay. Renders nothing
              when no controller is active or the cursor's page
              differs from the rendered page. Position is fixed
              relative to the tile image via querySelector, so the
              overlay survives presenter scroll/zoom of the area. */}
          {presenterSession && currentControllerEmail && controllerCursor && (
            <ControllerCursor
              email={controllerCursor.email}
              page={controllerCursor.page}
              xRatio={controllerCursor.xRatio}
              yRatio={controllerCursor.yRatio}
              currentPage={currentPage}
            />
          )}
          {/* Symmetric overlay for the recipient: shows the
              presenter's cursor while we're following them. The
              underlying state is only populated by CoViewingRecipient
              when followingRef.current is true, but we double-check
              followingPresenter here so a stale frame can't render
              after the user leaves follow mode. */}
          {activeCoViewSessionId && followingPresenter && remoteCursor && (
            <ControllerCursor
              email={remoteCursor.email}
              page={remoteCursor.page}
              xRatio={remoteCursor.xRatio}
              yRatio={remoteCursor.yRatio}
              currentPage={currentPage}
            />
          )}
          <TileRenderer
            sessionId={sessionId}
            fileId={file.id}
            file={file}
            totalPages={totalPages}
            onLock={() => setLocked(true)}
            targetPage={currentPage}
            onCurrentPageChange={setCurrentPage}
            targetZoom={currentZoom}
            onCurrentZoomChange={setCurrentZoom}
            commentMode={fbMode === "comment"}
            comments={[...sentComments, ...draftComments.map((d) => ({ id: d.tempId, page: d.page, x: d.x, y: d.y, body: d.body, draft: true }))]}
            draftPin={pendingComment}
            onPlaceComment={recipientFeedback ? onPlaceComment : undefined}
            drawMode={fbMode === "draw"}
            drawColor="#E0A54B"
            drawTool={drawTool}
            markups={[...sentMarkups, ...draftMarkups.map((d) => ({ id: d.tempId, page: d.page, points: d.points, color: d.color, draft: true, kind: d.kind }))]}
            onStrokeComplete={recipientFeedback ? onStrokeComplete : undefined}
            signMode={fbMode === "sign"}
            onPlaceSignature={recipientFeedback ? onPlaceSignature : undefined}
            signatures={[...sentSignatures, ...draftSignatures.map((d) => ({ id: d.tempId, page: d.page, x: d.x, y: d.y, w: d.w, h: d.h, style: d.style, points: d.points, typed_name: d.typed_name, draft: true }))]}
            // Owner-only entry point for co-viewing. Hidden while a
            // presenter session is already active (PresenterToolbar
            // takes over in the top overlay).
            onPresent={canPresent && !presenterSession ? () => setShowStartModal(true) : undefined}
            // Lock manual scroll + zoom when any of these are true:
            //  - Recipient is following the presenter (existing behaviour)
            //  - Presenter has handed control to a recipient (Phase 2a:
            //    presenter mirrors the controller; if presenter could
            //    also scroll, the two would fight)
            followMode={
              (!!activeCoViewSessionId && followingPresenter)
              || (!!presenterSession && !!currentControllerEmail)
            }
            // Publish scroll when this client is currently driving:
            //  - presenterSession   → presenter publishes (default)
            //  - pointerControlGranted → recipient with control publishes
            onPublishScroll={
              (presenterSession || pointerControlGranted) ? handlePublishScroll : undefined
            }
            // Cursor publish: presenter shares their cursor with all
            // recipients by default; recipient with pointer_control
            // shares theirs back. Each side renders the other's cursor
            // via the ControllerCursor overlay.
            onPublishCursor={
              (presenterSession || pointerControlGranted) ? handlePublishCursor : undefined
            }
            // Apply scroll programmatically when we're not driving:
            //  - recipient + following → mirror presenter
            //  - presenter + controlled → mirror controller
            subscribedScroll={
              (activeCoViewSessionId && followingPresenter && subscribedScroll)
              || (presenterSession && currentControllerEmail && subscribedScroll)
              || null
            }
            // Sprint 2 — recipient .afs download. Prop omitted entirely
            // for owners / disabled / already-deleted-blob so the button
            // does not render at all (per state-machine §1.2).
            onDownload={canDownload ? handleDownload : undefined}
            downloadState={canDownload ? downloadState : undefined}
            // B+ — "Send to another device" export. Shown only once a held
            // .afs copy exists locally (canSend). Owners don't see it (no
            // recipient device context); recipients can send a copy to their
            // other enrolled devices.
            onSend={canSend && !file.is_owner ? handleSendToDevice : undefined}
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
          presenterEmail={recipient?.email}
          controllerEmail={currentControllerEmail}
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
          sessionId={activeCoViewSessionId}
          accessToken={token}
          freeScrollGranted={freeScrollGranted}
          onFreeScrollChanged={setFreeScrollGranted}
          pointerControlGranted={pointerControlGranted}
          onPointerControlChanged={setPointerControlGranted}
          onRemoteCursor={(c) => setRemoteCursor(c ? { ...c, at: Date.now() } : null)}
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

      {/* Suspicious-tier step-up gate. The 'sender' mechanism is
          handled at the top of the render tree (above the AuthLoading-
          Screen early-return) because sessionId is null while waiting.
          OTP/OAuth still ride alongside the file UI as an overlay
          since the recipient is the actor here, not waiting. */}
      {pendingApprovalId && pendingApprovalMechanism === null && !delegationApprovalId && (
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
            setError({
              title: "Open request cancelled",
              body:  "You cancelled this open request. Open the file again from your email to try once more.",
              code:  "CLIENT_APPROVAL_CANCEL",
            });
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

      {/* Recipient feedback — unified draft-then-send menu. Overlay only; never
          touches the tile renderer. Flag-gated (recipientFeedback). Owner review
          shows pins/strokes without any menu. */}
      {recipientFeedback && sessionId && !locked && (
        <FeedbackMenu
          fileId={file.id} sessionId={sessionId}
          mode={fbMode} setMode={setFbMode}
          drawTool={drawTool} setDrawTool={setDrawTool}
          draftDecision={draftDecision} setDraftDecision={setDraftDecision}
          draftComments={draftComments} removeDraftComment={removeDraftComment}
          draftMarkups={draftMarkups} removeDraftMarkup={removeDraftMarkup}
          draftSignatures={draftSignatures} removeDraftSignature={removeDraftSignature}
          onSend={sendBatch} sending={sending}
        />
      )}

      {/* E-signature capture — after tapping a spot in Sign mode. */}
      {recipientFeedback && pendingSignature && !locked && (
        <SignaturePad
          onCancel={() => { setPendingSignature(null); setFbMode("none"); }}
          onDone={addDraftSignature}
        />
      )}

      {/* Draft-comment compose — after tapping a spot in Comment mode. */}
      {recipientFeedback && pendingComment && !locked && (
        <div onClick={() => { setPendingComment(null); setPendingText(""); }}
          style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(4,6,14,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 440, margin: 12, background: "#141830", border: "1px solid #2E3760", borderRadius: 16, padding: "15px 15px 17px",
              boxShadow: "0 24px 60px rgba(0,0,0,.6)", fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif", color: "#EAEFFB" }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 11 }}>
              <span style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 11, fontWeight: 700, color: "#7C9CF5", background: "#1C2347", padding: "3px 9px", borderRadius: 999 }}>💬 COMMENT · PAGE {pendingComment.page}</span>
              <button onClick={() => { setPendingComment(null); setPendingText(""); }} style={{ marginLeft: "auto", background: "none", border: "none", color: "#9098BC", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
            <textarea value={pendingText} onChange={(e) => setPendingText(e.target.value)} maxLength={1000} autoFocus placeholder="Your comment on this spot…"
              style={{ width: "100%", minHeight: 60, resize: "vertical", boxSizing: "border-box", border: "1px solid #2E3760", background: "#080A14", color: "#EAEFFB", borderRadius: 10, padding: "10px 12px", fontSize: 13, fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 9, marginTop: 11 }}>
              <button onClick={addDraftComment} disabled={!pendingText.trim()}
                style={{ flex: 1, background: pendingText.trim() ? "#2E55D4" : "#26305A", color: "#fff", border: "none", borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 660, cursor: pendingText.trim() ? "pointer" : "default" }}>Add to drafts</button>
              <button onClick={() => { setPendingComment(null); setPendingText(""); }} style={{ padding: "11px 14px", borderRadius: 10, border: "1px solid #2E3760", background: "transparent", color: "#9098BC", cursor: "pointer", fontSize: 13 }}>Cancel</button>
            </div>
            <div style={{ fontFamily: "ui-monospace,Menlo,monospace", fontSize: 10.5, color: "#666E96", marginTop: 9, textAlign: "center" }}>Draft only — nothing is sent until you press Send.</div>
          </div>
        </div>
      )}
    </>
  );
}
