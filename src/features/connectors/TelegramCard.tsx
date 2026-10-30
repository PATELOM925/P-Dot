import { FocusedMessage } from "./FocusedMessage";
import { mcpConnectedDate } from "./mcp";
import { TelegramLinkButton } from "./TelegramLinkButton";

export type TelegramCardState =
  | { kind: "account_required" }
  | { kind: "load_failed" }
  | { kind: "not_linked" }
  /** A row whose chat does not open (the key changed). Link again. */
  | { kind: "relink" }
  | { kind: "linked"; name: string; linkedAt: string };

const PILL: Record<TelegramCardState["kind"], { label: string; className: string }> = {
  account_required: { label: "Needs an account", className: "status-pill" },
  load_failed: { label: "Error", className: "status-pill status-failed" },
  not_linked: { label: "Not linked", className: "status-pill" },
  relink: { label: "Link again", className: "status-pill status-failed" },
  linked: { label: "Linked", className: "status-pill status-executed" },
};

const HELP =
  "P-Dot sends a message to your own Telegram chat only when you press Send on its card under a reply. The bot does not read your Telegram messages.";

/** The Telegram link (decision 0020). Shown only when the site owner set up the bot. */
export function TelegramCard({ state, message }: { state: TelegramCardState; message: { text: string; error: boolean } | null }) {
  const pill = PILL[state.kind];
  return (
    <article className="panel" id="telegram" aria-labelledby="telegram-heading">
      <div className="panel-heading">
        <h3 id="telegram-heading">
          <span className="chip">Telegram</span>
        </h3>
        <span className={pill.className}>{pill.label}</span>
      </div>
      {message ? <FocusedMessage text={message.text} error={message.error} /> : null}
      {state.kind === "account_required" && <p>Create an account to link Telegram. A demo session cannot link an app.</p>}
      {state.kind === "load_failed" && (
        <p className="alert alert-error" role="alert">
          P-Dot could not load your Telegram link. Reload the page to try again.
        </p>
      )}
      {(state.kind === "not_linked" || state.kind === "relink") && (
        <>
          <p id="telegram-help">{state.kind === "relink" ? `P-Dot cannot read your link now. Link Telegram again. ${HELP}` : HELP}</p>
          <TelegramLinkButton label={state.kind === "relink" ? "Link Telegram again" : "Link Telegram"} describedBy="telegram-help" />
        </>
      )}
      {state.kind === "linked" && (
        <>
          <p className="connector-status">
            Linked to {state.name || "your Telegram chat"} since {mcpConnectedDate(state.linkedAt)}
          </p>
          <p>{HELP}</p>
          <form method="post" action="/api/connectors/telegram/unlink">
            <button type="submit" className="button button-small">
              Unlink Telegram
            </button>
          </form>
        </>
      )}
      {state.kind === "relink" && (
        <form method="post" action="/api/connectors/telegram/unlink">
          <button type="submit" className="button button-small">
            Unlink Telegram
          </button>
        </form>
      )}
    </article>
  );
}
