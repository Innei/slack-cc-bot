import type { ImageAsset, Message, Slot, TraceEntry } from '@kagura/prompt-pipeline';
import { describe, expect, it } from 'vitest';

import { assembleResult } from '../../packages/prompt-pipeline/src/assembler.js';
import type { SlotWriterInternal } from '../../packages/prompt-pipeline/src/slot-writer.js';
import { createSlotWriter } from '../../packages/prompt-pipeline/src/slot-writer.js';

function makeWriters(): Map<Slot, SlotWriterInternal> {
  return new Map();
}

function writerWith(text: string, images?: ImageAsset[]): SlotWriterInternal {
  const w = createSlotWriter();
  w.append(text);
  if (images) {
    for (const img of images) w.image(img);
  }
  return w;
}

describe('assembleResult', () => {
  it('system slot becomes system string', () => {
    const writers = makeWriters();
    writers.set('system', writerWith('You are helpful.'));
    const result = assembleResult(writers, [], []);
    expect(result.system).toBe('You are helpful.');
    expect(result.messages).toEqual([]);
  });

  it('afterSystem segments become independent user messages', () => {
    const writers = makeWriters();
    const w = createSlotWriter();
    w.append('Tool A info');
    w.append('Tool B info');
    writers.set('afterSystem', w);
    const result = assembleResult(writers, [], []);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Tool A info' },
      { role: 'user', content: 'Tool B info' },
    ]);
  });

  it('firstUserMessage + firstUserMessageContext merge into one message', () => {
    const writers = makeWriters();
    writers.set('firstUserMessage', writerWith('First message body'));
    writers.set('firstUserMessageContext', writerWith('Memory context here'));
    const result = assembleResult(writers, [], []);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe('user');
    expect(result.messages[0]!.content).toContain('First message body');
    expect(result.messages[0]!.content).toContain('Memory context here');
  });

  it('lastUserMessage + lastUserMessageContext merge into one message', () => {
    const writers = makeWriters();
    writers.set('lastUserMessage', writerWith('User question'));
    writers.set('lastUserMessageContext', writerWith('Extra context'));
    const result = assembleResult(writers, [], []);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toContain('User question');
    expect(result.messages[0]!.content).toContain('Extra context');
  });

  it('thread history is placed between first and last user messages', () => {
    const writers = makeWriters();
    writers.set('firstUserMessage', writerWith('First'));
    writers.set('lastUserMessage', writerWith('Last'));
    const history: Message[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
    ];
    const result = assembleResult(writers, history, []);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]!.content).toContain('First');
    expect(result.messages[1]!.content).toBe('old question');
    expect(result.messages[2]!.content).toBe('old answer');
    expect(result.messages[3]!.content).toContain('Last');
  });

  it('empty first slot with only last slot emits single user message', () => {
    const writers = makeWriters();
    writers.set('lastUserMessage', writerWith('Only message'));
    const result = assembleResult(writers, [], []);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toContain('Only message');
  });

  it('afterUser segments become independent messages after last user', () => {
    const writers = makeWriters();
    writers.set('lastUserMessage', writerWith('User question'));
    const after = createSlotWriter();
    after.append('Reminder 1');
    after.append('Reminder 2');
    writers.set('afterUser', after);
    const result = assembleResult(writers, [], []);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]!.content).toBe('Reminder 1');
    expect(result.messages[2]!.content).toBe('Reminder 2');
  });

  it('images from slot writers attach to their resolved message', () => {
    const img: ImageAsset = { name: 'photo.jpg', mimeType: 'image/jpeg', base64Data: 'xyz' };
    const writers = makeWriters();
    writers.set('lastUserMessage', writerWith('See image', [img]));
    const result = assembleResult(writers, [], []);
    expect(result.messages[0]!.images).toEqual([img]);
  });

  it('full slot ordering: system → afterSystem → first → history → last → afterUser', () => {
    const writers = makeWriters();
    writers.set('system', writerWith('System'));
    const afterSys = createSlotWriter();
    afterSys.append('AfterSys');
    writers.set('afterSystem', afterSys);
    writers.set('firstUserMessage', writerWith('First'));
    writers.set('lastUserMessage', writerWith('Last'));
    const afterUsr = createSlotWriter();
    afterUsr.append('AfterUsr');
    writers.set('afterUser', afterUsr);

    const history: Message[] = [{ role: 'user', content: 'Mid' }];
    const result = assembleResult(writers, history, []);

    expect(result.system).toBe('System');
    expect(result.messages.map((m) => m.content)).toEqual([
      'AfterSys',
      'First',
      'Mid',
      'Last',
      'AfterUsr',
    ]);
  });

  it('trace entries are passed through', () => {
    const trace: TraceEntry[] = [{ plugin: 'p1', durationMs: 5 }];
    const result = assembleResult(makeWriters(), [], trace);
    expect(result.trace).toEqual(trace);
  });
});
