import { sql } from "drizzle-orm";
import { check, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import {
  CHANNELS,
  DRAFT_SOURCES,
  EXAMPLE_SOURCES,
  POST_KINDS,
  POST_STATUSES,
} from "../app/promo/types";

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
    workflowId: text("workflow_id"),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: text("created_at").notNull(),
    generatedAt: text("generated_at"),
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
