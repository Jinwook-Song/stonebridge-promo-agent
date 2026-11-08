CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`channel` text NOT NULL,
	`version` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`hashtags` text,
	`source` text NOT NULL,
	`confirmed_at` text,
	`edit_ratio` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "drafts_channel_check" CHECK("drafts"."channel" IN ('blog','instagram','daangn','place')),
	CONSTRAINT "drafts_source_check" CHECK("drafts"."source" IN ('ai','edit'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_post_channel_version_unique` ON `drafts` (`post_id`,`channel`,`version`);--> statement-breakpoint
CREATE TABLE `examples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_url` text,
	`created_at` text NOT NULL,
	CONSTRAINT "examples_channel_check" CHECK("examples"."channel" IN ('blog','instagram','daangn','place')),
	CONSTRAINT "examples_kind_check" CHECK("examples"."kind" IN ('case','product','other')),
	CONSTRAINT "examples_source_check" CHECK("examples"."source" IN ('blog_import','owner_final'))
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ip` text NOT NULL,
	`at` text NOT NULL,
	`ok` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`r2_key` text NOT NULL,
	`position` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_r2_key_unique` ON `photos` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `photos_post_position_unique` ON `photos` (`post_id`,`position`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`memo` text NOT NULL,
	`private_customer` integer NOT NULL,
	`attach_prices` integer NOT NULL,
	`status` text NOT NULL,
	`rewriting_channel` text,
	`workflow_id` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`generated_at` text,
	CONSTRAINT "posts_kind_check" CHECK("posts"."kind" IN ('case','product','other')),
	CONSTRAINT "posts_status_check" CHECK("posts"."status" IN ('draft','generating','ready','failed'))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
