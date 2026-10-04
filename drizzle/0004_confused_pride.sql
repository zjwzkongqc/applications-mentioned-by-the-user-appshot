CREATE TABLE `account_sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_account_sessions_account` ON `account_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_account_sessions_expiry` ON `account_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounts_recovery_hash` ON `accounts` (`recovery_hash`);--> statement-breakpoint
CREATE TABLE `auth_failures` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`failures` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_registrations` (
	`account_id` text NOT NULL,
	`club_id` text NOT NULL,
	`legacy_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`club_id`, `legacy_hash`, `nonce_hash`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_auth_registrations_expiry` ON `auth_registrations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `club_invites` (
	`invite_hash` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_club_invites_club` ON `club_invites` (`club_id`);--> statement-breakpoint
ALTER TABLE `members` ADD `account_id` text REFERENCES accounts(id);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_members_club_account` ON `members` (`club_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `idx_members_account` ON `members` (`account_id`);