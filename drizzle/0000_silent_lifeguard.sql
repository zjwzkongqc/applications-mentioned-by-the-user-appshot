CREATE TABLE `cheers` (
	`record_id` text NOT NULL,
	`member_id` text NOT NULL,
	`emoji` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cheers_record_member` ON `cheers` (`record_id`,`member_id`);--> statement-breakpoint
CREATE TABLE `clubs` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_hash` text NOT NULL,
	`name` text NOT NULL,
	`slogan` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clubs_invite_hash` ON `clubs` (`invite_hash`);--> statement-breakpoint
CREATE TABLE `culture` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`member_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_culture_club` ON `culture` (`club_id`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`nickname` text NOT NULL,
	`avatar_key` text,
	`bio` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_members_club` ON `members` (`club_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_members_club_session` ON `members` (`club_id`,`session_hash`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`member_id` text NOT NULL,
	`play_date` text NOT NULL,
	`minutes` integer NOT NULL,
	`partners` text NOT NULL,
	`venue` text NOT NULL,
	`mood` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_records_club_date` ON `records` (`club_id`,`play_date`);--> statement-breakpoint
CREATE INDEX `idx_records_member` ON `records` (`member_id`);