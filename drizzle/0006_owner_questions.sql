CREATE TABLE `owner_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`why` text,
	`current` text,
	`link` text,
	`link_label` text,
	`apply` text,
	`status` text DEFAULT 'open' NOT NULL,
	`answer` text,
	`answered_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT "owner_questions_kind_check" CHECK("owner_questions"."kind" IN ('text','confirm','action')),
	CONSTRAINT "owner_questions_status_check" CHECK("owner_questions"."status" IN ('open','later','answered','unknown'))
);
