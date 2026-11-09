import { sql } from "drizzle-orm";
import { check, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  CHANNELS,
  DRAFT_SOURCES,
  EXAMPLE_SOURCES,
  POST_KINDS,
  POST_STATUSES,
} from "../app/promo/types";
import { ALERT_KINDS, ALERT_STATUSES } from "../app/kakao/types";

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
