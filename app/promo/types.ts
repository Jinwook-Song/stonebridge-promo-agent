export const CHANNELS = ["blog", "instagram", "daangn", "place"] as const;
export type Channel = (typeof CHANNELS)[number];

export const POST_KINDS = ["case", "product", "other"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const POST_STATUSES = ["draft", "generating", "ready", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const DRAFT_SOURCES = ["ai", "edit"] as const;
export type DraftSource = (typeof DRAFT_SOURCES)[number];

export const EXAMPLE_SOURCES = ["blog_import", "owner_final"] as const;
export type ExampleSource = (typeof EXAMPLE_SOURCES)[number];

/** New-post upload limits, shared by the form and the server-side checks. */
export const MAX_PHOTOS = 8;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_MEMO_CHARS = 500;
