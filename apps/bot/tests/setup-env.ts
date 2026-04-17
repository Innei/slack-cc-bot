Object.assign(process.env, {
  NODE_ENV: 'test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_REACTION_NAME: 'eyes',
  SLACK_SIGNING_SECRET: 'test-signing-secret',
  CLAUDE_PERMISSION_MODE: 'bypassPermissions',
  LOG_DIR: './logs',
  LOG_LEVEL: 'error',
  LOG_TO_FILE: 'false',
  PORT: '3000',
  REPO_ROOT_DIR: './',
  SESSION_DB_PATH: './data/test-sessions.db',
});
