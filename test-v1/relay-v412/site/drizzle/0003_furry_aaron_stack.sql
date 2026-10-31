ALTER TABLE `rc_devices` ADD `warm_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rc_jobs` ADD `claimed_at` integer;--> statement-breakpoint
ALTER TABLE `rc_jobs` ADD `consumed_at` integer;--> statement-breakpoint
ALTER TABLE `rc_jobs` ADD `waiters` integer DEFAULT 0 NOT NULL;