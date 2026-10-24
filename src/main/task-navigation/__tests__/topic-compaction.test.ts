import { describe, expect, it } from 'vitest';
import {
  ContextMessage,
  TaskTopic,
  TopicCompactionTarget,
  getCompactionPromptMessageId,
  getCompactionSummaryMessageId,
  getCompactionTargetCharacters,
  getTopicCompactionBlockReason,
  getTopicCompactionIdFromMessageId,
  isTopicCompactionMessageId,
  isTopicCompactionPromptMessageId,
} from '@common/types';

import { toConversationEntries } from '../message-text';
import { findCurrentTopicIndex, markDetachedTopics, selectTopicsToSection } from '../summary-model';
import {
  COMPACTION_SYSTEM_PROMPT,
  TopicCompactionError,
  applyTopicCompaction,
  applyTopicCompactionUndo,
  buildCompactionMarkerText,
  buildCompactionPrompt,
  buildCompactionRequest,
  buildTopicCompactionPreview,
  cleanCompactionOutput,
  collectCompactionIndexEntries,
  findRemovedCompactionSummaries,
  planTopicCompaction,
  reconcileCompactions,
  renderCompactionTranscript,
  selectTopicsKeptOnRebuild,
} from '../topic-compaction';

const user = (id: string, text = `Question ${id}`): ContextMessage => ({ id, role: 'user', content: text }) as ContextMessage;

const assistant = (id: string, text = `Answer ${id}`, callIds: string[] = []): ContextMessage =>
  ({
    id,
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...callIds.map((toolCallId) => ({ type: 'tool-call', toolCallId, toolName: 'power---bash', input: { command: `run ${toolCallId}` } })),
    ],
  }) as ContextMessage;

const toolResult = (id: string, toolCallId: string, value = `output of ${toolCallId}`): ContextMessage =>
  ({ id, role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName: 'power---bash', output: { type: 'text', value } }] }) as ContextMessage;

const conversation = (): ContextMessage[] => [
  user('u1'),
  assistant('a1', 'Answer a1', ['c1']),
  toolResult('t1', 'c1'),
  user('u2'),
  assistant('a2'),
  user('u3'),
  assistant('a3'),
  user('u4'),
  assistant('a4'),
  user('u5'),
  assistant('a5'),
];

const topicMap = (): TaskTopic[] => [
  {
    summary: 'Topic A',
    messageIds: ['u1', 'a1', 'u2', 'a2', 'u3', 'a3'],
    sectioned: true,
    sections: [
      { summary: 'First part', startMessageId: 'u1' },
      { summary: 'Second part', startMessageId: 'u2' },
      { summary: 'Third part', startMessageId: 'u3' },
    ],
  },
  { summary: 'Topic B', messageIds: ['u4', 'a4'], sectioned: true },
  { summary: 'Topic C', messageIds: ['u5', 'a5'] },
];

const topicTarget = (topicIndex: number, topics: TaskTopic[] = topicMap()): TopicCompactionTarget => ({
  topicIndex,
  firstMessageId: topics[topicIndex].messageIds[0],
});

const sectionTarget = (topicIndex: number, sectionIndex: number, topics: TaskTopic[] = topicMap()): TopicCompactionTarget => ({
  topicIndex,
  sectionIndex,
  firstMessageId: topics[topicIndex].sections![sectionIndex].startMessageId,
});

const NOW = new Date('2026-10-24T10:00:00.000Z');

const compact = (messages: ContextMessage[], topics: TaskTopic[], target: TopicCompactionTarget, compactionId: string) =>
  applyTopicCompaction({ messages, topics, target, compactionId, recap: `Recap ${compactionId}`, level: 3, now: NOW });

const ids = (messages: ContextMessage[]): string[] => messages.map((message) => message.id);

const reasonOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof TopicCompactionError ? error.reason : 'other';
  }
  return undefined;
};

const P = getCompactionPromptMessageId;
const S = getCompactionSummaryMessageId;

describe('compaction ids and helpers', () => {
  it('derives the marker and recap ids from the compaction id and back', () => {
    expect(S('abc')).toBe('topic-compaction-abc');
    expect(P('abc')).toBe('topic-compaction-abc-prompt');
    expect(isTopicCompactionMessageId(S('abc'))).toBe(true);
    expect(isTopicCompactionMessageId(P('abc'))).toBe(true);
    expect(isTopicCompactionMessageId('u1')).toBe(false);
    expect(isTopicCompactionMessageId('topic-compaction-')).toBe(false);
    expect(isTopicCompactionPromptMessageId(P('abc'))).toBe(true);
    expect(isTopicCompactionPromptMessageId(S('abc'))).toBe(false);
    expect(getTopicCompactionIdFromMessageId(S('abc'))).toBe('abc');
    expect(getTopicCompactionIdFromMessageId(P('abc'))).toBe('abc');
    expect(getTopicCompactionIdFromMessageId('u1')).toBeUndefined();
  });

  it('finds the block reason in an error message, also behind an IPC prefix', () => {
    expect(getTopicCompactionBlockReason('running: the task is running')).toBe('running');
    expect(getTopicCompactionBlockReason("Error invoking remote method 'task-navigation-compaction-compact': Error: tool-pairs: split")).toBe('tool-pairs');
    expect(getTopicCompactionBlockReason('Something else failed')).toBeUndefined();
  });

  it('builds the marker text without a doubled full stop', () => {
    expect(buildCompactionMarkerText('Fixing the build.')).toBe("[Compacted part of the conversation: Fixing the build. The assistant's recap of it follows.]");
  });
});

describe('getCompactionTargetCharacters', () => {
  it.each([
    [1, 1000, 300],
    [1, 20000, 600],
    [1, 100000, 800],
    [2, 1000, 600],
    [2, 20000, 1600],
    [2, 100000, 2500],
    [3, 1000, 600],
    [3, 20000, 3000],
    [3, 100000, 6000],
    [4, 1000, 600],
    [4, 20000, 5400],
    [4, 100000, 14000],
    [5, 1000, 600],
    [5, 20000, 9000],
    [5, 100000, 40000],
  ])('level %i with %i source characters gives %i', (level, source, expected) => {
    expect(getCompactionTargetCharacters(level, source)).toBe(expected);
  });

  it('caps tiny sources at 200 characters and rounds to the nearest 50', () => {
    expect(getCompactionTargetCharacters(5, 100)).toBe(200);
    expect(getCompactionTargetCharacters(3, 12345)).toBe(1850);
  });
});

describe('locating the stretch', () => {
  it('locates a finished topic with its trailing tool result', () => {
    const { stretch } = planTopicCompaction(conversation(), topicMap(), topicTarget(0));
    expect(stretch.messageIds).toEqual(['u1', 'a1', 't1', 'u2', 'a2', 'u3', 'a3']);
    expect(stretch.endBeforeMessageId).toBe('u4');
  });

  it('locates each section of a topic', () => {
    const located = [0, 1, 2].map((index) => planTopicCompaction(conversation(), topicMap(), sectionTarget(0, index)).stretch);
    expect(located.map((stretch) => stretch.messageIds)).toEqual([
      ['u1', 'a1', 't1'],
      ['u2', 'a2'],
      ['u3', 'a3'],
    ]);
    expect(located.map((stretch) => stretch.endBeforeMessageId)).toEqual(['u2', 'u3', 'u4']);
  });

  it('previews the stretch and the target lengths per level', () => {
    const preview = buildTopicCompactionPreview(conversation(), topicMap(), sectionTarget(0, 1));
    expect(preview).toEqual({
      compactable: true,
      firstMessageId: 'u2',
      endBeforeMessageId: 'u3',
      messageCount: 2,
      sourceCharacters: 'Question u2'.length + 'Answer a2'.length,
      targetCharacters: { 1: 200, 2: 200, 3: 200, 4: 200, 5: 200 },
    });
  });

  it('includes the recap pairs of compacted first, middle and last sections in the topic stretch', () => {
    const first = compact(conversation(), topicMap(), sectionTarget(0, 0), 'f');
    expect(planTopicCompaction(first.messages, first.topics, topicTarget(0, first.topics)).stretch.messageIds).toEqual([
      P('f'),
      S('f'),
      'u2',
      'a2',
      'u3',
      'a3',
    ]);

    const middle = compact(conversation(), topicMap(), sectionTarget(0, 1), 'm');
    const middlePlan = planTopicCompaction(middle.messages, middle.topics, topicTarget(0, middle.topics));
    expect(middlePlan.stretch.messageIds).toEqual(['u1', 'a1', 't1', P('m'), S('m'), 'u3', 'a3']);
    expect(middlePlan.stretch.ownedCompactions.map((info) => info.id)).toEqual(['m']);
    expect(middlePlan.stretch.sourceCharacters).toBe('Question u1'.length + 'Answer a1'.length + 'Question u3'.length + 'Answer a3'.length + 'Recap m'.length);

    const last = compact(conversation(), topicMap(), sectionTarget(0, 2), 'l');
    const lastPlan = planTopicCompaction(last.messages, last.topics, topicTarget(0, last.topics));
    expect(lastPlan.stretch.messageIds).toEqual(['u1', 'a1', 't1', 'u2', 'a2', P('l'), S('l')]);
    expect(lastPlan.stretch.endBeforeMessageId).toBe('u4');

    const both = compact(first.messages, first.topics, sectionTarget(0, 2, first.topics), 'l');
    expect(planTopicCompaction(both.messages, both.topics, topicTarget(0, both.topics)).stretch.messageIds).toEqual([
      P('f'),
      S('f'),
      'u2',
      'a2',
      P('l'),
      S('l'),
    ]);
  });

  it('refuses a topic whose sections are all compacted, as it holds no entry of its own', () => {
    const first = compact(conversation(), topicMap(), sectionTarget(0, 0), 'f');
    const middle = compact(first.messages, first.topics, sectionTarget(0, 1, first.topics), 'm');
    const last = compact(middle.messages, middle.topics, sectionTarget(0, 2, middle.topics), 'l');
    expect(buildTopicCompactionPreview(last.messages, last.topics, topicTarget(0, last.topics)).reason).toBe('too-few-messages');
  });
});

describe('refusals', () => {
  it('refuses the current topic', () => {
    expect(buildTopicCompactionPreview(conversation(), topicMap(), topicTarget(2))).toEqual({
      compactable: false,
      reason: 'current-topic',
      messageCount: 0,
      sourceCharacters: 0,
      targetCharacters: {},
    });
    expect(() => compact(conversation(), topicMap(), topicTarget(2), 'x')).toThrow(/^current-topic: /);
  });

  it('refuses a detached topic', () => {
    const topics = topicMap();
    topics[0] = { ...topics[0], detached: true };
    expect(buildTopicCompactionPreview(conversation(), topics, topicTarget(0, topics)).reason).toBe('detached');
  });

  it('refuses a topic whose messages are not one run', () => {
    const topics = topicMap();
    topics[1] = { summary: 'Topic B', messageIds: ['u4', 'u5'] };
    topics[2] = { summary: 'Topic C', messageIds: ['a5'] };
    expect(buildTopicCompactionPreview(conversation(), topics, topicTarget(1, topics)).reason).toBe('not-contiguous');
  });

  it('refuses a stretch that would split a tool call from its result', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Answer a1', ['c9']),
      user('u2'),
      assistant('a2'),
      toolResult('t9', 'c9'),
      user('u3'),
      assistant('a3'),
      user('u4'),
      assistant('a4'),
    ];
    const topics: TaskTopic[] = [
      {
        summary: 'Topic A',
        messageIds: ['u1', 'a1', 'u2', 'a2'],
        sections: [
          { summary: 'First', startMessageId: 'u1' },
          { summary: 'Second', startMessageId: 'u2' },
        ],
      },
      { summary: 'Topic B', messageIds: ['u3', 'a3'] },
      { summary: 'Topic C', messageIds: ['u4', 'a4'] },
    ];
    expect(buildTopicCompactionPreview(messages, topics, sectionTarget(0, 0, topics)).reason).toBe('tool-pairs');
    expect(buildTopicCompactionPreview(messages, topics, sectionTarget(0, 1, topics)).reason).toBe('tool-pairs');
    expect(buildTopicCompactionPreview(messages, topics, topicTarget(0, topics)).compactable).toBe(true);
  });

  it('refuses a target with too few messages', () => {
    const topics = topicMap();
    topics[0] = { ...topics[0], sections: [topics[0].sections![0], topics[0].sections![1], { summary: 'Last reply', startMessageId: 'a3' }] };
    expect(buildTopicCompactionPreview(conversation(), topics, sectionTarget(0, 2, topics)).reason).toBe('too-few-messages');
  });

  it('refuses a section of a compacted topic, and a target compacted already', () => {
    const topic = compact(conversation(), topicMap(), topicTarget(0), 't');
    expect(buildTopicCompactionPreview(topic.messages, topic.topics, sectionTarget(0, 1, topic.topics)).reason).toBe('inside-compacted-topic');
    expect(buildTopicCompactionPreview(topic.messages, topic.topics, topicTarget(0, topic.topics)).reason).toBe('already-compacted');

    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    expect(buildTopicCompactionPreview(section.messages, section.topics, sectionTarget(0, 1, section.topics)).reason).toBe('already-compacted');
  });

  it('refuses a target that no longer matches what the caller saw', () => {
    expect(buildTopicCompactionPreview(conversation(), topicMap(), { topicIndex: 0, firstMessageId: 'zzz' }).reason).toBe('not-found');
    expect(buildTopicCompactionPreview(conversation(), topicMap(), { topicIndex: 9, firstMessageId: 'u1' }).reason).toBe('not-found');
    expect(buildTopicCompactionPreview(conversation(), topicMap(), { topicIndex: 0, sectionIndex: 5, firstMessageId: 'u1' }).reason).toBe('not-found');
  });

  it('refuses when the stretch changed after it was summarised', () => {
    const plan = planTopicCompaction(conversation(), topicMap(), topicTarget(1));
    const work = () =>
      applyTopicCompaction({
        messages: conversation(),
        topics: topicMap(),
        target: topicTarget(1),
        compactionId: 'x',
        recap: 'Recap',
        level: 3,
        expectedMessageIds: [...plan.stretch.messageIds, 'extra'],
      });
    expect(reasonOf(work)).toBe('not-found');
  });
});

describe('the summary pair', () => {
  it('replaces the stretch by a marker and a recap, records the compaction and keeps the originals', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'abc');
    expect(ids(result.messages)).toEqual(['u1', 'a1', 't1', 'u2', 'a2', 'u3', 'a3', 'topic-compaction-abc-prompt', 'topic-compaction-abc', 'u5', 'a5']);
    expect(result.messages[7]).toEqual({
      id: 'topic-compaction-abc-prompt',
      role: 'user',
      content: "[Compacted part of the conversation: Topic B. The assistant's recap of it follows.]",
      timestamp: NOW.getTime(),
    });
    expect(result.messages[8]).toEqual({ id: 'topic-compaction-abc', role: 'assistant', content: 'Recap abc', timestamp: NOW.getTime() });
    expect(result.info).toEqual({
      id: 'abc',
      level: 3,
      compactedAt: '2026-10-24T10:00:00.000Z',
      summaryMessageId: 'topic-compaction-abc',
      promptMessageId: 'topic-compaction-abc-prompt',
      messageCount: 2,
      sourceCharacters: 'Question u4'.length + 'Answer a4'.length,
      summaryCharacters: 'Recap abc'.length,
    });
    expect(result.topics[1].compaction).toEqual(result.info);
    expect(result.sidecar.originalMessages).toEqual([user('u4'), assistant('a4')]);
    expect(result.sidecar).toMatchObject({ version: 1, id: 'abc', target: topicTarget(1), messageCount: 2 });
  });
});

describe('undo', () => {
  it('restores the conversation exactly, with messages appended after the compaction', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'b');
    const appended = [...result.messages, user('u6'), assistant('a6')];
    const undone = applyTopicCompactionUndo(appended, result.topics, 'b', result.sidecar.originalMessages);
    expect(undone.messages).toEqual([...conversation(), user('u6'), assistant('a6')]);
    expect(undone.topics).toEqual(topicMap());
  });

  it('undoes nested compactions: section, then topic, then undo topic, then undo section', () => {
    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    const topic = compact(section.messages, section.topics, topicTarget(0, section.topics), 't');
    expect(ids(topic.sidecar.originalMessages)).toEqual(['u1', 'a1', 't1', P('s'), S('s'), 'u3', 'a3']);
    expect(topic.topics[0].sections![1].compaction?.id).toBe('s');

    expect(reasonOf(() => applyTopicCompactionUndo(topic.messages, topic.topics, 's', section.sidecar.originalMessages))).toBe('inside-compacted-topic');

    const topicUndone = applyTopicCompactionUndo(topic.messages, topic.topics, 't', topic.sidecar.originalMessages);
    expect(topicUndone.messages).toEqual(section.messages);
    expect(topicUndone.topics).toEqual(section.topics);

    const sectionUndone = applyTopicCompactionUndo(topicUndone.messages, topicUndone.topics, 's', section.sidecar.originalMessages);
    expect(sectionUndone.messages).toEqual(conversation());
    expect(sectionUndone.topics).toEqual(topicMap());
  });

  it('refuses when the recap is not in the conversation or the record is unknown', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'b');
    expect(reasonOf(() => applyTopicCompactionUndo(conversation(), result.topics, 'b', result.sidecar.originalMessages))).toBe('not-found');
    expect(reasonOf(() => applyTopicCompactionUndo(result.messages, result.topics, 'zzz', []))).toBe('not-found');
  });
});

describe('findRemovedCompactionSummaries', () => {
  it('reports recaps that a /compact-like replacement drops', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const compacted = [result.messages[0], { id: 'summary', role: 'user', content: 'Summary of the conversation' }];
    expect(findRemovedCompactionSummaries(result.messages, compacted)).toEqual(['topic-compaction-x']);
  });

  it('reports nothing for a smart-compaction-like replacement that keeps every id', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const trimmed = result.messages.map((message) => (message.role === 'tool' ? { ...message, content: [] } : { ...message }));
    expect(findRemovedCompactionSummaries(result.messages, trimmed)).toEqual([]);
  });
});

describe('reconcileCompactions', () => {
  it('clears lost when the recap is present', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const lostTopics = result.topics.map((topic, index) => (index === 1 ? { ...topic, compaction: { ...topic.compaction!, lost: true } } : topic));
    const reconciled = reconcileCompactions(lostTopics, ids(result.messages));
    expect(reconciled.topics).toEqual(result.topics);
    expect(reconciled.deletedCompactionIds).toEqual([]);
    expect(reconciled.changed).toBe(true);
  });

  it('marks a record lost when its recap and its messages are gone', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const reconciled = reconcileCompactions(result.topics, ['u1', 'u5']);
    expect(reconciled.topics[1].compaction?.lost).toBe(true);
    expect(reconciled.deletedCompactionIds).toEqual([]);
  });

  it('drops a record whose messages are back after an external undo', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const reconciled = reconcileCompactions(result.topics, ids(conversation()));
    expect(reconciled.topics).toEqual(topicMap());
    expect(reconciled.deletedCompactionIds).toEqual(['x']);
  });

  it('leaves the section records of a compacted topic alone and drops the topic record after an external undo', () => {
    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    const topic = compact(section.messages, section.topics, topicTarget(0, section.topics), 't');
    expect(reconcileCompactions(topic.topics, ids(topic.messages)).changed).toBe(false);

    const reconciled = reconcileCompactions(topic.topics, ids(section.messages));
    expect(reconciled.topics).toEqual(section.topics);
    expect(reconciled.deletedCompactionIds).toEqual(['t']);
  });
});

describe('topic maps with compactions', () => {
  it('keeps a compacted topic present while its recap is in the conversation', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const entries = toConversationEntries(result.messages);
    expect(markDetachedTopics(result.topics, entries, ids(result.messages))[1].detached).toBeUndefined();
    expect(markDetachedTopics(result.topics, entries)[1].detached).toBe(true);
  });

  it('keeps a topic present while the recaps of its compacted sections are in the conversation', () => {
    const first = compact(conversation(), topicMap(), sectionTarget(0, 0), 'f');
    const middle = compact(first.messages, first.topics, sectionTarget(0, 1, first.topics), 'm');
    const last = compact(middle.messages, middle.topics, sectionTarget(0, 2, middle.topics), 'l');
    const entries = toConversationEntries(last.messages);
    expect(markDetachedTopics(last.topics, entries, ids(last.messages))[0].detached).toBeUndefined();
    expect(markDetachedTopics(last.topics, entries, ['u5', 'a5'])[0].detached).toBe(true);
  });

  it('does not section a compacted topic', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const pending = result.topics.map((topic) => ({ ...topic, sectioned: undefined }));
    expect(selectTopicsToSection(pending, -1, 0)).toEqual([0]);
    expect(
      selectTopicsToSection(
        topicMap().map((topic) => ({ ...topic, sectioned: undefined })),
        -1,
        0,
      ),
    ).toEqual([0, 1]);
  });

  it('leaves the marker and the recap out of conversation entries unless the recap is asked for', () => {
    const result = compact(conversation(), topicMap(), topicTarget(1), 'x');
    const plain = toConversationEntries(result.messages).map((entry) => entry.id);
    expect(plain).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u5', 'a5']);
    const withRecaps = toConversationEntries(result.messages, { includeCompactionSummaries: true });
    expect(withRecaps.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', S('x'), 'u5', 'a5']);
    expect(withRecaps[6]).toMatchObject({ role: 'assistant', text: 'Recap x' });
  });
});

describe('collectCompactionIndexEntries', () => {
  it('indexes the originals of nested compactions under the outermost recap in the conversation', () => {
    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    const topic = compact(section.messages, section.topics, topicTarget(0, section.topics), 't');
    const sidecars = [section.sidecar, topic.sidecar];

    const nested = collectCompactionIndexEntries(topic.messages, sidecars);
    expect(nested.map((item) => [item.entry.id, item.scrollTarget])).toEqual([
      ['u1', S('t')],
      ['a1', S('t')],
      ['u3', S('t')],
      ['a3', S('t')],
      ['u2', S('t')],
      ['a2', S('t')],
    ]);

    const single = collectCompactionIndexEntries(section.messages, sidecars);
    expect(single.map((item) => [item.entry.id, item.scrollTarget])).toEqual([
      ['u2', S('s')],
      ['a2', S('s')],
    ]);
    expect(collectCompactionIndexEntries(conversation(), sidecars)).toEqual([]);
  });
});

describe('renderCompactionTranscript', () => {
  it('renders text, tool calls and results, images and earlier recaps, and skips reasoning and markers', () => {
    const messages = [
      {
        id: 'u1',
        role: 'user',
        content: [
          { type: 'text', text: 'See this' },
          { type: 'image', image: 'data' },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Thinking it over' },
          { type: 'text', text: 'Answer a1' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'power---bash', input: { command: 'run c1' } },
        ],
      },
      toolResult('t1', 'c1'),
      { id: P('z'), role: 'user', content: buildCompactionMarkerText('Earlier work') },
      { id: S('z'), role: 'assistant', content: 'Earlier recap text' },
    ] as ContextMessage[];
    expect(renderCompactionTranscript(messages)).toEqual({
      text: [
        'USER: See this',
        'USER: [image]',
        'ASSISTANT: Answer a1',
        'TOOL CALL bash: {"command":"run c1"}',
        'TOOL RESULT bash: output of c1',
        'EARLIER RECAP: Earlier recap text',
      ].join('\n\n'),
      shortened: false,
    });
  });

  it('cuts tool calls to 400 and tool results to 1,500 characters', () => {
    const messages = [user('u1', 'hi'), assistant('a1', 'ok', ['c1']), toolResult('t1', 'c1', 'x'.repeat(5000))];
    (messages[1].content as Array<{ input?: unknown }>)[1].input = { command: 'y'.repeat(1000) };
    const { text, shortened } = renderCompactionTranscript(messages);
    expect(shortened).toBe(false);
    expect(text).toContain(`${'x'.repeat(1499)}…`);
    expect(text).not.toContain('x'.repeat(1500));
    expect(text).not.toContain('y'.repeat(400));
  });

  it('cuts tool results to 300 characters when the transcript is too long', () => {
    const messages = [user('u1', 'hi'), assistant('a1', 'ok', ['c1']), toolResult('t1', 'c1', 'x'.repeat(1500))];
    const { text, shortened } = renderCompactionTranscript(messages, 1000);
    expect(shortened).toBe(true);
    expect(text).toContain('USER: hi');
    expect(text).toContain(`${'x'.repeat(299)}…`);
    expect(text).not.toContain('x'.repeat(300));
  });

  it('then shortens texts proportionally', () => {
    const messages = [user('u1', 'y'.repeat(3000)), assistant('a1', 'z'.repeat(1000))];
    const { text, shortened } = renderCompactionTranscript(messages, 2000);
    expect(shortened).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2000);
    const count = (character: string): number => text.split('').filter((item) => item === character).length;
    expect(count('y')).toBeGreaterThan(count('z') * 2);
  });
});

describe('the compaction prompt', () => {
  it('asks for a past-tense recap that keeps paths and decisions', () => {
    expect(COMPACTION_SYSTEM_PROMPT).toContain('past tense');
    expect(COMPACTION_SYSTEM_PROMPT).toContain('files created or changed, by path');
    expect(COMPACTION_SYSTEM_PROMPT).toContain('no preamble');
  });

  it('states the context, the target length, the shortening note and the instructions', () => {
    const prompt = buildCompactionPrompt({
      taskName: 'Build fixes',
      precedingTopics: ['Setup'],
      followingTopics: [],
      topicSummary: 'Topic A',
      sectionSummary: 'Second part',
      transcript: { text: 'USER: hi', shortened: true },
      targetCharacters: 1000,
      instructions: '  Keep the file list.  ',
    });
    expect(prompt).toContain('Task: Build fixes');
    expect(prompt).toContain('Topics before this part:\n- Setup');
    expect(prompt).toContain('This part: a section of the topic "Topic A": Second part');
    expect(prompt).toContain('Topics after this part:\n(none)');
    expect(prompt).toContain('(The transcript was shortened');
    expect(prompt).toContain('about 167 words');
    expect(prompt.endsWith('Additional instructions from the user (follow them):\nKeep the file list.')).toBe(true);
  });

  it('builds the request for a planned compaction', () => {
    const plan = planTopicCompaction(conversation(), topicMap(), sectionTarget(0, 1));
    const request = buildCompactionRequest('Task', topicMap(), plan, 3);
    expect(request.systemPrompt).toBe(COMPACTION_SYSTEM_PROMPT);
    expect(request.prompt).toContain('USER: Question u2\n\nASSISTANT: Answer a2');
    expect(request.prompt).toContain('Topics after this part:\n- Topic B\n- Topic C');
    expect(request.prompt).not.toContain('Additional instructions');
    expect(request.targetCharacters).toBe(200);
  });

  it('cleans the model output', () => {
    expect(cleanCompactionOutput('```markdown\nHello\n```')).toBe('Hello');
    expect(cleanCompactionOutput('  plain text  ')).toBe('plain text');
    expect(cleanCompactionOutput('')).toBe('');
    expect(cleanCompactionOutput(undefined)).toBe('');
  });
});

describe('rebuilds and the current topic', () => {
  it('keeps the topics up to the last one with a compaction record', () => {
    expect(selectTopicsKeptOnRebuild(topicMap())).toEqual([]);

    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    expect(selectTopicsKeptOnRebuild(section.topics)).toEqual([section.topics[0]]);

    const topic = compact(conversation(), topicMap(), topicTarget(1), 't');
    expect(selectTopicsKeptOnRebuild(topic.topics)).toEqual(topic.topics.slice(0, 2));
  });

  it('has no current topic when the last topic still in the conversation holds a compaction', () => {
    const topic = compact(conversation(), topicMap(), topicTarget(1), 't');
    expect(findCurrentTopicIndex(topic.topics)).toBe(2);
    expect(findCurrentTopicIndex(topic.topics.slice(0, 2))).toBe(-1);

    const section = compact(conversation(), topicMap(), sectionTarget(0, 1), 's');
    expect(findCurrentTopicIndex(section.topics.slice(0, 1))).toBe(-1);
  });
});
