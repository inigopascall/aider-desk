import { memo } from 'react';
import { FaRegUser } from 'react-icons/fa';
import { MdBookmark, MdBookmarkBorder, MdOutlineLayers, MdOutlineRefresh } from 'react-icons/md';
import { RiRobot2Line } from 'react-icons/ri';
import { VscTerminal, VscTools } from 'react-icons/vsc';
import { clsx } from 'clsx';

import { OutlineItem } from './outline';

import { IconButton } from '@/components/common/IconButton';

type Props = {
  item: OutlineItem;
  bookmarked: boolean;
  bookmarkable: boolean;
  onSelect: (item: OutlineItem) => void;
  onToggleBookmark: (messageId: string) => void;
};

const getIcon = (kind: OutlineItem['kind']) => {
  switch (kind) {
    case 'user':
      return <FaRegUser className="w-3.5 h-3.5" />;
    case 'response':
    case 'assistant-group':
      return <RiRobot2Line className="w-3.5 h-3.5" />;
    case 'tool':
      return <VscTools className="w-3.5 h-3.5" />;
    case 'group':
      return <MdOutlineLayers className="w-3.5 h-3.5" />;
    case 'workflow-run':
      return <VscTerminal className="w-3.5 h-3.5" />;
    case 'reflected':
      return <MdOutlineRefresh className="w-3.5 h-3.5" />;
  }
};

const ThreadOutlineItemComponent = ({ item, bookmarked, bookmarkable, onSelect, onToggleBookmark }: Props) => {
  return (
    <div
      className={clsx(
        'group/item flex h-7 items-center gap-1 px-1 text-2xs',
        bookmarked && 'bg-bg-secondary-light/40',
      )}
      style={{ paddingLeft: item.depth * 12 }}
    >
      <span className="flex-shrink-0 text-text-muted-light">{getIcon(item.kind)}</span>
      <span
        className={clsx('min-w-0 flex-1 cursor-pointer select-none truncate', bookmarked ? 'text-text-primary' : 'text-text-muted')}
        title={item.title}
        onClick={() => onSelect(item)}
      >
        {item.title}
      </span>
      {bookmarkable && (
        <IconButton
          icon={bookmarked ? <MdBookmark className="w-3.5 h-3.5" /> : <MdBookmarkBorder className="w-3.5 h-3.5" />}
          onClick={() => onToggleBookmark(item.id)}
          className={clsx('flex-shrink-0 transition-opacity', bookmarked ? 'text-amber-400' : 'opacity-0 group-hover/item:opacity-100')}
        />
      )}
    </div>
  );
};

export const ThreadOutlineItem = memo(ThreadOutlineItemComponent);
