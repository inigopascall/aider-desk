import { LoadingMessage } from '@common/types';

import { MessageActions } from '@/components/message/MessageActions';
import { TaskActivityIndicator } from '@/components/common/TaskActivityIndicator';

type Props = {
  message: LoadingMessage;
  baseDir: string;
  taskId: string;
  onInterrupt?: () => void;
  showActivityIndicator: boolean;
};

export const LoadingMessageBlock = ({ message, baseDir, taskId, onInterrupt, showActivityIndicator }: Props) => {
  const baseClasses = 'rounded-md p-3 max-w-full break-words whitespace-pre-wrap text-xs bg-bg-secondary border border-border-dark-light text-text-primary';

  return (
    <div className={`${baseClasses} text-text-secondary relative group flex items-center`}>
      <span className="relative flex-grow min-h-4">
        <TaskActivityIndicator active={showActivityIndicator} className={showActivityIndicator ? 'absolute left-0 top-1/2 -translate-y-1/2' : undefined} />
        <span
          className={showActivityIndicator ? 'absolute left-[18px] top-1/2 -translate-y-1/2' : undefined}
        >
          {message.content}
        </span>
      </span>
      {message.actionIds && (
        <div className="flex flex-wrap justify-end">
          <MessageActions actionIds={message.actionIds} baseDir={baseDir} taskId={taskId} onInterrupt={onInterrupt} />
        </div>
      )}
    </div>
  );
};
