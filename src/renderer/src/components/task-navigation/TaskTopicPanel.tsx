import { useCallback, useMemo, useState } from 'react';
import {
  TASK_NAVIGATION_METADATA_KEYS,
  TaskData,
  TaskTopic,
  getTaskKey,
  getTaskSummary,
  isResponseMessage,
  isTaskNameLocked,
  isUserMessage,
} from '@common/types';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { IoMdClose } from 'react-icons/io';
import { MdKeyboardArrowDown, MdKeyboardArrowRight, MdOutlineRefresh } from 'react-icons/md';
import { VscLock } from 'react-icons/vsc';

import { useTaskNavigationSettings } from './hooks';
import { formatRelativeTime } from './utils';

import { IconButton } from '@/components/common/IconButton';
import { extractFirstLine, truncateTitle } from '@/components/message/outline';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useTaskMessages } from '@/stores/taskStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';
import { showErrorNotification } from '@/utils/notifications';

const MESSAGE_LABEL_LENGTH = 90;

type MessageLabel = {
  role: 'user' | 'assistant';
  text: string;
};

type Props = {
  task: TaskData;
  onScrollToMessage: (messageId: string) => void;
};

/** Topic map of the task: an overlay on the right of the conversation, toggled from the task bar. */
export const TaskTopicPanel = ({ task, onScrollToMessage }: Props) => {
  const topicPanelOpen = useTaskNavigationStore((state) => state.topicPanelOpen);
  return topicPanelOpen ? <TaskTopicPanelContent task={task} onScrollToMessage={onScrollToMessage} /> : null;
};

const TaskTopicPanelContent = ({ task, onScrollToMessage }: Props) => {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const settings = useTaskNavigationSettings();
  const setTopicPanelOpen = useTaskNavigationStore((state) => state.setTopicPanelOpen);
  const messages = useTaskMessages(task.id);
  const [expandedTopics, setExpandedTopics] = useState<Set<number>>(new Set());
  const [regenerating, setRegenerating] = useState(false);

  const summary = getTaskSummary(task);
  const topics = summary?.topics ?? [];
  const taskKey = getTaskKey(task, settings);
  const nameLocked = isTaskNameLocked(task);

  const messageLabels = useMemo(() => {
    const labels = new Map<string, MessageLabel>();
    for (const message of messages) {
      if (isUserMessage(message)) {
        labels.set(message.id, { role: 'user', text: truncateTitle(extractFirstLine(message.content), MESSAGE_LABEL_LENGTH) });
      } else if (isResponseMessage(message) && message.content.trim()) {
        labels.set(message.id, { role: 'assistant', text: truncateTitle(extractFirstLine(message.content), MESSAGE_LABEL_LENGTH) });
      }
    }
    return labels;
  }, [messages]);

  const toggleTopic = useCallback((index: number) => {
    setExpandedTopics((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const scrollToTopic = useCallback(
    (topic: TaskTopic) => {
      const target = topic.messageIds.find((messageId) => messageLabels.has(messageId)) ?? topic.messageIds[0];
      if (target) {
        onScrollToMessage(target);
      }
    },
    [messageLabels, onScrollToMessage],
  );

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      await api.regenerateTaskSummary(task.baseDir, task.id);
    } catch (error) {
      showErrorNotification(t('taskNavigation.topicMap.regenerateFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setRegenerating(false);
    }
  }, [api, task.baseDir, task.id, t]);

  const handleUnlockTitle = useCallback(() => {
    void api.updateTask(task.baseDir, task.id, {
      metadata: { ...(task.metadata ?? {}), [TASK_NAVIGATION_METADATA_KEYS.nameLocked]: false },
    });
  }, [api, task.baseDir, task.id, task.metadata]);

  const getRoleLabel = (label: MessageLabel | undefined) => {
    if (!label) {
      return '';
    }
    return label.role === 'user' ? t('taskNavigation.you') : t('taskNavigation.assistant');
  };

  return (
    <div className="absolute top-0 right-0 bottom-0 z-20 w-[340px] max-w-full flex flex-col bg-bg-primary-light border-l border-border-default shadow-xl">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default">
        <span className="text-xs font-semibold text-text-primary">{t('taskNavigation.topicMap.title')}</span>
        {taskKey && <span className="text-2xs font-mono text-text-muted">{taskKey}</span>}
        <div className="flex-1" />
        <IconButton
          icon={<MdOutlineRefresh className={clsx('w-4 h-4', regenerating && 'animate-spin')} />}
          onClick={() => void handleRegenerate()}
          disabled={regenerating}
          tooltip={t('taskNavigation.topicMap.regenerate')}
          className="p-1 rounded-md hover:bg-bg-tertiary"
        />
        <IconButton
          icon={<IoMdClose className="w-4 h-4" />}
          onClick={() => setTopicPanelOpen(false)}
          tooltip={t('taskNavigation.topicMap.close')}
          className="p-1 rounded-md hover:bg-bg-tertiary"
        />
      </div>

      {summary?.title && (
        <div className="px-3 py-2 border-b border-border-default">
          <div className="flex items-start gap-1.5">
            <div className="flex-1 text-xs font-medium text-text-primary">{summary.title}</div>
            {nameLocked && (
              <Tooltip content={t('taskNavigation.topicMap.unlockTitle')}>
                <button type="button" className="text-text-muted hover:text-text-primary" onClick={handleUnlockTitle}>
                  <VscLock className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
          {nameLocked && <div className="mt-1 text-2xs text-text-muted">{t('taskNavigation.topicMap.titleLocked')}</div>}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 py-2">
        {topics.length === 0 ? (
          <div className="px-3 py-4 flex flex-col items-start gap-3">
            <div className="text-xs text-text-muted">{t('taskNavigation.topicMap.empty')}</div>
            <button
              type="button"
              disabled={regenerating}
              onClick={() => void handleRegenerate()}
              className="text-xs px-2 py-1 rounded border border-border-default text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
            >
              {t('taskNavigation.topicMap.generate')}
            </button>
          </div>
        ) : (
          <ol className="flex flex-col">
            {topics.map((topic, index) => {
              const expanded = expandedTopics.has(index);
              return (
                <li key={index} className="flex flex-col">
                  <div
                    className={clsx('flex items-start gap-1 px-2 py-1.5 rounded-md', topic.detached ? 'opacity-60' : 'cursor-pointer hover:bg-bg-tertiary')}
                    onClick={topic.detached ? undefined : () => scrollToTopic(topic)}
                  >
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 text-text-muted hover:text-text-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleTopic(index);
                      }}
                    >
                      {expanded ? <MdKeyboardArrowDown className="w-4 h-4" /> : <MdKeyboardArrowRight className="w-4 h-4" />}
                    </button>
                    <span className="mt-0.5 w-5 shrink-0 text-right text-2xs text-text-muted">{`${index + 1}.`}</span>
                    <span className="flex-1 text-xs text-text-secondary">{topic.summary}</span>
                    <span className="mt-0.5 shrink-0 text-2xs text-text-muted">
                      {topic.detached ? t('taskNavigation.topicMap.compacted') : t('taskNavigation.messageCount', { count: topic.messageIds.length })}
                    </span>
                  </div>
                  {expanded && (
                    <ul className="flex flex-col ml-8 mb-1 border-l border-border-default">
                      {topic.messageIds.map((messageId) => {
                        const label = messageLabels.get(messageId);
                        return (
                          <li
                            key={messageId}
                            className={clsx(
                              'flex gap-1.5 px-2 py-1 text-2xs rounded-r-md',
                              label ? 'cursor-pointer text-text-secondary hover:bg-bg-tertiary' : 'text-text-muted',
                            )}
                            onClick={label ? () => onScrollToMessage(messageId) : undefined}
                          >
                            <span className="shrink-0 font-semibold text-text-muted">{getRoleLabel(label)}</span>
                            <span className="truncate">{label?.text || t('taskNavigation.topicMap.messageNotLoaded')}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {summary && (
        <div className="px-3 py-1.5 border-t border-border-default text-2xs text-text-muted truncate">
          {t('taskNavigation.topicMap.updated', { time: formatRelativeTime(summary.generatedAt, i18n.language) })}
          {summary.model ? ` · ${summary.model}` : ''}
        </div>
      )}
    </div>
  );
};
