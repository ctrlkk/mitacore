CREATE TABLE `image_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `image_cache_updated_at_idx` ON `image_cache` (`updated_at`);--> statement-breakpoint
CREATE TABLE `pending_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`nickname` text NOT NULL,
	`date` integer NOT NULL,
	`is_at` integer NOT NULL,
	`is_admin` integer NOT NULL,
	`evaluated` integer,
	`segments` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_messages_session_idx` ON `pending_messages` (`session_id`);