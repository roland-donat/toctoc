CREATE TABLE `commerces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`address_id` text,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `commerces_address_idx` ON `commerces` (`address_id`);--> statement-breakpoint
ALTER TABLE `addresses` ADD `commerce_dismissed_at` integer;