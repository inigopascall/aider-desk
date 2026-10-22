import { describe, expect, it } from 'vitest';
import { ContextMessage } from '@common/types';

import { hashText, toConversationEntries, toIndexedContent, truncateText } from '../message-text';

const messages = [
  { id: 'u1', role: 'user', content: 'Hello   there' },
  {
    id: 'a1',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Looking at the file' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'power---file_read', input: { filePath: 'src/a.ts' } },
    ],
  },
  {
    id: 't1',
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'power---file_read', output: { type: 'text', value: 'x' } }],
  },
  { id: 'a2', role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'power---bash', input: { command: 'ls -la' } }] },
  { id: 'a3', role: 'assistant', content: 'Done' },
] as unknown as ContextMessage[];

describe('toConversationEntries', () => {
  it('keeps user and assistant text and attaches tool calls to the preceding entry', () => {
    const entries = toConversationEntries(messages);

    expect(entries.map((entry) => entry.id)).toEqual(['u1', 'a1', 'a3']);
    expect(entries[0].text).toBe('Hello   there');
    expect(entries[1].text).toBe('Looking at the file');
    expect(entries[1].tools).toHaveLength(2);
    expect(entries[1].tools[0]).toContain('src/a.ts');
    expect(entries[1].tools[1]).toContain('ls -la');
    expect(entries[2].tools).toEqual([]);
  });
});

describe('toIndexedContent', () => {
  it('appends the tool labels to the text', () => {
    const [, assistant] = toConversationEntries(messages);
    const content = toIndexedContent(assistant);

    expect(content.startsWith('Looking at the file\n')).toBe(true);
    expect(content).toContain('src/a.ts');
  });
});

describe('truncateText and hashText', () => {
  it('truncates with an ellipsis', () => {
    expect(truncateText('abcdef', 4)).toBe('abc…');
    expect(truncateText('abc', 4)).toBe('abc');
  });

  it('hashes text stably', () => {
    expect(hashText('same text')).toBe(hashText('same text'));
    expect(hashText('same text')).not.toBe(hashText('same texT'));
  });
});
