import { KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DefaultTaskState, TaskData, getTaskKey, getTaskLastMessagePreview, getTaskSummary } from '@common/types';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';

import { useTaskNavigationSettings } from './hooks';
import { TaskSummaryPreview } from './TaskSummaryPreview';
import { GENERATING_TASK_NAME, formatRelativeTime, getProjectName, getTaskActivity, getTaskTimestamp, tokenize } from './utils';

import { TaskStateChip } from '@/components/common/TaskStateChip';
import { TaskStatusIcon } from '@/components/project/TaskSidebar/TaskStatusIcon';
import { useOverlayRegistration } from '@/hooks/useOverlayFocusRestore';
import { useProjectStore } from '@/stores/projectStore';
import { useTaskMessages } from '@/stores/taskStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';

const MAX_FILTERED_RESULTS = 30;
const COLLAPSED_TOPIC_COUNT = 3;

type Entry = {
  task: TaskData;
  taskKey?: string;
  projectName: string;
  /** Lower-cased key and name. */
  nameText: string;
  /** Lower-cased key, name, project, title and topics. */
  searchText: string;
};

/** Hotkey-opened list of the most recently updated tasks across every open project. */
export const QuickSwitcher = () => {
  const isOpen = useTaskNavigationStore((state) => state.quickSwitcherOpen);
  useOverlayRegistration('task-quick-switcher', isOpen);
  return isOpen ? <QuickSwitcherContent /> : null;
};

const QuickSwitcherContent = () => {
  const { t, i18n } = useTranslation();
  const settings = useTaskNavigationSettings();
  const projectTasksMap = useProjectStore((state) => state.projectTasksMap);
  const closeQuickSwitcher = useTaskNavigationStore((state) => state.closeQuickSwitcher);
  const openGlobalSearch = useTaskNavigationStore((state) => state.openGlobalSearch);
  const requestTaskActivation = useTaskNavigationStore((state) => state.requestTaskActivation);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const result: Entry[] = [];
    projectTasksMap.forEach((tasks) => {
      for (const task of tasks) {
        if (!task.createdAt) {
          continue;
        }
        const taskKey = getTaskKey(task, settings);
        const projectName = getProjectName(task.baseDir);
        const summary = getTaskSummary(task);
        const name = task.name === GENERATING_TASK_NAME ? '' : task.name;
        const nameText = `${taskKey ?? ''} ${name}`.toLowerCase();
        const topicsText = (summary?.topics ?? []).map((topic) => topic.summary).join(' ');
        result.push({
          task,
          taskKey,
          projectName,
          nameText,
          searchText: `${nameText} ${projectName} ${summary?.title ?? ''} ${topicsText}`.toLowerCase(),
        });
      }
    });
    return result.sort((first, second) => getTaskTimestamp(second.task).localeCompare(getTaskTimestamp(first.task)));
  }, [projectTasksMap, settings]);

  const visibleEntries = useMemo(() => {
    const tokens = tokenize(filter);
    if (tokens.length === 0) {
      return entries.filter((entry) => !entry.task.archived).slice(0, settings.quickSwitcherCount);
    }
    return entries
      .filter((entry) => tokens.every((token) => entry.searchText.includes(token)))
      .map((entry, order) => ({
        entry,
        order,
        score: tokens.filter((token) => entry.nameText.includes(token)).length - (entry.task.archived ? 0.5 : 0),
      }))
      .sort((first, second) => second.score - first.score || first.order - second.order)
      .slice(0, MAX_FILTERED_RESULTS)
      .map(({ entry }) => entry);
  }, [entries, filter, settings.quickSwitcherCount]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectEntry = useCallback(
    (entry: Entry) => {
      requestTaskActivation(entry.task.baseDir, entry.task.id);
      closeQuickSwitcher();
    },
    [requestTaskActivation, closeQuickSwitcher],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = visibleEntries.length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) {
          setSelectedIndex((index) => (index + 1) % count);
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) {
          setSelectedIndex((index) => (index - 1 + count) % count);
        }
        break;
      case 'Enter': {
        event.preventDefault();
        const entry = visibleEntries[selectedIndex];
        if (entry) {
          selectEntry(entry);
        }
        break;
      }
      case 'Tab': {
        event.preventDefault();
        const entry = visibleEntries[selectedIndex];
        if (entry) {
          setExpandedTaskId((current) => (current === entry.task.id ? null : entry.task.id));
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeQuickSwitcher();
        break;
      default:
        break;
    }
  };

  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-start justify-center z-[100] pt-[12vh]" onClick={closeQuickSwitcher}>
      <div
        className="bg-bg-secondary-light-strongest shadow-2xl rounded-md border border-bg-tertiary-strong w-[720px] max-w-[94vw] max-h-[70vh] flex flex-col overflow-hidden"
        onClick={stopPropagation}
      >
        <div className="px-3 py-2 border-b border-bg-tertiary-strong">
          <input
            type="text"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            autoFocus
            placeholder={t('taskNavigation.quickSwitcher.placeholder')}
            className="w-full bg-transparent text-sm text-text-primary placeholder-text-muted focus:outline-none"
            spellCheck={false}
          />
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {visibleEntries.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-text-muted">
              {filter.trim() ? t('taskNavigation.quickSwitcher.noMatches') : t('taskNavigation.quickSwitcher.noTasks')}
            </div>
          ) : (
            visibleEntries.map((entry, index) => (
              <QuickSwitcherRow
                key={`${entry.task.baseDir}:${entry.task.id}`}
                entry={entry}
                index={index}
                selected={index === selectedIndex}
                expanded={expandedTaskId === entry.task.id}
                locale={i18n.language}
                onHover={setSelectedIndex}
                onSelect={selectEntry}
              />
            ))
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-bg-tertiary-strong flex items-center gap-3 text-2xs text-text-muted">
          <span className="flex-1 truncate">{t('taskNavigation.quickSwitcher.hint')}</span>
          <button type="button" className="hover:text-text-primary" onClick={() => openGlobalSearch(filter.trim())}>
            {t('taskNavigation.quickSwitcher.searchEverywhere')}
          </button>
        </div>
      </div>
    </div>
  );
};

type RowProps = {
  entry: Entry;
  index: number;
  selected: boolean;
  expanded: boolean;
  locale: string;
  onHover: (index: number) => void;
  onSelect: (entry: Entry) => void;
};

const QuickSwitcherRow = ({ entry, index, selected, expanded, locale, onHover, onSelect }: RowProps) => {
  const { t } = useTranslation();
  const { task, taskKey, projectName } = entry;
  const summary = getTaskSummary(task);
  const preview = getTaskLastMessagePreview(task);
  const inProgress = task.state === DefaultTaskState.InProgress;
  const name = task.name === GENERATING_TASK_NAME ? t('taskNavigation.generatingName') : task.name || t('taskNavigation.untitled');

  return (
    <div
      data-index={index}
      onMouseMove={() => {
        if (!selected) {
          onHover(index);
        }
      }}
      onClick={() => onSelect(entry)}
      className={clsx(
        'px-3 py-2 cursor-pointer border-l-2 border-b border-bg-tertiary-strong',
        selected ? 'bg-bg-tertiary border-l-accent-primary' : 'border-l-transparent',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-4 h-4 shrink-0 flex items-center justify-center">
          <TaskStatusIcon taskId={task.id} state={task.state} />
        </div>
        {taskKey && <span className="shrink-0 font-mono text-2xs text-text-muted">{taskKey}</span>}
        <span className="flex-1 min-w-0 truncate text-xs font-medium text-text-primary">{name}</span>
        {task.state && <TaskStateChip state={task.state} className="shrink-0" />}
        <span className="shrink-0 max-w-[140px] truncate text-2xs text-text-muted">{projectName}</span>
        <span className="shrink-0 w-16 text-right text-2xs text-text-muted">{formatRelativeTime(getTaskTimestamp(task), locale)}</span>
      </div>
      {summary && summary.topics.length > 0 && (
        <TaskSummaryPreview summary={summary} maxTopics={expanded ? summary.topics.length : COLLAPSED_TOPIC_COUNT} className="mt-1.5 ml-6" />
      )}
      {inProgress ? (
        <TaskActivityLine taskId={task.id} />
      ) : (
        preview && (
          <div className="mt-1 ml-6 line-clamp-2 text-2xs text-text-muted">
            {`${preview.role === 'user' ? t('taskNavigation.you') : t('taskNavigation.assistant')}: ${preview.text}`}
          </div>
        )
      )}
    </div>
  );
};

const TaskActivityLine = ({ taskId }: { taskId: string }) => {
  const { t } = useTranslation();
  const messages = useTaskMessages(taskId);
  const activity = useMemo(() => getTaskActivity(messages, t), [messages, t]);

  return activity ? <div className="mt-1 ml-6 line-clamp-2 text-2xs text-text-secondary">{activity}</div> : null;
};
