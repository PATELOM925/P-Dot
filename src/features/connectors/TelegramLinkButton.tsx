"use client";

import { useState } from "react";
import { QrCode } from "@/components/ui/QrCode";
import { errorMessage, sendJson } from "@/lib/api-client";

/**
 * Starts a Telegram link (decision 0020): gets a one-time t.me link from the
 * server and shows it as a button and as a QR code for a phone. The code in
 * the link ends after 10 minutes and works once.
 */
export function TelegramLinkButton({ label, describedBy }: { label: string; describedBy: string }) {
  const [busy, setBusy] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const body = await sendJson<{ deepLink: string }>("/api/connectors/telegram/link", "POST", {});
      setDeepLink(body.deepLink);
    } catch (err) {
      setError(errorMessage(err, "P-Dot could not start the link. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (deepLink) {
    return (
      <div className="stack">
        <ol className="steps">
          <li>
            <a className="button button-primary button-small" href={deepLink} target="_blank" rel="noopener noreferrer">
              Open Telegram
            </a>{" "}
            or scan the code with your phone.
          </li>
          <li>In Telegram, select Start.</li>
          <li>Select the button that the bot sends, then select Link this chat.</li>
        </ol>
        <QrCode text={deepLink} label="QR code that opens the P-Dot bot in Telegram" size={140} />
        <p className="muted">This link works once, for 10 minutes.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <div>
        <button type="button" className="button button-primary button-small" onClick={() => void start()} disabled={busy} aria-describedby={describedBy}>
          {busy ? "Starting…" : label}
        </button>
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
