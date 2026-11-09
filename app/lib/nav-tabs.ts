/** A menu tab: `end` = only the exact path counts (the index tab), else sub-paths count too. */
export type TabLink = { to: string; end: boolean };

export function tabMatches(link: TabLink, pathname: string): boolean {
  if (link.end || link.to === "/") return pathname === link.to;
  return pathname === link.to || pathname.startsWith(`${link.to}/`);
}

/**
 * Which tab to light. While a tap is loading the next page, its tab lights at once (the tap's
 * feedback), not when the server answers; otherwise the tab of the page on screen.
 */
export function litTab(links: readonly TabLink[], pathname: string, pendingPathname: string | null): string | null {
  const pending = pendingPathname === null ? undefined : links.find((l) => tabMatches(l, pendingPathname));
  if (pending) return pending.to;
  return links.find((l) => tabMatches(l, pathname))?.to ?? null;
}
