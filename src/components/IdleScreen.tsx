import { useEffect, useState, useCallback } from "react";
import { getActiveSessionToken, getRecipientSession, RecipientSession } from "../lib/recipient-session";
import { isAfsRenderEnabled, toggleAfsRender } from "../lib/afs-render";

declare const __API_BASE__: string;
const BASE = (typeof __API_BASE__ !== "undefined" && __API_BASE__) || "https://aspisfile.com";

type Props = {
  onLink:   (url: string) => void;
  // Phase A+ Stage 4 — invoked when the user taps "I have an
  // enrollment code". App.tsx switches to the EnrolmentScreen.
  onEnrol?: () => void;
  // Phase 3 — invoked when an enrolled recipient whose session has
  // expired taps "Sign back in". Resolves { ok } on success (App opens
  // any pending file), or { ok:false, message } to show inline.
  onSignIn?: () => Promise<{ ok: boolean; message?: string }>;
  // VDR viewer-home — open a chosen file/room-doc by its access token,
  // exactly as if a deep link had arrived. App wires this to openLink.
  onOpenToken?: (token: string) => void;
};

type HomeDoc  = { id: string; name: string; file_type: string; file_size: number; created_at?: string; token: string };
type HomeRoom = { id: string; name: string; docs: HomeDoc[] };
type HomeData = { rooms: HomeRoom[]; files: HomeDoc[] };
type SortKey  = "name" | "date" | "size";

function fmtSize(n: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });
}

export function IdleScreen({ onLink, onEnrol, onSignIn, onOpenToken }: Props) {
  const [input, setInput] = useState("");
  // Phase A+ UX polish — surface enrolment state on the idle screen so
  // a recipient who already installed the app can either see they're
  // enrolled (and as which email) or find the entry point to enrol
  // without needing a fresh deep-link to arrive first. Mirrors the
  // mobile account.tsx "Recipient identity" card.
  const [session, setSession] = useState<RecipientSession | null>(null);
  // Enrolled on this device but the session token has expired → offer a
  // "Sign back in" affordance instead of a dead "Enrolled" card.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInMsg, setSignInMsg] = useState("");
  // Phase B test toggle — visible in release builds (no devtools to set the
  // localStorage flag from a console). Flipping it takes effect on the next
  // file open (the viewer reads the flag at mount), so no reload needed.
  const [afsOn, setAfsOn] = useState(isAfsRenderEnabled());

  // VDR viewer-home — the recipient's data rooms + files, fetched with the
  // active passkey session. Listing only; opening always runs the full
  // /access pipeline (passkey + identity + enrol-code gates unchanged).
  const [home, setHome] = useState<HomeData | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeErr, setHomeErr] = useState("");

  // Home controls — collapsed sections by default, name filter, sort.
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>({});
  const [filesOpen, setFilesOpen] = useState(false);

  const refresh = () => {
    const s = getRecipientSession();
    setSession(s);
    setNeedsSignIn(!!s && !getActiveSessionToken());
  };

  const loadHome = useCallback(async () => {
    const token = getActiveSessionToken();
    if (!token) return;
    setHomeLoading(true); setHomeErr("");
    try {
      const res = await fetch(`${BASE}/api/v1/viewer/home`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { setHomeErr("Couldn't load your files. Tap refresh to try again."); return; }
      const d = await res.json().catch(() => null);
      if (d) setHome({ rooms: Array.isArray(d.rooms) ? d.rooms : [], files: Array.isArray(d.files) ? d.files : [] });
    } catch {
      setHomeErr("Couldn't reach AspisFile. Check your connection and tap refresh.");
    } finally {
      setHomeLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onVisible = () => refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // Once we have an active session (enrolled + not expired), pull the home list.
  useEffect(() => {
    if (session && !needsSignIn) loadHome();
    else setHome(null);
  }, [session, needsSignIn, loadHome]);

  async function doSignIn() {
    if (!onSignIn || signingIn) return;
    setSignInMsg("");
    setSigningIn(true);
    try {
      const res = await onSignIn();
      if (!res.ok) {
        setSignInMsg(res.message || "Couldn't sign you in on this device. Open your file link from your email.");
      } else {
        refresh(); // App opens any pending file; otherwise the card updates to active.
      }
    } finally {
      setSigningIn(false);
    }
  }

  function handleOpen() {
    const val = input.trim();
    if (val) onLink(val);
  }

  const active = !!session && !needsSignIn;
  const hasItems = !!home && (home.rooms.length > 0 || home.files.length > 0);
  const q = query.trim().toLowerCase();

  // Filter (by name) + sort a document list per the current controls.
  const prep = (docs: HomeDoc[]): HomeDoc[] => {
    const filtered = q ? docs.filter(d => d.name.toLowerCase().includes(q)) : docs;
    return [...filtered].sort((a, b) => {
      let r = 0;
      if (sortBy === "name") r = a.name.localeCompare(b.name);
      else if (sortBy === "size") r = (a.file_size || 0) - (b.file_size || 0);
      else r = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      return sortDir === "asc" ? r : -r;
    });
  };

  // A single clickable document/file row.
  const docRow = (d: HomeDoc) => (
    <button
      key={d.id}
      onClick={() => onOpenToken?.(d.token)}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
        background: "transparent", border: "none", borderTop: "0.5px solid rgba(255,255,255,0.06)",
        padding: "10px 14px", cursor: onOpenToken ? "pointer" : "default", fontFamily: "inherit",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ color: "#64748B", flexShrink: 0 }}>
        <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#E2E8F0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {d.name}
      </span>
      {d.created_at ? <span style={{ fontSize: 11, color: "#64748B", flexShrink: 0, minWidth: 56, textAlign: "right" }}>{fmtDate(d.created_at)}</span> : null}
      {d.file_size ? <span style={{ fontSize: 11, color: "#64748B", flexShrink: 0, minWidth: 52, textAlign: "right" }}>{fmtSize(d.file_size)}</span> : null}
      <span style={{ fontSize: 11.5, color: "#7DB1E8", flexShrink: 0 }}>Open →</span>
    </button>
  );

  // A collapsible section (room or the standalone-files group).
  const section = (key: string, icon: string, title: string, docs: HomeDoc[], open: boolean, toggle: () => void) => {
    if (q && docs.length === 0) return null;
    return (
      <div key={key} style={{ background: "rgba(255,255,255,0.03)", border: "0.5px solid rgba(255,255,255,0.10)", borderRadius: 12, overflow: "hidden" }}>
        <button
          onClick={toggle}
          style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "12px 14px", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
          onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        >
          <span style={{ fontSize: 10, color: "#64748B", width: 10, display: "inline-block", transition: "transform 0.12s", transform: open ? "rotate(90deg)" : "none" }}>▶</span>
          <span style={{ fontSize: 14 }}>{icon}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "#F1F5F9", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <span style={{ fontSize: 11, color: "#64748B", flexShrink: 0 }}>{docs.length} item{docs.length === 1 ? "" : "s"}</span>
        </button>
        {open && (
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {docs.length === 0
              ? <p style={{ fontSize: 12, color: "#64748B", padding: "12px 14px", margin: 0 }}>No documents.</p>
              : docs.map(docRow)}
          </div>
        )}
      </div>
    );
  };

  const sortLabel: Record<SortKey, string> = { name: "Name", date: "Date added", size: "Size" };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: active ? "flex-start" : "center",
        background: "#0F172A",
        color: "#94A3B8",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        gap: 16,
        padding: 32,
        overflowY: "auto",
      }}
    >
      <div style={{ fontSize: 28, marginBottom: 4, marginTop: active ? 12 : 0 }}>🔒</div>
      <p style={{ fontSize: 15, fontWeight: 500, color: "#E2E8F0", margin: 0 }}>
        AspisFile Viewer
      </p>
      {!active && (
        <p style={{ fontSize: 13, margin: 0, color: "#64748B" }}>
          Open a secure file link or double-click a .afs file to begin.
        </p>
      )}

      {/* ── Active session → the recipient's rooms + files ────────────── */}
      {active && (
        <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 12, marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#94A3B8" }}>
              Signed in as <span style={{ color: "#E2E8F0", fontWeight: 500 }}>{session!.email}</span>
            </span>
            <button
              onClick={loadHome}
              disabled={homeLoading}
              style={{ background: "transparent", border: "none", color: "#7DB1E8", fontSize: 12, cursor: homeLoading ? "default" : "pointer", fontFamily: "inherit" }}
            >
              {homeLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {homeLoading && !home && (
            <p style={{ fontSize: 13, color: "#64748B", textAlign: "center", margin: "18px 0" }}>Loading your documents…</p>
          )}
          {homeErr && (
            <p style={{ fontSize: 12.5, color: "#FCA5A5", textAlign: "center", margin: 0 }}>{homeErr}</p>
          )}

          {home && !hasItems && !homeLoading && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "0.5px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: "22px 18px", textAlign: "center" }}>
              <p style={{ fontSize: 13, color: "#94A3B8", margin: 0, lineHeight: 1.6 }}>
                Nothing has been shared with you yet.<br />
                Open a file link from your email to get started.
              </p>
            </div>
          )}

          {/* Filter + sort controls */}
          {hasItems && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Filter by name…"
                style={{ flex: 1, minWidth: 150, height: 34, padding: "0 12px", fontSize: 13, borderRadius: 8, border: "0.5px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.04)", color: "#E2E8F0", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.04)", border: "0.5px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: 2 }}>
                {(["name", "date", "size"] as SortKey[]).map(k => (
                  <button
                    key={k}
                    onClick={() => setSortBy(k)}
                    style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: "inherit", background: sortBy === k ? "#185FA5" : "transparent", color: sortBy === k ? "#fff" : "#94A3B8", whiteSpace: "nowrap" }}
                  >
                    {sortLabel[k]}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
                title={sortDir === "asc" ? "Ascending — tap for descending" : "Descending — tap for ascending"}
                style={{ width: 34, height: 34, borderRadius: 8, border: "0.5px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.04)", color: "#E2E8F0", cursor: "pointer", fontFamily: "inherit", fontSize: 14, flexShrink: 0 }}
              >
                {sortDir === "asc" ? "↑" : "↓"}
              </button>
            </div>
          )}

          {/* Data rooms — collapsed by default; expand to browse + scroll */}
          {home?.rooms.map(room => {
            const docs = prep(room.docs);
            const open = q ? docs.length > 0 : !!expandedRooms[room.id];
            return section(room.id, "📁", room.name, docs, open, () => setExpandedRooms(p => ({ ...p, [room.id]: !p[room.id] })));
          })}

          {/* Your files — collapsed by default */}
          {home && home.files.length > 0 &&
            section("__files__", "🗂️", "Your files", prep(home.files), q ? prep(home.files).length > 0 : filesOpen, () => setFilesOpen(o => !o))}

          {onEnrol && (
            <button
              onClick={onEnrol}
              style={{ alignSelf: "center", marginTop: 2, background: "transparent", border: "none", color: "#94A3B8", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
            >
              Use a different setup code
            </button>
          )}
        </div>
      )}

      {/* ── Session expired → sign back in ────────────────────────────── */}
      {session && needsSignIn && (
        <div
          style={{
            marginTop: 18,
            background: "rgba(255,255,255,0.04)",
            border: "0.5px solid rgba(255,255,255,0.18)",
            borderRadius: 8,
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            maxWidth: 360,
          }}
        >
          <span style={{ fontSize: 10, color: "#64748B", textTransform: "uppercase", letterSpacing: 1 }}>
            Enrolled
          </span>
          <span style={{ fontSize: 13, color: "#E2E8F0", fontWeight: 500, wordBreak: "break-all" }}>
            {session.email}
          </span>
          {onSignIn && (
            <>
              <p style={{ fontSize: 11, color: "#94A3B8", margin: "6px 0 2px", lineHeight: 1.5, textAlign: "center" }}>
                Your secure session expired.
              </p>
              <button
                onClick={doSignIn}
                disabled={signingIn}
                style={{
                  marginTop: 2, background: "#185FA5", border: "none", color: "#fff",
                  padding: "8px 18px", borderRadius: 6, fontSize: 13, fontWeight: 500,
                  cursor: signingIn ? "default" : "pointer", fontFamily: "inherit", opacity: signingIn ? 0.7 : 1,
                }}
              >
                {signingIn ? "Signing you in…" : "Sign back in"}
              </button>
              {signInMsg && (
                <p style={{ fontSize: 11, color: "#FCA5A5", margin: "6px 0 0", lineHeight: 1.5, textAlign: "center", maxWidth: 300 }}>
                  {signInMsg}
                </p>
              )}
            </>
          )}
          {onEnrol && (
            <button
              onClick={onEnrol}
              style={{ marginTop: 4, background: "transparent", border: "none", color: "#94A3B8", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
            >
              Use a different setup code
            </button>
          )}
        </div>
      )}

      {/* ── Not enrolled → quiet setup-code fallback ──────────────────── */}
      {!session && onEnrol && (
        // Last-resort fallback — a quiet link, not a prominent button. The
        // primary path is to open the file link (which enrols automatically);
        // this is here for the recipient who was emailed a setup code. Same
        // label as the code email's "tap 'I have a setup code'".
        <button
          onClick={onEnrol}
          style={{
            marginTop: 16, background: "transparent", border: "none", color: "#64748B",
            padding: "6px 8px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline",
          }}
        >
          I have a setup code
        </button>
      )}

      {/* Dev-mode URL input — paste a share link to test without deep link */}
      {import.meta.env.DEV && (
        <div
          style={{
            marginTop: 24,
            width: "100%",
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <span style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1 }}>
            Dev — paste share link
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="http://localhost:3000/access/TOKEN?sig=...&env=..."
              style={{
                flex: 1,
                padding: "9px 12px",
                borderRadius: 6,
                border: "0.5px solid #334155",
                background: "#1E293B",
                color: "#E2E8F0",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
              }}
            />
            <button
              onClick={handleOpen}
              disabled={!input.trim()}
              style={{
                padding: "9px 16px",
                borderRadius: 6,
                border: "none",
                background: input.trim() ? "#2563EB" : "#1E293B",
                color: input.trim() ? "#fff" : "#475569",
                fontSize: 13,
                cursor: input.trim() ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              Open
            </button>
          </div>
        </div>
      )}

      {/* .afs render toggle — DEV builds only. A real recipient must never see
          this: tapping it could disable the relay render path. Release builds
          keep the hidden Cmd/Ctrl+Shift+A shortcut (App.tsx) as the safety
          switch. Post-cutover .afs render is always ON by default anyway. */}
      {import.meta.env.DEV && (
        <button
          onClick={() => setAfsOn(toggleAfsRender())}
          style={{
            marginTop: 28,
            background: afsOn ? "rgba(37,99,235,0.18)" : "transparent",
            border: `0.5px solid ${afsOn ? "#2563EB" : "rgba(255,255,255,0.14)"}`,
            color: afsOn ? "#93C5FD" : "#475569",
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 11,
            cursor: "pointer",
            fontFamily: "monospace",
            letterSpacing: 0.4,
          }}
        >
          .afs render: {afsOn ? "ON" : "OFF"} · tap to toggle
        </button>
      )}
    </div>
  );
}
