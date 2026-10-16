CREATE TABLE `session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`itinerary_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_events_itinerary_idx` ON `session_events` (`itinerary_id`,`at`);--> statement-breakpoint
ALTER TABLE `itineraries` ADD `archived_at` integer;