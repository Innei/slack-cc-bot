import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  SlackStatusProbe,
  SlackStatusProbeProgressRecord,
  SlackStatusProbeRecord,
  SlackStatusProbeStatusRecord,
} from '~/slack/render/status-probe.js';

export class FileSlackStatusProbe implements SlackStatusProbe {
  constructor(private readonly outputPath: string) {}

  async recordStatus(record: SlackStatusProbeStatusRecord): Promise<void> {
    await this.appendRecord(record);
  }

  async recordProgressMessage(record: SlackStatusProbeProgressRecord): Promise<void> {
    await this.appendRecord(record);
  }

  private async appendRecord(record: SlackStatusProbeRecord): Promise<void> {
    const absolutePath = path.resolve(process.cwd(), this.outputPath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.appendFile(absolutePath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}

export async function resetSlackStatusProbeFile(outputPath: string): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, '', 'utf8');
}

export async function readSlackStatusProbeFile(
  outputPath: string,
): Promise<SlackStatusProbeRecord[]> {
  const absolutePath = path.resolve(process.cwd(), outputPath);

  try {
    const content = await fs.readFile(absolutePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SlackStatusProbeRecord);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
