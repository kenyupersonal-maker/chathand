CREATE TABLE `rc_chunks` (
	`job_id` text NOT NULL,
	`direction` text NOT NULL,
	`sequence` integer NOT NULL,
	`chunk_hash` text NOT NULL,
	`data_b64` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `rc_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rc_chunks_identity` ON `rc_chunks` (`job_id`,`direction`,`sequence`);--> statement-breakpoint
CREATE TABLE `rc_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`generation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rc_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`caller_hash` text NOT NULL,
	`rpc_id_json` text NOT NULL,
	`session_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`method` text NOT NULL,
	`request_bytes` integer NOT NULL,
	`request_chunks` integer NOT NULL,
	`response_hash` text,
	`response_bytes` integer,
	`response_chunks` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`tombstone_until` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`claim_id` text,
	`cancel_requested` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rc_jobs_dedupe_key_unique` ON `rc_jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `rc_jobs_queued_idx` ON `rc_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `rc_jobs_expiry_idx` ON `rc_jobs` (`expires_at`,`tombstone_until`);