export const WATCH_KINDS = ["rss", "page"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const WATCH_STATUSES = ["ok", "error"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];
