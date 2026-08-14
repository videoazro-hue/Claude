// Application-level encryption for credentials this app must itself hold
// long-term (e.g. a Coinbase/eToro read-only API key). This is different
// from the bank flow: there, GoCardless custodies the token and we never
// see a password. For investment providers without an aggregator, the API
// key has to live somewhere - so it's encrypted at rest with a key that
// only exists as a Worker secret (ENCRYPTION_KEY), never in the database
// or in code. A database leak alone does not expose these credentials.
import type { Env } from "./types";

async function getKey(env: Env): Promise<CryptoKey> {
  if (!env.ENCRYPTION_KEY) {
    throw new Error(
      "ENCRYPTION_KEY secret is not set - required before connecting Coinbase/eToro. Generate one with `openssl rand -base64 32` and `wrangler secret put ENCRYPTION_KEY`."
    );
  }
  const raw = base64ToBytes(env.ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return bytesToBase64(combined);
}

export async function decryptSecret(env: Env, stored: string): Promise<string> {
  const key = await getKey(env);
  const combined = base64ToBytes(stored);
  const iv = combined.slice(0, 12);
  const cipher = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}
