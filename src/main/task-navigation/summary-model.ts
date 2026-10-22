import { z } from 'zod';
import { TaskTopic } from '@common/types';

import { ConversationEntry, collapseWhitespace, truncateText } from './message-text';

export const MAX_TOPIC_SUMMARY_LENGTH = 160;
export const MAX_TITLE_LENGTH = 80;
export const MAX_PROMPT_CHARACTERS = 24000;
const USER_TEXT_LIMIT = 1200;
const ASSISTANT_TEXT_LIMIT = 600;
const MAX_TOOL_LABELS = 6;
const MAX_LISTED_TOPICS = 40;

export const SUMMARY_SYSTEM_PROMPT = `You maintain a compact topic map of a conversation between a developer and an AI coding assistant. The map lets the developer find where something was discussed and see at a glance what the conversation has become.

You receive the current topic map (possibly empty) and the messages added since it was last updated. Each new message has a reference such as m3.

Respond with a single JSON object and nothing else:
{
  "title": "...",
  "topics": [{ "key": "T4", "summary": "..." }],
  "assignments": [{ "ref": "m3", "topic": "T4" }]
}

Rules:
- "assignments" contains every new message reference exactly once.
- Assign a message to the most recent topic when it continues that topic. Start a new topic, with the next free key, when the conversation shifts, even when it returns to an earlier subject.
- Assign a message to an older topic only when it directly continues that topic.
- "topics" lists only topics that are new or whose summary should change. Leave an existing topic out to keep its summary.
- A topic summary is one plain line of ten to twenty words, never more than twenty. Describe what was discussed or decided, not who said it.
- Group related consecutive messages: a typical topic spans two to ten messages. Do not create a topic per message.
- "title" names what the conversation is about now, weighted towards its most recent topics: four to ten words, no quotes, no trailing period.`;

export const SummaryUpdateSchema = z.object({
  title: z.coerce.string().default(''),
  topics: z.array(z.object({ key: z.coerce.string(), summary: z.coerce.string() })).default([]),
  assignments: z.array(z.object({ ref: z.coerce.string(), topic: z.coerce.string() })).default([]),
});

export type SummaryUpdate = z.infer<typeof SummaryUpdateSchema>;

export interface PreparedEntry {
  ref: string;
  entry: ConversationEntry;
  rendered: string;
}

const stripWrapping = (text: string): string => {
  let result = collapseWhitespace(text);
  result = result.replace(/^[-*•\s]+/, '');
  result = result.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  return result.trim();
};

export const cleanTitle = (title: string): string => truncateText(stripWrapping(title).replace(/[.。]+$/, ''), MAX_TITLE_LENGTH);

export const cleanTopicSummary = (summary: string): string => truncateText(stripWrapping(summary), MAX_TOPIC_SUMMARY_LENGTH);

const fallbackTopicSummary = (entry: ConversationEntry): string => truncateText(collapseWhitespace(entry.text), 80);

/** Entries not yet referenced by any topic, in conversation order. */
export const getUnsummarizedEntries = (entries: ConversationEntry[], topics: TaskTopic[]): ConversationEntry[] => {
  const referenced = new Set(topics.flatMap((topic) => topic.messageIds));
  return entries.filter((entry) => !referenced.has(entry.id));
};

/** Flags topics whose messages are all gone from the conversation (compaction, clearing, redo) as detached. */
export const markDetachedTopics = (topics: TaskTopic[], entries: ConversationEntry[]): TaskTopic[] => {
  const present = new Set(entries.map((entry) => entry.id));
  return topics.map((topic) => {
    const detached = topic.messageIds.length > 0 && !topic.messageIds.some((id) => present.has(id));
    const { detached: _previous, ...rest } = topic;
    return detached ? { ...rest, detached: true } : rest;
  });
};

export const renderEntry = (entry: ConversationEntry, ref: string): string => {
  const limit = entry.role === 'user' ? USER_TEXT_LIMIT : ASSISTANT_TEXT_LIMIT;
  const lines = [`[${ref}] ${entry.role.toUpperCase()}: ${truncateText(collapseWhitespace(entry.text), limit)}`];
  if (entry.tools.length > 0) {
    const shown = entry.tools.slice(0, MAX_TOOL_LABELS).join('; ');
    const more = entry.tools.length > MAX_TOOL_LABELS ? ` (+${entry.tools.length - MAX_TOOL_LABELS} more)` : '';
    lines.push(`    tools: ${shown}${more}`);
  }
  return lines.join('\n');
};

/** Splits entries into prompt-sized chunks with references m1, m2, ... numbered across all chunks. */
export const chunkEntries = (entries: ConversationEntry[], maxCharacters = MAX_PROMPT_CHARACTERS): PreparedEntry[][] => {
  const chunks: PreparedEntry[][] = [];
  let current: PreparedEntry[] = [];
  let size = 0;

  entries.forEach((entry, index) => {
    const ref = `m${index + 1}`;
    const rendered = renderEntry(entry, ref);
    if (current.length > 0 && size + rendered.length > maxCharacters) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ ref, entry, rendered });
    size += rendered.length + 1;
  });

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

export const buildSummaryPrompt = (taskName: string, currentTitle: string, topics: TaskTopic[], chunk: PreparedEntry[]): string => {
  const lines: string[] = [];
  lines.push(`Task name: ${taskName || '(none)'}`);
  lines.push(`Current title: ${currentTitle || '(none)'}`);
  lines.push('');
  lines.push('Current topic map:');

  if (topics.length === 0) {
    lines.push('(empty: this is the start of the conversation)');
  } else {
    const firstListed = Math.max(0, topics.length - MAX_LISTED_TOPICS);
    if (firstListed > 0) {
      lines.push(`(${firstListed} earlier topics omitted)`);
    }
    topics.slice(firstListed).forEach((topic, offset) => {
      const key = `T${firstListed + offset + 1}`;
      const status = topic.detached ? ', no longer in the conversation' : '';
      lines.push(`${key} (${topic.messageIds.length} messages${status}): ${topic.summary}`);
    });
  }

  lines.push('');
  lines.push(`New messages (the next free topic key is T${topics.length + 1}):`);
  chunk.forEach((prepared) => lines.push(prepared.rendered));
  return lines.join('\n');
};

/** Extracts and validates the JSON object from a model response. Returns null when it cannot be parsed. */
export const parseSummaryResponse = (text: string | undefined | null): SummaryUpdate | null => {
  if (!text) {
    return null;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed = SummaryUpdateSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const parseTopicKey = (key: string): number => {
  const match = /^\s*T?\s*(\d+)\s*$/i.exec(key);
  return match ? Number(match[1]) : NaN;
};

/**
 * Applies a model update to the topic map: refreshes summaries, appends new topics and attaches each message of
 * the chunk to its assigned topic. Messages without a valid assignment join the topic of the previous message.
 */
export const applySummaryUpdate = (topics: TaskTopic[], chunk: PreparedEntry[], update: SummaryUpdate): TaskTopic[] => {
  const result: TaskTopic[] = topics.map((topic) => ({ ...topic, messageIds: [...topic.messageIds] }));
  const existingCount = result.length;

  const newSummaries = new Map<number, string>();
  for (const topic of update.topics) {
    const number = parseTopicKey(topic.key);
    const summary = cleanTopicSummary(topic.summary);
    if (!Number.isInteger(number) || number < 1 || !summary) {
      continue;
    }
    if (number <= existingCount) {
      result[number - 1].summary = summary;
    } else {
      newSummaries.set(number, summary);
    }
  }

  const createdIndexes = new Map<number, number>();
  [...newSummaries.keys()]
    .sort((first, second) => first - second)
    .forEach((number) => {
      createdIndexes.set(number, result.length);
      result.push({ summary: newSummaries.get(number)!, messageIds: [] });
    });

  const assignments = new Map(update.assignments.map((assignment) => [assignment.ref.trim().toLowerCase(), assignment.topic]));

  let previousIndex = -1;
  for (let index = existingCount - 1; index >= 0; index--) {
    if (!result[index].detached) {
      previousIndex = index;
      break;
    }
  }

  for (const prepared of chunk) {
    const key = assignments.get(prepared.ref.toLowerCase());
    let targetIndex = -1;
    if (key !== undefined) {
      const number = parseTopicKey(key);
      if (Number.isInteger(number) && number >= 1 && number <= existingCount) {
        targetIndex = number - 1;
      } else if (createdIndexes.has(number)) {
        targetIndex = createdIndexes.get(number)!;
      }
    }
    if (targetIndex === -1) {
      targetIndex = previousIndex;
    }
    if (targetIndex === -1) {
      targetIndex = result.length;
      result.push({ summary: fallbackTopicSummary(prepared.entry), messageIds: [] });
    }

    const target = result[targetIndex];
    target.messageIds.push(prepared.entry.id);
    if (target.detached) {
      delete target.detached;
    }
    previousIndex = targetIndex;
  }

  return result.filter((topic, index) => index < existingCount || topic.messageIds.length > 0);
};
