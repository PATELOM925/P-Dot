import "server-only";
import { z } from "zod";
import { readBounded, type FetchLike } from "@/server/google/http";
import type { McpServer } from "./catalog";

// OAuth for the MCP apps (decision 0016): discovery (RFC 9728 and RFC 8414)
// checked against the catalog, the client ID (CIMD, else RFC 7591), the code
// exchange, the refresh and the revocation. Plain fetch, timeouts, size caps
// and zod. Error bodies give only a short label and are never logged.

export const OAUTH_TIMEOUT_MS = 10_000;
export const REVOKE_TIMEOUT_MS = 5_000;
const MAX_OAUTH_BYTES = 16 * 1024;
const LABEL = /^[A-Za-z_]{1,64}$/;

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    readonly kind: "unsupported" | "rejected" | "unavailable" | "timeout" | "bad_response",
    readonly status: number | null = null,
    /** The `error` value of an OAuth error answer, for example "invalid_grant". */
    readonly label: string | null = null,
  ) {
    super(`OAuth request failed: ${kind}`);
  }
}

async function oauthRequest<T>(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new OAuthError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable");
  }
  let text: string | null;
  try {
    text = await readBounded(response, MAX_OAUTH_BYTES);
  } catch {
    throw new OAuthError(response.ok ? "timeout" : response.status >= 500 ? "unavailable" : "rejected", response.status);
  }
  if (!response.ok) {
    let label: string | null = null;
    try {
      const error = (JSON.parse(text ?? "") as { error?: unknown }).error;
      if (typeof error === "string" && LABEL.test(error)) label = error;
    } catch {
      // No label.
    }
    throw new OAuthError(response.status >= 500 || response.status === 429 ? "unavailable" : "rejected", response.status, label);
  }
  if (text === null) throw new OAuthError("bad_response");
  try {
    const parsed = schema.safeParse(text === "" ? {} : JSON.parse(text));
    if (!parsed.success) throw new OAuthError("bad_response");
    return parsed.data;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("bad_response");
  }
}

const httpsUrl = z.string().max(512).url();

const resourceMetadata = z
  .object({ resource: z.string().max(512), authorization_servers: z.array(z.string().max(512)).min(1).max(10) })
  .loose();

const serverMetadata = z
  .object({
    issuer: z.string().max(512),
    authorization_endpoint: httpsUrl,
    token_endpoint: httpsUrl,
    registration_endpoint: httpsUrl.optional(),
    revocation_endpoint: httpsUrl.optional(),
    code_challenge_methods_supported: z.array(z.string().max(32)).max(20).optional(),
    authorization_response_iss_parameter_supported: z.boolean().optional(),
    client_id_metadata_document_supported: z.boolean().optional(),
  })
  .loose();

export interface AuthEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  issRequired: boolean;
  cimd: boolean;
}

function onAllowedOrigin(server: McpServer, value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && server.authOrigins.includes(url.origin) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** RFC 9728: the metadata URL puts the well-known part between the host and the path. */
export function resourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
}

/** RFC 8414, the same rule for the issuer. */
export function serverMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname === "/" ? "" : url.pathname}`;
}

/**
 * Reads the protected resource metadata and the authorization server metadata.
 * The resource and the issuer must equal the catalog values, and every
 * endpoint must be https on an origin that the catalog allows.
 */
export async function discover(fetchImpl: FetchLike, server: McpServer): Promise<AuthEndpoints> {
  const get: RequestInit = { method: "GET", headers: { accept: "application/json" } };
  const resource = await oauthRequest(fetchImpl, resourceMetadataUrl(server.resource), get, OAUTH_TIMEOUT_MS, resourceMetadata);
  if (resource.resource !== server.resource || !resource.authorization_servers.includes(server.issuer)) {
    throw new OAuthError("unsupported");
  }
  const meta = await oauthRequest(fetchImpl, serverMetadataUrl(server.issuer), get, OAUTH_TIMEOUT_MS, serverMetadata);
  const endpoints = [meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint, meta.revocation_endpoint];
  if (
    meta.issuer !== server.issuer ||
    !endpoints.every((value) => value === undefined || onAllowedOrigin(server, value)) ||
    !meta.code_challenge_methods_supported?.includes("S256")
  ) {
    throw new OAuthError("unsupported");
  }
  return {
    issuer: meta.issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint ?? null,
    revocationEndpoint: meta.revocation_endpoint ?? null,
    issRequired: meta.authorization_response_iss_parameter_supported === true,
    cimd: meta.client_id_metadata_document_supported === true,
  };
}

/** The CIMD that P-Dot hosts. Its URL is the client ID. */
export function clientMetadata(siteUrl: string) {
  return {
    client_id: `${siteUrl}/oauth/client-metadata.json`,
    client_name: "P-Dot",
    client_uri: siteUrl,
    logo_uri: `${siteUrl}/icons/icon-192.png`,
    redirect_uris: [`${siteUrl}/api/connectors/mcp/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

const registration = z.object({ client_id: z.string().min(1).max(512) }).loose();

/**
 * The client ID: the CIMD URL when the server supports CIMD and the site is
 * https, else one dynamic registration (RFC 7591). Throws `unsupported` when
 * neither works.
 */
export async function clientIdFor(fetchImpl: FetchLike, endpoints: AuthEndpoints, siteUrl: string): Promise<string> {
  const metadata = clientMetadata(siteUrl);
  if (endpoints.cimd && siteUrl.startsWith("https://")) return metadata.client_id;
  if (!endpoints.registrationEndpoint) throw new OAuthError("unsupported");
  const { client_id: _id, ...body } = metadata;
  void _id;
  const answer = await oauthRequest(
    fetchImpl,
    endpoints.registrationEndpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, application_type: "web" }),
    },
    OAUTH_TIMEOUT_MS,
    registration,
  );
  return answer.client_id;
}

export function authorizationUrl(
  server: McpServer,
  endpoints: AuthEndpoints,
  input: { clientId: string; redirectUri: string; state: string; codeChallenge: string },
): string {
  const url = new URL(endpoints.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: server.scope,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    resource: server.resource,
  }).toString();
  return url.toString();
}

const tokenAnswer = z
  .object({
    access_token: z.string().min(1).max(4096),
    token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
    expires_in: z.number().int().min(60).max(31_536_000).optional(),
    refresh_token: z.string().min(1).max(2048).optional(),
    scope: z.string().max(2000).optional(),
  })
  .loose();

export interface Tokens {
  accessToken: string;
  /** Milliseconds since the epoch. */
  accessExpiresAt: number;
  refreshToken: string | null;
  /** The scopes P-Dot stores: the granted scopes that the catalog accepts. Empty when none. */
  scopes: string[];
}

export const DEFAULT_EXPIRES_IN_SECONDS = 3600;

function toTokens(server: McpServer, body: z.infer<typeof tokenAnswer>, now: number, previousRefresh: string | null): Tokens {
  const granted = body.scope === undefined ? [server.scope] : body.scope.split(" ").filter(Boolean);
  return {
    accessToken: body.access_token,
    accessExpiresAt: now + (body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
    refreshToken: body.refresh_token ?? previousRefresh,
    scopes: server.acceptedScopes.filter((scope) => granted.includes(scope)),
  };
}

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(body).toString(),
});

export async function exchangeCode(
  fetchImpl: FetchLike,
  server: McpServer,
  input: { tokenEndpoint: string; clientId: string; redirectUri: string; code: string; verifier: string },
  now: number,
): Promise<Tokens> {
  const body = await oauthRequest(
    fetchImpl,
    input.tokenEndpoint,
    form({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: server.resource,
    }),
    OAUTH_TIMEOUT_MS,
    tokenAnswer,
  );
  return toTokens(server, body, now, null);
}

/** A rotated refresh token replaces the old one; an answer without one keeps it. */
export async function refreshTokens(
  fetchImpl: FetchLike,
  server: McpServer,
  input: { tokenEndpoint: string; clientId: string; refreshToken: string },
  now: number,
): Promise<Tokens> {
  const body = await oauthRequest(
    fetchImpl,
    input.tokenEndpoint,
    form({ grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.clientId, resource: server.resource }),
    OAUTH_TIMEOUT_MS,
    tokenAnswer,
  );
  return toTokens(server, body, now, input.refreshToken);
}

/** RFC 7009. True only for a 2xx answer. */
export async function revokeToken(
  fetchImpl: FetchLike,
  input: { revocationEndpoint: string; clientId: string; token: string; hint: "refresh_token" | "access_token" },
): Promise<boolean> {
  try {
    await oauthRequest(
      fetchImpl,
      input.revocationEndpoint,
      form({ token: input.token, token_type_hint: input.hint, client_id: input.clientId }),
      REVOKE_TIMEOUT_MS,
      z.unknown(),
    );
    return true;
  } catch {
    return false;
  }
}
