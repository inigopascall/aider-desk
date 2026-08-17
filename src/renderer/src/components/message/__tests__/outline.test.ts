import { describe, expect, it } from 'vitest';
import { Message } from '@common/types';

import { buildOutline, deriveToolTitle, extractFirstLine, getGroupDisplayName, truncateTitle } from '../outline';

const t = (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key);

describe('outline helpers', () => {
  it('extractFirstLine skips blanks and strips supported formatting', () => {
    expect(extractFirstLine('\n\n## - **`Hello world`**\nSecond line')).toBe('Hello world');
    expect(extractFirstLine('> __`Quoted`__')).toBe('Quoted');
  });

  it('truncateTitle normalises whitespace and truncates only when needed', () => {
    expect(truncateTitle('  hello   world  ', 11)).toBe('hello world');
    expect(truncateTitle('  hello   world  ', 10)).toBe('hello worl…');
  });

  it('deriveToolTitle uses priority arguments and falls back to server and tool names', () => {
    expect(
      deriveToolTitle({
        id: 'tool-1',
        type: 'tool',
        content: '',
        serverName: 'power',
        toolName: 'bash',
        args: { command: 'npm test', query: 'ignored' },
      }),
    ).toBe('bash: npm test');

    expect(
      deriveToolTitle({
        id: 'tool-2',
        type: 'tool',
        content: '',
        serverName: 'power',
        toolName: 'unknown',
        args: {},
      }),
    ).toBe('power: unknown');
  });

  it('gets translated group display names', () => {
    expect(getGroupDisplayName(undefined, t)).toBe('messages.group');
    expect(getGroupDisplayName('messages.customGroup', t)).toBe('messages.customGroup');
    expect(getGroupDisplayName({ key: 'messages.groupWithValue', params: { value: 'x' } }, t)).toBe('messages.groupWithValue:{"value":"x"}');
  });

  it('builds a flat outline with depth-zero scroll targets', () => {
    const messages = [
      { id: 'user-1', type: 'user', content: 'User prompt' },
      { id: 'response-1', type: 'response', content: 'Assistant response' },
      { id: 'tool-1', type: 'tool', content: '', serverName: 'power', toolName: 'bash', args: { command: 'npm test' } },
    ] as Message[];

    const outline = buildOutline(messages, t);

    expect(outline.items).toHaveLength(3);
    expect(outline.items.every((item) => item.depth === 0 && item.scrollTargetId === item.id && item.bookmarkable)).toBe(true);
    expect(outline.bookmarkableMessageIds).toEqual(new Set(['user-1', 'response-1', 'tool-1']));
  });

  it('maps assistant-group children to the assistant group scroll target', () => {
    const messages = [
      {
        id: 'assistant-group-1',
        type: 'assistant-group',
        content: '',
        responseMessage: { id: 'response-1', type: 'response', content: 'Response' },
        toolMessages: [{ id: 'tool-1', type: 'tool', content: '', serverName: 'power', toolName: 'bash', args: {} }],
      },
    ] as Message[];

    const outline = buildOutline(messages, t);

    expect(outline.items).toHaveLength(2);
    expect(outline.items[0]).toMatchObject({ id: 'assistant-group-1', depth: 0, bookmarkable: true });
    expect(outline.items[1]).toMatchObject({ id: 'tool-1', depth: 1, scrollTargetId: 'assistant-group-1', bookmarkable: false });
    expect(outline.bookmarkableMessageIds).toEqual(new Set(['assistant-group-1']));
  });

  it('represents a sub-agent group as one non-bookmarkable row and excludes its children', () => {
    const messages = [
      {
        id: 'group-1',
        type: 'group',
        content: '',
        group: { id: 'group-1', name: 'messages.groupName' },
        children: [
          { id: 'user-1', type: 'user', content: 'User' },
          { id: 'response-1', type: 'response', content: 'Response' },
        ],
      },
    ] as Message[];

    const outline = buildOutline(messages, t);

    expect(outline.items).toEqual([
      expect.objectContaining({ id: 'group-1', depth: 0, title: 'messages.groupName', bookmarkable: false }),
    ]);
    expect(outline.items.map((item) => item.id)).not.toContain('user-1');
    expect(outline.items.map((item) => item.id)).not.toContain('response-1');
    expect(outline.bookmarkableMessageIds.has('group-1')).toBe(false);
    expect(outline.bookmarkableMessageIds.has('user-1')).toBe(false);
    expect(outline.bookmarkableMessageIds.has('response-1')).toBe(false);
  });

  it('uses the translated untitled fallback for empty content', () => {
    const outline = buildOutline([{ id: 'user-1', type: 'user', content: '' }] as Message[], t);

    expect(outline.items[0].title).toBe('messages.outline.untitled');
  });
});
