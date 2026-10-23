import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TASK_NAVIGATION_METADATA_KEYS, TaskData, getTaskKey, getTaskSummary, isResponseMessage, isTaskNameLocked, isUserMessage } from '@common/types';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { MdKeyboardArrowDown, MdKeyboardArrowRight, MdOutlineRefresh } from 'react-icons/md';
import { VscLock } from 'react-icons/vsc';

import { useTaskNavigationSettings } from './hooks';
import { MessageRow, NavigableRow, buildTopicMapRows, isNavigableRow, topicRowKey } from './topic-map-rows';
import { GENERATING_TASK_NAME, formatRelativeTime } from './utils';

import { extractFirstLine, truncateTitle } from '@/components/message/outline';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { useTaskMessages } from '@/stores/taskStore';
import { TopicMapViewState, getTopicMapViewKey, useTaskNavigationStore } from '@/stores/taskNavigationStore';
import { showErrorNotification } from '@/utils/notifications';

const MESSAGE_LABEL_LENGTH = 120;
const EMPTY_VIEW: TopicMapViewState = { selected: null, expanded: [] };

type MessageLabel = {
  role: 'user' | 'assistant';
  text: string;
};

type Props = {
  task: TaskData;
  onScrollToMessage: (messageId: string) => void;
};

/**
 * Topic map of a task as a modal, opened from the task bar or the topic map hotkey. Only the active task's view renders
 * it, so the task that hosts it is always the one on screen.
 */
export const TopicMapModal = ({ task, onScrollToMessage }: Props) => {
  const viewKey = getTopicMapViewKey(task.baseDir, task.id);
  const isOpen = useTaskNavigationStore((state) => state.topicMapOpen);
  const setTopicMapHost = useTaskNavigationStore((state) => state.setTopicMapHost);
  const releaseTopicMapHost = useTaskNavigationStore((state) => state.releaseTopicMapHost);

  useEffect(() => {
    setTopicMapHost(viewKey);
    return () => releaseTopicMapHost(viewKey);
  }, [viewKey, setTopicMapHost, releaseTopicMapHost]);

  return isOpen ? createPortal(<TopicMapContent task={task} viewKey={viewKey} onScrollToMessage={onScrollToMessage} />, document.body) : null;
};

type ContentProps = Props & {
  viewKey: string;
};

const TopicMapContent = ({ task, viewKey, onScrollToMessage }: ContentProps) => {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const settings = useTaskNavigationSettings();
  const closeTopicMap = useTaskNavigationStore((state) => state.closeTopicMap);
  const setTopicMapView = useTaskNavigationStore((state) => state.setTopicMapView);
  const view = useTaskNavigationStore((state) => state.topicMapViews[viewKey]) ?? EMPTY_VIEW;
  const messages = useTaskMessages(task.id);
  const [regenerating, setRegenerating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const summary = getTaskSummary(task);
  const topics = useMemo(() => summary?.topics ?? [], [summary]);
  const taskKey = getTaskKey(task, settings);
  const nameLocked = isTaskNameLocked(task);
  const taskName = task.name === GENERATING_TASK_NAME ? t('taskNavigation.generatingName') : task.name || t('taskNavigation.untitled');

  const expanded = useMemo(() => new Set(view.expanded.filter((index) => index >= 0 && index < topics.length)), [view.expanded, topics.length]);

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

  // Section rows are display-only: selection, the remembered view and keyboard navigation use the navigable rows
  const rows = useMemo(() => buildTopicMapRows(topics, expanded), [topics, expanded]);
  const navigableRows = useMemo(() => rows.filter(isNavigableRow), [rows]);
  const navigableIndexes = useMemo(() => new Map(navigableRows.map((row, index) => [row.key, index])), [navigableRows]);

  const selectedIndex = useMemo(() => {
    const exact = navigableRows.findIndex((row) => row.key === view.selected);
    if (exact !== -1) {
      return exact;
    }
    if (view.selected?.startsWith('message:')) {
      const topicRow = navigableRows.findIndex((row) => row.key === topicRowKey(Number(view.selected?.split(':')[1])));
      if (topicRow !== -1) {
        return topicRow;
      }
    }
    for (let index = navigableRows.length - 1; index >= 0; index--) {
      if (navigableRows[index].kind === 'topic') {
        return index;
      }
    }
    return -1;
  }, [navigableRows, view.selected]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const saveView = useCallback(
    (selected: string | null, expandedTopics: Set<number>) => {
      setTopicMapView(viewKey, { selected, expanded: [...expandedTopics].sort((first, second) => first - second) });
    },
    [setTopicMapView, viewKey],
  );

  const selectRow = useCallback((row: NavigableRow) => saveView(row.key, expanded), [saveView, expanded]);

  const setTopicExpanded = useCallback(
    (topicIndex: number, open: boolean) => {
      const next = new Set(expanded);
      if (open) {
        next.add(topicIndex);
      } else {
        next.delete(topicIndex);
      }
      saveView(topicRowKey(topicIndex), next);
    },
    [expanded, saveView],
  );

  const openMessage = useCallback(
    (row: MessageRow) => {
      saveView(row.key, expanded);
      if (!messageLabels.has(row.messageId)) {
        return;
      }
      closeTopicMap();
      onScrollToMessage(row.messageId);
    },
    [saveView, expanded, messageLabels, closeTopicMap, onScrollToMessage],
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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
      return;
    }
    const row = navigableRows[selectedIndex];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (navigableRows.length === 0) {
          break;
        }
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = selectedIndex === -1 ? 0 : (selectedIndex + step + navigableRows.length) % navigableRows.length;
        selectRow(navigableRows[next]);
        break;
      }
      case 'Home':
      case 'End':
        event.preventDefault();
        if (navigableRows.length > 0) {
          selectRow(navigableRows[event.key === 'Home' ? 0 : navigableRows.length - 1]);
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (row?.kind === 'topic') {
          setTopicExpanded(row.topicIndex, !expanded.has(row.topicIndex));
        } else if (row?.kind === 'message') {
          openMessage(row);
        }
        break;
      case 'ArrowRight':
        if (row?.kind === 'topic' && !expanded.has(row.topicIndex)) {
          event.preventDefault();
          setTopicExpanded(row.topicIndex, true);
        }
        break;
      case 'ArrowLeft':
        if (row && (row.kind === 'message' || expanded.has(row.topicIndex))) {
          event.preventDefault();
          setTopicExpanded(row.topicIndex, false);
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeTopicMap();
        break;
      default:
        break;
    }
  };

  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-start justify-center z-[100] pt-[10vh]" onClick={closeTopicMap}>
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={stopPropagation}
        className="bg-bg-secondary-light-strongest shadow-2xl rounded-md border border-bg-tertiary-strong w-[760px] max-w-[94vw] max-h-[76vh] flex flex-col overflow-hidden focus:outline-none"
      >
        <div className="px-3 py-2 border-b border-bg-tertiary-strong flex items-center gap-2 min-w-0">
          {taskKey && <span className="shrink-0 font-mono text-2xs text-text-muted">{taskKey}</span>}
          <span className="flex-1 min-w-0 truncate text-xs font-medium uppercase text-text-primary">{taskName}</span>
          {nameLocked && (
            <Tooltip content={t('taskNavigation.topicMap.unlockTitle')}>
              <button type="button" className="shrink-0 text-text-muted hover:text-text-primary" onClick={handleUnlockTitle}>
                <VscLock className="w-3.5 h-3.5" />
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('taskNavigation.topicMap.regenerate')}>
            <button
              type="button"
              disabled={regenerating}
              onClick={() => void handleRegenerate()}
              className="shrink-0 text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              <MdOutlineRefresh className={clsx('w-4 h-4', regenerating && 'animate-spin')} />
            </button>
          </Tooltip>
        </div>

        {nameLocked && (
          <div className="px-3 py-1.5 border-b border-bg-tertiary-strong text-2xs text-text-muted truncate">
            {t('taskNavigation.topicMap.titleLocked')}
            {summary?.title ? ` · ${summary.title}` : ''}
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {topics.length === 0 ? (
            <div className="px-3 py-6 flex flex-col items-center gap-3 text-xs text-text-muted">
              <span>{t('taskNavigation.topicMap.empty')}</span>
              <button
                type="button"
                disabled={regenerating}
                onClick={() => void handleRegenerate()}
                className="px-2 py-1 rounded border border-border-default text-text-primary hover:bg-bg-tertiary disabled:opacity-50"
              >
                {t('taskNavigation.topicMap.generate')}
              </button>
            </div>
          ) : (
            rows.map((row) => {
              if (row.kind === 'section') {
                return (
                  <div key={row.key} className="pl-10 pr-3 pt-1.5 pb-0.5 border-l-2 border-l-transparent text-2xs font-medium text-text-primary">
                    {row.summary}
                  </div>
                );
              }

              const index = navigableIndexes.get(row.key) ?? -1;
              const rowClassName = clsx(
                'cursor-pointer border-l-2',
                index === selectedIndex ? 'bg-bg-tertiary border-l-accent-primary' : 'border-l-transparent',
              );

              if (row.kind === 'topic') {
                const topic = topics[row.topicIndex];
                const isExpanded = expanded.has(row.topicIndex);
                return (
                  <div
                    key={row.key}
                    data-index={index}
                    onClick={() => setTopicExpanded(row.topicIndex, !isExpanded)}
                    className={clsx(rowClassName, 'px-3 py-1.5 flex items-start gap-1.5', topic.detached && 'opacity-60')}
                  >
                    {isExpanded ? (
                      <MdKeyboardArrowDown className="mt-0.5 w-4 h-4 shrink-0 text-text-muted" />
                    ) : (
                      <MdKeyboardArrowRight className="mt-0.5 w-4 h-4 shrink-0 text-text-muted" />
                    )}
                    <span className="mt-0.5 w-6 shrink-0 text-right text-2xs text-text-muted">{`${row.topicIndex + 1}.`}</span>
                    <span className="flex-1 min-w-0 text-xs text-text-primary">{topic.summary}</span>
                    <span className="mt-0.5 shrink-0 text-2xs text-text-muted">
                      {topic.detached ? t('taskNavigation.topicMap.compacted') : t('taskNavigation.messageCount', { count: topic.messageIds.length })}
                    </span>
                  </div>
                );
              }

              const label = messageLabels.get(row.messageId);
              return (
                <div
                  key={row.key}
                  data-index={index}
                  onClick={() => openMessage(row)}
                  className={clsx(rowClassName, 'pl-14 pr-3 py-1 flex items-start gap-2 text-2xs', !label && 'text-text-muted')}
                >
                  <span className="w-8 shrink-0 font-semibold text-text-muted">
                    {label ? (label.role === 'user' ? t('taskNavigation.you') : t('taskNavigation.assistant')) : ''}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-text-muted">{label?.text || t('taskNavigation.topicMap.messageNotLoaded')}</span>
                </div>
              );
            })
          )}
        </div>

        <div className="px-3 py-1.5 border-t border-bg-tertiary-strong flex items-center gap-3 text-2xs text-text-muted">
          <span className="flex-1 truncate">{t('taskNavigation.topicMap.hint')}</span>
          {summary && (
            <span className="shrink-0 max-w-[45%] truncate">
              {t('taskNavigation.topicMap.updated', { time: formatRelativeTime(summary.generatedAt, i18n.language) })}
              {summary.model ? ` · ${summary.model}` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
