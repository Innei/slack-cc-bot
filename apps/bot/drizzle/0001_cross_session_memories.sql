CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`thread_ts` text,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`expires_at` text
);
