PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_alias` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`platform` text NOT NULL,
	`platform_id` text NOT NULL,
	`nickname` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `user_alias_platform_unique` UNIQUE(`platform`,`platform_id`)
);
--> statement-breakpoint
INSERT INTO `__new_user_alias`(`id`, `platform`, `platform_id`, `nickname`, `created_at`, `last_seen_at`) SELECT `id`, `platform`, `platform_id`, `nickname`, `created_at`, `last_seen_at` FROM `user_alias`;--> statement-breakpoint
DROP TABLE `user_alias`;--> statement-breakpoint
ALTER TABLE `__new_user_alias` RENAME TO `user_alias`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `user_alias_platform_unique`;