import type { FriendlyAccessError } from "../lib/access-errors";

type Props = {
  /**
   * Heartbeat-driven end reasons: file_revoked, recipient_revoked,
   * session_ended, expired. Maps to a title + body via endedCopy.
   * Pass this when the screen is rendered because the heartbeat said
   * the session ended.
   */
  reason?: string;
  /**
   * Already-translated server / client error. Pass this when the
   * screen is rendered because something failed during the access
   * ceremony; the caller used translateAccessError to convert raw
   * server codes into a user-readable shape before passing it in.
   */
  friendly?: FriendlyAccessError;
};

function endedCopy(reason?: string): { title: string; body: string } {
  switch (reason) {
    case "file_revoked":
      return { title: "File revoked", body: "The sender just revoked this file. Close to exit." };
    case "recipient_revoked":
      return { title: "Access revoked", body: "The sender just revoked your access to this file. Close to exit." };
    case "session_ended":
      return { title: "Session ended", body: "This viewing session ended. Open the file again to continue." };
    case "expired":
      return { title: "Session expired", body: "Your session has expired. Open the file again to continue." };
    default:
      return { title: "Access ended", body: "Your viewing session was closed. Contact the sender if you believe this is an error." };
  }
}

export function RevokedScreen({ reason, friendly }: Props) {
  const { title, body } = friendly
    ? { title: friendly.title, body: friendly.body }
    : endedCopy(reason);

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#000",
        color: "#fff",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif",
        gap: 12,
        padding: 24,
        textAlign: "center",
      }}
    >
      <p style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{title}</p>
      <p style={{ fontSize: 13, color: "#94A3B8", margin: 0, maxWidth: 360, lineHeight: 1.6 }}>
        {body}
      </p>
    </div>
  );
}
