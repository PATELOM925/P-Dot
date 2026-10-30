"use client";

import { useState } from "react";
import { ApiError, errorMessage, sendJson } from "@/lib/api-client";
import { telegramSendText } from "@/lib/telegram";

type CardState =
  | { kind: "closed" }
  | { kind: "open"; key: string }
  | { kind: "sending"; key: string }
  | { kind: "sent" }
  | { kind: "unknown" }
  | { kind: "failed"; message: string };

/**
 * "Send to Telegram" under a reply (decision 0020). It opens an approval card
 * with the exact text and the chat. Only the Send button sends, once for each
 * card: the card's key makes a repeat send nothing. A new card has a new key.
 */
export function SendToTelegram({ text, chatName }: { text: string; chatName: string }) {
  const [state, setState] = useState<CardState>({ kind: "closed" });
  const shown = telegramSendText(text);
  if (!shown.text) return null;
  const open = () => setState({ kind: "open", key: crypto.randomUUID() });

  async function send(key: string) {
    setState({ kind: "sending", key });
    try {
      const result = await sendJson<{ status: "sent" | "unknown" }>("/api/connectors/telegram/send", "POST", { text: shown.text, key });
      setState(result.status === "sent" ? { kind: "sent" } : { kind: "unknown" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({
        kind: "failed",
        message: error instanceof ApiError && error.status === 0
          ? "P-Dot could not reach the server. The message may not be sent. Check Telegram before you send again."
          : errorMessage(error, "Telegram did not send it. Try again."),
      });
    }
  }

  if (state.kind === "closed") {
    return (
      <button type="button" className="button button-small" onClick={open}>
        Send to Telegram
      </button>
    );
  }
  if (state.kind === "sent") return <p className="hint" role="status">Sent to your Telegram.</p>;

  return (
    <section
      className={`approval-card telegram-card${state.kind === "open" || state.kind === "sending" ? " approval-proposed" : ""}`}
      aria-label="Send this reply to Telegram"
    >
      <div className="panel-heading">
        <h3>Send to Telegram</h3>
        <span className="status-pill">Needs your approval</span>
      </div>
      <p>
        To: <strong>{chatName || "your Telegram chat"}</strong> (your own chat with the P-Dot bot)
      </p>
      <pre className="telegram-preview">{shown.text}</pre>
      {shown.cut && <p className="muted">Telegram allows a limited length. P-Dot sends only the part above.</p>}
      {state.kind === "unknown" && (
        <p className="alert alert-warning" role="status">
          Telegram did not answer in time. The message may be sent. Check your Telegram chat before you send again.
        </p>
      )}
      {state.kind === "failed" && (
        <p className="alert alert-error" role="alert">
          {state.message}
        </p>
      )}
      <div className="actions">
        {state.kind === "open" || state.kind === "sending" ? (
          <button type="button" className="button button-primary button-small" disabled={state.kind === "sending"} onClick={() => void send(state.key)}>
            {state.kind === "sending" ? "Sending…" : "Send"}
          </button>
        ) : (
          <button type="button" className="button button-small" onClick={open}>
            Send again
          </button>
        )}
        <button type="button" className="button button-small" disabled={state.kind === "sending"} onClick={() => setState({ kind: "closed" })}>
          {state.kind === "open" || state.kind === "sending" ? "Cancel" : "Close"}
        </button>
      </div>
    </section>
  );
}
