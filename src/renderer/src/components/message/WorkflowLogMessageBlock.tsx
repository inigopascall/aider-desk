import { FaExclamationTriangle, FaExclamationCircle } from 'react-icons/fa';
import { LuWorkflow } from 'react-icons/lu';
import { MdClose } from 'react-icons/md';
import { useTranslation } from 'react-i18next';
import { WorkflowLogMessage } from '@common/types';
import { clsx } from 'clsx';

import { CopyMessageButton } from './CopyMessageButton';
import { MessageActions } from './MessageActions';

import { IconButton } from '@/components/common/IconButton';
import { useParsedContent } from '@/hooks/useParsedContent';

type Props = {
  baseDir: string;
  taskId: string;
  message: WorkflowLogMessage;
  onRemove?: () => void;
  compact?: boolean;
  onInterrupt?: () => void;
};

export const WorkflowLogMessageBlock = ({ baseDir, taskId, message, onRemove, compact = false, onInterrupt }: Props) => {
  const { t } = useTranslation();
  const translatedContent = t(message.content);
  const parsedContent = useParsedContent(baseDir, translatedContent, [], true, false);
  const baseClasses = 'rounded-md p-3 max-w-full break-words whitespace-pre-wrap text-xs border';

  const levelConfig = {
    info: {
      levelClasses: 'bg-bg-secondary border-bg-tertiary-strong text-text-primary',
      tooltipClass: 'text-text-muted hover:text-text-muted-light',
      Icon: LuWorkflow,
    },
    warning: {
      levelClasses: 'bg-warning-subtle border-warning-emphasis text-agent-context-files',
      tooltipClass: 'text-warning hover:text-warning-light',
      Icon: FaExclamationTriangle,
    },
    error: {
      levelClasses: 'bg-error-muted border-error-emphasis text-diffViewerTextPrimary',
      tooltipClass: 'text-error-light hover:text-diffViewerTextPrimary',
      Icon: FaExclamationCircle,
    },
  };

  const config = levelConfig[message.level] || levelConfig.info;
  const Icon = config.Icon;

  const renderMessage = () => (
    <div className="flex items-start gap-3 min-w-0">
      <Icon className="inline-block h-3 w-3 flex-shrink-0 mt-[3px]" />
      <div className="min-w-0 flex-1 overflow-hidden" title={`${message.workflowName} (${message.runId})`}>
        {parsedContent}
      </div>
    </div>
  );

  if (compact) {
    return renderMessage();
  }

  return (
    <div className={`${baseClasses} ${config.levelClasses} relative group flex items-center justify-between`}>
      {renderMessage()}
      <div className="flex items-center gap-4">
        {message.actionIds && (
          <div className="flex flex-wrap justify-end">
            <MessageActions actionIds={message.actionIds} baseDir={baseDir} taskId={taskId} onInterrupt={onInterrupt} />
          </div>
        )}
        <div className="flex items-center space-x-1">
          <CopyMessageButton
            content={translatedContent}
            className={clsx(config.tooltipClass, 'transition-colors text-text-dark group-hover:text-text-muted-light')}
            alwaysShow={true}
          />
          {onRemove && (
            <IconButton
              icon={<MdClose className="w-4 h-4" />}
              onClick={onRemove}
              tooltip={t('common.remove')}
              className={clsx(config.tooltipClass, 'p-1 rounded transition-colors text-text-dark group-hover:text-text-muted-light duration-200')}
            />
          )}
        </div>
      </div>
    </div>
  );
};
