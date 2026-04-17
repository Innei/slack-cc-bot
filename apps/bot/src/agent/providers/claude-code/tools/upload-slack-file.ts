import { zodParse } from '~/schemas/safe-parse.js';

import {
  type UploadSlackFileToolInput,
  UploadSlackFileToolInputSchema,
} from '../schemas/upload-slack-file.js';

export {
  UPLOAD_SLACK_FILE_TOOL_DESCRIPTION,
  UPLOAD_SLACK_FILE_TOOL_NAME,
} from '~/agent/slack-runtime-tools.js';

export function parseUploadSlackFileToolInput(input: unknown): UploadSlackFileToolInput {
  return zodParse(UploadSlackFileToolInputSchema, input, 'UploadSlackFileToolInput');
}
