import { TaskTopic, TopicCompactionInfo } from '@common/types';

export type TopicRow = { kind: 'topic'; key: string; topicIndex: number };
export type SectionRow = { kind: 'section'; key: string; topicIndex: number; sectionIndex: number; summary: string };
export type MessageRow = { kind: 'message'; key: string; topicIndex: number; messageId: string };
/** One row in place of the messages of a compacted topic or section; a lost recap can't be opened. */
export type RecapRow = { kind: 'recap'; key: string; topicIndex: number; sectionIndex?: number; compaction: TopicCompactionInfo };
export type TopicMapRow = TopicRow | SectionRow | MessageRow | RecapRow;
/** Rows that can be selected; section rows and the rows of lost recaps are display-only. */
export type NavigableRow = TopicRow | MessageRow | RecapRow;

export const topicRowKey = (topicIndex: number): string => `topic:${topicIndex}`;

export const sectionRowKey = (topicIndex: number, sectionIndex: number): string => `section:${topicIndex}:${sectionIndex}`;

export const messageRowKey = (topicIndex: number, messageId: string): string => `message:${topicIndex}:${messageId}`;

export const recapRowKey = (topicIndex: number, sectionIndex?: number): string =>
  sectionIndex === undefined ? `recap:${topicIndex}` : `recap:${topicIndex}:${sectionIndex}`;

export const isNavigableRow = (row: TopicMapRow): row is NavigableRow => row.kind !== 'section' && !(row.kind === 'recap' && row.compaction.lost);

/**
 * Rows of the topic map: each topic and, for an expanded topic, its messages, with each section title as a display-only
 * row directly above the section's first message. A section whose start message is not in the topic is not shown. A
 * compacted topic shows one recap row in place of its messages; a compacted section shows its title and one recap row.
 */
export const buildTopicMapRows = (topics: TaskTopic[], expanded: ReadonlySet<number>): TopicMapRow[] => {
  const rows: TopicMapRow[] = [];
  topics.forEach((topic, topicIndex) => {
    rows.push({ kind: 'topic', key: topicRowKey(topicIndex), topicIndex });
    if (!expanded.has(topicIndex)) {
      return;
    }
    if (topic.compaction) {
      rows.push({ kind: 'recap', key: recapRowKey(topicIndex), topicIndex, compaction: topic.compaction });
      return;
    }

    const sections = topic.sections ?? [];
    const sectionStarts = new Map<string, number>();
    sections.forEach((section, sectionIndex) => {
      if (!sectionStarts.has(section.startMessageId)) {
        sectionStarts.set(section.startMessageId, sectionIndex);
      }
    });

    let insideCompactedSection = false;
    for (const messageId of topic.messageIds) {
      const sectionIndex = sectionStarts.get(messageId);
      if (sectionIndex !== undefined) {
        sectionStarts.delete(messageId);
        const section = sections[sectionIndex];
        rows.push({ kind: 'section', key: sectionRowKey(topicIndex, sectionIndex), topicIndex, sectionIndex, summary: section.summary });
        insideCompactedSection = !!section.compaction;
        if (section.compaction) {
          rows.push({ kind: 'recap', key: recapRowKey(topicIndex, sectionIndex), topicIndex, sectionIndex, compaction: section.compaction });
        }
      }
      if (!insideCompactedSection) {
        rows.push({ kind: 'message', key: messageRowKey(topicIndex, messageId), topicIndex, messageId });
      }
    }
  });
  return rows;
};
