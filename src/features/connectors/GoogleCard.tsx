import { FocusedMessage } from "./FocusedMessage";
import type { GoogleCardState } from "./google";

const PILL: Record<GoogleCardState["kind"], { label: string; className: string }> = {
  not_set_up: { label: "Not set up", className: "status-pill" },
  account_required: { label: "Needs an account", className: "status-pill" },
  load_failed: { label: "Error", className: "status-pill status-failed" },
  not_connected: { label: "Not connected", className: "status-pill" },
  needs_reconnect: { label: "Connect again", className: "status-pill status-failed" },
  connected: { label: "Connected", className: "status-pill status-executed" },
};

function ConnectForm({ label, describedBy }: { label: string; describedBy: string }) {
  return (
    <form method="post" action="/api/connectors/google/connect">
      <button type="submit" className="button button-primary button-small" aria-describedby={describedBy}>
        {label}
      </button>
    </form>
  );
}

/** Gmail and Calendar through one Google connection (decision 0014). */
export function GoogleCard({ state, message }: { state: GoogleCardState; message: { text: string; error: boolean } | null }) {
  const pill = PILL[state.kind];
  return (
    <article className="panel" id="google" aria-labelledby="google-heading">
      <div className="panel-heading">
        <h3 id="google-heading">
          <span className="chip chip-gmail">Gmail</span> <span className="chip chip-calendar">Calendar</span>
        </h3>
        <span className={pill.className}>{pill.label}</span>
      </div>
      {message ? <FocusedMessage text={message.text} error={message.error} /> : null}
      {state.kind === "not_set_up" && (
        <p className="muted">Google is not set up on this site yet. The site owner must add the Google settings first.</p>
      )}
      {state.kind === "account_required" && (
        <p>Create an account to connect Google. A demo session cannot connect a Google account.</p>
      )}
      {state.kind === "load_failed" && (
        <p className="alert alert-error" role="alert">
          P-Dot could not load your Google connection. Reload the page to try again.
        </p>
      )}
      {state.kind === "not_connected" && (
        <>
          <p id="google-connect-help">
            Connect your Google account so P-Dot can read your Gmail and calendar when you ask. P-Dot sends an email or
            adds an event only after you approve it. Google shows you the access before you agree.
          </p>
          <ConnectForm label="Connect Google" describedBy="google-connect-help" />
        </>
      )}
      {state.kind === "needs_reconnect" && (
        <>
          <p id="google-connect-help">
            Google access for <strong>{state.email}</strong> ended. Connect again to continue. While Google is in test mode,
            access ends after 7 days.
          </p>
          <ConnectForm label="Connect Google again" describedBy="google-connect-help" />
        </>
      )}
      {state.kind === "connected" && (
        <>
          <p className="connector-status">
            Connected as <strong>{state.email}</strong>
          </p>
          <ul aria-label="What P-Dot can do with Google">
            {state.access.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <form method="post" action="/api/connectors/google/disconnect">
            <button type="submit" className="button button-small" aria-describedby="google-disconnect-help">
              Disconnect Google
            </button>
          </form>
          <p id="google-disconnect-help" className="muted">
            Disconnect removes P-Dot&apos;s access at Google and deletes the stored key.
          </p>
        </>
      )}
    </article>
  );
}
