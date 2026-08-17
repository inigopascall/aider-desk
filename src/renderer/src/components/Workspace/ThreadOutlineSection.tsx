import { motion } from 'framer-motion';
import { useCallback, useDeferredValue, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MdBookmark, MdBookmarkBorder } from 'react-icons/md';
import { clsx } from 'clsx';
import { useLocalStorage } from '@reactuses/core';

import { SectionHeader } from './SectionHeader';
import { ThreadOutlineItem } from '@/components/message/ThreadOutlineItem';
import { buildOutline, type OutlineItem } from '@/components/message/outline';
import { Tooltip } from '@/components/ui/Tooltip';
import { useProcessedMessages } from '@/hooks/useProcessedMessages';
import { pruneTaskBookmarks, toggleBookmark, useTaskBookmarks } from '@/stores/bookmarkStore';
import { useTaskMessages } from '@/stores/taskStore';

export type ThreadOutlineFilter = 'all' | 'bookmarks';

type Props = {
  baseDir: string;
  taskId: string;
  isOpen: boolean;
  totalStats: { additions: number; deletions: number };
  visitedSections: Set<string>;
  onToggle: () => void;
  onScrollToMessage?: (messageId: string) => void;
  editMode?: boolean;
  isHidden?: boolean;
  onToggleHidden?: () => void;
  showBorderTop?: boolean;
};

export const ThreadOutlineSection = ({ baseDir, taskId, isOpen, totalStats, visitedSections, onToggle, onScrollToMessage, editMode, isHidden, onToggleHidden, showBorderTop }: Props) => {
  const { t } = useTranslation();
  const messages = useTaskMessages(taskId);
  const deferredMessages = useDeferredValue(messages);
  const processedMessages = useProcessedMessages(deferredMessages);
  const { items, bookmarkableMessageIds } = useMemo(() => buildOutline(processedMessages, t), [processedMessages, t]);
  const bookmarks = useTaskBookmarks(taskId);
  const bookmarkedIds = useMemo(() => new Set(Object.keys(bookmarks)), [bookmarks]);
  const bookmarkedCount = useMemo(() => items.reduce((n, item) => n + (item.bookmarkable && bookmarkedIds.has(item.id) ? 1 : 0), 0), [items, bookmarkedIds]);
  useEffect(() => {
    if (items.length > 0) pruneTaskBookmarks(taskId, bookmarkableMessageIds);
  }, [taskId, items.length, bookmarkableMessageIds]);
  const [storedFilter, setFilter] = useLocalStorage<ThreadOutlineFilter>(`workspace-outline-filter-${baseDir}`, 'all');
  const filter = storedFilter ?? 'all';
  const filteredItems = useMemo(() => filter === 'bookmarks' ? items.filter((item) => item.bookmarkable && bookmarkedIds.has(item.id)) : items, [items, filter, bookmarkedIds]);
  const handleSelect = useCallback((item: OutlineItem) => onScrollToMessage?.(item.scrollTargetId), [onScrollToMessage]);
  const handleToggleBookmark = useCallback((messageId: string) => {
    const item = items.find((candidate) => candidate.id === messageId);
    if (!item?.bookmarkable) {
      return;
    }
    toggleBookmark(taskId, messageId, item.title);
  }, [items, taskId]);
  const actions = useMemo(() => (
    <Tooltip content={filter === 'bookmarks' ? t('messages.outline.filterAll') : t('messages.outline.filterBookmarks')}>
      <button className="p-1.5 rounded-md hover:bg-bg-tertiary transition-colors" onClick={() => setFilter(filter === 'bookmarks' ? 'all' : 'bookmarks')}>
        {filter === 'bookmarks' ? <MdBookmark className="w-4 h-4 text-amber-400" /> : <MdBookmarkBorder className="w-4 h-4 text-text-primary" />}
      </button>
    </Tooltip>
  ), [filter, setFilter, t]);
  const hasContent = visitedSections.has('outline') && filteredItems.length > 0;
  return <motion.div className={clsx('flex flex-col overflow-hidden min-h-[40px]', showBorderTop && 'border-t border-border-dark-light')} initial={false} animate={editMode ? { flexGrow: 0, flexShrink: 0 } : { flexGrow: isOpen ? 1 : 0, flexShrink: isOpen ? 1 : 0 }} transition={{ duration: 0.3, ease: 'easeIn' }}>
    <SectionHeader section="outline" title={t('messages.outline.title')} count={bookmarkedCount} totalCount={items.length} isOpen={isOpen} totalStats={totalStats} onToggle={onToggle} actions={actions} editMode={editMode} isHidden={isHidden} onToggleHidden={onToggleHidden} />
    {isOpen && (
      <motion.div className="flex-grow w-full overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-bg-tertiary scrollbar-track-bg-primary-light scrollbar-rounded py-1 bg-bg-primary-light-strong relative" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
        {hasContent ? filteredItems.map((item) => <ThreadOutlineItem key={item.id} item={item} bookmarked={item.bookmarkable && bookmarkedIds.has(item.id)} bookmarkable={item.bookmarkable} onSelect={handleSelect} onToggleBookmark={handleToggleBookmark} />) : <div className="absolute inset-0 flex items-center justify-center text-center text-text-muted text-2xs">{t(filter === 'bookmarks' ? 'messages.outline.emptyBookmarks' : 'messages.outline.empty')}</div>}
      </motion.div>
    )}
  </motion.div>;
};

