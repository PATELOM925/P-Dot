import { MCP_SERVER_NAMES, type McpServerId } from "@/lib/connectors";
import { FocusedMessage } from "./FocusedMessage";
import { mcpConnectedDate, type McpCardState } from "./mcp";

const PILL: Record<McpCardState["kind"], { label: string; className: string }> = {
  not_set_up: { label: "Not set up", className: "status-pill" },
  account_required: { label: "Needs an account", className: "status-pill" },
  load_failed: { label: "Error", className: "status-pill status-failed" },
  not_connected: { label: "Not connected", className: "status-pill" },
  needs_reconnect: { label: "Connect again", className: "status-pill status-failed" },
  connected: { label: "Connected", className: "status-pill status-executed" },
};

function ConnectForm({ app, label, describedBy }: { app: McpServerId; label: string; describedBy: string }) {
  return (
    <form method="post" action={`/api/connectors/mcp/${app}/connect`}>
      <button type="submit" className="button button-primary button-small" aria-describedby={describedBy}>
        {label}
      </button>
    </form>
  );
}

/** One read-only app connection (decision 0016). */
export function McpCard({
  app,
  state,
  message,
}: {
  app: McpServerId;
  state: McpCardState;
  message: { text: string; error: boolean } | null;
}) {
  const name = MCP_SERVER_NAMES[app];
  const pill = PILL[state.kind];
  const helpId = `${app}-connect-help`;
  const help = `P-Dot reads ${name} only for a message that names ${name}. You can turn it off for that message. P-Dot cannot change anything in ${name}.`;
  return (
    <article className="panel" id={app} aria-labelledby={`${app}-heading`}>
      <div className="panel-heading">
        <h3 id={`${app}-heading`}>
          <span className="chip">{name}</span>
        </h3>
        <span className={pill.className}>{pill.label}</span>
      </div>
      {message ? <FocusedMessage text={message.text} error={message.error} /> : null}
      {state.kind === "not_set_up" && (
        <p className="muted">{name} is not set up on this site yet. The site owner must add the connector settings first.</p>
      )}
      {state.kind === "account_required" && (
        <p>Create an account to connect {name}. A demo session cannot connect an app.</p>
      )}
      {state.kind === "load_failed" && (
        <p className="alert alert-error" role="alert">
          P-Dot could not load your {name} connection. Reload the page to try again.
        </p>
      )}
      {state.kind === "not_connected" && (
        <>
          <p id={helpId}>{help}</p>
          <ConnectForm app={app} label={`Connect ${name}`} describedBy={helpId} />
        </>
      )}
      {state.kind === "needs_reconnect" && (
        <>
          <p id={helpId}>
            {name} access ended. Connect again to continue. {help}
          </p>
          <ConnectForm app={app} label={`Connect ${name} again`} describedBy={helpId} />
        </>
      )}
      {state.kind === "connected" && (
        <>
          <p className="connector-status">Connected since {mcpConnectedDate(state.connectedAt)}</p>
          <p>{help}</p>
          <p>
            {state.ready.length} of {state.ready.length + state.missing.length} tools ready
          </p>
          {state.ready.length > 0 && (
            <ul aria-label={`What P-Dot can read in ${name}`}>
              {state.ready.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          )}
          {state.missing.length > 0 && <p className="muted">Not available: {state.missing.join(", ")}</p>}
          {state.noRefresh && <p className="muted">Access ends soon. P-Dot cannot renew it. Connect again then.</p>}
          <form method="post" action={`/api/connectors/mcp/${app}/disconnect`}>
            <button type="submit" className="button button-small" aria-describedby={`${app}-disconnect-help`}>
              Disconnect {name}
            </button>
          </form>
          <p id={`${app}-disconnect-help`} className="muted">
            Disconnect deletes the stored key. It also ends P-Dot&apos;s access at {name} when {name} allows it.
          </p>
        </>
      )}
    </article>
  );
}
