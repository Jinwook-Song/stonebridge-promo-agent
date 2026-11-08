// Short-lived signed links to private R2 photos, so Claude's servers can fetch them
// without a session. The signature covers the key and the expiry, nothing else.

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const payload = (key: string, exp: number | string) => encoder.encode(`${key}\n${exp}`);

export async function signImageUrl(
  origin: string,
  key: string,
  secret: string,
  now: Date,
  ttlSec = 600,
): Promise<string> {
  const exp = Math.floor(now.getTime() / 1000) + ttlSec;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), payload(key, exp));
  return `${origin}/img/${key}?exp=${exp}&sig=${toBase64Url(new Uint8Array(mac))}`;
}

export async function verifyImageSig(
  key: string,
  exp: string,
  sig: string,
  secret: string,
  now: Date,
): Promise<boolean> {
  if (!/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) < now.getTime() / 1000) return false;
  const mac = fromBase64Url(sig);
  if (!mac) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, payload(key, exp));
}
