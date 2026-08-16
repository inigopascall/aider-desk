[DEPRECATED: PLEASE DELETE]import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FiFilter } from 'react-icons/fi';
import { clsx } from 'clsx';
import { Message } from '@common/types';

import { buildOutline, OutlineItem } from './outline';
import { ThreadOutlineItem } from './ThreadOutlineItem';

import { FloatingPanel } from '@/components/common/FloatingPanel';
import { useProcessedMessages } from '@/hooks/useProcessedMessages';
import { addBookmark, removeBookmark, pruneTaskBookmarks, useTaskBookmarks } from '@/stores/bookmarkStore';

export type ThreadOutlineFilter = 'all' | 'bookmarks';

export interface ThreadOutlineWindowProps {
  baseDir: string;
  taskId: string;
  messages: Message[];
  onScrollToMessage: (messageId: string) => void;
  onClose: () => void;
}

const ThreadOutlineWindowComponent = ({ baseDir, taskId, messages, onScrollToMessage, onClose }: ThreadOutlineWindowProps) => {
  const { t } = useTranslation();
  const bookmarks = useTaskBookmarks(taskId);

  const processedMessages = useProcessedMessages(messages);

  // Build outline using the translation function
  const { items, knownMessageIds } = useMemo(() => buildOutline(processedMessages, t), [processedMessages, t]);

  // The store no-ops when nothing is removed, so streaming updates are harmless.
  useEffect(() => {
    pruneTaskBookmarks(taskId, knownMessageIds);
  }, [taskId, knownMessageIds]);

  // Derive the bookmarked set from the bookmark store
  const bookmarkedIds = useMemo(() => new Set(Object.keys(bookmarks)), [bookmarks]);

  // Filter state - default to 'all'
  const [filter, setFilter] = useState<ThreadOutlineFilter>('all');

  // Compute filtered items based on the current filter
  const filteredItems = useMemo(() => {
    if (filter === 'bookmarks') {
      return items.filter((item) => bookmarkedIds.has(item.id));
    }
    return items;
  }, [items, filter, bookmarkedIds]);

  const handleSelect = useCallback(
    (item: OutlineItem) => {
      onScrollToMessage(item.scrollTargetId);
    },
    [onScrollToMessage],
  );

  const handleToggleBookmark = useCallback(
    (messageId: string) => {
      const item = items.find((i) => i.id === messageId);
      const label = item?.title ?? '';
      if (bookmarks[messageId]) {
        removeBookmark(taskId, messageId);
      } else {
        addBookmark(taskId, messageId, label);
      }
    },
    [bookmarks, items, taskId],
  );

  const handleFilterChange = useCallback((newFilter: ThreadOutlineFilter) => {
    setFilter(newFilter);
  }, []);

  const emptyMessage = filter === 'bookmarks' ? t('messages.outline.emptyBookmarks') : t('messages.outline.empty');

  return (
    <FloatingPanel
      title={t('messages.outline.title')}
      onClose={onClose}
      storageKey={`thread-outline-${baseDir}-${taskId}`}
      defaultPosition={{ x: 50, y: 50 }}
      defaultSize={{ width: 360, height: 500 }}
      minWidth={200}
      minHeight={200}
      className="z-50"
    >
      <div className="flex flex-col h-full">
        {/* Filter bar */}
        <div className="flex items-center px-2 py-1 border-b border-border-dark-light gap-1 bg-bg-primary-light">
          <FiFilter className="w-3.5 h-3.5 text-text-muted-light flex-shrink-0" />
          <button
            onClick={() => handleFilterChange('all')}
            className={clsx(
              'flex-1 text-2xs font-medium py-1 px-2 rounded transition-colors',
              filter === 'all' ? 'bg-bg-secondary text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary',
            )}
          >
            {t('messages.outline.filterAll')}
          </button>
          <button
            onClick={() => handleFilterChange('bookmarks')}
            className={clsx(
              'flex-1 text-2xs font-medium py-1 px-2 rounded transition-colors',
              filter === 'bookmarks' ? 'bg-bg-secondary text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-bg-tertiary',
            )}
          >
            {t('messages.outline.filterBookmarks')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-bg-primary scrollbar-thumb-bg-tertiary hover:scrollbar-thumb-bg-fourth">
          {filteredItems.length === 0 ? (
            <div className="p-4 text-center text-2xs text-text-muted">{emptyMessage}</div>
          ) : (
            <div className="py-1">
              {filteredItems.map((item) => (
                <ThreadOutlineItem
                  key={item.id}
                  item={item}
                  bookmarked={bookmarkedIds.has(item.id)}
                  onSelect={handleSelect}
                  onToggleBookmark={handleToggleBookmark}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </FloatingPanel>
  );
};

export const ThreadOutlineWindow = memo(ThreadOutlineWindowComponent);
