CREATE TABLE `rc_runtime` (
	`id` text PRIMARY KEY NOT NULL,
	`manifest_json` text NOT NULL,
	`settings_json` text NOT NULL,
	`revision` text NOT NULL,
	`updated_at` integer NOT NULL
);
