// #5 — per-device sign-in friction signal.
//
// The enrolment/sign-in gate leads with "Sign in with your passkey" after the
// recipient cancels the native Touch ID / Windows Hello sheet — the fastest way
// back in when the cancel was a fat-finger. But a recipient who keeps cancelling
// (their vault has no usable passkey on THIS device, they don't recognise the
// prompt, corporate policy blocks it…) shouldn't be pushed at the same wall over
// and over. After a couple of cancels we "escalate to code": the email-code path
// becomes the emphasised primary and the passkey retry demotes to a quiet link.
//
// The signal is per-device (localStorage), survives the gate re-mounting between
// attempts, and resets the moment ANY passkey ceremony succeeds — so a recipient
// who simply mis-tapped once isn't permanently steered away from their passkey.

const KEY = "aspis_passkey_friction";
const ESCALATE_AT = 2; // two consecutive cancels → prefer the code path

export function recordPasskeyCancel(): void {
  try {
    const n = Number(localStorage.getItem(KEY) ?? "0") || 0;
    localStorage.setItem(KEY, String(n + 1));
  } catch { /* private mode / storage disabled — no escalation, no harm */ }
}

export function resetPasskeyFriction(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// True once the recipient has cancelled the passkey sheet enough times that we
// should lead with the email-code path instead of another passkey attempt.
export function passkeyIsFrictiony(): boolean {
  try { return (Number(localStorage.getItem(KEY) ?? "0") || 0) >= ESCALATE_AT; }
  catch { return false; }
}
