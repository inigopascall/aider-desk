import { describe, expect, it } from 'vitest';
import { TaskTopic } from '@common/types';

import { ConversationEntry } from '../message-text';
import {
  applySummaryUpdate,
  buildSummaryPrompt,
  chunkEntries,
  cleanTitle,
  cleanTopicSummary,
  getUnsummarizedEntries,
  markDetachedTopics,
  parseSummaryResponse,
} from '../summary-model';

const entry = (id: string, role: 'user' | 'assistant', text: string): ConversationEntry => ({ id, role, text, tools: [] });

const e1 = entry('e1', 'user', 'How do I speed up MySQL joins?');
const e2 = entry('e2', 'assistant', 'Add an index on the join columns.');
const e3 = entry('e3', 'user', 'What about Postgres?');
const e4 = entry('e4', 'assistant', 'Postgres has similar options.');

describe('parseSummaryResponse', () => {
  it('extracts the JSON object from surrounding text', () => {
    const expected = { title: 'Database tuning', topics: [{ key: 'T1', summary: 'Speeding up joins' }], assignments: [{ ref: 'm1', topic: 'T1' }] };
    expect(parseSummaryResponse(`Here it is: ${JSON.stringify(expected)} Done.`)).toEqual(expected);
  });

  it('fills missing fields with defaults', () => {
    expect(parseSummaryResponse('{"title":"Only a title"}')).toEqual({ title: 'Only a title', topics: [], assignments: [] });
  });

  it('returns null when there is no valid JSON object', () => {
    expect(parseSummaryResponse(undefined)).toBeNull();
    expect(parseSummaryResponse('no json here')).toBeNull();
    expect(parseSummaryResponse('{not valid json}')).toBeNull();
  });
});

describe('cleanTitle and cleanTopicSummary', () => {
  it('strips quotes, bullets and a trailing period', () => {
    expect(cleanTitle('"Fix the login bug."')).toBe('Fix the login bug');
    expect(cleanTopicSummary('- Discussed   indexing\n strategies')).toBe('Discussed indexing strategies');
  });
});

describe('chunkEntries', () => {
  it('numbers references across chunks', () => {
    const chunks = chunkEntries([e1, e2, e3], 1);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk[0].ref)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps entries together when they fit', () => {
    const chunks = chunkEntries([e1, e2, e3]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].map((prepared) => prepared.entry.id)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('applySummaryUpdate', () => {
  it('creates topics from an empty map', () => {
    const chunk = chunkEntries([e1, e2, e3])[0];
    const topics = applySummaryUpdate([], chunk, {
      title: 'Database tuning',
      topics: [
        { key: 'T1', summary: 'Speeding up MySQL joins' },
        { key: 'T2', summary: 'Postgres alternatives' },
      ],
      assignments: [
        { ref: 'm1', topic: 'T1' },
        { ref: 'm2', topic: 'T1' },
        { ref: 'm3', topic: 'T2' },
      ],
    });

    expect(topics).toEqual([
      { summary: 'Speeding up MySQL joins', messageIds: ['e1', 'e2'] },
      { summary: 'Postgres alternatives', messageIds: ['e3'] },
    ]);
  });

  it('adds messages to existing topics and updates their summaries', () => {
    const existing: TaskTopic[] = [{ summary: 'Speeding up MySQL joins', messageIds: ['e1', 'e2'] }];
    const chunk = chunkEntries([e3, e4])[0];
    const topics = applySummaryUpdate(existing, chunk, {
      title: 'Database tuning',
      topics: [{ key: 'T1', summary: 'Speeding up joins in MySQL and Postgres' }],
      assignments: [
        { ref: 'm1', topic: 'T1' },
        { ref: 'm2', topic: 'T1' },
      ],
    });

    expect(topics).toEqual([{ summary: 'Speeding up joins in MySQL and Postgres', messageIds: ['e1', 'e2', 'e3', 'e4'] }]);
    expect(existing[0].messageIds).toEqual(['e1', 'e2']);
  });

  it('puts unassigned messages in the topic of the previous message', () => {
    const existing: TaskTopic[] = [
      { summary: 'First', messageIds: ['e1'] },
      { summary: 'Second', messageIds: ['e2'] },
    ];
    const chunk = chunkEntries([e3, e4])[0];
    const topics = applySummaryUpdate(existing, chunk, { title: '', topics: [], assignments: [{ ref: 'm2', topic: 'banana' }] });

    expect(topics.map((topic) => topic.messageIds)).toEqual([['e1'], ['e2', 'e3', 'e4']]);
  });

  it('skips detached topics when choosing the previous topic', () => {
    const existing: TaskTopic[] = [
      { summary: 'Live', messageIds: ['e1'] },
      { summary: 'Compacted', messageIds: ['gone'], detached: true },
    ];
    const chunk = chunkEntries([e3])[0];
    const topics = applySummaryUpdate(existing, chunk, { title: '', topics: [], assignments: [] });

    expect(topics[0].messageIds).toEqual(['e1', 'e3']);
    expect(topics[1]).toEqual({ summary: 'Compacted', messageIds: ['gone'], detached: true });
  });

  it('starts a topic from the first message when the map is empty and nothing is assigned', () => {
    const chunk = chunkEntries([e1])[0];
    const topics = applySummaryUpdate([], chunk, { title: '', topics: [], assignments: [] });

    expect(topics).toEqual([{ summary: 'How do I speed up MySQL joins?', messageIds: ['e1'] }]);
  });

  it('drops new topics that receive no messages and accepts case-insensitive references', () => {
    const chunk = chunkEntries([e1])[0];
    const topics = applySummaryUpdate([], chunk, {
      title: '',
      topics: [
        { key: 'T1', summary: 'Joins' },
        { key: 'T2', summary: 'Unused' },
      ],
      assignments: [{ ref: 'M1', topic: 't1' }],
    });

    expect(topics).toEqual([{ summary: 'Joins', messageIds: ['e1'] }]);
  });
});

describe('getUnsummarizedEntries and markDetachedTopics', () => {
  it('returns the entries that no topic references', () => {
    const topics: TaskTopic[] = [{ summary: 'Joins', messageIds: ['e1', 'e2'] }];
    expect(getUnsummarizedEntries([e1, e2, e3], topics).map((item) => item.id)).toEqual(['e3']);
  });

  it('marks topics whose messages are all gone as detached', () => {
    const topics: TaskTopic[] = [
      { summary: 'Gone', messageIds: ['x1'] },
      { summary: 'Present', messageIds: ['e1', 'x2'], detached: true },
    ];
    const result = markDetachedTopics(topics, [e1]);

    expect(result[0]).toEqual({ summary: 'Gone', messageIds: ['x1'], detached: true });
    expect(result[1]).toEqual({ summary: 'Present', messageIds: ['e1', 'x2'] });
  });
});

describe('buildSummaryPrompt', () => {
  it('lists the current topics and the next free topic key', () => {
    const topics: TaskTopic[] = [
      { summary: 'Joins', messageIds: ['e1'] },
      { summary: 'Old work', messageIds: ['x1'], detached: true },
    ];
    const prompt = buildSummaryPrompt('Database task', 'Database tuning', topics, chunkEntries([e3])[0]);

    expect(prompt).toContain('T1 (1 messages): Joins');
    expect(prompt).toContain('T2 (1 messages, no longer in the conversation): Old work');
    expect(prompt).toContain('the next free topic key is T3');
    expect(prompt).toContain('[m1] USER: What about Postgres?');
  });
});
