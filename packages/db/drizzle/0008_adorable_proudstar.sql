ALTER TABLE `addresses`
ADD COLUMN `smarty_match_status` text DEFAULT 'verified' NOT NULL
CHECK (`smarty_match_status` IN ('verified', 'uncertain'));
--> statement-breakpoint
ALTER TABLE `addresses`
ADD COLUMN `smarty_match_message` text;
--> statement-breakpoint
ALTER TABLE `crawl_discovered_addresses`
ADD COLUMN `smarty_match_status` text
CHECK (`smarty_match_status` IS NULL OR `smarty_match_status` IN ('verified', 'uncertain'));
--> statement-breakpoint
ALTER TABLE `crawl_discovered_addresses`
ADD COLUMN `smarty_match_message` text;
