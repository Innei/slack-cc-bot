import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assemblePrompt,
  fileContextProcessor,
  imageCollectionProcessor,
  memoryContextProcessor,
  memoryInstructionProcessor,
  sessionContextProcessor,
  systemRoleProcessor,
  threadContextProcessor,
  userMessageProcessor,
} from '~/agent/prompt/index.js';
import type { AgentExecutionRequest } from '~/agent/types.js';

const CODEX_GENERATED_ARTIFACTS_DIRNAME = 'generated';
const CODEX_RUNTIME_DIRNAME = 'runtime';
const CODEX_RUNTIME_ROOT_DIR = path.join(os.tmpdir(), 'kagura', 'codex-cli');

export interface CodexRuntimePaths {
  generatedArtifactsDir: string;
  memoryOpsPath: string;
  runtimeDir: string;
}

const CODEX_PROMPT_PROCESSORS = [
  systemRoleProcessor,
  memoryInstructionProcessor,
  sessionContextProcessor,
  memoryContextProcessor,
  threadContextProcessor,
  fileContextProcessor,
  userMessageProcessor,
  imageCollectionProcessor,
];

export function buildCodexPrompt(
  request: AgentExecutionRequest,
  runtimePaths = getCodexRuntimePaths(request),
): string {
  const prompt = assemblePrompt(request, CODEX_PROMPT_PROCESSORS);
  const sections: Array<string | undefined> = [
    `<system_instructions>\n${prompt.systemPrompt}\n</system_instructions>`,
    `<codex_runtime_tools>\nThis Codex CLI adapter exposes host-side tools through files managed outside the current workspace.\n\nMemory tools:\n- To call save_memory, append one JSON object per line to ${runtimePaths.memoryOpsPath}.\n- JSON shape: {"tool":"save_memory","category":"preference|context|decision|observation|task_completed","scope":"global|workspace","content":"memory text","metadata":{...},"expiresAt":"optional ISO datetime"}.\n- If scope is omitted, the host uses workspace scope when a workspace is set, otherwise global scope.\n- When the user explicitly asks you to call save_memory, you MUST write the JSONL operation before your final answer.\n- To recall memory, use the <conversation_memory> section already loaded by the host. If the user says "use recall_memory", answer from that loaded memory context.\n</codex_runtime_tools>`,
    `<codex_slack_uploads>\nWhen you need to send a generated image or file back to Slack, write the final artifact under ${runtimePaths.generatedArtifactsDir}/. The host adapter uploads new or modified files from that directory to the Slack thread after your run. Use normal file extensions such as .png, .jpg, .webp, .gif, .txt, .md, .json, or .csv so the host can classify them.\n</codex_slack_uploads>`,
    buildCodexSkillInstructions(request),
    prompt.userText,
  ];

  if (prompt.images.length > 0) {
    sections.push(
      '<image_notice>\nThis Codex CLI adapter currently does not forward Slack image bytes. If image inspection is necessary, explain that limitation briefly and ask the user for text details or a file path available in the workspace.\n</image_notice>',
    );
  }

  return sections
    .filter(
      (section): section is string => typeof section === 'string' && section.trim().length > 0,
    )
    .join('\n\n');
}

export function getCodexRuntimePaths(request: AgentExecutionRequest): CodexRuntimePaths {
  const rootSuffix = sanitizeRuntimePathPart(
    [request.channelId, request.threadTs, request.executionId ?? 'memory'].join('-'),
  );
  const runtimeRoot = path.join(CODEX_RUNTIME_ROOT_DIR, rootSuffix);
  const runtimeDir = path.join(runtimeRoot, CODEX_RUNTIME_DIRNAME);
  const generatedArtifactsDir = path.join(runtimeRoot, CODEX_GENERATED_ARTIFACTS_DIRNAME);
  const memoryOpsPath = path.join(runtimeDir, getCodexMemoryOpsFileName(request));

  return {
    generatedArtifactsDir,
    memoryOpsPath,
    runtimeDir,
  };
}

function getCodexMemoryOpsFileName(request: AgentExecutionRequest): string {
  const suffix = sanitizeRuntimePathPart(request.executionId ?? 'memory');
  return `${suffix}-memory-ops.jsonl`;
}

function buildCodexSkillInstructions(request: AgentExecutionRequest): string | undefined {
  const names = extractRequestedSkillNames(request.mentionText);
  if (names.length === 0) {
    return undefined;
  }

  const root = request.workspacePath ?? process.cwd();
  const sections: string[] = [];
  for (const name of names.slice(0, 3)) {
    const skillPath = path.join(root, '.claude', 'skills', name, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }

    sections.push(`## /${name}\n${content.trim()}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return `<codex_workspace_skills>\nWhen the user asks to invoke one of these slash skills, follow the matching SKILL.md exactly as task instructions.\n\n${sections.join('\n\n')}\n</codex_workspace_skills>`;
}

function extractRequestedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\/([\da-z][\w-]{1,80})\b/gi)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

function sanitizeRuntimePathPart(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '_').slice(0, 120) || 'memory';
}
