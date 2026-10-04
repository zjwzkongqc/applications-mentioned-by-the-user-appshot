CREATE TABLE `checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`club_id` text NOT NULL,
	`member_id` text NOT NULL,
	`checkin_date` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`club_id`) REFERENCES `clubs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_checkins_member_date` ON `checkins` (`member_id`,`checkin_date`);--> statement-breakpoint
CREATE INDEX `idx_checkins_club_date` ON `checkins` (`club_id`,`checkin_date`);--> statement-breakpoint
ALTER TABLE `records` ADD `training_projects` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `training_content` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `training_effect` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `effect_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `records` ADD `next_plan` text DEFAULT '' NOT NULL;