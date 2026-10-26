import { z } from 'zod';
import { TaskTopic, TopicCompactionInfo } from '@common/types';

import { ConversationEntry, collapseWhitespace, truncateText } from './message-text';

export const MAX_TOPIC_SUMMARY_LENGTH = 160;
export const MAX_TITLE_LENGTH = 80;
export const MAX_PROMPT_CHARACTERS = 24000;
/** A finished topic with fewer messages than this in the conversation is marked sectioned without a model call. */
export const MIN_SECTIONED_TOPIC_MESSAGES = 4;
/** The most messages a section may hold. A topic with more messages than this must be divided into sections. */
export const MAX_SECTION_MESSAGES = 9;
const USER_TEXT_LIMIT = 1200;
const ASSISTANT_TEXT_LIMIT = 600;
const MAX_TOOL_LABELS = 6;
const MAX_LISTED_TOPICS = 40;
const MAX_SECTION_SUMMARY_LENGTH = 120;
const MIN_SHORTENED_TEXT_LENGTH = 40;
const RENDERED_PREFIX_LENGTH = 24;
const MAX_RETRY_ANSWER_LENGTH = 4000;
const UNPARSEABLE_SECTION_ANSWER = 'The answer was not a JSON object of the form { "sections": [{ "start": "m1", "summary": "..." }] }.';

export const SUMMARY_SYSTEM_PROMPT = `You maintain a compact topic map of a conversation between a developer and an AI coding assistant. The map lets the developer find where something was discussed and see at a glance what the conversation has become.

You receive the current topic map (possibly empty), the current title and description, and the messages added since the map was last updated. Each new message has a reference such as m3. The prompt names the current topic: the latest topic, the only one that can still grow.

Respond with a single JSON object and nothing else:
{
  "title": "...",
  "description": "...",
  "topics": [{ "key": "T4", "summary": "..." }],
  "assignments": [{ "ref": "m3", "topic": "T4" }]
}

Write the title, the description and every topic summary in plain, everyday language that someone who is not a programmer could follow. Say what is being done and why, not how it is built: prefer "made the search find older tasks" to "added an FTS5 prefix index". Use a technical term, file name or code identifier only when nothing plainer would do.

Rules:
- "assignments" contains every new message reference exactly once.
- Assign a message to the current topic when it continues that topic. Start a new topic, with the next free key, when the conversation shifts; later messages go to that new topic or to a newer one.
- Never assign a message to an earlier topic: earlier topics are finished. When the conversation returns to an earlier subject, start a new topic.
- "topics" lists only new topics, and the current topic when its summary should change. Leave the current topic out to keep its summary; earlier topics keep theirs.
- A topic summary is one plain line of ten to twenty words, never more than twenty. Describe what was discussed or decided, not who said it.
- Group related consecutive messages: a typical topic spans two to ten messages. Do not create a topic per message.
- "title" names what the conversation is about now, weighted towards its most recent topics: four to ten words, no quotes, no trailing period.
- "description" describes the whole task in thirty to forty words: what it is for, what has been done so far, and where it stands now. Always return it, rewritten to take in the new messages; when nothing important changed, return the current description unchanged.`;

export const SECTION_SYSTEM_PROMPT = `You divide one finished topic of a conversation between a developer and an AI coding assistant into sections, so that a long topic can be scanned. A section is a run of consecutive messages under a one-line title.

You receive the topic's summary and its messages in conversation order. Each message has a reference such as m3.

Respond with a single JSON object and nothing else:
{
  "sections": [{ "start": "m1", "summary": "..." }, { "start": "m6", "summary": "..." }]
}

Rules:
- Split the topic only where it moves through distinct phases, for example investigating, deciding, implementing and verifying. A topic without distinct phases gets an empty list: { "sections": [] }.
- A section runs from its start message up to the next section's start, or to the end of the topic. List the sections in order; the first section starts at m1.
- When you return sections, return at least two.
- A topic of ${MAX_SECTION_MESSAGES + 1} or more messages must be split so that no section holds more than ${MAX_SECTION_MESSAGES} messages.
- A section title is one plain line of five to twelve words that summarises all of the section's messages. Describe what was done or decided, not who said it.
- Write section titles in plain, everyday language that someone who is not a programmer could follow: say what was done and why, not how it was built. Use a technical term, file name or code identifier only when nothing plainer would do.`;

export const SummaryUpdateSchema = z.object({
  title: z.coerce.string().default(''),
  description: z.string().optional().catch(undefined),
  topics: z.array(z.object({ key: z.coerce.string(), summary: z.coerce.string() })).default([]),
  assignments: z.array(z.object({ ref: z.coerce.string(), topic: z.coerce.string() })).default([]),
});

export type SummaryUpdate = z.infer<typeof SummaryUpdateSchema>;

const SectionResponseSchema = z.object({
  sections: z.array(z.object({ start: z.coerce.string().default(''), summary: z.coerce.string().default('') })).default([]),
});

export interface PreparedEntry {
  ref: string;
  entry: ConversationEntry;
  rendered: string;
}

/** A section of a model answer: where it starts among the topic's messages, and its title. */
export interface ParsedSection {
  /** Zero-based position of the section's first message among the messages sent to the model. */
  startIndex: number;
  summary: string;
}

export interface SectionAnswer {
  /** The usable sections: valid, ascending, the first starting at the first message; none when fewer than two remain. */
  sections: ParsedSection[];
  /** Rules the answer breaks, phrased for the model. */
  violations: string[];
}

export type SectionGenerate = (systemPrompt: string, prompt: string) => Promise<string>;

export interface SectioningWarning {
  message: string;
  details: Record<string, unknown>;
}

export interface SectioningResult {
  topics: TaskTopic[];
  /** Topics marked sectioned in this run, with or without sections. */
  done: number;
  /** Topics that received sections. */
  withSections: number;
  /** Model calls made, retries included. */
  calls: number;
  warnings: SectioningWarning[];
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const stripWrapping = (text: string): string => {
  let result = collapseWhitespace(text);
  result = result.replace(/^[-*•\s]+/, '');
  result = result.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  return result.trim();
};

export const cleanTitle = (title: string): string => truncateText(stripWrapping(title).replace(/[.。]+$/, ''), MAX_TITLE_LENGTH);

export const cleanTopicSummary = (summary: string): string => truncateText(stripWrapping(summary), MAX_TOPIC_SUMMARY_LENGTH);

export const MAX_DESCRIPTION_LENGTH = 400;

export const cleanDescription = (description: string | undefined): string => truncateText(stripWrapping(description ?? ''), MAX_DESCRIPTION_LENGTH);

const cleanSectionSummary = (summary: string): string => truncateText(stripWrapping(summary).replace(/[.。]+$/, ''), MAX_SECTION_SUMMARY_LENGTH);

const fallbackTopicSummary = (entry: ConversationEntry): string => truncateText(collapseWhitespace(entry.text), 80);

/** Entries not yet referenced by any topic, in conversation order. */
export const getUnsummarizedEntries = (entries: ConversationEntry[], topics: TaskTopic[]): ConversationEntry[] => {
  const referenced = new Set(topics.flatMap((topic) => topic.messageIds));
  return entries.filter((entry) => !referenced.has(entry.id));
};

/**
 * Flags topics whose messages are all gone from the conversation (compaction, clearing, redo) as detached. A topic stays
 * present while one of its messages is present, or the recap of its own compaction or of one of its sections'
 * compactions is. storedMessageIds are the ids of every stored message, recaps included.
 */
export const markDetachedTopics = (topics: TaskTopic[], entries: ConversationEntry[], storedMessageIds: Iterable<string> = []): TaskTopic[] => {
  const present = new Set([...entries.map((entry) => entry.id), ...storedMessageIds]);
  return topics.map((topic) => {
    const recapIds = [topic.compaction, ...(topic.sections ?? []).map((section) => section.compaction)]
      .filter((info): info is TopicCompactionInfo => info !== undefined)
      .map((info) => info.summaryMessageId);
    const detached = topic.messageIds.length > 0 && !topic.messageIds.some((id) => present.has(id)) && !recapIds.some((id) => present.has(id));
    const { detached: _previous, ...rest } = topic;
    return detached ? { ...rest, detached: true } : rest;
  });
};

/** True when a topic, or one of its sections, is compacted. */
export const hasCompactionRecord = (topic: TaskTopic): boolean => !!topic.compaction || !!topic.sections?.some((section) => section.compaction);

/**
 * Index of the current topic: the last topic that is not detached, or -1. Only the current topic receives new messages.
 * A compacted topic is finished, so when the last topic that is not detached holds a compaction there is no current topic.
 */
export const findCurrentTopicIndex = (topics: TaskTopic[]): number => {
  for (let index = topics.length - 1; index >= 0; index--) {
    if (!topics[index].detached) {
      return hasCompactionRecord(topics[index]) ? -1 : index;
    }
  }
  return -1;
};

/** Renders an entry for a prompt. A text limit shortens the text further and leaves out the tool line. */
export const renderEntry = (entry: ConversationEntry, ref: string, textLimit?: number): string => {
  const limit = Math.min(entry.role === 'user' ? USER_TEXT_LIMIT : ASSISTANT_TEXT_LIMIT, textLimit ?? Infinity);
  const lines = [`[${ref}] ${entry.role.toUpperCase()}: ${truncateText(collapseWhitespace(entry.text), limit)}`];
  if (textLimit === undefined && entry.tools.length > 0) {
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

export const buildSummaryPrompt = (taskName: string, currentTitle: string, topics: TaskTopic[], chunk: PreparedEntry[], currentDescription = ''): string => {
  const lines: string[] = [];
  lines.push(`Task name: ${taskName || '(none)'}`);
  lines.push(`Current title: ${currentTitle || '(none)'}`);
  lines.push(`Current description: ${currentDescription || '(none)'}`);
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

  const currentIndex = findCurrentTopicIndex(topics);
  const currentTopic = currentIndex === -1 ? '' : `the current topic is T${currentIndex + 1}; `;
  lines.push('');
  lines.push(`New messages (${currentTopic}the next free topic key is T${topics.length + 1}):`);
  chunk.forEach((prepared) => lines.push(prepared.rendered));
  return lines.join('\n');
};

/** Parses the outermost JSON object in a model response; undefined when there is none. */
const extractJsonObject = (text: string | undefined | null): unknown => {
  if (!text) {
    return undefined;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

/** Extracts and validates the JSON object from a model response. Returns null when it cannot be parsed. */
export const parseSummaryResponse = (text: string | undefined | null): SummaryUpdate | null => {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return null;
  }
  const parsed = SummaryUpdateSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};

const parseTopicKey = (key: string): number => {
  const match = /^\s*T?\s*(\d+)\s*$/i.exec(key);
  return match ? Number(match[1]) : NaN;
};

/**
 * Applies a model update to the topic map. Only the current topic grows: each message of the chunk joins the current
 * topic or a new topic, never an earlier one, and once a message has started a new topic, later messages cannot go back.
 * An assignment to an earlier topic, or one that is missing or invalid, goes to the topic of the previous message.
 * Summary changes apply to the current topic and to new topics; earlier topics are final.
 */
export const applySummaryUpdate = (topics: TaskTopic[], chunk: PreparedEntry[], update: SummaryUpdate): TaskTopic[] => {
  const result: TaskTopic[] = topics.map((topic) => ({ ...topic, messageIds: [...topic.messageIds] }));
  const existingCount = result.length;
  const currentIndex = findCurrentTopicIndex(result);

  const newSummaries = new Map<number, string>();
  for (const topic of update.topics) {
    const number = parseTopicKey(topic.key);
    const summary = cleanTopicSummary(topic.summary);
    if (!Number.isInteger(number) || number < 1 || !summary) {
      continue;
    }
    if (number > existingCount) {
      newSummaries.set(number, summary);
    } else if (number - 1 === currentIndex) {
      result[currentIndex].summary = summary;
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

  let previousIndex = currentIndex;
  for (const prepared of chunk) {
    const key = assignments.get(prepared.ref.toLowerCase());
    let targetIndex = -1;
    if (key !== undefined) {
      const number = parseTopicKey(key);
      if (currentIndex !== -1 && number - 1 === currentIndex) {
        targetIndex = currentIndex;
      } else if (createdIndexes.has(number)) {
        targetIndex = createdIndexes.get(number)!;
      }
    }
    if (targetIndex === -1 || targetIndex < previousIndex) {
      targetIndex = previousIndex;
    }
    if (targetIndex === -1) {
      targetIndex = result.length;
      result.push({ summary: fallbackTopicSummary(prepared.entry), messageIds: [] });
    }

    result[targetIndex].messageIds.push(prepared.entry.id);
    previousIndex = targetIndex;
  }

  return result.filter((topic, index) => index < existingCount || topic.messageIds.length > 0);
};

// Topic sections

/**
 * Topics to divide into sections after a topic map update: finished topics (not the last live topic, not detached, not
 * sectioned, not compacted) that were the current topic before the update, were created during it, or are pending after a failed
 * attempt (`sectioned: false`). A rebuild passes -1 and 0, so every finished topic qualifies.
 */
export const selectTopicsToSection = (topics: TaskTopic[], previousCurrentIndex: number, previousCount: number): number[] => {
  const lastLiveIndex = findCurrentTopicIndex(topics);
  const indexes: number[] = [];
  topics.forEach((topic, index) => {
    if (index === lastLiveIndex || topic.detached || topic.sectioned === true || topic.compaction) {
      return;
    }
    if (topic.sectioned === false || index === previousCurrentIndex || index >= previousCount) {
      indexes.push(index);
    }
  });
  return indexes;
};

/** Prompt for dividing a topic into sections: its summary and its messages as m1, m2, ...; texts are shortened to fit maxCharacters. */
export const buildSectionPrompt = (summary: string, entries: ConversationEntry[], maxCharacters = MAX_PROMPT_CHARACTERS): string => {
  let rendered = entries.map((entry, index) => renderEntry(entry, `m${index + 1}`));
  const size = rendered.reduce((total, text) => total + text.length + 1, 0);
  if (size > maxCharacters && entries.length > 0) {
    const textLimit = Math.max(MIN_SHORTENED_TEXT_LENGTH, Math.floor(maxCharacters / entries.length) - RENDERED_PREFIX_LENGTH);
    rendered = entries.map((entry, index) => renderEntry(entry, `m${index + 1}`, textLimit));
  }
  return [`Topic: ${summary}`, '', `Messages (m1 to m${entries.length}):`, ...rendered].join('\n');
};

/** The sectioning prompt again, with the previous answer and the rules it broke. */
export const buildSectionRetryPrompt = (prompt: string, previousAnswer: string, violations: string[]): string =>
  [
    prompt,
    '',
    'Your previous answer was:',
    truncateText(previousAnswer.trim(), MAX_RETRY_ANSWER_LENGTH) || '(empty)',
    '',
    'It breaks these rules:',
    ...violations.map((violation) => `- ${violation}`),
    '',
    'Respond again with a single corrected JSON object.',
  ].join('\n');

const parseMessageRef = (ref: string): number => {
  const match = /^\s*\[?\s*m\s*(\d+)\s*\]?\s*$/i.exec(ref);
  return match ? Number(match[1]) - 1 : NaN;
};

/**
 * Parses and validates a sectioning answer for a topic of messageCount messages. Returns null when it cannot be parsed.
 * Invalid entries are dropped, the first start is moved to m1, and fewer than two sections leave none; every broken rule
 * is listed in `violations`.
 */
export const parseSectionResponse = (text: string | undefined | null, messageCount: number): SectionAnswer | null => {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return null;
  }
  const parsed = SectionResponseSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }

  const violations: string[] = [];
  const sections: ParsedSection[] = [];
  for (const item of parsed.data.sections) {
    const startIndex = parseMessageRef(item.start);
    const previous = sections[sections.length - 1];
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= messageCount) {
      violations.push(`"${item.start}" is not one of the message references m1 to m${messageCount}.`);
    } else if (previous && startIndex <= previous.startIndex) {
      violations.push(`Section starts must ascend: m${startIndex + 1} does not come after m${previous.startIndex + 1}.`);
    } else {
      const summary = cleanSectionSummary(item.summary);
      if (summary) {
        sections.push({ startIndex, summary });
      } else {
        violations.push(`The section starting at m${startIndex + 1} has no title.`);
      }
    }
  }

  if (sections.length === 1) {
    violations.push('Only one section was given: return at least two sections, or an empty list.');
    sections.length = 0;
  }
  if (sections.length > 0) {
    sections[0] = { ...sections[0], startIndex: 0 };
  }
  sections.forEach((section, index) => {
    const end = index + 1 < sections.length ? sections[index + 1].startIndex : messageCount;
    const size = end - section.startIndex;
    if (size > MAX_SECTION_MESSAGES) {
      violations.push(`The section starting at m${section.startIndex + 1} holds ${size} messages; no section may hold more than ${MAX_SECTION_MESSAGES}.`);
    }
  });
  if (sections.length === 0 && messageCount > MAX_SECTION_MESSAGES) {
    violations.push(`The topic has ${messageCount} messages, so it must be divided into sections of at most ${MAX_SECTION_MESSAGES} messages.`);
  }

  return { sections, violations };
};

/**
 * Stores sections on a topic and marks it sectioned. Section starts are positions in messageIds (the topic's messages
 * that were sent to the model); the first section starts at the topic's first message. Fewer than two sections store none.
 */
export const applyTopicSections = (topic: TaskTopic, messageIds: string[], sections: ParsedSection[]): TaskTopic => {
  const { sections: _previousSections, sectioned: _previousSectioned, ...rest } = topic;
  const stored = sections
    .filter((section) => section.startIndex >= 0 && section.startIndex < messageIds.length)
    .map((section) => ({ summary: section.summary, startMessageId: messageIds[section.startIndex] }));
  if (stored.length < 2) {
    return { ...rest, sectioned: true };
  }
  stored[0] = { ...stored[0], startMessageId: topic.messageIds[0] ?? stored[0].startMessageId };
  return { ...rest, sections: stored, sectioned: true };
};

/**
 * Divides the given topics into sections: one model call per topic, plus at most one retry when the answer breaks the
 * rules. A topic with fewer than MIN_SECTIONED_TOPIC_MESSAGES messages in the conversation is marked sectioned without
 * a call. When a model call fails, that topic and every topic not yet tried are marked `sectioned: false`, so the next
 * update tries them again.
 */
export const sectionTopics = async (
  topics: TaskTopic[],
  indexes: number[],
  entries: ConversationEntry[],
  generate: SectionGenerate,
  maxCharacters = MAX_PROMPT_CHARACTERS,
): Promise<SectioningResult> => {
  const result = [...topics];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const warnings: SectioningWarning[] = [];
  let done = 0;
  let withSections = 0;
  let calls = 0;

  for (let position = 0; position < indexes.length; position++) {
    const topicIndex = indexes[position];
    const topic = result[topicIndex];
    if (!topic) {
      continue;
    }
    const present = topic.messageIds.map((id) => byId.get(id)).filter((entry): entry is ConversationEntry => entry !== undefined);
    if (present.length < MIN_SECTIONED_TOPIC_MESSAGES) {
      result[topicIndex] = applyTopicSections(topic, [], []);
      done++;
      continue;
    }

    const prompt = buildSectionPrompt(topic.summary, present, maxCharacters);
    let answer: SectionAnswer | null = null;
    try {
      calls++;
      const firstResponse = await generate(SECTION_SYSTEM_PROMPT, prompt);
      answer = parseSectionResponse(firstResponse, present.length);
      if (!answer || answer.violations.length > 0) {
        const violations = answer?.violations ?? [UNPARSEABLE_SECTION_ANSWER];
        calls++;
        const secondResponse = await generate(SECTION_SYSTEM_PROMPT, buildSectionRetryPrompt(prompt, firstResponse, violations));
        answer = parseSectionResponse(secondResponse, present.length) ?? answer;
        if (answer && answer.violations.length > 0) {
          warnings.push({
            message: 'Accepted topic sections that break the sectioning rules',
            details: { topic: topicIndex + 1, violations: answer.violations },
          });
        }
      }
    } catch (error) {
      for (const pendingIndex of indexes.slice(position)) {
        if (result[pendingIndex]) {
          result[pendingIndex] = { ...result[pendingIndex], sectioned: false };
        }
      }
      warnings.push({
        message: 'Topic sectioning failed; it is retried at the next update',
        details: { topic: topicIndex + 1, pending: indexes.length - position, error: describeError(error) },
      });
      break;
    }

    if (!answer) {
      warnings.push({ message: 'Unparseable topic sections; the topic is left without sections', details: { topic: topicIndex + 1 } });
    }
    const updated = applyTopicSections(
      topic,
      present.map((entry) => entry.id),
      answer?.sections ?? [],
    );
    result[topicIndex] = updated;
    done++;
    if (updated.sections) {
      withSections++;
    }
  }

  return { topics: result, done, withSections, calls, warnings };
};

// Task titles

const NEWLINE = String.fromCharCode(10);

export const TITLE_SYSTEM_PROMPT = [
  'You name a conversation between a developer and an AI coding assistant. You receive messages sampled evenly from the whole conversation, from its first message to its last, and possibly its topic map and description.',
  '',
  'Respond with the title only: four to ten words in plain, everyday language that names what the whole conversation is about. Take in every part of it, from the start to the end, not only the most recent part. No quotes, no trailing period, nothing else.',
].join(NEWLINE);

const TITLE_PROMPT_CHARACTERS = 16000;
const TITLE_TEXT_LIMIT = 400;

/**
 * Prompt for a task title that covers the whole conversation: the description, every topic summary, and messages sampled
 * evenly from the first to the last so that a long conversation is represented end to end.
 */
export const buildTitlePrompt = (entries: ConversationEntry[], topics: TaskTopic[], description = '', maxCharacters = TITLE_PROMPT_CHARACTERS): string => {
  const lines: string[] = [];
  if (description) {
    lines.push(`Description: ${description}`, '');
  }
  if (topics.length > 0) {
    lines.push('Topics, first to last:');
    topics.forEach((topic, index) => lines.push(`T${index + 1}: ${topic.summary}`));
    lines.push('');
  }
  const rendered = entries.map((entry) => `${entry.role.toUpperCase()}: ${truncateText(collapseWhitespace(entry.text), TITLE_TEXT_LIMIT)}`);
  if (rendered.length === 0) {
    return lines.join(NEWLINE);
  }
  const budget = Math.max(0, maxCharacters - lines.join(NEWLINE).length);
  const average = rendered.reduce((total, text) => total + text.length + 1, 0) / rendered.length;
  const count = Math.max(1, Math.min(rendered.length, Math.floor(budget / Math.max(1, average))));
  lines.push(`Messages sampled from the whole conversation (${count} of ${rendered.length}, in order):`);
  for (let position = 0; position < count; position++) {
    const index = count === 1 ? 0 : Math.round((position * (rendered.length - 1)) / (count - 1));
    lines.push(rendered[index]);
  }
  return lines.join(NEWLINE);
};
