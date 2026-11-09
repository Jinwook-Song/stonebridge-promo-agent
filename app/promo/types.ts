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

/** AI photo pick limits: browser-made thumbnails (640 px JPEG, ~40–80 KB) sent to /api/photo-pick. */
export const MAX_PICK_CANDIDATES = 40;
export const MAX_THUMB_BYTES = 300 * 1024;

/** Result-screen edit limits, shared by the editor and saveDraftEdit. */
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 10_000;

/** Display labels, shared by the UI and the prompt. Keep this file free of server-only imports. */
export const KIND_LABELS: Record<PostKind, string> = {
  case: "단체 주문 사례",
  product: "상품·시즌 안내",
  other: "기타",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  blog: "블로그",
  instagram: "인스타",
  daangn: "당근",
  place: "플레이스",
};
