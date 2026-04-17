import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ClaudeExecutionProbe,
  ClaudeExecutionProbeRecord,
} from '~/agent/providers/claude-code/execution-probe.js';

export class FileClaudeExecutionProbe implements ClaudeExecutionProbe {
  constructor(private readonly outputPath: string) {}

  async record(record: ClaudeExecutionProbeRecord): Promise<void> {
    const absolutePath = path.resolve(process.cwd(), this.outputPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.appendFile(absolutePath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export async function resetClaudeExecutionProbeFile(outputPath: string): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, '', 'utf8');
}

export async function readClaudeExecutionProbeFile(
  outputPath: string,
): Promise<ClaudeExecutionProbeRecord[]> {
  const absolutePath = path.resolve(process.cwd(), outputPath);

  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClaudeExecutionProbeRecord);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
