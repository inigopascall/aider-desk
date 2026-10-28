import { clsx } from 'clsx';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { RiRobot2Line } from 'react-icons/ri';
import { LuWorkflow } from 'react-icons/lu';
import { ResponseMessage, getWorkflowColor } from '@common/types';

import { MessageBar } from './MessageBar';

import { useParsedContent } from '@/hooks/useParsedContent';

const flashQuoteSelection = (range: Range) => {
  if (!range.getClientRects) {
    return;
  }

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'quote-selection-fade';
  overlay.setAttribute('aria-hidden', 'true');

  rects.forEach((rect) => {
    const child = document.createElement('div');
    child.className = 'quote-selection-fade-rect';
    child.style.left = `${rect.left}px`;
    child.style.top = `${rect.top}px`;
    child.style.width = `${rect.width}px`;
    child.style.height = `${rect.height}px`;
    overlay.appendChild(child);
  });

  document.body.appendChild(overlay);
  window.setTimeout(() => overlay.remove(), 180);
};

type Props = {
  baseDir: string;
  message: ResponseMessage;
  allFiles: string[];
  renderMarkdown: boolean;
  compact?: boolean;
  hideMessageBar?: boolean;
  showThinking?: boolean;
  showActivityIndicator?: boolean;
  onRemove?: () => void;
  onFork?: () => void;
  onRemoveUpTo?: () => void;
  onQuoteSelection?: (text: string) => void;
};

export const ResponseMessageBlock = ({
  baseDir,
  message,
  allFiles,
  renderMarkdown,
  compact = false,
  hideMessageBar = false,
  showThinking = true,
  showActivityIndicator = false,
  onRemove,
  onFork,
  onRemoveUpTo,
  onQuoteSelection,
}: Props) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isQuoteSelecting, setIsQuoteSelecting] = useState(false);
  const baseClasses = 'rounded-md max-w-full text-xs bg-bg-secondary text-text-primary';

  const workflowMeta = message.promptContext?.workflow;

  const parsedContent = useParsedContent(baseDir, message.content, allFiles, renderMarkdown, showThinking, message.reasoning);

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (onQuoteSelection && event.button === 0 && event.ctrlKey) {
      setIsQuoteSelecting(true);
    }
  };

  useEffect(() => {
    if (!isQuoteSelecting) {
      return undefined;
    }

    const cancel = () => setIsQuoteSelecting(false);
    const handleMouseUp = (event: globalThis.MouseEvent) => {
      setIsQuoteSelecting(false);
      if (!event.ctrlKey || !onQuoteSelection) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }

      const range = selection.getRangeAt(0);
      const content = contentRef.current;
      if (!content || !content.contains(selection.anchorNode) || !content.contains(selection.focusNode)) {
        return;
      }

      const selectedText = selection.toString().trim();
      if (!selectedText) {
        return;
      }

      flashQuoteSelection(range);
      onQuoteSelection(selectedText);
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Escape') {
        cancel();
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', cancel);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isQuoteSelecting, onQuoteSelection]);

  if (!parsedContent || (Array.isArray(parsedContent) && parsedContent.length === 0)) {
    return null;
  }

  return (
    <div
      data-message-block
      className={clsx(
        baseClasses,
        'relative flex flex-col group',
        !renderMarkdown && 'break-words whitespace-pre-wrap',
        !compact && 'p-3 border border-border-dark-light',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-[1px] relative">
          {workflowMeta ? (
            <LuWorkflow className="w-4 h-4" style={{ color: getWorkflowColor(workflowMeta.workflowId) }} />
          ) : (
            <RiRobot2Line className="text-text-muted w-4 h-4" />
          )}
        </div>
        <div
          ref={contentRef}
          onMouseDown={handleMouseDown}
          data-response-content
          className={clsx('flex-grow-1 w-full overflow-hidden', isQuoteSelecting && 'quote-selection-source')}
        >
          {parsedContent}
        </div>
      </div>
      {!hideMessageBar && (
        <MessageBar
          message={message}
          content={message.content || message.reasoning}
          usageReport={message.usageReport}
          remove={onRemove}
          onFork={onFork}
          onRemoveUpTo={onRemoveUpTo}
          showActivityIndicator={showActivityIndicator}
        />
      )}
    </div>
  );
};
