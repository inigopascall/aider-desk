import { TaskTopic, TopicCompactionBlockReason, TopicCompactionInfo, TopicCompactionTarget, getTopicCompactionBlockReason } from '@common/types';

import { NavigableRow, RecapRow } from './topic-map-rows';

import type { PendingCompaction } from '@/stores/taskNavigationStore';

/** Rows of the topic map that the compaction keys act on. */
export type CompactionRow = NavigableRow | RecapRow;

export type FoundTopicCompaction = {
  compaction: TopicCompactionInfo;
  topicIndex: number;
  /** Set when the compaction is of a section. */
  sectionIndex?: number;
  /** The topic that holds the compaction is itself compacted. */
  topicCompacted: boolean;
};

/** A translation key and its values. */
export type TranslatedText = {
  key: string;
  values?: Record<string, unknown>;
};

/** The current topic: the last topic that is neither detached nor compacted, or -1. It can't be compacted. */
export const getCurrentTopicIndex = (topics: TaskTopic[]): number => {
  for (let index = topics.length - 1; index >= 0; index--) {
    if (!topics[index].detached && !topics[index].compaction) {
      return index;
    }
  }
  return -1;
};

/**
 * Whether a topic, or one of its sections, looks compactable from the client: a finished topic that is neither detached
 * nor compacted and, for a section, a section that is not compacted. The engine's preview has the final word.
 */
export const isCompactableFromClient = (topics: TaskTopic[], topicIndex: number, sectionIndex?: number): boolean => {
  const topic = topics[topicIndex];
  if (!topic || topic.detached || topic.compaction || topicIndex === getCurrentTopicIndex(topics)) {
    return false;
  }
  if (sectionIndex === undefined) {
    return topic.messageIds.length > 0;
  }
  const section = topic.sections?.[sectionIndex];
  return !!section && !section.compaction;
};

/** Index of the section of a topic that holds a message; undefined when the topic has no sections or lacks the message. */
export const getSectionIndexOfMessage = (topic: TaskTopic, messageId: string): number | undefined => {
  const position = topic.messageIds.indexOf(messageId);
  if (position === -1) {
    return undefined;
  }
  let result: number | undefined;
  (topic.sections ?? []).forEach((section, sectionIndex) => {
    const start = topic.messageIds.indexOf(section.startMessageId);
    if (start !== -1 && start <= position) {
      result = sectionIndex;
    }
  });
  return result;
};

/** The engine target of a topic, or of one of its sections. */
export const getTopicCompactionTarget = (topics: TaskTopic[], topicIndex: number, sectionIndex?: number): TopicCompactionTarget | undefined => {
  const topic = topics[topicIndex];
  if (!topic) {
    return undefined;
  }
  if (sectionIndex === undefined) {
    const firstMessageId = topic.messageIds[0];
    return firstMessageId ? { topicIndex, firstMessageId } : undefined;
  }
  const section = topic.sections?.[sectionIndex];
  return section ? { topicIndex, sectionIndex, firstMessageId: section.startMessageId } : undefined;
};

/**
 * The target that `c` compacts for a row: a topic row compacts its topic; a message row or a recap row compacts the
 * section that holds it, or the topic when there is no such section. The recap of a whole topic targets the topic.
 */
export const getCompactionTargetForRow = (topics: TaskTopic[], row: CompactionRow): TopicCompactionTarget | undefined => {
  const topic = topics[row.topicIndex];
  if (!topic) {
    return undefined;
  }
  if (row.kind === 'topic') {
    return getTopicCompactionTarget(topics, row.topicIndex);
  }
  const sectionIndex = row.kind === 'message' ? getSectionIndexOfMessage(topic, row.messageId) : row.sectionIndex;
  const sectionTarget = sectionIndex === undefined ? undefined : getTopicCompactionTarget(topics, row.topicIndex, sectionIndex);
  return sectionTarget ?? getTopicCompactionTarget(topics, row.topicIndex);
};

/** The compaction that `u` undoes for a row: that of a compacted topic row, or that of a recap row. */
export const getUndoCompactionIdForRow = (topics: TaskTopic[], row: CompactionRow): string | undefined => {
  if (row.kind === 'topic') {
    return topics[row.topicIndex]?.compaction?.id;
  }
  if (row.kind === 'recap') {
    return row.compaction.id;
  }
  return undefined;
};

/** Finds a compaction record of a topic or a section by its id. */
export const findTopicCompaction = (topics: TaskTopic[], compactionId: string): FoundTopicCompaction | undefined => {
  for (let topicIndex = 0; topicIndex < topics.length; topicIndex++) {
    const topic = topics[topicIndex];
    if (topic.compaction?.id === compactionId) {
      return { compaction: topic.compaction, topicIndex, topicCompacted: true };
    }
    const sections = topic.sections ?? [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const compaction = sections[sectionIndex].compaction;
      if (compaction?.id === compactionId) {
        return { compaction, topicIndex, sectionIndex, topicCompacted: !!topic.compaction };
      }
    }
  }
  return undefined;
};

export const getCompactionReasonKey = (reason: TopicCompactionBlockReason): string => `taskNavigation.compaction.reasons.${reason}`;

/** Translation key of the refusal reason in an error message, also when Electron's IPC prefixed it; undefined for other errors. */
export const getCompactionErrorReasonKey = (errorMessage: string): string | undefined => {
  const reason = getTopicCompactionBlockReason(errorMessage);
  return reason ? getCompactionReasonKey(reason) : undefined;
};

/** Text of a failed compaction call: the refusal reason, or the failure message with the raw error. */
export const getCompactionErrorText = (error: unknown, failedKey: string): TranslatedText => {
  const message = error instanceof Error ? error.message : String(error);
  const reasonKey = getCompactionErrorReasonKey(message);
  return reasonKey ? { key: reasonKey } : { key: failedKey, values: { error: message } };
};

/** Formats a token estimate compactly, using an em dash when the estimate is unknown. */
export const formatTopicTokenCount = (tokens: number | null | undefined): string => {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
    return '—';
  }
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  return `${Math.round((tokens / 1000) * 10) / 10}k`;
};

/** Finds whether a pending compaction targets the current topic or overlaps its section. */
export const getPendingTargetState = (
  pending: Record<string, PendingCompaction>,
  baseDir: string,
  taskId: string,
  topics: TaskTopic[],
  topicIndex: number,
  sectionIndex?: number,
): 'active' | 'overlap' | undefined => {
  const topic = topics[topicIndex];
  if (!topic) {
    return undefined;
  }
  const currentFirst = topic.messageIds[0];
  const currentSection = sectionIndex === undefined ? undefined : topic.sections?.[sectionIndex];
  if (!currentFirst || (sectionIndex !== undefined && !currentSection)) {
    return undefined;
  }
  for (const item of Object.values(pending)) {
    if (item.baseDir !== baseDir || item.taskId !== taskId) {
      continue;
    }
    const target = item.target;
    const pendingSectionStart = target?.sectionIndex === undefined ? undefined : target.firstMessageId;
    const pendingTopicFirst = item.topicFirstMessageId ?? target?.firstMessageId;
    const sectionMatchesCurrent = pendingSectionStart === currentSection?.startMessageId;
    if (pendingTopicFirst !== currentFirst && !(pendingSectionStart !== undefined && sectionMatchesCurrent)) {
      continue;
    }
    if (sectionIndex === undefined) {
      if (pendingSectionStart === undefined) {
        return 'active';
      }
      return 'overlap';
    }
    if (pendingSectionStart === currentSection?.startMessageId) {
      return 'active';
    }
    if (pendingSectionStart === undefined) {
      return 'overlap';
    }
  }
  return undefined;
};

/** Rough word count of a length in characters, at six characters a word. */
export const estimateWords = (characters: number): number => Math.round(Math.max(0, characters) / 6);
