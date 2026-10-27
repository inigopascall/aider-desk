import { ContextMessage, TaskTopic, TaskTopicEstimates } from '@common/types';

import { toConversationEntries } from './message-text';

import { estimateMessageTokens } from '@/agent/utils';

type Owner = { topicIndex: number; sectionIndex?: number };
type MessageEstimator = (messages: ContextMessage[]) => number;

/** Estimates live topic occupancy while keeping trailing tool messages with their issuing entry. */
export const estimateTaskTopics = (messages: ContextMessage[], topics: TaskTopic[], estimate: MessageEstimator = estimateMessageTokens): TaskTopicEstimates => {
  const owners = new Map<string, Owner>();
  const excluded = new Set<string>();
  const topicResults = topics.map((topic) => ({
    firstMessageId: topic.messageIds[0] ?? '',
    tokens: null as number | null,
    messageCount: 0,
    sections: (topic.sections ?? []).map((section) => ({
      firstMessageId: section.startMessageId,
      tokens: null as number | null,
      messageCount: 0,
    })),
  }));

  topics.forEach((topic, topicIndex) => {
    const sections = topic.sections ?? [];
    if (topic.compaction) {
      topic.messageIds.forEach((id) => excluded.add(id));
      owners.set(topic.compaction.promptMessageId, { topicIndex });
      owners.set(topic.compaction.summaryMessageId, { topicIndex });
    } else {
      topic.messageIds.forEach((id) => owners.set(id, { topicIndex }));
      sections.forEach((section, sectionIndex) => {
        const start = topic.messageIds.indexOf(section.startMessageId);
        const next = sections[sectionIndex + 1] ? topic.messageIds.indexOf(sections[sectionIndex + 1].startMessageId) : -1;
        if (start < 0) {
          return;
        }
        const ids = topic.messageIds.slice(start, next > start ? next : topic.messageIds.length);
        if (section.compaction) {
          ids.forEach((id) => excluded.add(id));
          owners.set(section.compaction.promptMessageId, { topicIndex, sectionIndex });
          owners.set(section.compaction.summaryMessageId, { topicIndex, sectionIndex });
        } else {
          ids.forEach((id) => owners.set(id, { topicIndex, sectionIndex }));
        }
      });
    }
  });

  const visibleIds = new Set(toConversationEntries(messages, { includeCompactionSummaries: true }).map((entry) => entry.id));
  let current: Owner | undefined;
  const counted = new Set<string>();

  for (const message of messages) {
    const id = message.id;
    const mapped = id ? owners.get(id) : undefined;
    if (mapped) {
      current = mapped;
    } else if (message.role === 'user' || (id && visibleIds.has(id))) {
      // Unknown user/assistant text starts an unowned run; it must not inflate the prior topic.
      current = undefined;
    }
    if (!current || !id || counted.has(id) || excluded.has(id)) {
      continue;
    }
    counted.add(id);
    const result = topicResults[current.topicIndex];
    const tokens = estimate([message]);
    result.tokens = (result.tokens ?? 0) + tokens;
    const section = current.sectionIndex === undefined || !result.sections ? undefined : result.sections[current.sectionIndex];
    if (section) {
      section.tokens = (section.tokens ?? 0) + tokens;
    }
    const isSummary =
      id === topics[current.topicIndex].compaction?.summaryMessageId ||
      id === topics[current.topicIndex].sections?.[current.sectionIndex ?? -1]?.compaction?.summaryMessageId;
    if (visibleIds.has(id) && (!id.startsWith('topic-compaction-') || isSummary)) {
      result.messageCount += 1;
      if (section) {
        section.messageCount += 1;
      }
    }
  }

  return { topics: topicResults };
};

/** Returns the local occupancy estimate used for a compaction preview. */
export const estimateCompactionSourceTokens = (messages: ContextMessage[]): number => estimateMessageTokens(messages);

export type { MessageEstimator };
