import { describe, expect, it, vi } from 'vitest';
import { TaskTopic } from '@common/types';

import { ConversationEntry } from '../message-text';
import {
  MAX_SECTION_MESSAGES,
  MIN_SECTIONED_TOPIC_MESSAGES,
  SECTION_SYSTEM_PROMPT,
  applySummaryUpdate,
  applyTopicSections,
  buildSectionPrompt,
  buildSummaryPrompt,
  chunkEntries,
  cleanDescription,
  cleanTitle,
  cleanTopicSummary,
  findCurrentTopicIndex,
  getUnsummarizedEntries,
  markDetachedTopics,
  parseSectionResponse,
  parseSummaryResponse,
  sectionTopics,
  selectTopicsToSection,
} from '../summary-model';

const entry = (id: string, role: 'user' | 'assistant', text: string): ConversationEntry => ({ id, role, text, tools: [] });

const e1 = entry('e1', 'user', 'How do I speed up MySQL joins?');
const e2 = entry('e2', 'assistant', 'Add an index on the join columns.');
const e3 = entry('e3', 'user', 'What about Postgres?');
const e4 = entry('e4', 'assistant', 'Postgres has similar options.');

const numbered = (count: number, prefix = 's'): ConversationEntry[] =>
  Array.from({ length: count }, (_, index) => entry(`${prefix}${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `Message ${index + 1}`));

const topicOf = (items: ConversationEntry[], summary = 'Topic'): TaskTopic => ({ summary, messageIds: items.map((item) => item.id) });

const sectionsJson = (...starts: number[]): string =>
  JSON.stringify({ sections: starts.map((start) => ({ start: `m${start}`, summary: `Section from m${start}` })) });

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

describe('task descriptions', () => {
  it('parses a description, and leaves it out when it is missing or not text', () => {
    expect(parseSummaryResponse('{"title":"T","description":"Making the search easier to use."}')?.description).toBe('Making the search easier to use.');
    expect(parseSummaryResponse('{"title":"T"}')?.description).toBeUndefined();
    expect(parseSummaryResponse('{"title":"T","description":42}')).toMatchObject({ title: 'T', description: undefined });
  });

  it('cleans the description and puts the current one in the prompt', () => {
    expect(cleanDescription('  "Making the search easier to use."  ')).toBe('Making the search easier to use.');
    expect(cleanDescription(undefined)).toBe('');
    expect(buildSummaryPrompt('Task', 'Title', [], chunkEntries([e1])[0], 'Making the search easier to use.')).toContain(
      'Current description: Making the search easier to use.',
    );
    expect(buildSummaryPrompt('Task', 'Title', [], chunkEntries([e1])[0])).toContain('Current description: (none)');
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

describe('findCurrentTopicIndex', () => {
  it('returns the last topic that is not detached', () => {
    expect(
      findCurrentTopicIndex([
        { summary: 'Live', messageIds: ['e1'] },
        { summary: 'Gone', messageIds: ['x1'], detached: true },
      ]),
    ).toBe(0);
    expect(findCurrentTopicIndex([])).toBe(-1);
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

  it('adds messages to the current topic and updates its summary', () => {
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

  it('redirects a message assigned to an earlier topic to the current topic', () => {
    const existing: TaskTopic[] = [
      { summary: 'First', messageIds: ['e1'] },
      { summary: 'Second', messageIds: ['e2'] },
    ];
    const topics = applySummaryUpdate(existing, chunkEntries([e3, e4])[0], {
      title: '',
      topics: [],
      assignments: [
        { ref: 'm1', topic: 'T1' },
        { ref: 'm2', topic: 'T2' },
      ],
    });

    expect(topics.map((topic) => topic.messageIds)).toEqual([['e1'], ['e2', 'e3', 'e4']]);
  });

  it('never returns a message to a topic once a newer topic exists', () => {
    const existing: TaskTopic[] = [{ summary: 'Joins', messageIds: ['e1', 'e2'] }];
    const topics = applySummaryUpdate(existing, chunkEntries([e3, e4])[0], {
      title: '',
      topics: [{ key: 'T2', summary: 'Postgres' }],
      assignments: [
        { ref: 'm1', topic: 'T2' },
        { ref: 'm2', topic: 'T1' },
      ],
    });

    expect(topics).toEqual([
      { summary: 'Joins', messageIds: ['e1', 'e2'] },
      { summary: 'Postgres', messageIds: ['e3', 'e4'] },
    ]);
  });

  it('ignores summary changes to finished topics', () => {
    const existing: TaskTopic[] = [
      { summary: 'First', messageIds: ['e1'] },
      { summary: 'Second', messageIds: ['e2'] },
    ];
    const topics = applySummaryUpdate(existing, chunkEntries([e3])[0], {
      title: '',
      topics: [
        { key: 'T1', summary: 'Rewritten first' },
        { key: 'T2', summary: 'Second, extended' },
      ],
      assignments: [{ ref: 'm1', topic: 'T2' }],
    });

    expect(topics.map((topic) => topic.summary)).toEqual(['First', 'Second, extended']);
  });

  it('does not assign messages to a detached topic', () => {
    const existing: TaskTopic[] = [
      { summary: 'Live', messageIds: ['e1'] },
      { summary: 'Compacted', messageIds: ['gone'], detached: true },
    ];
    const topics = applySummaryUpdate(existing, chunkEntries([e3])[0], {
      title: '',
      topics: [{ key: 'T2', summary: 'Revived' }],
      assignments: [{ ref: 'm1', topic: 'T2' }],
    });

    expect(topics).toEqual([
      { summary: 'Live', messageIds: ['e1', 'e3'] },
      { summary: 'Compacted', messageIds: ['gone'], detached: true },
    ]);
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
  it('lists the current topics, names the current topic and gives the next free topic key', () => {
    const topics: TaskTopic[] = [
      { summary: 'Joins', messageIds: ['e1'] },
      { summary: 'Old work', messageIds: ['x1'], detached: true },
    ];
    const prompt = buildSummaryPrompt('Database task', 'Database tuning', topics, chunkEntries([e3])[0]);

    expect(prompt).toContain('T1 (1 messages): Joins');
    expect(prompt).toContain('T2 (1 messages, no longer in the conversation): Old work');
    expect(prompt).toContain('the current topic is T1; the next free topic key is T3');
    expect(prompt).toContain('[m1] USER: What about Postgres?');
  });
});

describe('parseSectionResponse', () => {
  it('accepts a valid split', () => {
    expect(parseSectionResponse(`Sections: ${sectionsJson(1, 4)}`, 6)).toEqual({
      sections: [
        { startIndex: 0, summary: 'Section from m1' },
        { startIndex: 3, summary: 'Section from m4' },
      ],
      violations: [],
    });
  });

  it('accepts an empty list for a short topic', () => {
    expect(parseSectionResponse('{"sections":[]}', 5)).toEqual({ sections: [], violations: [] });
  });

  it('flags a topic of ten or more messages without sections', () => {
    const answer = parseSectionResponse('{"sections":[]}', MAX_SECTION_MESSAGES + 1);

    expect(answer?.sections).toEqual([]);
    expect(answer?.violations).toHaveLength(1);
    expect(answer?.violations[0]).toContain('must be divided');
  });

  it('flags a section of ten messages', () => {
    const answer = parseSectionResponse(sectionsJson(1, 11), 12);

    expect(answer?.sections.map((section) => section.startIndex)).toEqual([0, 10]);
    expect(answer?.violations).toEqual([`The section starting at m1 holds 10 messages; no section may hold more than ${MAX_SECTION_MESSAGES}.`]);
  });

  it('moves a first start other than m1 to m1', () => {
    expect(parseSectionResponse(sectionsJson(2, 4), 6)).toEqual({
      sections: [
        { startIndex: 0, summary: 'Section from m2' },
        { startIndex: 3, summary: 'Section from m4' },
      ],
      violations: [],
    });
  });

  it('flags and drops references that are out of order or unknown', () => {
    const answer = parseSectionResponse(sectionsJson(1, 5, 3, 9), 6);

    expect(answer?.sections.map((section) => section.startIndex)).toEqual([0, 4]);
    expect(answer?.violations).toHaveLength(2);
    expect(answer?.violations[0]).toContain('m3');
    expect(answer?.violations[1]).toContain('"m9"');
  });

  it('flags a single section and keeps none', () => {
    expect(parseSectionResponse(sectionsJson(1), 6)).toEqual({ sections: [], violations: [expect.stringContaining('Only one section')] });
  });

  it('returns null when the answer cannot be parsed', () => {
    expect(parseSectionResponse('no json', 6)).toBeNull();
    expect(parseSectionResponse('{"sections":"none"}', 6)).toBeNull();
  });
});

describe('applyTopicSections', () => {
  it('stores the sections by message id, starting at the topic first message, and marks the topic sectioned', () => {
    const topic: TaskTopic = { summary: 'Work', messageIds: ['gone', 's1', 's2', 's3', 's4'] };
    const result = applyTopicSections(
      topic,
      ['s1', 's2', 's3', 's4'],
      [
        { startIndex: 0, summary: 'Plan' },
        { startIndex: 2, summary: 'Build' },
      ],
    );

    expect(result).toEqual({
      summary: 'Work',
      messageIds: ['gone', 's1', 's2', 's3', 's4'],
      sections: [
        { summary: 'Plan', startMessageId: 'gone' },
        { summary: 'Build', startMessageId: 's3' },
      ],
      sectioned: true,
    });
  });

  it('marks a topic sectioned without sections when fewer than two remain', () => {
    expect(applyTopicSections({ summary: 'Work', messageIds: ['s1'], sectioned: false }, ['s1'], [])).toEqual({
      summary: 'Work',
      messageIds: ['s1'],
      sectioned: true,
    });
  });
});

describe('buildSectionPrompt', () => {
  it('lists the topic summary and its messages as m1 to mN', () => {
    const prompt = buildSectionPrompt('Database work', [e1, e2]);

    expect(prompt).toContain('Topic: Database work');
    expect(prompt).toContain('[m1] USER: How do I speed up MySQL joins?');
    expect(prompt).toContain('[m2] ASSISTANT: Add an index on the join columns.');
  });

  it('shortens each message to fit instead of splitting the topic', () => {
    const long = numbered(5).map((item) => ({ ...item, text: 'x'.repeat(1000) }));
    const prompt = buildSectionPrompt('Long work', long, 1000);

    expect(prompt).toContain('[m5] USER: ');
    expect(prompt.length).toBeLessThan(1200);
  });
});

describe('selectTopicsToSection', () => {
  const topic = (summary: string, extra: Partial<TaskTopic> = {}): TaskTopic => ({ summary, messageIds: [summary], ...extra });

  it('selects only the topic that just closed and the finished topics created during an extend', () => {
    // Before the update: Old (finished, never sectioned) and Current. The update added New and Latest.
    const topics = [topic('Old'), topic('Current'), topic('New'), topic('Latest')];

    expect(selectTopicsToSection(topics, 1, 2)).toEqual([1, 2]);
  });

  it('selects nothing while the current topic is still the last', () => {
    expect(selectTopicsToSection([topic('Old'), topic('Current')], 1, 2)).toEqual([]);
  });

  it('selects every finished topic after a rebuild', () => {
    expect(selectTopicsToSection([topic('A'), topic('B'), topic('C')], -1, 0)).toEqual([0, 1]);
  });

  it('retries pending topics and skips detached and sectioned ones', () => {
    const topics = [
      topic('Pending', { sectioned: false }),
      topic('Gone', { detached: true }),
      topic('Done', { sectioned: true }),
      topic('Closed'),
      topic('Latest'),
    ];

    expect(selectTopicsToSection(topics, 3, 4)).toEqual([0, 3]);
  });
});

describe('sectionTopics', () => {
  it('accepts a valid first answer with one call', async () => {
    const items = numbered(6);
    const generate = vi.fn().mockResolvedValue(sectionsJson(1, 4));
    const result = await sectionTopics([topicOf(items), topicOf([e1])], [0], [...items, e1], generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe(SECTION_SYSTEM_PROMPT);
    expect(result.topics[0].sections).toEqual([
      { summary: 'Section from m1', startMessageId: 's1' },
      { summary: 'Section from m4', startMessageId: 's4' },
    ]);
    expect(result.topics[0].sectioned).toBe(true);
    expect(result.topics[1]).toEqual(topicOf([e1]));
    expect(result).toMatchObject({ done: 1, withSections: 1, calls: 1, warnings: [] });
  });

  it('retries once when the answer breaks a rule and accepts the second answer', async () => {
    const items = numbered(MAX_SECTION_MESSAGES + 1);
    const generate = vi.fn().mockResolvedValueOnce('{"sections":[]}').mockResolvedValueOnce(sectionsJson(1, 6));
    const result = await sectionTopics([topicOf(items)], [0], items, generate);

    expect(generate).toHaveBeenCalledTimes(2);
    const retryPrompt = generate.mock.calls[1][1] as string;
    expect(retryPrompt).toContain('Your previous answer was:');
    expect(retryPrompt).toContain('must be divided');
    expect(result.topics[0].sections?.map((section) => section.startMessageId)).toEqual(['s1', 's6']);
    expect(result).toMatchObject({ done: 1, withSections: 1, calls: 2, warnings: [] });
  });

  it('accepts a parseable second answer that still breaks the cap, with a warning', async () => {
    const items = numbered(12);
    const generate = vi.fn().mockResolvedValueOnce(sectionsJson(1, 11)).mockResolvedValueOnce(sectionsJson(1, 2));
    const result = await sectionTopics([topicOf(items)], [0], items, generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.topics[0].sections?.map((section) => section.startMessageId)).toEqual(['s1', 's2']);
    expect(result.warnings).toHaveLength(1);
  });

  it('marks the topic sectioned without sections when neither answer parses', async () => {
    const items = numbered(6);
    const generate = vi.fn().mockResolvedValue('no json');
    const result = await sectionTopics([topicOf(items)], [0], items, generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.topics[0]).toEqual({ ...topicOf(items), sectioned: true });
    expect(result.warnings).toHaveLength(1);
  });

  it('marks a topic with too few messages in the conversation sectioned without a call', async () => {
    const short = numbered(MIN_SECTIONED_TOPIC_MESSAGES - 1, 'a');
    const long = numbered(MIN_SECTIONED_TOPIC_MESSAGES, 'b');
    const shortTopic: TaskTopic = { summary: 'Short', messageIds: ['gone', ...short.map((item) => item.id)] };
    const generate = vi.fn().mockResolvedValue('{"sections":[]}');
    const result = await sectionTopics([shortTopic, topicOf(long), topicOf([e1])], [0, 1], [...short, ...long, e1], generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][1]).toContain(`[m${MIN_SECTIONED_TOPIC_MESSAGES}]`);
    expect(result.topics[0]).toEqual({ ...shortTopic, sectioned: true });
    expect(result.topics[1]).toEqual({ ...topicOf(long), sectioned: true });
    expect(result).toMatchObject({ done: 2, withSections: 0, calls: 1 });
  });

  it('marks the failed topic and every untried candidate pending when a model call fails', async () => {
    const first = numbered(6, 'a');
    const second = numbered(6, 'b');
    const third = numbered(2, 'c');
    const generate = vi.fn().mockRejectedValueOnce(new Error('provider down')).mockResolvedValue(sectionsJson(1, 4));
    const topics = [topicOf(first, 'First'), topicOf(second, 'Second'), topicOf(third, 'Third'), topicOf([e1], 'Current')];
    const result = await sectionTopics(topics, [0, 1, 2], [...first, ...second, ...third, e1], generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.topics.slice(0, 3).map((topic) => topic.sectioned)).toEqual([false, false, false]);
    expect(result.topics[0].sections).toBeUndefined();
    expect(result.topics[3]).toEqual(topics[3]);
    expect(result).toMatchObject({ done: 0, withSections: 0, calls: 1 });
    expect(result.warnings).toHaveLength(1);
    expect(selectTopicsToSection(result.topics, 3, 4)).toEqual([0, 1, 2]);
  });
});
