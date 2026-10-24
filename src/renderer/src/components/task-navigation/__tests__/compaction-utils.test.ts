import { describe, expect, it } from 'vitest';
import { TaskTopic, TopicCompactionInfo } from '@common/types';

import {
  estimateWords,
  findTopicCompaction,
  getCompactionErrorReasonKey,
  getCompactionErrorText,
  getCompactionTargetForRow,
  getCurrentTopicIndex,
  getUndoCompactionIdForRow,
  isCompactableFromClient,
} from '../compaction-utils';

const record = (id: string): TopicCompactionInfo => ({
  id,
  level: 3,
  compactedAt: '2026-10-24T10:00:00.000Z',
  summaryMessageId: `topic-compaction-${id}`,
  promptMessageId: `topic-compaction-${id}-prompt`,
  messageCount: 4,
  sourceCharacters: 1200,
  summaryCharacters: 300,
});

const topics: TaskTopic[] = [
  { summary: 'Plain finished topic', messageIds: ['a1', 'a2'] },
  {
    summary: 'Sectioned topic',
    messageIds: ['b1', 'b2', 'b3', 'b4'],
    sections: [
      { summary: 'First', startMessageId: 'b1' },
      { summary: 'Second', startMessageId: 'b3', compaction: record('s1') },
    ],
  },
  {
    summary: 'Compacted topic',
    messageIds: ['c1', 'c2'],
    compaction: record('t1'),
    sections: [{ summary: 'Inner', startMessageId: 'c1', compaction: record('s2') }],
  },
  { summary: 'Detached topic', messageIds: ['d1'], detached: true },
  { summary: 'Current topic', messageIds: ['e1'] },
  { summary: 'Detached after current', messageIds: ['f1'], detached: true },
];

describe('getCurrentTopicIndex', () => {
  it('is the last topic that is neither detached nor compacted', () => {
    expect(getCurrentTopicIndex(topics)).toBe(4);
    expect(getCurrentTopicIndex([{ summary: 'x', messageIds: [], detached: true }])).toBe(-1);
  });
});

describe('isCompactableFromClient', () => {
  it('accepts finished topics and their uncompacted sections', () => {
    expect(isCompactableFromClient(topics, 0)).toBe(true);
    expect(isCompactableFromClient(topics, 1)).toBe(true);
    expect(isCompactableFromClient(topics, 1, 0)).toBe(true);
  });

  it('refuses the current, detached and compacted topics, compacted sections and sections of compacted topics', () => {
    expect(isCompactableFromClient(topics, 4)).toBe(false);
    expect(isCompactableFromClient(topics, 3)).toBe(false);
    expect(isCompactableFromClient(topics, 2)).toBe(false);
    expect(isCompactableFromClient(topics, 1, 1)).toBe(false);
    expect(isCompactableFromClient(topics, 2, 0)).toBe(false);
    expect(isCompactableFromClient(topics, 9)).toBe(false);
  });
});

describe('getCompactionTargetForRow', () => {
  it('targets the topic for a topic row', () => {
    expect(getCompactionTargetForRow(topics, { kind: 'topic', key: 'topic:1', topicIndex: 1 })).toEqual({ topicIndex: 1, firstMessageId: 'b1' });
  });

  it('targets the section that holds a message row', () => {
    expect(getCompactionTargetForRow(topics, { kind: 'message', key: 'message:1:b2', topicIndex: 1, messageId: 'b2' })).toEqual({
      topicIndex: 1,
      sectionIndex: 0,
      firstMessageId: 'b1',
    });
    expect(getCompactionTargetForRow(topics, { kind: 'message', key: 'message:1:b4', topicIndex: 1, messageId: 'b4' })).toEqual({
      topicIndex: 1,
      sectionIndex: 1,
      firstMessageId: 'b3',
    });
  });

  it('targets the topic for a message row of a topic without sections', () => {
    expect(getCompactionTargetForRow(topics, { kind: 'message', key: 'message:0:a2', topicIndex: 0, messageId: 'a2' })).toEqual({
      topicIndex: 0,
      firstMessageId: 'a1',
    });
  });

  it('targets the section of a section recap row and the topic of a topic recap row', () => {
    expect(getCompactionTargetForRow(topics, { kind: 'recap', key: 'recap:1:1', topicIndex: 1, sectionIndex: 1, compaction: record('s1') })).toEqual({
      topicIndex: 1,
      sectionIndex: 1,
      firstMessageId: 'b3',
    });
    expect(getCompactionTargetForRow(topics, { kind: 'recap', key: 'recap:2', topicIndex: 2, compaction: record('t1') })).toEqual({
      topicIndex: 2,
      firstMessageId: 'c1',
    });
  });
});

describe('getUndoCompactionIdForRow', () => {
  it('undoes a compacted topic row or a recap row, and nothing else', () => {
    expect(getUndoCompactionIdForRow(topics, { kind: 'topic', key: 'topic:2', topicIndex: 2 })).toBe('t1');
    expect(getUndoCompactionIdForRow(topics, { kind: 'topic', key: 'topic:0', topicIndex: 0 })).toBeUndefined();
    expect(getUndoCompactionIdForRow(topics, { kind: 'recap', key: 'recap:1:1', topicIndex: 1, sectionIndex: 1, compaction: record('s1') })).toBe('s1');
    expect(getUndoCompactionIdForRow(topics, { kind: 'message', key: 'message:0:a1', topicIndex: 0, messageId: 'a1' })).toBeUndefined();
  });
});

describe('findTopicCompaction', () => {
  it('finds topic and section records, and whether the topic is compacted', () => {
    expect(findTopicCompaction(topics, 't1')).toMatchObject({ topicIndex: 2, topicCompacted: true });
    expect(findTopicCompaction(topics, 't1')?.sectionIndex).toBeUndefined();
    expect(findTopicCompaction(topics, 's1')).toMatchObject({ topicIndex: 1, sectionIndex: 1, topicCompacted: false });
    expect(findTopicCompaction(topics, 's2')).toMatchObject({ topicIndex: 2, sectionIndex: 0, topicCompacted: true });
    expect(findTopicCompaction(topics, 'none')).toBeUndefined();
  });
});

describe('compaction error text', () => {
  it('finds the reason key in a plain refusal and in one with an Electron IPC prefix', () => {
    expect(getCompactionErrorReasonKey('tool-pairs: the stretch would split a tool call')).toBe('taskNavigation.compaction.reasons.tool-pairs');
    expect(getCompactionErrorReasonKey("Error invoking remote method 'compact-topic': Error: current-topic: the current topic")).toBe(
      'taskNavigation.compaction.reasons.current-topic',
    );
    expect(getCompactionErrorReasonKey('network down')).toBeUndefined();
  });

  it('falls back to the failure key with the raw message', () => {
    expect(getCompactionErrorText(new Error('no-model: none set'), 'failed')).toEqual({ key: 'taskNavigation.compaction.reasons.no-model' });
    expect(getCompactionErrorText(new Error('boom'), 'failed')).toEqual({ key: 'failed', values: { error: 'boom' } });
  });

  it('estimates words at six characters each', () => {
    expect(estimateWords(1200)).toBe(200);
    expect(estimateWords(-5)).toBe(0);
  });
});
