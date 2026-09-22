import { clsx } from 'clsx';
import { RiRobot2Line } from 'react-icons/ri';
import { LuWorkflow } from 'react-icons/lu';
import { ResponseMessage, getWorkflowColor } from '@common/types';

import { MessageBar } from './MessageBar';

import { useParsedContent } from '@/hooks/useParsedContent';

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
}: Props) => {
  const baseClasses = 'rounded-md max-w-full text-xs bg-bg-secondary text-text-primary';

  const workflowMeta = message.promptContext?.workflow;

  const parsedContent = useParsedContent(baseDir, message.content, allFiles, renderMarkdown, showThinking, message.reasoning);

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
        <div className="flex-grow-1 w-full overflow-hidden">{parsedContent}</div>
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
