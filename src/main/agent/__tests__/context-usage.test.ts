import { describe, expect, it } from 'vitest';
import { ContextMessage } from '@common/types';

import {
  buildContextUsageBreakdown,
  countTextTokens,
  describeContextMessage,
  estimateContextMessageItem,
  groupToolTokensByServer,
  SYSTEM_PROMPT_ITEM_ID,
} from '../context-usage';

const item = (id: string, tokens: number) => ({ id, label: id, tokens });

const emptyInput = {
  systemPromptTokens: 0,
  rules: [],
  tools: [],
  repoMappings: [],
  readOnlyFiles: [],
  editableFiles: [],
  conversation: [],
};

describe('buildContextUsageBreakdown', () => {
  it('subtracts the rules from the system prompt and keeps the drawing order', () => {
    const breakdown = buildContextUsageBreakdown({
      ...emptyInput,
      systemPromptTokens: 1000,
      rules: [item('a.md', 150), item('b.md', 50)],
      tools: [item('power', 300)],
      editableFiles: [item('src/x.ts', 40)],
      conversation: [item('m1', 10), item('m2', 20)],
    });

    expect(breakdown.categories.map((category) => category.id)).toEqual(['systemPrompt', 'rules', 'tools', 'editableFiles', 'conversation']);
    expect(breakdown.categories[0]).toEqual({
      id: 'systemPrompt',
      tokens: 800,
      items: [{ id: SYSTEM_PROMPT_ITEM_ID, label: '', tokens: 800 }],
    });
    expect(breakdown.categories[1].tokens).toBe(200);
    expect(breakdown.categories[4].items.map((conversationItem) => conversationItem.id)).toEqual(['m1', 'm2']);
    expect(breakdown.totalTokens).toBe(800 + 200 + 300 + 40 + 30);
  });

  it('clamps the system prompt at zero when the rules exceed it', () => {
    const breakdown = buildContextUsageBreakdown({
      ...emptyInput,
      systemPromptTokens: 100,
      rules: [item('a.md', 150)],
    });

    expect(breakdown.categories.map((category) => category.id)).toEqual(['rules']);
    expect(breakdown.totalTokens).toBe(150);
  });

  it('drops zero-token items and empty categories', () => {
    const breakdown = buildContextUsageBreakdown({
      ...emptyInput,
      readOnlyFiles: [item('.aider-desk/rules/x.md', 0)],
      conversation: [item('m1', 0), item('m2', 5)],
    });

    expect(breakdown.categories).toEqual([{ id: 'conversation', tokens: 5, items: [item('m2', 5)] }]);
    expect(breakdown.totalTokens).toBe(5);
  });
});

describe('groupToolTokensByServer', () => {
  it('groups tool definitions by the name before the separator', () => {
    const fileRead = {
      name: 'power---file_read',
      description: 'Read a file',
      inputSchema: {},
    };
    const bash = {
      name: 'power---bash',
      description: 'Run a command',
      inputSchema: {},
    };
    const kbSearch = {
      name: 'kb---kb_search',
      description: 'Search the knowledge base',
      inputSchema: {},
    };

    const items = groupToolTokensByServer([fileRead, bash, kbSearch]);

    expect(items.map((toolItem) => toolItem.id)).toEqual(['power', 'kb']);
    expect(items[0].tokens).toBe(countTextTokens(JSON.stringify(fileRead, null, 2)) + countTextTokens(JSON.stringify(bash, null, 2)));
    expect(items[1].tokens).toBe(countTextTokens(JSON.stringify(kbSearch, null, 2)));
  });
});

describe('describeContextMessage', () => {
  it('collapses whitespace in a plain text message', () => {
    const message = {
      id: 'u1',
      role: 'user',
      content: '  Fix the\n\nlogin   bug  ',
    } as ContextMessage;

    expect(describeContextMessage(message)).toBe('Fix the login bug');
  });

  it('truncates long text to 80 characters', () => {
    const message = {
      id: 'u1',
      role: 'user',
      content: 'x'.repeat(200),
    } as ContextMessage;

    const label = describeContextMessage(message);

    expect(label).toHaveLength(80);
    expect(label.endsWith('…')).toBe(true);
  });

  it('names the tools when an assistant message has no text', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: '1',
          toolName: 'power---file_read',
          input: {},
        },
        {
          type: 'tool-call',
          toolCallId: '2',
          toolName: 'power---bash',
          input: {},
        },
        {
          type: 'tool-call',
          toolCallId: '3',
          toolName: 'power---file_read',
          input: {},
        },
      ],
    } as unknown as ContextMessage;

    expect(describeContextMessage(message)).toBe('power---file_read, power---bash');
  });

  it('names the tool a tool result answers', () => {
    const message = {
      id: 't1',
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: '1',
          toolName: 'kb---kb_search',
          output: { type: 'text', value: 'result' },
        },
      ],
    } as unknown as ContextMessage;

    expect(describeContextMessage(message)).toBe('kb---kb_search');
  });
});

describe('estimateContextMessageItem', () => {
  it('carries the message id and role and counts its tokens', () => {
    const message = {
      id: 'u1',
      role: 'user',
      content: 'Hello there, how are you today?',
    } as ContextMessage;

    const result = estimateContextMessageItem(message);

    expect(result.id).toBe('u1');
    expect(result.detail).toBe('user');
    expect(result.tokens).toBe(countTextTokens('Hello there, how are you today?'));
  });
});
