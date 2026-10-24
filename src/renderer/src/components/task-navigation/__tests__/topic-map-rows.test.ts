import { describe, expect, it } from 'vitest';
import { TaskTopic, TopicCompactionInfo } from '@common/types';

import { buildTopicMapRows, isNavigableRow } from '../topic-map-rows';

const topics: TaskTopic[] = [
  {
    summary: 'Sectioned topic',
    messageIds: ['a1', 'a2', 'a3', 'a4'],
    sections: [
      { summary: 'Planning the change', startMessageId: 'a1' },
      { summary: 'Building and testing it', startMessageId: 'a3' },
    ],
    sectioned: true,
  },
  { summary: 'Current topic', messageIds: ['b1', 'b2'] },
];

describe('buildTopicMapRows', () => {
  it('shows only topic rows when no topic is expanded', () => {
    expect(buildTopicMapRows(topics, new Set()).map((row) => row.key)).toEqual(['topic:0', 'topic:1']);
  });

  it('puts each section title directly above its first message', () => {
    const rows = buildTopicMapRows(topics, new Set([0, 1]));

    expect(rows.map((row) => row.key)).toEqual([
      'topic:0',
      'section:0:0',
      'message:0:a1',
      'message:0:a2',
      'section:0:1',
      'message:0:a3',
      'message:0:a4',
      'topic:1',
      'message:1:b1',
      'message:1:b2',
    ]);
    expect(rows[1]).toEqual({ kind: 'section', key: 'section:0:0', topicIndex: 0, sectionIndex: 0, summary: 'Planning the change' });
  });

  it('leaves section rows out of the navigable rows', () => {
    const rows = buildTopicMapRows(topics, new Set([0]));

    expect(rows.filter((row) => row.kind === 'section')).toHaveLength(2);
    expect(rows.filter(isNavigableRow).map((row) => row.key)).toEqual(['topic:0', 'message:0:a1', 'message:0:a2', 'message:0:a3', 'message:0:a4', 'topic:1']);
  });

  it('skips a section whose start message is not in the topic', () => {
    const rows = buildTopicMapRows([{ summary: 'Topic', messageIds: ['x1'], sections: [{ summary: 'Lost', startMessageId: 'missing' }] }], new Set([0]));

    expect(rows.map((row) => row.kind)).toEqual(['topic', 'message']);
  });
});

const record = (id: string, lost = false): TopicCompactionInfo => ({
  id,
  level: 3,
  compactedAt: '2026-10-24T10:00:00.000Z',
  summaryMessageId: `topic-compaction-${id}`,
  promptMessageId: `topic-compaction-${id}-prompt`,
  messageCount: 2,
  sourceCharacters: 1200,
  summaryCharacters: 300,
  ...(lost ? { lost: true } : {}),
});

describe('buildTopicMapRows with compactions', () => {
  it('shows one recap row in place of the messages and sections of a compacted topic', () => {
    const rows = buildTopicMapRows(
      [
        { summary: 'Compacted', messageIds: ['c1', 'c2'], compaction: record('t1'), sections: [{ summary: 'Inner', startMessageId: 'c1' }] },
        { summary: 'Current topic', messageIds: ['d1'] },
      ],
      new Set([0]),
    );

    expect(rows.map((row) => row.key)).toEqual(['topic:0', 'recap:0', 'topic:1']);
    expect(rows[1]).toMatchObject({ kind: 'recap', topicIndex: 0, compaction: { id: 't1' } });
  });

  it('shows a compacted section as its title and one recap row', () => {
    const rows = buildTopicMapRows(
      [
        {
          summary: 'Sectioned topic',
          messageIds: ['a1', 'a2', 'a3', 'a4'],
          sections: [
            { summary: 'Planning the change', startMessageId: 'a1' },
            { summary: 'Building and testing it', startMessageId: 'a3', compaction: record('s1') },
          ],
        },
      ],
      new Set([0]),
    );

    expect(rows.map((row) => row.key)).toEqual(['topic:0', 'section:0:0', 'message:0:a1', 'message:0:a2', 'section:0:1', 'recap:0:1']);
    expect(rows[5]).toMatchObject({ kind: 'recap', topicIndex: 0, sectionIndex: 1, compaction: { id: 's1' } });
  });

  it('includes recap rows in the navigable rows, but not the rows of lost recaps', () => {
    const rows = buildTopicMapRows(
      [
        { summary: 'Compacted', messageIds: ['c1'], compaction: record('t1') },
        { summary: 'Lost', messageIds: ['e1'], compaction: record('t2', true) },
      ],
      new Set([0, 1]),
    );

    expect(rows.map((row) => row.key)).toEqual(['topic:0', 'recap:0', 'topic:1', 'recap:1']);
    expect(rows.filter(isNavigableRow).map((row) => row.key)).toEqual(['topic:0', 'recap:0', 'topic:1']);
  });
});
