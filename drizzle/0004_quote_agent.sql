CREATE TABLE `competitor_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`source_url` text NOT NULL,
	`date` text,
	`client` text,
	`venue` text,
	`event_type` text,
	`menu_json` text,
	`quantity` integer,
	`headcount` integer,
	`price` integer,
	`seen_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `watch_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_events_source_url_unique` ON `competitor_events` (`source_url`);--> statement-breakpoint
CREATE TABLE `competitor_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`source_url` text NOT NULL,
	`package_name` text NOT NULL,
	`per_person` integer,
	`items_json` text,
	`minimum` integer,
	`fees_json` text,
	`seen_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `watch_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_prices_source_package_idx` ON `competitor_prices` (`source_id`,`package_name`);--> statement-breakpoint
CREATE TABLE `price_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`unit` text NOT NULL,
	`unit_price` integer,
	`minimum_qty` integer,
	`menu` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`needs_confirm` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "price_items_kind_check" CHECK("price_items"."kind" IN ('per_person','per_event'))
);
--> statement-breakpoint
CREATE TABLE `quote_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`quote_id` integer NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`workflow_id` text,
	`generation_started_at` text,
	`input_text` text NOT NULL,
	`change_request` text,
	`event_json` text,
	`lines_json` text,
	`comparison_json` text,
	`email_subject` text,
	`email_body` text,
	`changes_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`generated_at` text,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "quote_versions_status_check" CHECK("quote_versions"."status" IN ('generating','ready','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quote_versions_quote_version_unique` ON `quote_versions` (`quote_id`,`version`);--> statement-breakpoint
CREATE TABLE `quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`sender_json` text NOT NULL,
	`vat_included` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "quotes_status_check" CHECK("quotes"."status" IN ('draft','sent','won','lost')),
	CONSTRAINT "quotes_source_check" CHECK("quotes"."source" IN ('app','imported'))
);
--> statement-breakpoint
CREATE TABLE `watch_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_seen_key` text,
	`last_run_at` text,
	`last_status` text,
	`last_error` text,
	`content_hash` text,
	`created_at` text NOT NULL,
	CONSTRAINT "watch_sources_kind_check" CHECK("watch_sources"."kind" IN ('rss','page')),
	CONSTRAINT "watch_sources_status_check" CHECK("watch_sources"."last_status" IS NULL OR "watch_sources"."last_status" IN ('ok','error'))
);
