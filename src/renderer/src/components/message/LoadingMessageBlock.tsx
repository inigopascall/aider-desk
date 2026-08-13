import { LoadingMessage } from '@common/types';

import { MessageActions } from '@/components/message/MessageActions';
import { TaskActivityIndicator } from '@/components/common/TaskActivityIndicator';
import { useSettingsStore } from '@/stores/settingsStore';

type Props = {
  message: LoadingMessage;
  baseDir: string;
  taskId: string;
  onInterrupt?: () => void;
};

export const LoadingMessageBlock = ({ message, baseDir, taskId, onInterrupt }: Props) => {
  const baseClasses = 'rounded-md p-3 max-w-full break-words whitespace-pre-wrap text-xs bg-bg-secondary border border-border-dark-light text-text-primary';
  const disableCssStreamingAnimations = useSettingsStore((state) => state.settings?.disableCssStreamingAnimations ?? true);

  // When CSS animations are disabled, show a stable red dot in its own
  // absolute-positioned slot and offset the text so it does not overlap.
  // Otherwise, show the loading text with the legacy animate-pulse and
  // without the dot wrapper.
  if (disableCssStreamingAnimations) {
    return (
      <div className={`${baseClasses} text-text-secondary relative group flex items-center`}>
        <span className="relative flex-grow min-h-4">
          <TaskActivityIndicator active className="absolute left-0 top-1/2 -translate-y-1/2" />
          <span className="absolute left-[18px] top-1/2 -translate-y-1/2">{message.content}</span>
        </span>
        {message.actionIds && (
          <div className="flex flex-wrap justify-end">
            <MessageActions actionIds={message.actionIds} baseDir={baseDir} taskId={taskId} onInterrupt={onInterrupt} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`${baseClasses} text-text-secondary relative group flex items-center`}>
      <span className="flex-grow min-h-4">
        <span className="animate-pulse">{message.content}</span>
      </span>
      {message.actionIds && (
        <div className="flex flex-wrap justify-end">
          <MessageActions actionIds={message.actionIds} baseDir={baseDir} taskId={taskId} onInterrupt={onInterrupt} />
        </div>
      )}
    </div>
  );
};
