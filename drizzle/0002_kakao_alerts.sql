CREATE TABLE `alert_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`period_key` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`sent_at` text,
	CONSTRAINT "alert_log_kind_check" CHECK("alert_log"."kind" IN ('order','monthly')),
	CONSTRAINT "alert_log_status_check" CHECK("alert_log"."status" IN ('sending','sent','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_log_kind_period_unique` ON `alert_log` (`kind`,`period_key`);--> statement-breakpoint
CREATE TABLE `kakao_link` (
	`id` integer PRIMARY KEY NOT NULL,
	`kakao_user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`access_expires_at` text NOT NULL,
	`refresh_token` text NOT NULL,
	`refresh_expires_at` text NOT NULL,
	`linked_at` text NOT NULL,
	`needs_relogin` integer DEFAULT false NOT NULL,
	`last_error` text,
	CONSTRAINT "kakao_link_single_row" CHECK("kakao_link"."id" = 1)
);
