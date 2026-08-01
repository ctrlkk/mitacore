CREATE TABLE `media_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_cache_kind_updated_at_idx` ON `media_cache` (`kind`,`updated_at`);