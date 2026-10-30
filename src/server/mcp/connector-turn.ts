import "server-only";
import type { McpAccountRepository } from "@/server/db/connected-accounts";
import type { FetchLike } from "@/server/google/http";
import type { Logger } from "@/server/log";
import type { AssistantToolName } from "@/types/api";
import { MCP_SERVERS, isToolPinned, remoteSteps, type CatalogTool, type McpServer, type McpServerId } from "./catalog";
import { McpError, openMcpSession, type McpSession } from "./client";
import { openBundle } from "./bundle";
import { ID_REFUSAL, PHRASE_REFUSAL, TurnIds, isUserPhrase } from "./outbound";
import { canonicalJson } from "./pins";
import { StepStop, type StepCaller } from "./steps";
import { MAX_RESULT_CHARS, MAX_TURN_CHARS, cleanText, resultJson, resultText, untrustedConnectorBlock } from "./results";
import { McpAccessError, openMcpAccess, type McpAccess } from "./token-store";

// The connector services of one chat request (decision 0016): which apps a
// turn may offer, and one ConnectorTurn that runs the reads, holds the
// outbound rule's per-turn IDs and the character budget, and closes every MCP
// session at the end of the turn.

export type ConnectorTools = ReadonlyMap<McpServerId, ReadonlySet<AssistantToolName>>;

export interface ConnectorTurn {
  run(server: McpServer, tool: CatalogTool, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

export interface ConnectorServices {
  /** The verified `is_anonymous` claim. */
  anonymous: boolean;
  /** The pinned tools of each requested app that is connected. No token is used. */
  available(requested: readonly McpServerId[]): Promise<ConnectorTools>;
  startTurn(input: { requestId: string; userMessage: string; servers: readonly McpServerId[]; signal: AbortSignal }): ConnectorTurn;
}

export interface ConnectorDeps {
  repo: McpAccountRepository;
  key: Uint8Array;
  userId: string;
  anonymous: boolean;
  fetch: FetchLike;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** False for an app whose settings are missing (decision 0020). Chat does not offer it. Default: every app. */
  isReady?: (server: McpServerId) => boolean;
}

const ERROR_TEXT: Record<McpError["kind"], string> = {
  unauthorized: "access ended. Tell the user to connect it again on Connectors.",
  forbidden: "did not allow this read.",
  rejected: "did not accept the request.",
  unavailable: "did not answer.",
  timeout: "did not answer in time.",
  too_large: "sent an answer that was too large.",
  bad_response: "sent an answer that P-Dot could not read.",
};

const ACCESS_TEXT: Record<McpAccessError["reason"], string> = {
  not_connected: "is not connected.",
  needs_reconnect: "access ended. Tell the user to connect it again on Connectors.",
  busy: "is busy. Try again in a moment.",
  changed: "connection changed during this message. Try again.",
};

export function createConnectorServices(deps: ConnectorDeps): ConnectorServices {
  return {
    anonymous: deps.anonymous,

    async available(requested) {
      const tools = new Map<McpServerId, Set<AssistantToolName>>();
      if (deps.anonymous || requested.length === 0) return tools;
      const rows = await deps.repo.listMcp(deps.userId);
      for (const row of rows) {
        if (!requested.includes(row.provider) || row.status !== "connected" || deps.isReady?.(row.provider) === false) continue;
        const server = MCP_SERVERS[row.provider];
        const bundle = await openBundle(deps.key, deps.userId, server, row.subject, row.tokenCiphertext);
        if (!bundle) continue;
        const pinned = new Set(server.tools.filter((tool) => isToolPinned(tool, bundle.pins)).map((tool) => tool.name));
        if (pinned.size > 0) tools.set(row.provider, pinned);
      }
      return tools;
    },

    startTurn({ requestId, userMessage, servers, signal }) {
      const ids = new TurnIds(userMessage, servers.map((id) => MCP_SERVERS[id]));
      const sessions = new Map<McpServerId, Promise<{ access: McpAccess; session: McpSession }>>();
      let used = 0;
      // Remote calls made in this turn, for each app, and the answers of calls that may run again (decision 0020).
      const remoteCalls = new Map<McpServerId, number>();
      const answers = new Map<string, Promise<{ json: unknown; text: string }>>();
      const log = (event: string, fields: Record<string, string>) => deps.log("warn", event, { requestId, ...fields });

      const open = (server: McpServer) => {
        let found = sessions.get(server.id);
        if (!found) {
          found = openMcpAccess({
            repo: deps.repo,
            key: deps.key,
            server,
            userId: deps.userId,
            fetch: deps.fetch,
            requestId,
            log: deps.log,
            signal,
            now: deps.now,
            sleep: deps.sleep,
          }).then((access) => ({
            access,
            session: openMcpSession({ url: server.resource, fetch: deps.fetch, token: (force) => access.token(force), signal }),
          }));
          sessions.set(server.id, found);
        }
        return found;
      };

      return {
        async run(server, tool, args) {
          const outbound = { ...args };
          if (tool.outbound.kind === "words" && !isUserPhrase(String(args[tool.outbound.field] ?? ""), userMessage)) {
            log("mcp_outbound_refused", { server: server.id, tool: tool.name, rule: "user_phrase" });
            return PHRASE_REFUSAL;
          }
          if (tool.outbound.kind === "id") {
            const id = ids.allowed(server, String(args[tool.outbound.field] ?? ""));
            if (!id) {
              log("mcp_outbound_refused", { server: server.id, tool: tool.name, rule: "turn_ids" });
              return ID_REFUSAL;
            }
            outbound[tool.outbound.field] = id;
          }
          if (used >= MAX_TURN_CHARS) return "The limit for app data in this turn is reached. Nothing was read.";

          const call = async (remote: string, remoteArgs: Record<string, unknown>) => {
            if (!remoteSteps(tool).some((step) => step.remote === remote)) throw new StepStop("P-Dot does not use this read. Nothing was read.");
            const limit = server.maxRemoteCallsPerTurn;
            const count = remoteCalls.get(server.id) ?? 0;
            if (limit !== undefined && count >= limit) {
              throw new StepStop(`The limit of ${limit} ${server.name} reads for this message is reached. Nothing more was read. Answer with what you have.`);
            }
            const { access, session } = await open(server);
            const pin = access.pins[remote];
            if (!pin) throw new StepStop(`${server.name} does not offer this read. Nothing was read.`);
            if ((await session.pinOfTool(remote)) !== pin) {
              log("mcp_pin_changed", { server: server.id, tool: tool.name });
              throw new StepStop(
                `${server.name} changed the tool ${remote} after the user connected it. P-Dot did not use it. Tell the user to connect ${server.name} again on Connectors.`,
              );
            }
            remoteCalls.set(server.id, count + 1);
            const result = await session.callTool(remote, remoteArgs);
            if (result.isError) throw new StepStop(`${server.name} reported an error. Nothing was read.`);
            return { json: resultJson(result), text: resultText(result) };
          };

          try {
            let text: string;
            if (tool.steps) {
              const caller: StepCaller = {
                call(remote, remoteArgs) {
                  const key = `${server.id}:${remote}:${canonicalJson(remoteArgs)}`;
                  let answer = answers.get(key);
                  if (!answer) {
                    answer = call(remote, remoteArgs);
                    answers.set(key, answer);
                    // A call that failed may run again later in the turn.
                    answer.catch(() => answers.delete(key));
                  }
                  return answer;
                },
                allowId: (id) => ids.add(server, id),
              };
              text = await tool.run(caller, outbound);
            } else {
              const result = await call(tool.remote, tool.remoteArgs(outbound));
              ids.addFromResult(server, result.json);
              text = result.text;
            }
            const cleaned = cleanText(text, Math.min(MAX_RESULT_CHARS, MAX_TURN_CHARS - used));
            used += cleaned.text.length;
            if (!cleaned.text.trim()) return `${server.name} returned nothing.`;
            return untrustedConnectorBlock(server.id, tool.name, cleaned.cut ? `${cleaned.text}\n[cut]` : cleaned.text);
          } catch (error) {
            if (signal.aborted) throw error;
            if (error instanceof StepStop) return error.text;
            if (error instanceof McpAccessError) {
              log("mcp_access_failed", { server: server.id, reason: error.reason });
              return `${server.name} ${ACCESS_TEXT[error.reason]} Nothing was read.`;
            }
            const kind = error instanceof McpError ? error.kind : "bad_response";
            log("mcp_call_failed", { server: server.id, tool: tool.name, kind });
            return `${server.name} ${ERROR_TEXT[kind]} Nothing was read.`;
          }
        },

        close() {
          for (const pending of sessions.values()) {
            pending.then(({ session }) => session.close()).catch(() => undefined);
          }
        },
      };
    },
  };
}
