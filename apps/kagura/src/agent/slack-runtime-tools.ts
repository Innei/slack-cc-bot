export const RECALL_MEMORY_TOOL_NAME = 'recall_memory';
export const RECALL_MEMORY_TOOL_DESCRIPTION =
  'Retrieve memories from previous sessions. Supports both global (cross-workspace) and workspace-scoped memories.';

export const SAVE_MEMORY_TOOL_NAME = 'save_memory';
export const SAVE_MEMORY_TOOL_DESCRIPTION =
  'Persist an important durable memory for future sessions. Categories: "preference" for user preferences, nicknames, identity, behavioral rules, and standing instructions (almost always scope "global"); "context" for durable project or conversation context that is likely to matter later; "decision" for key decisions; "observation" for notable facts; "task_completed" for completed tasks. Use "global" scope for cross-workspace knowledge, "workspace" scope for project-specific context. Save detected preferences as separate calls. Avoid saving routine conversation summaries, ephemeral status, or facts already present in loaded memory.';

export const UPLOAD_SLACK_FILE_TOOL_NAME = 'upload_slack_file';
export const UPLOAD_SLACK_FILE_TOOL_DESCRIPTION =
  'Queue an existing local file from the current workspace/session root to be uploaded into the current Slack thread. Use this after you create a deliverable file for the user. Relative paths are resolved from the current workspace root.';

export const SLACK_ATTACHMENT_CAPABILITY_LINES = [
  'Slack attachment capabilities:',
  '- Slack thread images are included in your context when available.',
  '- Supported Slack text/code files attached in the thread are downloaded and included in your context when available.',
  `- Use ${UPLOAD_SLACK_FILE_TOOL_NAME} after creating a local file that must be delivered into Slack when this provider exposes that tool directly.`,
  '- If provider-specific instructions define a file-based upload path, use that path instead of a direct upload tool.',
  '- The Slack runtime may also auto-detect persisted local files, but explicit upload is preferred for user-facing deliverables.',
  '- Saved image files are uploaded and rendered back as Slack images; other saved files are uploaded as Slack file attachments.',
  '- When the user asks for a file deliverable, you must actually create and save the file locally, then use the available Kagura upload path; a text-only reply is not sufficient.',
  '- Do not claim that you cannot upload files or images to Slack when this flow applies.',
] as const;
