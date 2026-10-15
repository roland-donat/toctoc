CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`number` integer,
	`rep` text,
	`street_name` text NOT NULL,
	`street_key` text NOT NULL,
	`lieu_dit` text,
	`postal_code` text,
	`insee_code` text NOT NULL,
	`match_key` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`dwellings` integer,
	`retired_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `addresses_match_key_idx` ON `addresses` (`match_key`);--> statement-breakpoint
CREATE INDEX `addresses_street_key_idx` ON `addresses` (`street_key`);--> statement-breakpoint
CREATE TABLE `admin_account` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`failed_logins` integer DEFAULT 0 NOT NULL,
	`last_failed_at` integer
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cheatsheets` (
	`id` text PRIMARY KEY NOT NULL,
	`age_band` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `electors` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`birth_name` text NOT NULL,
	`usage_name` text,
	`first_names` text NOT NULL,
	`sex` text,
	`birth_date` text,
	`birth_commune_code` text,
	`birth_commune` text,
	`birth_department` text,
	`birth_country` text,
	`nationality` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `electors_identity_key_unique` ON `electors` (`identity_key`);--> statement-breakpoint
CREATE TABLE `import_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`kind` text NOT NULL,
	`bureau` text,
	`order_number` integer,
	`elector_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`elector_id`) REFERENCES `electors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`imported_at` integer NOT NULL,
	`row_count` integer NOT NULL,
	`is_current` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`elector_id` text NOT NULL,
	`import_id` text NOT NULL,
	`list_type` text NOT NULL,
	`bureau` text NOT NULL,
	`order_number` integer,
	`address_id` text,
	`match_status` text NOT NULL,
	`fallback_proposal_id` text,
	`raw_number` text,
	`raw_street` text,
	`raw_complement1` text,
	`raw_complement2` text,
	`raw_lieu_dit` text,
	`raw_postal_code` text,
	FOREIGN KEY (`elector_id`) REFERENCES `electors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registrations_import_elector_list_idx` ON `registrations` (`import_id`,`elector_id`,`list_type`);--> statement-breakpoint
CREATE INDEX `registrations_address_idx` ON `registrations` (`address_id`);--> statement-breakpoint
CREATE INDEX `registrations_bureau_order_idx` ON `registrations` (`bureau`,`order_number`);--> statement-breakpoint
CREATE TABLE `vote_history` (
	`id` text PRIMARY KEY NOT NULL,
	`elector_id` text NOT NULL,
	`election` text NOT NULL,
	`round` integer NOT NULL,
	`value` text NOT NULL,
	`proxy` text,
	`import_id` text,
	FOREIGN KEY (`elector_id`) REFERENCES `electors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vote_history_elector_round_idx` ON `vote_history` (`elector_id`,`election`,`round`);--> statement-breakpoint
CREATE TABLE `field_links` (
	`id` text PRIMARY KEY NOT NULL,
	`itinerary_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_links_token_hash_unique` ON `field_links` (`token_hash`);--> statement-breakpoint
CREATE TABLE `itineraries` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`name` text,
	`zone` text NOT NULL,
	`start_lat` real NOT NULL,
	`start_lon` real NOT NULL,
	`duration_minutes` integer NOT NULL,
	`total_seconds` integer NOT NULL,
	`show_names` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `itinerary_doors` (
	`itinerary_id` text NOT NULL,
	`address_id` text NOT NULL,
	`position` integer NOT NULL,
	`service_seconds` integer NOT NULL,
	`walk_seconds_from_previous` integer NOT NULL,
	`priority` integer NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`itinerary_id`, `address_id`),
	FOREIGN KEY (`itinerary_id`) REFERENCES `itineraries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `visits` (
	`id` text PRIMARY KEY NOT NULL,
	`address_id` text NOT NULL,
	`dwelling` text,
	`visit_date` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`source` text NOT NULL,
	`itinerary_id` text,
	`contact` text,
	`contact_quality` text,
	`to_accompany` integer DEFAULT false NOT NULL,
	`accompany_done` integer DEFAULT false NOT NULL,
	`to_revisit` integer DEFAULT false NOT NULL,
	`qualification` text,
	`qualification_scope` text,
	`remarks` text,
	FOREIGN KEY (`address_id`) REFERENCES `addresses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `visits_address_idx` ON `visits` (`address_id`);--> statement-breakpoint
CREATE INDEX `visits_date_idx` ON `visits` (`visit_date`);