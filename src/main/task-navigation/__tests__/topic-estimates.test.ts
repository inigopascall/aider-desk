import { describe, expect, it } from 'vitest';
import { ContextMessage, TaskTopic } from '@common/types';

import { estimateTaskTopics } from '../topic-estimates';

import { estimateMessageTokens } from '@/agent/utils';

const message = (id: string, role: ContextMessage['role'], content: unknown): ContextMessage => ({ id, role, content }) as ContextMessage;
const estimate = (messages: ContextMessage[]): number => messages.reduce((total, item) => total + JSON.stringify(item.content).length, 0);

const topics: TaskTopic[] = [
  {
    summary: 'A',
    messageIds: ['u1', 'a1', 'u2', 'a2'],
    sections: [
      { summary: 'one', startMessageId: 'u1' },
      { summary: 'two', startMessageId: 'u2' },
    ],
  },
  { summary: 'B', messageIds: ['u3', 'a3'] },
];

const messages: ContextMessage[] = [
  message('u1', 'user', 'one'),
  message('a1', 'assistant', [
    { type: 'text', text: 'answer' },
    { type: 'tool-call', toolCallId: 'c1', toolName: 'power---bash', input: { command: 'long' } },
  ]),
  message('t1', 'tool', [{ type: 'tool-result', toolCallId: 'c1', toolName: 'power---bash', output: { type: 'text', value: 'result' } }]),
  message('u2', 'user', 'two'),
  message('a2', 'assistant', [
    { type: 'text', text: 'answer' },
    { type: 'reasoning', text: 'thinking' },
  ]),
  message('u3', 'user', 'three'),
  message('a3', 'assistant', 'four'),
];

describe('topic estimates', () => {
  it('counts each owned message once, including tools and reasoning, and partitions sections', () => {
    const result = estimateTaskTopics(messages, topics, estimate);
    expect(result.topics[0].tokens).toBe(estimate(messages.slice(0, 5)));
    expect(result.topics[0].sections[0].tokens).toBe(estimate(messages.slice(0, 3)));
    expect(result.topics[0].sections[1].tokens).toBe(estimate(messages.slice(3, 5)));
    expect((result.topics[0].sections[0].tokens ?? 0) + (result.topics[0].sections[1].tokens ?? 0)).toBe(result.topics[0].tokens);
  });

  it('resets ownership for unknown visible messages and does not attribute later messages across the reset', () => {
    const result = estimateTaskTopics([...messages.slice(0, 2), message('unknown', 'user', 'image'), ...messages.slice(2)], topics, () => 10);
    expect(result.topics[0].tokens).toBe(40);
    expect(result.topics[1].tokens).toBe(20);
  });

  it('resets for an unknown image-only user message', () => {
    const image = message('unknown-image', 'user', [{ type: 'image', image: 'data', mediaType: 'image/png' }]);
    const result = estimateTaskTopics([...messages.slice(0, 2), image, ...messages.slice(2)], topics, () => 10);
    expect(result.topics[0].tokens).toBe(40);
  });

  it('uses the actual estimator for live topic totals', () => {
    const result = estimateTaskTopics(messages, topics);
    expect(result.topics[0].tokens).toBe(messages.slice(0, 5).reduce((total, item) => total + estimateMessageTokens([item]), 0));
  });

  it('hides sections and returns zero for a compacted topic without a live pair', () => {
    const compacted: TaskTopic = {
      summary: 'A',
      messageIds: ['u1', 'a1'],
      sections: [{ summary: 'one', startMessageId: 'u1' }],
      compaction: {
        id: 'c',
        level: 2,
        compactedAt: '',
        promptMessageId: 'prompt',
        summaryMessageId: 'summary',
        messageCount: 2,
        sourceCharacters: 99,
        summaryCharacters: 3,
      },
    };
    const result = estimateTaskTopics([], [compacted], estimate);
    expect(result.topics[0].tokens).toBeNull();
    expect(result.topics[0].messageCount).toBe(0);
    expect(result.topics[0].sections).toEqual([{ firstMessageId: 'u1', tokens: null, messageCount: 0 }]);
  });

  it('counts only the visible marker and recap for a compacted topic', () => {
    const compacted: TaskTopic = {
      summary: 'A',
      messageIds: ['u1', 'a1'],
      compaction: {
        id: 'c',
        level: 2,
        compactedAt: '',
        promptMessageId: 'topic-compaction-c-prompt',
        summaryMessageId: 'topic-compaction-c',
        messageCount: 2,
        sourceCharacters: 99,
        summaryCharacters: 3,
      },
    };
    const live = [message('topic-compaction-c-prompt', 'user', 'marker'), message('topic-compaction-c', 'assistant', 'recap')];
    const result = estimateTaskTopics(live, [compacted], estimate);
    expect(result.topics[0].tokens).toBe(estimate(live));
    expect(result.topics[0].messageCount).toBe(1);
  });
});
