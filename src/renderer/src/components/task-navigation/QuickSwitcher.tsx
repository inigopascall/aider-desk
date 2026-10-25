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

type Entry = {
  task: TaskData;
  taskKey?: string;
  parent?: { name: string; taskKey?: string };
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
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      for (const task of tasks) {
        if (!task.createdAt) {
          continue;
        }
        const taskKey = getTaskKey(task, settings);
        const projectName = getProjectName(task.baseDir);
        const parent = task.parentId && task.parentId !== task.id ? tasksById.get(task.parentId) : undefined;
        const summary = getTaskSummary(task);
        const name = task.name === GENERATING_TASK_NAME ? '' : task.name;
        const nameText = `${taskKey ?? ''} ${name}`.toLowerCase();
        const topicsText = (summary?.topics ?? []).map((topic) => topic.summary).join(' ');
        result.push({
          task,
          taskKey,
          parent: parent ? { name: parent.name, taskKey: getTaskKey(parent, settings) } : undefined,
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
        className="bg-bg-secondary-light-strongest shadow-2xl rounded-md border border-bg-tertiary-strong w-[1008px] max-w-[94vw] max-h-[70vh] flex flex-col overflow-hidden"
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
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-bg-tertiary scrollbar-track-bg-primary-light scrollbar-rounded"
        >
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
                topicCount={settings.quickSwitcherTopicCount}
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
  topicCount: number;
  onHover: (index: number) => void;
  onSelect: (entry: Entry) => void;
};

const QuickSwitcherRow = ({ entry, index, selected, expanded, locale, topicCount, onHover, onSelect }: RowProps) => {
  const { t } = useTranslation();
  const { task, taskKey, parent, projectName } = entry;
  const summary = getTaskSummary(task);
  const preview = getTaskLastMessagePreview(task);
  const inProgress = task.state === DefaultTaskState.InProgress;
  const name = task.name === GENERATING_TASK_NAME ? t('taskNavigation.generatingName') : task.name || t('taskNavigation.untitled');
  const parentName = parent ? (parent.name === GENERATING_TASK_NAME ? t('taskNavigation.generatingName') : parent.name || t('taskNavigation.untitled')) : null;

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
        'pl-6 pr-3 py-2 cursor-pointer border-l-2 border-b border-bg-tertiary-strong',
        selected ? 'bg-bg-tertiary border-l-accent-primary' : 'border-l-transparent',
      )}
    >
      <div className={clsx(parent && 'flex flex-col gap-1.5')}>
        {parent && (
          <div className="relative flex items-center gap-2 min-w-0">
            <ParentConnector part="start" />
            {parent.taskKey && <span className="shrink-0 font-mono text-2xs text-text-muted">{parent.taskKey}</span>}
            <span className="flex-1 min-w-0 truncate text-xs font-medium uppercase text-text-primary" title={parent.name}>
              {parentName}
            </span>
          </div>
        )}
        <div className="min-w-0">
          <div className="relative flex items-center gap-2 min-w-0">
            {parent && <ParentConnector part="end" />}
            {taskKey && <span className="shrink-0 font-mono text-2xs text-text-muted">{taskKey}</span>}
            <span className="flex-1 min-w-0 truncate text-xs font-medium uppercase text-text-primary">{name}</span>
            <span className="ml-1 shrink-0 flex items-center empty:hidden">
              <TaskStatusIcon taskId={task.id} state={task.state} />
            </span>
            {task.state && <TaskStateChip state={task.state} className="shrink-0" />}
            <span className="shrink-0 max-w-[140px] truncate text-2xs text-text-muted">{projectName}</span>
            <span className="shrink-0 w-16 text-right text-2xs text-text-muted">{formatRelativeTime(getTaskTimestamp(task), locale)}</span>
          </div>
          {summary && summary.topics.length > 0 && (
            <TaskSummaryPreview summary={summary} maxTopics={expanded ? summary.topics.length : topicCount} className="mt-1.5" />
          )}
          {inProgress ? (
            <TaskActivityLine taskId={task.id} />
          ) : (
            preview && (
              <div className="mt-1 line-clamp-2 text-2xs text-text-muted">
                {`${preview.role === 'user' ? t('taskNavigation.you') : t('taskNavigation.assistant')}: ${preview.text}`}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
};

/** Stroke width and end-dot diameter of the parent connector, in pixels. */
const CONNECTOR_STROKE = 2;
const CONNECTOR_DOT = 5;
/** Space between a parent line and the sub-task's title line: the row's `gap-1.5`. */
const PARENT_LINE_GAP = '0.375rem';

type ParentConnectorProps = {
  /** `start` is drawn on the parent line, `end` on the sub-task's title line. */
  part: 'start' | 'end';
};

/**
 * Connector from a sub-task's parent line to its title line, in the muted colour of the task keys. The
 * vertical stroke runs 1em left of both titles, from the middle of the parent line down to the middle of the sub-task
 * line, then turns right and stops 0.5em left of the sub-task title. Each end has a dot; the corner has none. Lengths in
 * em are at the title's font size (`text-xs`).
 */
const ParentConnector = ({ part }: ParentConnectorProps) => {
  const half = CONNECTOR_STROKE / 2;
  const dot = { width: CONNECTOR_DOT, height: CONNECTOR_DOT };
  if (part === 'start') {
    return (
      <span aria-hidden="true" className="pointer-events-none absolute text-xs" style={{ left: '-1em', top: '50%', bottom: `-${PARENT_LINE_GAP}` }}>
        <span className="absolute top-0 bottom-0 bg-text-muted" style={{ left: -half, width: CONNECTOR_STROKE }} />
        <span className="absolute rounded-full bg-text-muted" style={{ ...dot, left: -CONNECTOR_DOT / 2, top: -CONNECTOR_DOT / 2 }} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="pointer-events-none absolute text-xs" style={{ left: '-1em', top: 0, height: '50%' }}>
      <span
        className="absolute top-0 border-solid border-text-muted"
        style={{
          left: -half,
          bottom: -half,
          width: `calc(0.5em + ${half}px)`,
          borderLeftWidth: CONNECTOR_STROKE,
          borderBottomWidth: CONNECTOR_STROKE,
        }}
      />
      <span className="absolute rounded-full bg-text-muted" style={{ ...dot, left: `calc(0.5em - ${CONNECTOR_DOT / 2}px)`, bottom: -CONNECTOR_DOT / 2 }} />
    </span>
  );
};

const TaskActivityLine = ({ taskId }: { taskId: string }) => {
  const { t } = useTranslation();
  const messages = useTaskMessages(taskId);
  const activity = useMemo(() => getTaskActivity(messages, t), [messages, t]);

  return activity ? <div className="mt-1 line-clamp-2 text-2xs text-text-secondary">{activity}</div> : null;
};
