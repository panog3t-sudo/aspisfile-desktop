import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  setupComplete:      boolean;
  biometricEnabled:   boolean;
  pinSet:             boolean;
  biometricAvailable: boolean;
  markSetupComplete(opts: { biometricEnabled: boolean; pinSet: boolean }): Promise<void>;
  unlock(): void;
  lock(): void;
};

const LockContext = createContext<LockContextType>({
  locked:             false,
  setupComplete:      true,  // default true so the UI doesn't flash SetupModal before init
  biometricEnabled:   false,
  pinSet:             false,
  biometricAvailable: false,
  markSetupComplete:  async () => {},
  unlock:             () => {},
  lock:               () => {},
});

export function LockProvider({ children }: { children: ReactNode }) {
  const [locked,             setLockedState]        = useState(false);
  const [setupComplete,      setSetupComplete]      = useState(true);   // pessimistic on init: skip modal until storage read
  const [biometricEnabled,   setBiometricEnabled]   = useState(false);
  const [pinSet,             setPinSet]             = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [initialised,        setInitialised]        = useState(false);

  useEffect(() => {
    const init = async () => {
      // Local storage flags
      try {
        setSetupComplete(localStorage.getItem(KEY_SETUP_COMPLETE) === "1");
        setBiometricEnabled(localStorage.getItem(KEY_BIOMETRIC_ENABLED) === "1");
        setPinSet(localStorage.getItem(KEY_PIN_SET) === "1");
      } catch { /* localStorage may be unavailable in some sandboxed
                   Tauri contexts — fall through to defaults */ }

      // Biometric capability via Tauri Rust command. macOS uses
      // LAContext (Touch ID + password fallback); Windows uses
      // UserConsentVerifier. Linux falls through to PIN-only.
      try {
        const platform = await invoke<string>("get_platform");
        setBiometricAvailable(platform === "macos" || platform === "windows");
      } catch {
        setBiometricAvailable(false);
      }

      setInitialised(true);
    };
    init();
  }, []);

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
        setupComplete:      initialised ? setupComplete : true,
        biometricEnabled,
        pinSet,
        biometricAvailable,
        markSetupComplete,
        unlock: () => setLockedState(false),
        lock:   () => setLockedState(true),
      }}
    >
      {children}
    </LockContext.Provider>
  );
}

export const useLock = () => useContext(LockContext);
