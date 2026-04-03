CREATE TABLE `sessions` (
	`thread_ts` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`root_message_ts` text NOT NULL,
	`bootstrap_message_ts` text,
	`stream_message_ts` text,
	`claude_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
