import "server-only";

// AES-256-GCM through WebCrypto (decision 0014). The sealed form is
// "v1.<iv>.<ciphertext and tag>", both base64url. The associated data binds a
// sealed value to one purpose, for example one user's Google token, so a value
// copied to another row or purpose does not open.

const VERSION = "v1";
const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Random bytes as base64url, for OAuth state and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function importKey(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealText(key: Uint8Array, plaintext: string, associatedData: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) },
    await importKey(key),
    encoder.encode(plaintext),
  );
  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** The plaintext, or null when the value is not in the v1 form, was changed, or has other associated data. */
export async function openText(key: Uint8Array, sealed: string, associatedData: string): Promise<string | null> {
  const [version, ivText, bodyText, extra] = sealed.split(".");
  if (version !== VERSION || ivText === undefined || bodyText === undefined || extra !== undefined) return null;
  const iv = fromBase64Url(ivText);
  const body = fromBase64Url(bodyText);
  if (!iv || iv.length !== IV_BYTES || !body || body.length < 16) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(associatedData) },
      await importKey(key),
      body as BufferSource,
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}

/** S256 code challenge for a PKCE verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export const tokenAssociatedData = (userId: string, provider: string) => `pdot:connected_accounts:${userId}:${provider}`;
export const OAUTH_STATE_ASSOCIATED_DATA = "pdot:oauth_state:google";
