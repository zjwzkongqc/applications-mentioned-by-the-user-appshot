CREATE TABLE `account_credentials` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_credentials_email` ON `account_credentials` (`email`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`actor_member_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`details` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_club` ON `audit_events` (`club_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `monthly_ratings` (
	`member_id` text NOT NULL,
	`month` text NOT NULL,
	`forehand` integer,
	`backhand` integer,
	`serve` integer,
	`return_skill` integer,
	`net` integer,
	`footwork` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `month`),
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `record_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`member_id` text NOT NULL,
	`record_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_record_photos_record` ON `record_photos` (`record_id`);--> statement-breakpoint
CREATE INDEX `idx_record_photos_club` ON `record_photos` (`club_id`);--> statement-breakpoint
ALTER TABLE `club_invites` ADD `revoked_at` text;--> statement-breakpoint
ALTER TABLE `club_invites` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clubs` ADD `invite_revoked_at` text;--> statement-breakpoint
ALTER TABLE `members` ADD `removed_at` text;--> statement-breakpoint
ALTER TABLE `members` ADD `public_share_hash` text;