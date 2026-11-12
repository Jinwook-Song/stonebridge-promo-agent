CREATE TABLE `demo_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `demo_calls_at_idx` ON `demo_calls` (`at`);