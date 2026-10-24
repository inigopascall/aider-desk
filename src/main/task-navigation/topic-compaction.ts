import {
  ContextAssistantMessage,
  ContextMessage,
  ContextUserMessage,
  FilePart,
  ImagePart,
  ReasoningPart,
  TOPIC_COMPACTION_LEVELS,
  TaskTopic,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  TopicCompactionBlockReason,
  TopicCompactionInfo,
  TopicCompactionPreview,
  TopicCompactionTarget,
  getCompactionPromptMessageId,
  getCompactionSummaryMessageId,
  getCompactionTargetCharacters,
  isTopicCompactionMessageId,
  isTopicCompactionPromptMessageId,
  normalizeTopicCompactionLevel,
} from '@common/types';
import { extractServerNameToolName, extractTextContent } from '@common/utils';

import { ConversationEntry, collapseWhitespace, toConversationEntries, truncateText } from './message-text';
import { findCurrentTopicIndex, hasCompactionRecord } from './summary-model';

/** Longest transcript sent to the model; a longer one is shortened. */
export const COMPACTION_TRANSCRIPT_MAX_CHARACTERS = 160_000;
const TOOL_CALL_LIMIT = 400;
const TOOL_RESULT_LIMIT = 1500;
const SHORTENED_TOOL_RESULT_LIMIT = 300;
const MIN_SHORTENED_TEXT_LENGTH = 80;
const MAX_SHORTENING_ATTEMPTS = 20;
const PRECEDING_TOPIC_COUNT = 5;
const FOLLOWING_TOPIC_COUNT = 3;
const CHARACTERS_PER_WORD = 6;

export const COMPACTION_SYSTEM_PROMPT = `You write the recap that replaces one part of a conversation between a developer and an AI coding assistant. The messages of that part are removed from the thread and your recap is put in their place, so the thread reads: the earlier messages, then your recap, then the later messages. A model that later reads the whole thread must be able to carry on the work from it.

Write the recap as the assistant, looking back on this part of the conversation in the past tense, for example "You asked me to ...", "I found ...", "We decided ...". It must read naturally between the part before it and the part after it.

Keep what matters:
- what the user asked for, and why;
- what was investigated, and what was found;
- the decisions taken, and the reasons for them;
- the files created or changed, by path;
- the commands run, and their outcomes;
- the errors met, and how they were fixed;
- what was left open or still to do.

Preserve exact identifiers, file paths, names, numbers, versions and error messages. Leave out pleasantries, repetition and dead ends that taught nothing.

Write the recap only: no preamble, no closing remarks, and no mention that it is a summary or that you were given a transcript. Markdown is allowed.`;

/** A refusal. Its message starts with the block reason followed by `: `, so the user interface can map it. */
export class TopicCompactionError extends Error {
  readonly reason: TopicCompactionBlockReason;

  constructor(reason: TopicCompactionBlockReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'TopicCompactionError';
    this.reason = reason;
  }
}

const blocked = (reason: TopicCompactionBlockReason, detail: string): TopicCompactionError => new TopicCompactionError(reason, detail);

/** A topic or section that may be compacted, with the original ids of its entries. */
export interface ResolvedCompactionTarget {
  topicIndex: number;
  sectionIndex?: number;
  topic: TaskTopic;
  /** Summary of the topic, or of the section. */
  summary: string;
  /** Original entry ids of the target: the topic's message ids, or the section's run of them. */
  entryIds: string[];
  /** Compactions recorded inside the target: for a topic, those of its sections; none for a section. */
  ownedCompactions: TopicCompactionInfo[];
}

/** The run of stored messages that a compaction replaces. */
export interface CompactionStretch {
  /** Stored index of the first message of the stretch. */
  start: number;
  /** Stored index of the first message after the stretch. */
  end: number;
  messages: ContextMessage[];
  /** Ids of the stored messages of the stretch, in order. */
  messageIds: string[];
  /** The target's entries in the stretch. */
  entries: ConversationEntry[];
  /** Compactions recorded inside the target whose recap is in the stretch. */
  ownedCompactions: TopicCompactionInfo[];
  /** Stored id of the first message after the stretch, or null when the stretch ends the conversation. */
  endBeforeMessageId: string | null;
  /** Characters of user and assistant text in the stretch, recaps of owned compactions included. */
  sourceCharacters: number;
}

export interface TopicCompactionPlan {
  target: TopicCompactionTarget;
  resolved: ResolvedCompactionTarget;
  stretch: CompactionStretch;
}

/** The file kept in the task folder for a compaction: everything needed to put the original messages back. */
export interface TopicCompactionSidecar {
  version: 1;
  id: string;
  createdAt: string;
  level: number;
  instructions?: string;
  model?: string;
  target: TopicCompactionTarget;
  summaryMessageId: string;
  promptMessageId: string;
  messageCount: number;
  sourceCharacters: number;
  summaryCharacters: number;
  originalMessages: ContextMessage[];
}

/** The part of a sidecar that the search index needs. */
export interface CompactionSidecarMessages {
  summaryMessageId: string;
  originalMessages: ContextMessage[];
}

export interface CompactionIndexEntry {
  entry: ConversationEntry;
  /** Id of the outermost recap in the stored conversation that stands in for the entry. */
  scrollTarget: string;
}

export interface CompactionReconcileResult {
  topics: TaskTopic[];
  /** Compactions whose records were dropped because their messages are back; their sidecars can be deleted. */
  deletedCompactionIds: string[];
  changed: boolean;
}

export interface CompactionTranscript {
  text: string;
  shortened: boolean;
}

export interface CompactionPromptInput {
  taskName: string;
  precedingTopics: string[];
  followingTopics: string[];
  /** Summary of the topic; for a section, of the topic the section belongs to. */
  topicSummary: string;
  /** Summary of the section, when the target is a section. */
  sectionSummary?: string;
  transcript: CompactionTranscript;
  targetCharacters: number;
  instructions?: string;
}

export interface CompactionRequest {
  systemPrompt: string;
  prompt: string;
  targetCharacters: number;
  shortened: boolean;
}

export interface ApplyTopicCompactionInput {
  messages: ContextMessage[];
  topics: TaskTopic[];
  target: TopicCompactionTarget;
  compactionId: string;
  recap: string;
  level: number;
  model?: string;
  instructions?: string;
  now?: Date;
  /** Ids of the stretch that was summarised; the compaction fails when the stretch is no longer the same. */
  expectedMessageIds?: string[];
}

export interface ApplyTopicCompactionResult {
  messages: ContextMessage[];
  topics: TaskTopic[];
  info: TopicCompactionInfo;
  sidecar: TopicCompactionSidecar;
}

export interface CompactionRecord {
  topicIndex: number;
  sectionIndex?: number;
  info: TopicCompactionInfo;
}

const isSameIds = (first: string[], second: string[]): boolean => first.length === second.length && first.every((id, index) => id === second[index]);

const withCompaction = <T extends { compaction?: TopicCompactionInfo }>(item: T, info: TopicCompactionInfo | undefined): T => {
  const { compaction: _previous, ...rest } = item;
  return (info ? { ...rest, compaction: info } : rest) as unknown as T;
};

const clearLost = (info: TopicCompactionInfo): TopicCompactionInfo => {
  const { lost: _lost, ...rest } = info;
  return rest;
};

const getMessageId = (message: unknown): string | undefined =>
  message && typeof message === 'object' && typeof (message as { id?: unknown }).id === 'string' ? (message as { id: string }).id : undefined;

const stringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** Ids of a section's messages: from its start up to the next section's start, or to the end of the topic. */
export const getSectionMessageIds = (topic: TaskTopic, sectionIndex: number): string[] => {
  const sections = topic.sections ?? [];
  const section = sections[sectionIndex];
  if (!section) {
    return [];
  }
  const start = topic.messageIds.indexOf(section.startMessageId);
  if (start === -1) {
    return [];
  }
  const next = sections[sectionIndex + 1];
  const nextStart = next ? topic.messageIds.indexOf(next.startMessageId) : -1;
  return topic.messageIds.slice(start, nextStart > start ? nextStart : topic.messageIds.length);
};

/** Checks that a topic or section may be compacted (D3) and returns its entry ids. Throws a TopicCompactionError otherwise. */
export const resolveCompactionTarget = (topics: TaskTopic[], target: TopicCompactionTarget): ResolvedCompactionTarget => {
  const topicIndex = target.topicIndex;
  const topic = Number.isInteger(topicIndex) ? topics[topicIndex] : undefined;
  if (!topic) {
    throw blocked('not-found', 'the topic does not exist');
  }
  if (topic.detached) {
    throw blocked('detached', 'the topic is no longer in the conversation');
  }
  if (topicIndex === findCurrentTopicIndex(topics)) {
    throw blocked('current-topic', 'the current topic is still growing');
  }

  const sectionIndex = target.sectionIndex;
  if (sectionIndex === undefined || sectionIndex === null) {
    if (topic.compaction) {
      throw blocked('already-compacted', 'the topic is already compacted');
    }
    if (topic.messageIds[0] !== target.firstMessageId) {
      throw blocked('not-found', 'the topic changed; reload the topic map');
    }
    return {
      topicIndex,
      topic,
      summary: topic.summary,
      entryIds: [...topic.messageIds],
      ownedCompactions: (topic.sections ?? []).map((section) => section.compaction).filter((info): info is TopicCompactionInfo => info !== undefined),
    };
  }

  if (topic.compaction) {
    throw blocked('inside-compacted-topic', 'the topic of this section is compacted');
  }
  const section = Number.isInteger(sectionIndex) ? topic.sections?.[sectionIndex] : undefined;
  if (!section) {
    throw blocked('not-found', 'the section does not exist');
  }
  if (section.compaction) {
    throw blocked('already-compacted', 'the section is already compacted');
  }
  if (section.startMessageId !== target.firstMessageId) {
    throw blocked('not-found', 'the section changed; reload the topic map');
  }
  const entryIds = getSectionMessageIds(topic, sectionIndex);
  if (entryIds.length === 0) {
    throw blocked('not-found', 'the section has no messages');
  }
  return { topicIndex, sectionIndex, topic, summary: section.summary, entryIds, ownedCompactions: [] };
};

/** Ids of tool calls without their result, and of tool results without their call, in the given messages. */
export const findUnpairedToolCallIds = (messages: ContextMessage[]): string[] => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as Array<{ type?: string; toolCallId?: string }>) {
      if (part?.type === 'tool-call' && part.toolCallId) {
        calls.add(part.toolCallId);
      } else if (part?.type === 'tool-result' && part.toolCallId) {
        results.add(part.toolCallId);
      }
    }
  }
  return [...[...calls].filter((id) => !results.has(id)), ...[...results].filter((id) => !calls.has(id))];
};

/**
 * Finds the stretch of stored messages that a compaction of the target replaces (D2) and validates it. Throws a
 * TopicCompactionError when the target's entries are not one run, nothing follows them, the stretch would split a
 * tool call from its result, or it holds too few messages.
 */
export const locateCompactionStretch = (messages: ContextMessage[], resolved: ResolvedCompactionTarget): CompactionStretch => {
  const entries = toConversationEntries(messages);
  const entryIds = new Set(entries.map((entry) => entry.id));
  const targetIds = new Set(resolved.entryIds);
  const indexById = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.id && !indexById.has(message.id)) {
      indexById.set(message.id, index);
    }
  });

  const targetEntries = entries.filter((entry) => targetIds.has(entry.id));
  const ownedIds = new Set<string>();
  const ownedCompactions: TopicCompactionInfo[] = [];
  for (const info of resolved.ownedCompactions) {
    if (indexById.has(info.summaryMessageId)) {
      ownedCompactions.push(info);
      ownedIds.add(info.summaryMessageId);
      ownedIds.add(info.promptMessageId);
    }
  }

  const contentIndexes = [...targetEntries.map((entry) => entry.id), ...ownedIds]
    .map((id) => indexById.get(id))
    .filter((index): index is number => index !== undefined);
  if (contentIndexes.length === 0) {
    throw blocked('not-found', 'none of its messages are in the conversation');
  }
  const start = Math.min(...contentIndexes);
  const last = Math.max(...contentIndexes);

  const isBoundary = (message: ContextMessage): boolean => entryIds.has(message.id) || (isTopicCompactionMessageId(message.id) && !ownedIds.has(message.id));

  for (let index = start; index <= last; index++) {
    const message = messages[index];
    if (isBoundary(message) && !targetIds.has(message.id)) {
      throw blocked('not-contiguous', 'other messages lie between its messages');
    }
  }

  let end = -1;
  for (let index = last + 1; index < messages.length; index++) {
    if (isBoundary(messages[index])) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw blocked('current-topic', 'nothing follows it yet, so it is not finished');
  }

  const stretchMessages = messages.slice(start, end);
  const unpaired = findUnpairedToolCallIds(stretchMessages);
  if (unpaired.length > 0) {
    throw blocked('tool-pairs', `tool call ${unpaired[0]} and its result would be separated`);
  }
  if (!(targetEntries.length >= 2 || (ownedCompactions.length >= 1 && targetEntries.length >= 1))) {
    throw blocked('too-few-messages', 'it holds too few messages to compact');
  }

  const recapCharacters = ownedCompactions.reduce((total, info) => {
    const index = indexById.get(info.summaryMessageId);
    return total + (index === undefined ? 0 : extractTextContent(messages[index].content).trim().length);
  }, 0);

  return {
    start,
    end,
    messages: stretchMessages,
    messageIds: stretchMessages.map((message) => message.id),
    entries: targetEntries,
    ownedCompactions,
    endBeforeMessageId: messages[end]?.id ?? null,
    sourceCharacters: targetEntries.reduce((total, entry) => total + entry.text.length, 0) + recapCharacters,
  };
};

export const planTopicCompaction = (messages: ContextMessage[], topics: TaskTopic[], target: TopicCompactionTarget): TopicCompactionPlan => {
  const resolved = resolveCompactionTarget(topics, target);
  return { target, resolved, stretch: locateCompactionStretch(messages, resolved) };
};

export const getTargetCharactersByLevel = (sourceCharacters: number): Record<number, number> =>
  Object.fromEntries(TOPIC_COMPACTION_LEVELS.map((level) => [level, getCompactionTargetCharacters(level, sourceCharacters)]));

export const getBlockedPreview = (reason: TopicCompactionBlockReason): TopicCompactionPreview => ({
  compactable: false,
  reason,
  messageCount: 0,
  sourceCharacters: 0,
  targetCharacters: {},
});

/** Preview of a compaction; a refusal is returned as `compactable: false` with its reason, never thrown. */
export const buildTopicCompactionPreview = (messages: ContextMessage[], topics: TaskTopic[], target: TopicCompactionTarget): TopicCompactionPreview => {
  try {
    const { stretch } = planTopicCompaction(messages, topics, target);
    return {
      compactable: true,
      firstMessageId: stretch.messageIds[0],
      endBeforeMessageId: stretch.endBeforeMessageId,
      messageCount: stretch.messages.length,
      sourceCharacters: stretch.sourceCharacters,
      targetCharacters: getTargetCharactersByLevel(stretch.sourceCharacters),
    };
  } catch (error) {
    if (error instanceof TopicCompactionError) {
      return getBlockedPreview(error.reason);
    }
    throw error;
  }
};

export const buildCompactionMarkerText = (targetSummary: string): string => {
  const summary = collapseWhitespace(targetSummary).replace(/[.。]+$/, '') || 'an earlier part of the conversation';
  return `[Compacted part of the conversation: ${summary}. The assistant's recap of it follows.]`;
};

/** The marker and recap messages that stand in for the removed messages; they take the timestamps of the first and last of them. */
export const buildCompactionPair = (
  compactionId: string,
  targetSummary: string,
  recap: string,
  removed: ContextMessage[],
  now: number,
): [ContextUserMessage, ContextAssistantMessage] => {
  const timestamps = removed.map((message) => message.timestamp).filter((timestamp): timestamp is number => typeof timestamp === 'number');
  const first = timestamps[0] ?? now;
  const last = timestamps[timestamps.length - 1] ?? first;
  return [
    { id: getCompactionPromptMessageId(compactionId), role: 'user', content: buildCompactionMarkerText(targetSummary), timestamp: first },
    { id: getCompactionSummaryMessageId(compactionId), role: 'assistant', content: recap, timestamp: last },
  ];
};

/** Replaces the run of messages with the expected ids by the replacement. Throws `not-found` when the run is not there. */
export const replaceMessageRun = (
  messages: ContextMessage[],
  expectedIds: string[],
  replacement: ContextMessage[],
): { messages: ContextMessage[]; removed: ContextMessage[] } => {
  const start = expectedIds.length === 0 ? -1 : messages.findIndex((message) => message.id === expectedIds[0]);
  const run = start === -1 ? [] : messages.slice(start, start + expectedIds.length);
  if (
    run.length === 0 ||
    !isSameIds(
      run.map((message) => message.id),
      expectedIds,
    )
  ) {
    throw blocked('not-found', 'the conversation changed while the recap was being written');
  }
  return { messages: [...messages.slice(0, start), ...replacement, ...messages.slice(start + expectedIds.length)], removed: run };
};

/** Sets or, with undefined, clears the compaction record of a topic or of one of its sections. */
export const setCompactionRecord = (
  topics: TaskTopic[],
  topicIndex: number,
  sectionIndex: number | undefined,
  info: TopicCompactionInfo | undefined,
): TaskTopic[] =>
  topics.map((topic, index) => {
    if (index !== topicIndex) {
      return topic;
    }
    if (sectionIndex === undefined || sectionIndex === null) {
      return withCompaction(topic, info);
    }
    return { ...topic, sections: (topic.sections ?? []).map((section, position) => (position === sectionIndex ? withCompaction(section, info) : section)) };
  });

export const findCompactionRecord = (topics: TaskTopic[], compactionId: string): CompactionRecord | undefined => {
  for (let topicIndex = 0; topicIndex < topics.length; topicIndex++) {
    const topic = topics[topicIndex];
    if (topic.compaction?.id === compactionId) {
      return { topicIndex, info: topic.compaction };
    }
    const sections = topic.sections ?? [];
    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
      const info = sections[sectionIndex].compaction;
      if (info?.id === compactionId) {
        return { topicIndex, sectionIndex, info };
      }
    }
  }
  return undefined;
};

/**
 * Compacts a topic or section: replaces its stretch by the marker and recap pair and records the compaction in the
 * topic map. Returns the new messages and topics, the record and the sidecar holding the removed messages unchanged.
 */
export const applyTopicCompaction = (input: ApplyTopicCompactionInput): ApplyTopicCompactionResult => {
  const plan = planTopicCompaction(input.messages, input.topics, input.target);
  if (input.expectedMessageIds && !isSameIds(plan.stretch.messageIds, input.expectedMessageIds)) {
    throw blocked('not-found', 'the conversation changed while the recap was being written');
  }
  const recap = input.recap.trim();
  if (!recap) {
    throw new Error('The recap is empty');
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const level = normalizeTopicCompactionLevel(input.level);
  const pair = buildCompactionPair(input.compactionId, plan.resolved.summary, recap, plan.stretch.messages, now.getTime());
  const { messages, removed } = replaceMessageRun(input.messages, plan.stretch.messageIds, pair);
  const info: TopicCompactionInfo = {
    id: input.compactionId,
    level,
    compactedAt: createdAt,
    summaryMessageId: pair[1].id,
    promptMessageId: pair[0].id,
    messageCount: removed.length,
    sourceCharacters: plan.stretch.sourceCharacters,
    summaryCharacters: recap.length,
    ...(input.model ? { model: input.model } : {}),
  };
  const instructions = input.instructions?.trim();
  const sidecar: TopicCompactionSidecar = {
    version: 1,
    id: input.compactionId,
    createdAt,
    level,
    ...(instructions ? { instructions } : {}),
    ...(input.model ? { model: input.model } : {}),
    target: { ...input.target },
    summaryMessageId: info.summaryMessageId,
    promptMessageId: info.promptMessageId,
    messageCount: info.messageCount,
    sourceCharacters: info.sourceCharacters,
    summaryCharacters: info.summaryCharacters,
    originalMessages: removed,
  };
  return { messages, topics: setCompactionRecord(input.topics, input.target.topicIndex, input.target.sectionIndex, info), info, sidecar };
};

/** Puts the original messages back in place of a compaction's marker and recap, wherever the pair now sits. */
export const restoreCompactedMessages = (messages: ContextMessage[], compactionId: string, originalMessages: ContextMessage[]): ContextMessage[] => {
  const markerIndex = messages.findIndex((message) => message.id === getCompactionPromptMessageId(compactionId));
  const summaryIndex = messages.findIndex((message) => message.id === getCompactionSummaryMessageId(compactionId));
  if (markerIndex === -1 || summaryIndex !== markerIndex + 1) {
    throw blocked('not-found', 'its recap is not in the conversation');
  }
  return [...messages.slice(0, markerIndex), ...originalMessages, ...messages.slice(summaryIndex + 1)];
};

/** Undoes a compaction: restores its messages and clears its record. A section of a compacted topic is refused. */
export const applyTopicCompactionUndo = (
  messages: ContextMessage[],
  topics: TaskTopic[],
  compactionId: string,
  originalMessages: ContextMessage[],
): { messages: ContextMessage[]; topics: TaskTopic[]; record: CompactionRecord } => {
  const record = findCompactionRecord(topics, compactionId);
  if (!record) {
    throw blocked('not-found', 'the topic map has no such compaction');
  }
  if (record.sectionIndex !== undefined && topics[record.topicIndex].compaction) {
    throw blocked('inside-compacted-topic', 'undo the compaction of its topic first');
  }
  return {
    messages: restoreCompactedMessages(messages, compactionId, originalMessages),
    topics: setCompactionRecord(topics, record.topicIndex, record.sectionIndex, undefined),
    record,
  };
};

/**
 * Brings compaction records in line with the stored conversation (D5): a record whose recap is present loses `lost`; one
 * whose recap is gone but whose original entries are all back is dropped, and its sidecar can be deleted; any other
 * becomes `lost`. The section records of a compacted topic are left alone: their recaps are inside the topic's sidecar.
 */
export const reconcileCompactions = (topics: TaskTopic[], storedMessageIds: Iterable<string>): CompactionReconcileResult => {
  const present = new Set(storedMessageIds);
  const deletedCompactionIds: string[] = [];
  const reconcile = (info: TopicCompactionInfo, entryIds: string[], covered: Set<string>): TopicCompactionInfo | undefined => {
    if (present.has(info.summaryMessageId)) {
      return clearLost(info);
    }
    if (entryIds.length > 0 && entryIds.every((id) => present.has(id) || covered.has(id))) {
      deletedCompactionIds.push(info.id);
      return undefined;
    }
    return { ...info, lost: true };
  };

  const result = topics.map((topic) => {
    let next = topic;
    if (topic.compaction) {
      // Entries of sections compacted before the topic count as present while their recaps are
      const covered = new Set<string>();
      (topic.sections ?? []).forEach((section, index) => {
        if (section.compaction && present.has(section.compaction.summaryMessageId)) {
          getSectionMessageIds(topic, index).forEach((id) => covered.add(id));
        }
      });
      next = withCompaction(topic, reconcile(topic.compaction, topic.messageIds, covered));
      if (next.compaction) {
        return next;
      }
    }
    const owner = next;
    const sections = owner.sections ?? [];
    if (!sections.some((section) => section.compaction)) {
      return owner;
    }
    return {
      ...owner,
      sections: sections.map((section, index) =>
        section.compaction ? withCompaction(section, reconcile(section.compaction, getSectionMessageIds(owner, index), new Set())) : section,
      ),
    };
  });

  return { topics: result, deletedCompactionIds, changed: JSON.stringify(result) !== JSON.stringify(topics) };
};

/**
 * Topics that a rebuild of the topic map keeps unchanged: every topic up to and including the last one that holds a
 * compaction record, on itself or on a section, so that its compactions can still be undone. None when there is none.
 */
export const selectTopicsKeptOnRebuild = (topics: TaskTopic[]): TaskTopic[] => {
  let last = -1;
  topics.forEach((topic, index) => {
    if (hasCompactionRecord(topic)) {
      last = index;
    }
  });
  return topics.slice(0, last + 1);
};

/** Recap ids present before a replacement of the conversation and missing after it (D8). */
export const findRemovedCompactionSummaries = (previous: unknown[], next: unknown[]): string[] => {
  const nextIds = new Set(next.map(getMessageId).filter((id): id is string => id !== undefined));
  return previous
    .map(getMessageId)
    .filter((id): id is string => id !== undefined && isTopicCompactionMessageId(id) && !isTopicCompactionPromptMessageId(id) && !nextIds.has(id));
};

/**
 * Entries of the original messages of compactions in effect, for the search index (D10): a sidecar counts when its recap
 * is in the stored conversation, or in the originals of another counted sidecar. Each entry carries the outermost recap
 * id in the stored conversation as its scroll target.
 */
export const collectCompactionIndexEntries = (messages: ContextMessage[], sidecars: CompactionSidecarMessages[]): CompactionIndexEntry[] => {
  const bySummary = new Map(sidecars.map((sidecar) => [sidecar.summaryMessageId, sidecar]));
  const visited = new Set<string>();
  const result: CompactionIndexEntry[] = [];
  const visit = (summaryMessageId: string, scrollTarget: string): void => {
    const sidecar = bySummary.get(summaryMessageId);
    if (!sidecar || visited.has(summaryMessageId)) {
      return;
    }
    visited.add(summaryMessageId);
    for (const entry of toConversationEntries(sidecar.originalMessages)) {
      result.push({ entry, scrollTarget });
    }
    for (const message of sidecar.originalMessages) {
      if (message.id && bySummary.has(message.id)) {
        visit(message.id, scrollTarget);
      }
    }
  };
  for (const message of messages) {
    if (message.id && bySummary.has(message.id)) {
      visit(message.id, message.id);
    }
  }
  return result;
};

// Transcript and prompt

type TranscriptPart = TextPart | ImagePart | FilePart | ReasoningPart | ToolCallPart | ToolResultPart;

interface TranscriptSegment {
  label: string;
  body: string;
  kind: 'text' | 'call' | 'result' | 'fixed';
}

const getToolLabel = (toolName: string): string => extractServerNameToolName(toolName ?? '')[1] || toolName || 'tool';

const describeToolOutput = (output: unknown): string => {
  if (output === null || output === undefined) {
    return '';
  }
  if (typeof output !== 'object') {
    return String(output);
  }
  const value = (output as { value?: unknown }).value;
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : stringify(item),
      )
      .join('\n');
  }
  return stringify(value);
};

const toTranscriptSegments = (messages: ContextMessage[]): TranscriptSegment[] => {
  const segments: TranscriptSegment[] = [];
  for (const message of messages) {
    if (isTopicCompactionPromptMessageId(message.id)) {
      continue;
    }
    if (isTopicCompactionMessageId(message.id)) {
      segments.push({ label: 'EARLIER RECAP:', body: extractTextContent(message.content).trim(), kind: 'text' });
      continue;
    }
    const label = message.role === 'user' ? 'USER:' : 'ASSISTANT:';
    if (typeof message.content === 'string') {
      if (message.content.trim()) {
        segments.push({ label, body: message.content.trim(), kind: 'text' });
      }
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as TranscriptPart[]) {
      switch (part?.type) {
        case 'text':
          if (part.text?.trim()) {
            segments.push({ label, body: part.text.trim(), kind: 'text' });
          }
          break;
        case 'image':
          segments.push({ label, body: '[image]', kind: 'fixed' });
          break;
        case 'file':
          segments.push({ label, body: part.filename ? `[file: ${part.filename}]` : '[file]', kind: 'fixed' });
          break;
        case 'tool-call':
          segments.push({ label: `TOOL CALL ${getToolLabel(part.toolName)}:`, body: collapseWhitespace(stringify(part.input)), kind: 'call' });
          break;
        case 'tool-result':
          segments.push({ label: `TOOL RESULT ${getToolLabel(part.toolName)}:`, body: describeToolOutput(part.output).trim(), kind: 'result' });
          break;
        default:
          break;
      }
    }
  }
  return segments;
};

/**
 * Renders a stretch as a transcript for the compaction prompt (D9): user and assistant text in full, tool calls cut to
 * 400 characters, tool results to 1,500, images as [image], recaps of earlier compactions as EARLIER RECAP. A
 * transcript longer than maxCharacters gets tool results cut to 300 characters, then texts shortened proportionally.
 */
export const renderCompactionTranscript = (messages: ContextMessage[], maxCharacters = COMPACTION_TRANSCRIPT_MAX_CHARACTERS): CompactionTranscript => {
  const segments = toTranscriptSegments(messages);
  const render = (resultLimit: number, textRatio: number): string =>
    segments
      .map((segment) => {
        let limit = Infinity;
        if (segment.kind === 'call') {
          limit = TOOL_CALL_LIMIT;
        } else if (segment.kind === 'result') {
          limit = resultLimit;
        } else if (segment.kind === 'text' && textRatio < 1) {
          limit = Math.max(MIN_SHORTENED_TEXT_LENGTH, Math.floor(segment.body.length * textRatio));
        }
        return `${segment.label} ${truncateText(segment.body, limit)}`;
      })
      .join('\n\n');

  const full = render(TOOL_RESULT_LIMIT, 1);
  if (full.length <= maxCharacters) {
    return { text: full, shortened: false };
  }
  const reduced = render(SHORTENED_TOOL_RESULT_LIMIT, 1);
  if (reduced.length <= maxCharacters) {
    return { text: reduced, shortened: true };
  }

  const textTotal = segments.filter((segment) => segment.kind === 'text').reduce((total, segment) => total + segment.body.length, 0);
  let ratio = textTotal > 0 ? Math.max(0, (textTotal - (reduced.length - maxCharacters)) / textTotal) : 0;
  let text = render(SHORTENED_TOOL_RESULT_LIMIT, ratio);
  for (let attempt = 0; attempt < MAX_SHORTENING_ATTEMPTS && text.length > maxCharacters && ratio > 0; attempt++) {
    ratio *= 0.8;
    text = render(SHORTENED_TOOL_RESULT_LIMIT, ratio);
  }
  return { text, shortened: true };
};

/** Summaries of up to five live topics before the topic and three after it. */
export const getSurroundingTopicSummaries = (topics: TaskTopic[], topicIndex: number): { preceding: string[]; following: string[] } => {
  const live = (topic: TaskTopic): boolean => !topic.detached && !!topic.summary;
  return {
    preceding: topics
      .slice(0, Math.max(0, topicIndex))
      .filter(live)
      .slice(-PRECEDING_TOPIC_COUNT)
      .map((topic) => topic.summary),
    following: topics
      .slice(topicIndex + 1)
      .filter(live)
      .slice(0, FOLLOWING_TOPIC_COUNT)
      .map((topic) => topic.summary),
  };
};

export const buildCompactionPrompt = (input: CompactionPromptInput): string => {
  const listTopics = (summaries: string[]): string[] => (summaries.length > 0 ? summaries.map((summary) => `- ${summary}`) : ['(none)']);
  const lines: string[] = [`Task: ${input.taskName || '(no name)'}`, '', 'Topics before this part:', ...listTopics(input.precedingTopics), ''];
  lines.push(input.sectionSummary ? `This part: a section of the topic "${input.topicSummary}": ${input.sectionSummary}` : `This part: ${input.topicSummary}`);
  lines.push('', 'Topics after this part:', ...listTopics(input.followingTopics), '', 'Transcript of this part:');
  if (input.transcript.shortened) {
    lines.push('(The transcript was shortened to fit: long tool results and messages are cut.)');
  }
  lines.push(
    input.transcript.text,
    '',
    `Write the recap of this part in about ${Math.max(20, Math.round(input.targetCharacters / CHARACTERS_PER_WORD))} words.`,
  );
  const instructions = input.instructions?.trim();
  if (instructions) {
    lines.push('', 'Additional instructions from the user (follow them):', instructions);
  }
  return lines.join('\n');
};

/** The system prompt and prompt of the model call that writes the recap of a planned compaction. */
export const buildCompactionRequest = (
  taskName: string,
  topics: TaskTopic[],
  plan: TopicCompactionPlan,
  level: number,
  instructions?: string,
): CompactionRequest => {
  const { resolved, stretch } = plan;
  const transcript = renderCompactionTranscript(stretch.messages);
  const targetCharacters = getCompactionTargetCharacters(level, stretch.sourceCharacters);
  const { preceding, following } = getSurroundingTopicSummaries(topics, resolved.topicIndex);
  const prompt = buildCompactionPrompt({
    taskName,
    precedingTopics: preceding,
    followingTopics: following,
    topicSummary: resolved.topic.summary,
    sectionSummary: resolved.sectionIndex === undefined ? undefined : resolved.summary,
    transcript,
    targetCharacters,
    instructions,
  });
  return { systemPrompt: COMPACTION_SYSTEM_PROMPT, prompt, targetCharacters, shortened: transcript.shortened };
};

/** Trims the model's recap and strips a single code fence wrapping all of it. An empty result means the model failed. */
export const cleanCompactionOutput = (text: string | null | undefined): string => {
  const trimmed = (text ?? '').trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
};
