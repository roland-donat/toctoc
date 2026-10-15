CREATE TABLE `dwelling_units` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`label` text NOT NULL,
	`label_key` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dwelling_units_address_label_idx` ON `dwelling_units` (`address_id`,`label_key`);--> statement-breakpoint
CREATE INDEX `dwelling_units_address_idx` ON `dwelling_units` (`address_id`);--> statement-breakpoint
ALTER TABLE `registrations` ADD `dwelling_unit_id` text;--> statement-breakpoint
ALTER TABLE `visits` ADD `dwelling_unit_id` text REFERENCES dwelling_units(id);--> statement-breakpoint
ALTER TABLE `visits` ADD `non_registered` integer DEFAULT false NOT NULL;