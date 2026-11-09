/**
 * Requests that reach the Worker on its own *.workers.dev host get sent to PUBLIC_ORIGIN (the
 * pages.dev front, which Korea reaches via Seoul instead of LA). 308 keeps the method and body, so
 * an old tab's form POST still lands. Returns null when the request is already on the right host,
 * when PUBLIC_ORIGIN is not https (local dev), or when PUBLIC_ORIGIN itself is the workers.dev host.
 */
export function canonicalRedirect(requestUrl: string, publicOrigin: string): string | null {
  const url = new URL(requestUrl);
  if (!url.hostname.endsWith(".workers.dev")) return null;
  let target: URL;
  try {
    target = new URL(publicOrigin);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.host === url.host) return null;
  return `${target.origin}${url.pathname}${url.search}`;
}
