/** Standard base64 (with padding). */
export function toBase64(bytes: Uint8Array): string {
  // Chunked: spreading a whole photo into fromCharCode overflows the call stack.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
