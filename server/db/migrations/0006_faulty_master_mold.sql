PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_field_links` (
	`id` text PRIMARY KEY NOT NULL,
	`itinerary_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token` text,
	`issued_at` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_field_links`("id", "itinerary_id", "token_hash", "token", "issued_at", "expires_at", "revoked_at") SELECT "id", "itinerary_id", "token_hash", NULL, "issued_at", "expires_at", "revoked_at" FROM `field_links`;--> statement-breakpoint
DROP TABLE `field_links`;--> statement-breakpoint
ALTER TABLE `__new_field_links` RENAME TO `field_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `field_links_token_hash_unique` ON `field_links` (`token_hash`);--> statement-breakpoint
ALTER TABLE `itineraries` ADD `ended_at` integer;--> statement-breakpoint
-- Links still serving lose their time limit (16/10/2026): only an end, an archive or a revocation stops them now.
UPDATE `field_links` SET `expires_at` = NULL WHERE `revoked_at` IS NULL AND `expires_at` > CAST(strftime('%s', 'now') AS INTEGER) * 1000;
