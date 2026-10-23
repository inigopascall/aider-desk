import { KeyboardEvent, MouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GlobalSearchMessageHit,
  GlobalSearchResponse,
  GlobalSearchTaskResult,
  SEARCH_SNIPPET_MATCH_END,
  SEARCH_SNIPPET_MATCH_START,
  SEARCH_TASK_ROW_MESSAGE_ID,
  SearchIndexStatus,
  formatTaskKey,
  getProjectPrefix,
} from '@common/types';
import { compareBaseDirs } from '@common/utils';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { MdOutlineRefresh, MdSearch } from 'react-icons/md';

import { useTaskNavigationSettings } from './hooks';
import { formatRelativeTime, getProjectName } from './utils';

import { TaskStateChip } from '@/components/common/TaskStateChip';
import { useApi } from '@/contexts/ApiContext';
import { useOverlayRegistration } from '@/hooks/useOverlayFocusRestore';
import { useProjectStore } from '@/stores/projectStore';
import { useTaskNavigationStore } from '@/stores/taskNavigationStore';
import { showInfoNotification } from '@/utils/notifications';

const SEARCH_DELAY_MS = 180;
const STATUS_POLL_MS = 3000;
const RESULT_LIMIT = 30;

type Item = { kind: 'task'; result: GlobalSearchTaskResult } | { kind: 'hit'; result: GlobalSearchTaskResult; hit: GlobalSearchMessageHit };

/** Splits a search snippet into plain text and highlighted matches. */
const renderSnippet = (snippet: string): ReactNode[] => {
  const parts: ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(SEARCH_SNIPPET_MATCH_START);
    if (start === -1) {
      parts.push(rest);
      break;
    }
    if (start > 0) {
      parts.push(rest.slice(0, start));
    }
    const end = rest.indexOf(SEARCH_SNIPPET_MATCH_END, start + 1);
    const match = end === -1 ? rest.slice(start + 1) : rest.slice(start + 1, end);
    parts.push(
      <mark key={key++} className="bg-transparent font-semibold text-text-primary underline decoration-accent-primary">
        {match}
      </mark>,
    );
    rest = end === -1 ? '' : rest.slice(end + 1);
  }
  return parts;
};

/** Hotkey-opened search across the conversations of every task in every project. */
export const GlobalSearch = () => {
  const isOpen = useTaskNavigationStore((state) => state.globalSearchOpen);
  useOverlayRegistration('task-global-search', isOpen);
  return isOpen ? <GlobalSearchContent /> : null;
};

const GlobalSearchContent = () => {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const settings = useTaskNavigationSettings();
  const initialQuery = useTaskNavigationStore((state) => state.globalSearchInitialQuery);
  const closeGlobalSearch = useTaskNavigationStore((state) => state.closeGlobalSearch);
  const requestTaskActivation = useTaskNavigationStore((state) => state.requestTaskActivation);
  const searchOrder = useTaskNavigationStore((state) => state.searchOrder);
  const toggleSearchOrder = useTaskNavigationStore((state) => state.toggleSearchOrder);
  const projectTasksMap = useProjectStore((state) => state.projectTasksMap);
  const [query, setQuery] = useState(initialQuery);
  const [response, setResponse] = useState<GlobalSearchResponse | null>(null);
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const requestIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const openProjectDirs = useMemo(() => [...projectTasksMap.keys()], [projectTasksMap]);
  const isProjectOpen = useCallback((baseDir: string) => openProjectDirs.some((dir) => compareBaseDirs(dir, baseDir)), [openProjectDirs]);

  useEffect(() => {
    let cancelled = false;
    const loadStatus = () => {
      api
        .getSearchIndexStatus()
        .then((next) => {
          if (!cancelled) {
            setStatus(next);
          }
        })
        .catch(() => undefined);
    };
    loadStatus();
    const interval = window.setInterval(loadStatus, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [api]);

  const trimmedQuery = query.trim();

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!trimmedQuery) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLoading(true);
      api
        .searchTasks(trimmedQuery, RESULT_LIMIT)
        .then((result) => {
          if (requestIdRef.current === requestId) {
            setResponse(result);
            setStatus(result.status);
            setSelectedIndex(0);
          }
        })
        .catch(() => {
          if (requestIdRef.current === requestId) {
            setResponse(null);
          }
        })
        .finally(() => {
          if (requestIdRef.current === requestId) {
            setLoading(false);
          }
        });
    }, SEARCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [api, trimmedQuery]);

  const activeResponse = trimmedQuery ? response : null;
  const searching = loading && !!trimmedQuery;

  const items = useMemo<Item[]>(() => {
    const results = [...(activeResponse?.results ?? [])];
    if (searchOrder === 'recent') {
      results.sort((first, second) => (second.updatedAt ?? '').localeCompare(first.updatedAt ?? ''));
    }
    const list: Item[] = [];
    for (const result of results) {
      list.push({ kind: 'task', result });
      for (const hit of result.hits) {
        list.push({ kind: 'hit', result, hit });
      }
    }
    return list;
  }, [activeResponse, searchOrder]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectItem = useCallback(
    (item: Item) => {
      requestTaskActivation(item.result.baseDir, item.result.taskId, item.kind === 'hit' ? item.hit.messageId : undefined);
      closeGlobalSearch();
    },
    [requestTaskActivation, closeGlobalSearch],
  );

  const handleRebuild = useCallback(() => {
    api
      .rebuildSearchIndex()
      .then((next) => {
        setStatus(next);
        showInfoNotification(t('taskNavigation.search.rebuildStarted'));
      })
      .catch(() => undefined);
  }, [api, t]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = items.length;
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
        const item = items[selectedIndex];
        if (item) {
          selectItem(item);
        }
        break;
      }
      case 'Tab':
        event.preventDefault();
        toggleSearchOrder();
        setSelectedIndex(0);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeGlobalSearch();
        break;
      default:
        break;
    }
  };

  const statusText = useMemo(() => {
    if (!status) {
      return '';
    }
    if (status.state === 'disabled') {
      return t('taskNavigation.search.disabled');
    }
    if (status.state === 'error') {
      return t('taskNavigation.search.error', { error: status.error ?? '' });
    }
    const indexText =
      status.state === 'indexing'
        ? t('taskNavigation.search.indexing', { done: status.tasksIndexed, total: status.tasksTotal })
        : t('taskNavigation.search.indexed', { tasks: status.tasksIndexed, messages: status.messagesIndexed });
    const conceptText = status.embedding
      ? t('taskNavigation.search.conceptBuilding')
      : status.conceptSearchAvailable
        ? t('taskNavigation.search.conceptOn', { vectors: status.vectorsIndexed })
        : t('taskNavigation.search.conceptOff');
    return `${indexText} · ${conceptText}`;
  }, [status, t]);

  const getTaskLabel = (result: GlobalSearchTaskResult) => {
    const key = result.taskNumber ? formatTaskKey(getProjectPrefix(result.baseDir, settings), result.taskNumber) : undefined;
    const name = result.name || t('taskNavigation.untitled');
    return { key, name };
  };

  const getRoleLabel = (hit: GlobalSearchMessageHit) => {
    if (hit.messageId === SEARCH_TASK_ROW_MESSAGE_ID || hit.role === 'task') {
      return t('taskNavigation.search.taskRow');
    }
    return hit.role === 'user' ? t('taskNavigation.you') : t('taskNavigation.assistant');
  };

  const stopPropagation = (event: MouseEvent<HTMLDivElement>) => event.stopPropagation();

  const renderEmptyState = () => {
    if (!trimmedQuery) {
      return t('taskNavigation.search.typeToSearch');
    }
    if (searching || !activeResponse) {
      return t('taskNavigation.search.searching');
    }
    return t('taskNavigation.search.noResults');
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-start justify-center z-[100] pt-[10vh]" onClick={closeGlobalSearch}>
      <div
        className="bg-bg-secondary-light-strongest shadow-2xl rounded-md border border-bg-tertiary-strong w-[820px] max-w-[94vw] max-h-[76vh] flex flex-col overflow-hidden"
        onClick={stopPropagation}
      >
        <div className="px-3 py-2 border-b border-bg-tertiary-strong flex items-center gap-2">
          <MdSearch className="w-4 h-4 shrink-0 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            placeholder={t('taskNavigation.search.placeholder')}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted focus:outline-none"
            spellCheck={false}
          />
          {searching && <span className="shrink-0 text-2xs text-text-muted">{t('taskNavigation.search.searching')}</span>}
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-text-muted">{renderEmptyState()}</div>
          ) : (
            items.map((item, index) => {
              const selected = index === selectedIndex;
              const rowClassName = clsx('cursor-pointer border-l-2', selected ? 'bg-bg-tertiary border-l-accent-primary' : 'border-l-transparent');
              const onMouseMove = () => {
                if (!selected) {
                  setSelectedIndex(index);
                }
              };

              if (item.kind === 'task') {
                const { result } = item;
                const { key, name } = getTaskLabel(result);
                return (
                  <div
                    key={`task:${result.baseDir}:${result.taskId}`}
                    data-index={index}
                    onMouseMove={onMouseMove}
                    onClick={() => selectItem(item)}
                    className={clsx(rowClassName, 'px-3 pt-2 pb-1 flex items-center gap-2 min-w-0', index > 0 && 'border-t border-t-bg-tertiary-strong')}
                  >
                    {key && <span className="shrink-0 font-mono text-2xs text-text-muted">{key}</span>}
                    <span className="flex-1 min-w-0 truncate text-xs font-medium uppercase text-text-primary">{name}</span>
                    {result.matchedBy.includes('concept') && (
                      <span className="shrink-0 text-2xs text-accent-primary">{t('taskNavigation.search.matchedConcept')}</span>
                    )}
                    {result.state && <TaskStateChip state={result.state} className="shrink-0" />}
                    <span className="shrink-0 max-w-[160px] truncate text-2xs text-text-muted">{getProjectName(result.baseDir)}</span>
                    {!isProjectOpen(result.baseDir) && <span className="shrink-0 text-2xs italic text-text-muted">{t('taskNavigation.search.notOpen')}</span>}
                    <span className="shrink-0 w-16 text-right text-2xs text-text-muted">{formatRelativeTime(result.updatedAt, i18n.language)}</span>
                  </div>
                );
              }

              const { hit, result } = item;
              return (
                <div
                  key={`hit:${result.baseDir}:${result.taskId}:${hit.messageId}:${hit.matchedBy}`}
                  data-index={index}
                  onMouseMove={onMouseMove}
                  onClick={() => selectItem(item)}
                  className={clsx(rowClassName, 'pl-9 pr-3 py-1 flex items-start gap-2 text-2xs')}
                >
                  <span className="shrink-0 w-20 truncate font-semibold text-text-muted">{getRoleLabel(hit)}</span>
                  <span className="flex-1 min-w-0 line-clamp-2 text-text-secondary">{renderSnippet(hit.snippet)}</span>
                  {hit.matchedBy === 'concept' && <span className="shrink-0 text-accent-primary">{t('taskNavigation.search.matchedConcept')}</span>}
                  <span className="shrink-0 w-16 text-right text-text-muted">{formatRelativeTime(hit.timestamp, i18n.language)}</span>
                </div>
              );
            })
          )}
        </div>
        <div className="px-3 py-1.5 border-t border-bg-tertiary-strong flex items-center gap-3 text-2xs text-text-muted">
          <span className="flex-1 truncate">{statusText}</span>
          <button
            type="button"
            className="shrink-0 hover:text-text-primary"
            onClick={() => {
              toggleSearchOrder();
              setSelectedIndex(0);
            }}
          >
            {searchOrder === 'recent' ? t('taskNavigation.search.sortedByRecent') : t('taskNavigation.search.sortedByRelevance')}
          </button>
          <span className="shrink-0">{t('taskNavigation.search.hint')}</span>
          <button type="button" className="shrink-0 flex items-center gap-1 hover:text-text-primary" onClick={handleRebuild}>
            <MdOutlineRefresh className="w-3.5 h-3.5" />
            {t('taskNavigation.search.rebuild')}
          </button>
        </div>
      </div>
    </div>
  );
};
