/** A fake of Google's HTTP endpoints. Each handler answers one URL prefix; every call is recorded. */
export interface GoogleCall {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
}

export type GoogleHandler = (call: GoogleCall) => Response | Promise<Response>;

export function fakeGoogle(handlers: Record<string, GoogleHandler>) {
  const calls: GoogleCall[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: GoogleCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers,
      signal: init?.signal,
    };
    calls.push(call);
    const prefix = Object.keys(handlers)
      .filter((key) => url.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) throw new Error(`No fake for ${url}`);
    return handlers[prefix]!(call);
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** An unsigned ID token with these claims, as Google's token endpoint returns one. */
export function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
