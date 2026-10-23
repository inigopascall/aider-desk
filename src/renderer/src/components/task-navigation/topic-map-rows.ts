import { TaskTopic } from '@common/types';

export type TopicRow = { kind: 'topic'; key: string; topicIndex: number };
export type SectionRow = { kind: 'section'; key: string; topicIndex: number; sectionIndex: number; summary: string };
export type MessageRow = { kind: 'message'; key: string; topicIndex: number; messageId: string };
export type TopicMapRow = TopicRow | SectionRow | MessageRow;
/** Rows that can be selected; section rows are display-only. */
export type NavigableRow = TopicRow | MessageRow;

export const topicRowKey = (topicIndex: number): string => `topic:${topicIndex}`;

export const sectionRowKey = (topicIndex: number, sectionIndex: number): string => `section:${topicIndex}:${sectionIndex}`;

export const messageRowKey = (topicIndex: number, messageId: string): string => `message:${topicIndex}:${messageId}`;

export const isNavigableRow = (row: TopicMapRow): row is NavigableRow => row.kind !== 'section';

/**
 * Rows of the topic map: each topic and, for an expanded topic, its messages, with each section title as a display-only
 * row directly above the section's first message. A section whose start message is not in the topic is not shown.
 */
export const buildTopicMapRows = (topics: TaskTopic[], expanded: ReadonlySet<number>): TopicMapRow[] => {
  const rows: TopicMapRow[] = [];
  topics.forEach((topic, topicIndex) => {
    rows.push({ kind: 'topic', key: topicRowKey(topicIndex), topicIndex });
    if (!expanded.has(topicIndex)) {
      return;
    }

    const sections = topic.sections ?? [];
    const sectionStarts = new Map<string, number>();
    sections.forEach((section, sectionIndex) => {
      if (!sectionStarts.has(section.startMessageId)) {
        sectionStarts.set(section.startMessageId, sectionIndex);
      }
    });

    for (const messageId of topic.messageIds) {
      const sectionIndex = sectionStarts.get(messageId);
      if (sectionIndex !== undefined) {
        sectionStarts.delete(messageId);
        rows.push({ kind: 'section', key: sectionRowKey(topicIndex, sectionIndex), topicIndex, sectionIndex, summary: sections[sectionIndex].summary });
      }
      rows.push({ kind: 'message', key: messageRowKey(topicIndex, messageId), topicIndex, messageId });
    }
  });
  return rows;
};
