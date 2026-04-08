import type {
  Slot,
} from '@kagura/prompt-pipeline';
import { PipelineConfigError, PluginInjectError } from '@kagura/prompt-pipeline';
import { describe, expect, it } from 'vitest';

describe('Core types', () => {
  it('Slot type accepts all valid slot names', () => {
    const slots: Slot[] = [
      'system',
      'afterSystem',
      'firstUserMessage',
      'firstUserMessageContext',
      'lastUserMessage',
      'lastUserMessageContext',
      'afterUser',
    ];
    expect(slots).toHaveLength(7);
  });

  it('PipelineConfigError is instanceof Error', () => {
    const err = new PipelineConfigError('bad config');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('PipelineConfigError');
  });

  it('PluginInjectError carries plugin name', () => {
    const err = new PluginInjectError('my-plugin', 'bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err.pluginName).toBe('my-plugin');
    expect(err.message).toContain('my-plugin');
    expect(err.name).toBe('PluginInjectError');
  });
});
