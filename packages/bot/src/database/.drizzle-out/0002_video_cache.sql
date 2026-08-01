CREATE TABLE `video_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `video_cache_updated_at_idx` ON `video_cache` (`updated_at`);