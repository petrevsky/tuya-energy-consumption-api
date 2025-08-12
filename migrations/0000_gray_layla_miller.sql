CREATE TABLE `DailyConsumption` (
	`id` integer PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`device_id` text NOT NULL,
	`low_tariff_kwh` real DEFAULT 0 NOT NULL,
	`high_tariff_kwh` real DEFAULT 0 NOT NULL,
	`last_processed_timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `Devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `Devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`household_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `Households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `Households` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `InvoicePeriods` (
	`id` integer PRIMARY KEY NOT NULL,
	`household_id` integer NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `Households`(`id`) ON UPDATE no action ON DELETE no action
);
