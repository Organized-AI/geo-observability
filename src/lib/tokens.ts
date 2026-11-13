import { sha256Hex } from "./util";

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Share-link token: <shareId>.<expiresUnix>.<hmac>. The share_links row can still revoke it. */
export async function signShare(secret: string, shareId: string, expiresAt: Date): Promise<string> {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${shareId}.${exp}.${await hmac(secret, `${shareId}.${exp}`)}`;
}

export async function verifyShare(secret: string, token: string): Promise<string | null> {
  const [id, exp, sig] = token.split(".");
  if (!id || !exp || !sig || !/^\d+$/.test(exp)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  return timingSafeEqual(sig, await hmac(secret, `${id}.${exp}`)) ? id : null;
}

/** API key secrets are shown once; only a SHA-256 hash is stored. */
export async function newApiKey(): Promise<{ secret: string; hash: string; prefix: string }> {
  const secret = `geo_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  return { secret, hash: await sha256Hex(secret), prefix: secret.slice(0, 10) };
}
