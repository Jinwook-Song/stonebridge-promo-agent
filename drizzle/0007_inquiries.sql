CREATE TABLE `inquiries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_token` text NOT NULL,
	`ip_hash` text NOT NULL,
	`contact_name` text NOT NULL,
	`org` text NOT NULL,
	`phone` text NOT NULL,
	`email` text NOT NULL,
	`event_date` text,
	`start_time` text NOT NULL,
	`venue` text NOT NULL,
	`headcount` integer,
	`event_type` text NOT NULL,
	`menus_json` text NOT NULL,
	`budget` text NOT NULL,
	`requests` text NOT NULL,
	`referral` text NOT NULL,
	`consent_at` text NOT NULL,
	`quote_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inquiries_client_token_unique` ON `inquiries` (`client_token`);--> statement-breakpoint
CREATE INDEX `inquiries_ip_created_idx` ON `inquiries` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `inquiries_quote_idx` ON `inquiries` (`quote_id`);