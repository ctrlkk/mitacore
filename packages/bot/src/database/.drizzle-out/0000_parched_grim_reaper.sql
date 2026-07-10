CREATE TABLE `user_alias` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text NOT NULL,
	`platform_id` text NOT NULL,
	`nickname` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_alias_platform_unique` ON `user_alias` (`platform`,`platform_id`);