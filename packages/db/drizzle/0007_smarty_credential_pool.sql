CREATE TABLE `smarty_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`auth_id` text NOT NULL,
	`auth_token_encrypted` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`last_status` text DEFAULT 'not_tested' NOT NULL,
	`last_message` text,
	`last_checked_at` text,
	`last_used_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "smarty_credentials_status_check" CHECK("smarty_credentials"."last_status" IN ('not_tested', 'success', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smarty_credentials_auth_id_unique` ON `smarty_credentials` (`auth_id`);
--> statement-breakpoint
CREATE INDEX `smarty_credentials_active_idx` ON `smarty_credentials` (`is_active`);
--> statement-breakpoint
CREATE INDEX `smarty_credentials_status_idx` ON `smarty_credentials` (`last_status`);
--> statement-breakpoint
INSERT OR IGNORE INTO `smarty_credentials` (
	`auth_id`, `auth_token_encrypted`, `is_active`,
	`last_status`, `last_message`, `last_checked_at`,
	`created_at`, `updated_at`
)
SELECT
	`smarty_auth_id`,
	`smarty_auth_token_encrypted`,
	1,
	CASE `smarty_connection_status`
		WHEN 'connected' THEN 'success'
		WHEN 'failed' THEN 'failed'
		ELSE 'not_tested'
	END,
	`smarty_connection_message`,
	`smarty_last_tested_at`,
	`created_at`,
	`updated_at`
FROM `system_settings`
WHERE `smarty_auth_id` <> '' AND `smarty_auth_token_encrypted` IS NOT NULL;
--> statement-breakpoint
UPDATE `system_settings`
SET `smarty_auth_id` = '', `smarty_auth_token_encrypted` = NULL
WHERE `smarty_auth_id` <> '' AND `smarty_auth_token_encrypted` IS NOT NULL;
