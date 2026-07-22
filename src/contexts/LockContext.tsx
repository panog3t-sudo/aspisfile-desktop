import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getActiveSessionToken } from "../lib/recipient-session";

// Phase 1 Day 9.7 — desktop lock state. Sibling to mobile's
// contexts/LockContext.tsx. Differences from mobile:
//   - localStorage instead of AsyncStorage (webview-origin scoped,
//     survives app restarts but resets on app uninstall — same
//     ergonomic as mobile's AsyncStorage)
//   - biometricAvailable resolved from Tauri get_platform: macOS and
//     Windows have biometric Rust commands wired (src-tauri/src/
//     commands.rs::authenticate_biometric). Linux has none.
//   - The 60s blur lock trigger is already implemented in
//     SecureViewer.tsx::useLockGuard. This context tracks the locked
//     state itself; setLocked is invoked by useLockGuard.

const KEY_SETUP_COMPLETE    = "lock_setup_complete_v1";
const KEY_BIOMETRIC_ENABLED = "lock_biometric_enabled_v1";
const KEY_PIN_SET           = "lock_pin_set_v1";

type LockContextType = {
  locked:             boolean;
  // True once init() has finished — localStorage read, biometric
  // availability resolved, cold-start lock decision made. Consumers
  // that race the init (e.g. cold-start .afs drain) should wait on
  // this before reading `locked` so they don't see the initial
  // optimistic-false and skip the buffering branch.
  initialised:        boolean;
  setupComplete:      boolean;
  biometricEnabled:   boolean;
  pinSet:             boolean;
  biometricAvailable: boolean;
  markSetupComplete(opts: { biometricEnabled: boolean; pinSet: boolean }): Promise<void>;
  unlock(): void;
  lock(): void;

  // Single-prompt biometric dedup. Any caller that successfully runs
  // a Touch ID / Windows Hello prompt calls recordBiometric();
  // sibling gates check lastBiometricAt and skip their own prompt if
  // it's within BIOMETRIC_FRESH_MS. Prevents the double-Touch-ID UX
  // when the app-level lock and per-file gate both want verification
  // for one logical user action.
  lastBiometricAt:   number;
  recordBiometric(): void;

  // Hard global mutex. Mirrors the mobile fix — prevents concurrent
  // invoke('authenticate_biometric') calls. The mobile crash was
  // SIGABRT from overlapping LAContext evaluations; macOS native
  // LAContext has the same single-evaluation contract so the desktop
  // is vulnerable too even if we haven't crashed yet.
  tryBeginBiometric(): boolean;
  endBiometric(): void;
};

// 30s — short enough that an attacker who grabs the unlocked Mac
// can't browse files, long enough that a single user "open the app
// + open a file" action only sees ONE Touch ID prompt.
export const BIOMETRIC_FRESH_MS = 30 * 1000;

const LockContext = createContext<LockContextType>({
  locked:             false,
  initialised:        false,
  setupComplete:      true,  // default true so the UI doesn't flash SetupModal before init
  biometricEnabled:   false,
  pinSet:             false,
  biometricAvailable: false,
  markSetupComplete:  async () => {},
  unlock:             () => {},
  lock:               () => {},
  lastBiometricAt:    0,
  recordBiometric:    () => {},
  tryBeginBiometric:  () => true,
  endBiometric:       () => {},
});

export function LockProvider({ children }: { children: ReactNode }) {
  const [locked,             setLockedState]        = useState(false);
  const [setupComplete,      setSetupComplete]      = useState(true);   // pessimistic on init: skip modal until storage read
  const [biometricEnabled,   setBiometricEnabled]   = useState(false);
  const [pinSet,             setPinSet]             = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [initialised,        setInitialised]        = useState(false);
  const [lastBiometricAt,    setLastBiometricAt]    = useState(0);
  const biometricInFlightRef = useRef(false);

  useEffect(() => {
    const init = async () => {
      // Local storage flags
      let setupRaw = "0", bioRaw = "0", pinRaw = "0";
      try {
        setupRaw = localStorage.getItem(KEY_SETUP_COMPLETE)    ?? "0";
        bioRaw   = localStorage.getItem(KEY_BIOMETRIC_ENABLED) ?? "0";
        pinRaw   = localStorage.getItem(KEY_PIN_SET)           ?? "0";
        setSetupComplete(setupRaw === "1");
        setBiometricEnabled(bioRaw === "1");
        setPinSet(pinRaw === "1");
      } catch { /* localStorage may be unavailable in some sandboxed
                   Tauri contexts — fall through to defaults */ }

      // Biometric capability via Tauri Rust command. macOS uses
      // LAContext (Touch ID + password fallback); Windows uses
      // UserConsentVerifier. Linux falls through to PIN-only.
      // Real availability, not "is this Windows". The old check assumed any
      // Windows machine had Hello and offered a biometric that then hard-failed
      // on PCs with no Hello configured (managed/corporate — our market). The
      // Rust command checks UserConsentVerifier::CheckAvailabilityAsync on
      // Windows; macOS always has a password fallback so returns true.
      try {
        setBiometricAvailable(await invoke<boolean>("biometric_available"));
      } catch {
        setBiometricAvailable(false);
      }

      // Cold-start app lock (2026-05-30 per user request): if the
      // device has any enrolled credential — sender setupComplete OR
      // Phase A+ recipient session — start LOCKED so the app opens
      // straight to LockScreen and the user has to prove presence
      // before reaching IdleScreen / viewer. Matches the mobile
      // LockContext change. Configurable per-user is deferred (see
      // memory project_deferred_configurable_app_lock.md).
      const recipientToken    = getActiveSessionToken();
      const recipientPresent  = !!recipientToken;
      const senderCanUnlock   = setupRaw === "1" && (bioRaw === "1" || pinRaw === "1");
      const shouldColdStartLock = recipientPresent || senderCanUnlock;
      setLockedState(shouldColdStartLock);

      setInitialised(true);
    };
    init();
  }, []);

  // ── App-level blur lock (mirrors mobile's AppState background path) ──
  // Fires setLocked(true) after the AspisFile window has been unfocused
  // for 60s OR after 2 min of no user interaction in the window. Only
  // active when the user has any unlock credential — sender setup OR
  // Phase A+ recipient session. Distinct from SecureViewer's
  // useLockGuard which only runs when a file is actively being viewed.
  useEffect(() => {
    if (!initialised) return;
    const recipientToken  = getActiveSessionToken();
    const senderCanUnlock = setupComplete && (biometricEnabled || pinSet);
    const enabled = !!recipientToken || senderCanUnlock;
    if (!enabled) return;
    // Do NOT arm the recurring idle/blur re-lock when there is no LOCAL
    // authenticator (no Windows Hello / Touch ID) and no PIN. Re-locking would
    // force a browser+phone QR round-trip on every idle timeout — unusable
    // (reported 2026-07-22). The cold-start lock still fires once per launch
    // and is satisfied by the browser passkey unlock; that one deliberate
    // presence proof per session is the balance for these machines.
    if (!biometricAvailable && !pinSet) return;

    const BLUR_MS = 60 * 1000;
    const IDLE_MS = 2 * 60 * 1000;
    let blurTimer:  number;
    let idleTimer:  number;

    const lockNow   = () => setLockedState(true);
    const resetIdle = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(lockNow, IDLE_MS);
    };
    const handleBlur  = () => { blurTimer = window.setTimeout(lockNow, BLUR_MS); };
    const handleFocus = () => window.clearTimeout(blurTimer);

    const events = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;
    events.forEach((e) => document.addEventListener(e, resetIdle, { passive: true }));
    window.addEventListener("blur",  handleBlur);
    window.addEventListener("focus", handleFocus);
    resetIdle();

    return () => {
      window.clearTimeout(idleTimer);
      window.clearTimeout(blurTimer);
      events.forEach((e) => document.removeEventListener(e, resetIdle));
      window.removeEventListener("blur",  handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, [initialised, setupComplete, biometricEnabled, pinSet, biometricAvailable]);

  const markSetupComplete = async (opts: { biometricEnabled: boolean; pinSet: boolean }) => {
    try {
      localStorage.setItem(KEY_SETUP_COMPLETE,    "1");
      localStorage.setItem(KEY_BIOMETRIC_ENABLED, opts.biometricEnabled ? "1" : "0");
      localStorage.setItem(KEY_PIN_SET,           opts.pinSet ? "1" : "0");
    } catch { /* see init() comment */ }
    setSetupComplete(true);
    setBiometricEnabled(opts.biometricEnabled);
    setPinSet(opts.pinSet);
  };

  return (
    <LockContext.Provider
      value={{
        // Suppress overlays until initialised — otherwise the SetupModal
        // flashes on cold-start before localStorage is read.
        locked:             initialised ? locked : false,
        initialised,
        setupComplete:      initialised ? setupComplete : true,
        biometricEnabled,
        pinSet,
        biometricAvailable,
        markSetupComplete,
        unlock: () => setLockedState(false),
        lock:   () => setLockedState(true),
        lastBiometricAt,
        recordBiometric: () => setLastBiometricAt(Date.now()),
        tryBeginBiometric: () => {
          if (biometricInFlightRef.current) return false;
          biometricInFlightRef.current = true;
          return true;
        },
        endBiometric: () => {
          biometricInFlightRef.current = false;
        },
      }}
    >
      {children}
    </LockContext.Provider>
  );
}

export const useLock = () => useContext(LockContext);
