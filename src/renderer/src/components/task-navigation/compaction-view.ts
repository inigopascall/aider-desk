import { useMemo } from 'react';
import { Message, ResponseMessage, isTopicCompactionMessageId, isTopicCompactionPromptMessageId } from '@common/types';

import { PendingCompaction, useTaskNavigationStore } from '@/stores/taskNavigationStore';

/** Prefix of the id of the "Compacting…" placeholder that stands in for a stretch of messages while it is compacted. */
export const COMPACTING_PLACEHOLDER_ID_PREFIX = 'task-navigation-compacting-';

export const getCompactingPlaceholderId = (nonce: number): string => `${COMPACTING_PLACEHOLDER_ID_PREFIX}${nonce}`;

export const isCompactingPlaceholderId = (id: string): boolean => typeof id === 'string' && id.startsWith(COMPACTING_PLACEHOLDER_ID_PREFIX);

/** True for the id of a compaction's recap. The marker that goes with it is never shown. */
export const isTopicCompactionRecapId = (id: string): boolean => isTopicCompactionMessageId(id) && !isTopicCompactionPromptMessageId(id);

const createPlaceholder = (nonce: number, first: Message): ResponseMessage => ({
  id: getCompactingPlaceholderId(nonce),
  type: 'response',
  content: '',
  finished: true,
  timestamp: first.timestamp,
});

/**
 * The conversation as shown: compaction markers are dropped, and the stretch of each pending compaction, from its first
 * message up to but not including its end message (or to the end of the list when the end message is null or not in the
 * list), is replaced by one placeholder. Stretches are found before the markers are dropped, so a stretch may end at a
 * marker.
 */
export const applyTopicCompactionView = (messages: Message[], pending: Readonly<Record<string, PendingCompaction>>): Message[] => {
  const stretches = new Map<number, { end: number; nonce: number }>();
  for (const [firstMessageId, entry] of Object.entries(pending)) {
    const start = messages.findIndex((message) => message.id === firstMessageId);
    if (start === -1) {
      continue;
    }
    const endBefore = entry.endBeforeMessageId;
    const found = endBefore ? messages.findIndex((message, index) => index > start && message.id === endBefore) : -1;
    stretches.set(start, { end: found === -1 ? messages.length : found, nonce: entry.nonce });
  }

  if (stretches.size === 0 && !messages.some((message) => isTopicCompactionPromptMessageId(message.id))) {
    return messages;
  }

  const result: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const stretch = stretches.get(index);
    if (stretch) {
      result.push(createPlaceholder(stretch.nonce, messages[index]));
      index = stretch.end - 1;
    } else if (!isTopicCompactionPromptMessageId(messages[index].id)) {
      result.push(messages[index]);
    }
  }
  return result;
};

/** The messages of a conversation as shown, with the pending compactions of the task navigation store applied. */
export const useTopicCompactionView = (messages: Message[]): Message[] => {
  const pendingCompactions = useTaskNavigationStore((state) => state.pendingCompactions);
  return useMemo(() => applyTopicCompactionView(messages, pendingCompactions), [messages, pendingCompactions]);
};
