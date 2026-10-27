import { describe, expect, it } from 'vitest';

import { formatTopicTokenCount, getPendingTargetState } from '../compaction-utils';

import type { TaskTopic } from '@common/types';

describe('compaction-utils', () => {
  it.each([
    [undefined, '—'],
    [null, '—'],
    [0, '0'],
    [22000, '22k'],
    [1600, '1.6k'],
  ])('formats %s as %s', (tokens, expected) => {
    expect(formatTopicTokenCount(tokens)).toBe(expected);
  });

  it('keeps pending state stable when the topic id precedes or follows the raw marker', () => {
    const topics: TaskTopic[] = [{ summary: 'one', messageIds: ['topic-first', 'a', 'marker'] }];
    const target = { topicIndex: 0, firstMessageId: 'a' };
    const pending = { a: { endBeforeMessageId: 'marker', nonce: 1, baseDir: '/p', taskId: 't', target, topicFirstMessageId: 'topic-first' } };
    expect(getPendingTargetState(pending, '/p', 't', topics, 0)).toBe('active');
  });

  it('does not overlap distinct sections, while a whole-topic block overlaps sections', () => {
    const topics: TaskTopic[] = [
      {
        summary: 'one',
        messageIds: ['a', 'b', 'c'],
        sections: [
          { summary: 'first', startMessageId: 'a' },
          { summary: 'second', startMessageId: 'b' },
        ],
      },
    ];
    const section = { topicIndex: 0, sectionIndex: 0, firstMessageId: 'a' };
    expect(
      getPendingTargetState(
        { a: { endBeforeMessageId: 'b', nonce: 1, baseDir: '/p', taskId: 't', target: section, topicFirstMessageId: 'a' } },
        '/p',
        't',
        topics,
        0,
        1,
      ),
    ).toBeUndefined();
    expect(
      getPendingTargetState(
        { a: { endBeforeMessageId: null, nonce: 1, baseDir: '/p', taskId: 't', target: { topicIndex: 0, firstMessageId: 'a' }, topicFirstMessageId: 'a' } },
        '/p',
        't',
        topics,
        0,
        1,
      ),
    ).toBe('overlap');
  });

  it('does not let another task block the target', () => {
    const topics: TaskTopic[] = [{ summary: 'one', messageIds: ['a', 'b'] }];
    expect(
      getPendingTargetState({ a: { endBeforeMessageId: null, nonce: 1, baseDir: '/other', taskId: 't', topicFirstMessageId: 'a' } }, '/p', 't', topics, 0),
    ).toBeUndefined();
  });
});
