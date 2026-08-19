import { useEffect, useState } from 'react';
import { FaExclamationTriangle, FaExclamationCircle } from 'react-icons/fa';
import { LuWorkflow } from 'react-icons/lu';
import { MdKeyboardArrowDown, MdKeyboardArrowRight } from 'react-icons/md';
import { WorkflowRunMessage, WorkflowLogData } from '@common/types';
import { clsx } from 'clsx';

import { CopyMessageButton } from './CopyMessageButton';

import { getWorkflowColor } from '@common/types';
import { useParsedContent } from '@/hooks/useParsedContent';

type Props = {
  baseDir: string;
  taskId: string;
  message: WorkflowRunMessage;
  inProgress?: boolean;
};

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

const WorkflowLogRow = ({ baseDir, log }: { baseDir: string; log: WorkflowLogData }) => {
  const config = levelConfig[log.level] || levelConfig.info;
  const Icon = config.Icon;
  const parsedContent = useParsedContent(baseDir, log.message, [], true, false);

  return (
    <div className="flex items-start gap-3 min-w-0 group/row">
      <Icon className="inline-block h-3 w-3 flex-shrink-0 mt-[3px]" />
      <div className="min-w-0 flex-1 overflow-hidden">{parsedContent}</div>
      <CopyMessageButton
        content={log.message}
        className={clsx(config.tooltipClass, 'transition-colors text-text-dark group-hover/row:text-text-muted-light')}
      />
    </div>
  );
};

export const WorkflowRunMessageBlock = ({ baseDir, taskId, message, inProgress = false }: Props) => {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (inProgress && message.isLatestRun) setExpanded(true);
  }, [inProgress, message.isLatestRun]);

  const warningCount = message.logs.filter((log) => log.level === 'warning').length;
  const errorCount = message.logs.filter((log) => log.level === 'error').length;
  const copyAllContent = message.logs.map((log) => log.message).join('\n\n');

  return (
    <div className="rounded-md p-3 max-w-full break-words whitespace-pre-wrap text-xs border border-border-dark-light bg-bg-secondary">
      <button
        type="button"
        className="w-full flex items-center gap-2 text-left"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <LuWorkflow className="h-4 w-4 flex-shrink-0" style={{ color: getWorkflowColor(message.workflowId) }} />
        <span className="text-xs font-semibold flex-1 truncate">{message.workflowName}</span>
        <span className="text-text-muted text-2xs">{message.logs.length} events</span>
        {warningCount > 0 && (
          <span className="text-warning text-2xs font-semibold bg-warning-subtle border border-warning-emphasis rounded px-1.5 py-0.5">{warningCount}</span>
        )}
        {errorCount > 0 && (
          <span className="text-error-light text-2xs font-semibold bg-error-muted border border-error-emphasis rounded px-1.5 py-0.5">{errorCount}</span>
        )}
        <CopyMessageButton content={copyAllContent} alwaysShow={true} />
        {expanded ? <MdKeyboardArrowDown className="h-4 w-4 flex-shrink-0" /> : <MdKeyboardArrowRight className="h-4 w-4 flex-shrink-0" />}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 pl-1">
          {message.logs.map((log) => (
            <WorkflowLogRow key={log.id} baseDir={baseDir} log={log} />
          ))}
        </div>
      )}
    </div>
  );
};
