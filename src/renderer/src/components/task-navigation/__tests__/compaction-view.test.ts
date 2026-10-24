import { describe, expect, it } from 'vitest';
import { Message } from '@common/types';

import { COMPACTING_PLACEHOLDER_ID_PREFIX, applyTopicCompactionView, isCompactingPlaceholderId, isTopicCompactionRecapId } from '../compaction-view';

const message = (id: string, type: Message['type'] = 'user'): Message => ({ id, type, content: id });
const ids = (messages: Message[]): string[] => messages.map((item) => item.id);

const MARKER = 'topic-compaction-abc-prompt';
const RECAP = 'topic-compaction-abc';

describe('applyTopicCompactionView', () => {
  it('drops compaction markers and keeps recaps', () => {
    const messages = [message('a'), message(MARKER), message(RECAP, 'response'), message('b')];

    expect(ids(applyTopicCompactionView(messages, {}))).toEqual(['a', RECAP, 'b']);
  });

  it('returns the same list when there is nothing to change', () => {
    const messages = [message('a'), message('b')];

    expect(applyTopicCompactionView(messages, {})).toBe(messages);
  });

  it('replaces a pending stretch with exactly one finished, empty placeholder', () => {
    const messages = [message('a'), message('b'), message('c', 'response'), message('d'), message('e')];

    const result = applyTopicCompactionView(messages, { b: { endBeforeMessageId: 'd', nonce: 7 } });

    expect(ids(result)).toEqual(['a', `${COMPACTING_PLACEHOLDER_ID_PREFIX}7`, 'd', 'e']);
    expect(result[1]).toMatchObject({ type: 'response', content: '', finished: true });
  });

  it('runs a stretch to the end of the list when its end is null or absent', () => {
    const messages = [message('a'), message('b'), message('c')];

    expect(ids(applyTopicCompactionView(messages, { b: { endBeforeMessageId: null, nonce: 1 } }))).toEqual(['a', `${COMPACTING_PLACEHOLDER_ID_PREFIX}1`]);
    expect(ids(applyTopicCompactionView(messages, { b: { endBeforeMessageId: 'missing', nonce: 2 } }))).toEqual(['a', `${COMPACTING_PLACEHOLDER_ID_PREFIX}2`]);
  });

  it('ends a stretch at a marker, which is then dropped', () => {
    const messages = [message('a'), message('b'), message(MARKER), message(RECAP, 'response'), message('c')];

    expect(ids(applyTopicCompactionView(messages, { a: { endBeforeMessageId: MARKER, nonce: 3 } }))).toEqual([
      `${COMPACTING_PLACEHOLDER_ID_PREFIX}3`,
      RECAP,
      'c',
    ]);
  });

  it('replaces two pending stretches with two placeholders with different ids', () => {
    const messages = [message('a'), message('b'), message('c'), message('d'), message('e')];

    const result = applyTopicCompactionView(messages, {
      a: { endBeforeMessageId: 'c', nonce: 4 },
      d: { endBeforeMessageId: null, nonce: 5 },
    });

    expect(ids(result)).toEqual([`${COMPACTING_PLACEHOLDER_ID_PREFIX}4`, 'c', `${COMPACTING_PLACEHOLDER_ID_PREFIX}5`]);
    expect(new Set(ids(result)).size).toBe(result.length);
  });

  it('changes nothing when the first message of a pending stretch is not in the list', () => {
    const messages = [message('a'), message('b')];

    expect(applyTopicCompactionView(messages, { missing: { endBeforeMessageId: null, nonce: 6 } })).toBe(messages);
  });
});

describe('message id helpers', () => {
  it('tells placeholders, recaps and markers apart', () => {
    expect(isCompactingPlaceholderId(`${COMPACTING_PLACEHOLDER_ID_PREFIX}1`)).toBe(true);
    expect(isCompactingPlaceholderId(RECAP)).toBe(false);
    expect(isTopicCompactionRecapId(RECAP)).toBe(true);
    expect(isTopicCompactionRecapId(MARKER)).toBe(false);
    expect(isTopicCompactionRecapId(`${COMPACTING_PLACEHOLDER_ID_PREFIX}1`)).toBe(false);
  });
});
