import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MdKeyboardArrowDown, MdKeyboardArrowUp, MdKeyboardDoubleArrowDown } from 'react-icons/md';
import { Message } from '@common/types';

import { createBookmarkMarkers, getActiveBookmarkMarkerId } from './messageMapUtils';
import { MessageMapMarker } from './MessageMapMarker';

import { Tooltip } from '@/components/ui/Tooltip';
import { useTaskBookmarks } from '@/stores/bookmarkStore';

type Props = {
  taskId: string;
  messages: Message[];
  visibleIndex: number;
  onNavigate: (index: number, animated: boolean) => void;
  onScrollToBottom: () => void;
};

/** Map of the task's bookmarked messages at the left of the message list; hidden when the task has no bookmarks. */
export const MessageMap = memo(({ taskId, messages, visibleIndex, onNavigate, onScrollToBottom }: Props) => {
  const { t } = useTranslation();
  const bookmarks = useTaskBookmarks(taskId);
  const markers = useMemo(() => createBookmarkMarkers(messages, bookmarks), [messages, bookmarks]);
  const activeMarkerId = useMemo(() => getActiveBookmarkMarkerId(markers, visibleIndex), [markers, visibleIndex]);

  if (markers.length === 0) {
    return null;
  }

  const previous = [...markers].reverse().find((marker) => marker.index < visibleIndex);
  const next = markers.find((marker) => marker.index > visibleIndex);

  const buttonClassName =
    'flex h-6 w-7 shrink-0 items-center justify-center text-text-muted opacity-0 transition-opacity duration-200 hover:text-text-primary group-hover:opacity-100 disabled:opacity-30 focus-visible:outline focus-visible:outline-1 focus-visible:outline-text-primary rounded-sm';

  return (
    <nav
      aria-label={t('messages.map.title')}
      className="group absolute left-0 top-1/2 z-20 flex max-h-[calc(100%-4rem)] w-8 origin-left -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-r-md border-y border-r border-transparent bg-bg-primary-light/0 py-1.5 opacity-10 transition-all duration-200 hover:max-h-[calc((100%-4rem)/3)] hover:translate-x-0 hover:scale-[3] hover:border-border-default hover:bg-bg-primary-light hover:opacity-100"
    >
      <Tooltip content={t('messages.map.previousBookmark')} side="right">
        <button
          type="button"
          aria-label={t('messages.map.previousBookmark')}
          disabled={!previous}
          onClick={() => previous && onNavigate(previous.index, true)}
          className={buttonClassName}
        >
          <MdKeyboardArrowUp className="h-5 w-5" />
        </button>
      </Tooltip>
      <div className="w-full flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin scrollbar-track-bg-primary-light scrollbar-thumb-bg-tertiary hover:scrollbar-thumb-bg-fourth flex flex-col items-center gap-0.5 py-1">
        {markers.map((marker) => (
          <MessageMapMarker
            key={marker.id}
            turnNumber={marker.turnNumber}
            role={marker.role}
            index={marker.index}
            preview={marker.preview}
            active={activeMarkerId === marker.id}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      <Tooltip content={t('messages.map.nextBookmark')} side="right">
        <button
          type="button"
          aria-label={t('messages.map.nextBookmark')}
          disabled={!next}
          onClick={() => next && onNavigate(next.index, true)}
          className={buttonClassName}
        >
          <MdKeyboardArrowDown className="h-5 w-5" />
        </button>
      </Tooltip>
      <Tooltip content={t('messages.scrollToBottom')} side="right">
        <button type="button" aria-label={t('messages.scrollToBottom')} onClick={onScrollToBottom} className={buttonClassName}>
          <MdKeyboardDoubleArrowDown className="h-5 w-5" />
        </button>
      </Tooltip>
    </nav>
  );
});

MessageMap.displayName = 'MessageMap';
