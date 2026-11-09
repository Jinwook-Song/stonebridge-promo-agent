import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  CHANNELS,
  DRAFT_SOURCES,
  EXAMPLE_SOURCES,
  POST_KINDS,
  POST_STATUSES,
} from "../app/promo/types";
import { ALERT_KINDS, ALERT_STATUSES } from "../app/kakao/types";
import { PRICE_KINDS, QUOTE_SOURCES, QUOTE_STATUSES, VERSION_STATUSES } from "../app/quote/types";
import { WATCH_KINDS, WATCH_STATUSES } from "../app/watch/types";

// 시각은 모두 UTC ISO 문자열.

const inList = (column: unknown, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(","))})`;

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const loginAttempts = sqliteTable("login_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ip: text("ip").notNull(),
  at: text("at").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
});

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: POST_KINDS }).notNull(),
    memo: text("memo").notNull(),
    privateCustomer: integer("private_customer", { mode: "boolean" }).notNull(),
    attachPrices: integer("attach_prices", { mode: "boolean" }).notNull(),
    status: text("status", { enum: POST_STATUSES }).notNull(),
    /** Channel currently being rewritten by a single-channel regenerate, if any. */
    rewritingChannel: text("rewriting_channel", { enum: CHANNELS }),
    /** Instance id of the Workflow that owns the current (or last) generation. */
    workflowId: text("workflow_id"),
    /** When the current (or last) generation was claimed; a claim older than 40 min is stale. */
    generationStartedAt: text("generation_started_at"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: text("created_at").notNull(),
    generatedAt: text("generated_at"),
    /** When the "초안 준비됐어요" Kakao alert was claimed; set once, so it is sent at most once. */
    draftNotifiedAt: text("draft_notified_at"),
  },
  (t) => [
    check("posts_kind_check", inList(t.kind, POST_KINDS)),
    check("posts_status_check", inList(t.status, POST_STATUSES)),
  ],
);

export const photos = sqliteTable(
  "photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull().unique(),
    position: integer("position").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    /** One-line description from the last full generation (DraftOutput.photos). */
    note: text("note"),
  },
  (t) => [unique("photos_post_position_unique").on(t.postId, t.position)],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: CHANNELS }).notNull(),
    version: integer("version").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    /** JSON array of strings. */
    hashtags: text("hashtags"),
    source: text("source", { enum: DRAFT_SOURCES }).notNull(),
    confirmedAt: text("confirmed_at"),
    /** How much the owner changed the AI draft (0..1), set when she confirms an edited version. */
    editRatio: real("edit_ratio"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("drafts_post_channel_version_unique").on(t.postId, t.channel, t.version),
    check("drafts_channel_check", inList(t.channel, CHANNELS)),
    check("drafts_source_check", inList(t.source, DRAFT_SOURCES)),
  ],
);

export const examples = sqliteTable(
  "examples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel", { enum: CHANNELS }).notNull(),
    kind: text("kind", { enum: POST_KINDS }).notNull(),
    title: text("title"),
    body: text("body").notNull(),
    source: text("source", { enum: EXAMPLE_SOURCES }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sourceUrl: text("source_url"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("examples_channel_check", inList(t.channel, CHANNELS)),
    check("examples_kind_check", inList(t.kind, POST_KINDS)),
    check("examples_source_check", inList(t.source, EXAMPLE_SOURCES)),
  ],
);

/**
 * The one Kakao account that receives alerts (id is always 1). Whoever connects last replaces it,
 * so the developer can test with their own account and the owner takes over by connecting again.
 */
export const kakaoLink = sqliteTable(
  "kakao_link",
  {
    id: integer("id").primaryKey(),
    kakaoUserId: text("kakao_user_id").notNull(),
    accessToken: text("access_token").notNull(),
    accessExpiresAt: text("access_expires_at").notNull(),
    refreshToken: text("refresh_token").notNull(),
    refreshExpiresAt: text("refresh_expires_at").notNull(),
    linkedAt: text("linked_at").notNull(),
    /** Set when Kakao rejects the refresh token; she has to connect again. */
    needsRelogin: integer("needs_relogin", { mode: "boolean" }).notNull().default(false),
    lastError: text("last_error"),
  },
  (t) => [check("kakao_link_single_row", sql`${t.id} = 1`)],
);

export const alertLog = sqliteTable(
  "alert_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ALERT_KINDS }).notNull(),
    /** KST date (order) or KST month (monthly) the alert is for. */
    periodKey: text("period_key").notNull(),
    status: text("status", { enum: ALERT_STATUSES }).notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    sentAt: text("sent_at"),
  },
  (t) => [
    unique("alert_log_kind_period_unique").on(t.kind, t.periodKey),
    check("alert_log_kind_check", inList(t.kind, ALERT_KINDS)),
    check("alert_log_status_check", inList(t.status, ALERT_STATUSES)),
  ],
);

/** Price sheet. `unitPrice` is the supply price (VAT excluded); null = the owner has not set it. */
export const priceItems = sqliteTable(
  "price_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: PRICE_KINDS }).notNull(),
    name: text("name").notNull(),
    content: text("content").notNull().default(""),
    unit: text("unit").notNull(),
    unitPrice: integer("unit_price"),
    minimumQty: integer("minimum_qty"),
    menu: text("menu").notNull().default(""),
    note: text("note").notNull().default(""),
    /** A seeded price the owner has not confirmed yet; highlighted in the editor. */
    needsConfirm: integer("needs_confirm", { mode: "boolean" }).notNull().default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sort: integer("sort").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [check("price_items_kind_check", inList(t.kind, PRICE_KINDS))],
);

/** Event details (customer, date, headcount...) live per version in quote_versions.event_json. */
export const quotes = sqliteTable(
  "quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    status: text("status", { enum: QUOTE_STATUSES }).notNull(),
    source: text("source", { enum: QUOTE_SOURCES }).notNull(),
    /** JSON Sender snapshot taken when the quote was created. */
    senderJson: text("sender_json").notNull(),
    vatIncluded: integer("vat_included", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("quotes_status_check", inList(t.status, QUOTE_STATUSES)),
    check("quotes_source_check", inList(t.source, QUOTE_SOURCES)),
  ],
);

export const quoteVersions = sqliteTable(
  "quote_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", { enum: VERSION_STATUSES }).notNull(),
    error: text("error"),
    /** Instance id of the Workflow that owns this generation. */
    workflowId: text("workflow_id"),
    /** When the generation was claimed; a claim older than 40 min is stale (same as posts). */
    generationStartedAt: text("generation_started_at"),
    inputText: text("input_text").notNull(),
    /** What the owner asked to change relative to the previous version; null for version 1. */
    changeRequest: text("change_request"),
    /** JSON QuoteEvent / QuoteLine[] / Comparison; null until generated. */
    eventJson: text("event_json"),
    linesJson: text("lines_json"),
    comparisonJson: text("comparison_json"),
    emailSubject: text("email_subject"),
    emailBody: text("email_body"),
    /** JSON array of strings describing what changed from the previous version. */
    changesJson: text("changes_json"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: text("created_at").notNull(),
    generatedAt: text("generated_at"),
  },
  (t) => [
    unique("quote_versions_quote_version_unique").on(t.quoteId, t.version),
    check("quote_versions_status_check", inList(t.status, VERSION_STATUSES)),
  ],
);

export const watchSources = sqliteTable(
  "watch_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    kind: text("kind", { enum: WATCH_KINDS }).notNull(),
    url: text("url").notNull(),
    memo: text("memo").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    /** Newest item key seen so far (RSS guid/link), so only newer items are read. */
    lastSeenKey: text("last_seen_key"),
    lastRunAt: text("last_run_at"),
    lastStatus: text("last_status", { enum: WATCH_STATUSES }),
    lastError: text("last_error"),
    /** Hash of the last fetched page content (kind = page), to skip unchanged pages. */
    contentHash: text("content_hash"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("watch_sources_kind_check", inList(t.kind, WATCH_KINDS)),
    check("watch_sources_status_check", sql`${t.lastStatus} IS NULL OR ${inList(t.lastStatus, WATCH_STATUSES)}`),
  ],
);

export const competitorEvents = sqliteTable("competitor_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceId: integer("source_id")
    .notNull()
    .references(() => watchSources.id, { onDelete: "cascade" }),
  sourceUrl: text("source_url").notNull().unique(),
  date: text("date"),
  client: text("client"),
  venue: text("venue"),
  eventType: text("event_type"),
  /** JSON array of strings. */
  menuJson: text("menu_json"),
  quantity: integer("quantity"),
  headcount: integer("headcount"),
  price: integer("price"),
  seenAt: text("seen_at").notNull(),
});

export const competitorPrices = sqliteTable(
  "competitor_prices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => watchSources.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    packageName: text("package_name").notNull(),
    perPerson: integer("per_person"),
    /** JSON array of strings. */
    itemsJson: text("items_json"),
    minimum: integer("minimum"),
    /** JSON array of { label, amount } extra fees. */
    feesJson: text("fees_json"),
    seenAt: text("seen_at").notNull(),
  },
  (t) => [index("competitor_prices_source_package_idx").on(t.sourceId, t.packageName)],
);
