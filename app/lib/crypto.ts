const ITERATIONS = 100_000; // Workers caps PBKDF2 at 100,000
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(pw: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pw),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2$100000$<saltB64>$<hashB64> */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(pw, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > ITERATIONS) return false;
  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  const actual = await derive(pw, salt, iterations);
  return safeBytesEqual(actual, expected);
}

/** base64url, no padding. 32 bytes -> 43 chars. */
export function randomToken(bytes = 32): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function safeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  // timingSafeEqual requires equal lengths, so zero-pad both to the longer one
  // and fold the length check in afterwards. Sync on purpose: an async variant
  // would be a truthy Promise if a caller forgot to await it.
  const len = Math.max(a.length, b.length);
  const pa = new Uint8Array(len);
  const pb = new Uint8Array(len);
  pa.set(a);
  pb.set(b);
  // not in the bundled lib typings yet, but present in workerd
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
  };
  const same = subtle.timingSafeEqual(pa, pb);
  return same && a.length === b.length;
}

export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return safeBytesEqual(enc.encode(a), enc.encode(b));
}
