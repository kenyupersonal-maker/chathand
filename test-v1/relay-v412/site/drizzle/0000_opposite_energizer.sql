CREATE TABLE `relay_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`claim_id` text,
	`result_json` text,
	`completed_at` integer
);
