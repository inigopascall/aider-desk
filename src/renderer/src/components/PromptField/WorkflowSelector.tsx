import { memo } from 'react';
import { LuWorkflow } from 'react-icons/lu';
import { AVAILABLE_WORKFLOWS, getWorkflowColor, WorkflowInfo } from '@common/types';
import { clsx } from 'clsx';

import { Tooltip } from '@/components/ui/Tooltip';

type Props = {
  selectedWorkflowId: string | null;
  onWorkflowClick: (workflowId: string) => void;
  workflows?: WorkflowInfo[];
};

/**
 * Button selector for choosing which workflow to run.
 * Purely presentational: it reports which workflow was clicked and the
 * parent decides what that means (open configuration, select, or deselect).
 * When a `workflows` list is provided it is used (e.g. the per-project
 * enabled subset); otherwise all available workflows are shown.
 */
export const WorkflowSelector = memo(({ selectedWorkflowId, onWorkflowClick, workflows }: Props) => {
  const workflowList = workflows ?? AVAILABLE_WORKFLOWS;

  if (workflowList.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center bg-bg-secondary border border-border-default rounded-md h-[26px]">
      {workflowList.map((workflow, index) => {
        const isActive = selectedWorkflowId === workflow.id;
        return (
          <Tooltip key={workflow.id} content={workflow.name} delayDuration={500}>
            <button
              onClick={() => onWorkflowClick(workflow.id)}
              className={clsx(
                'flex items-center px-2 py-1 transition-colors duration-150 border border-transparent',
                isActive
                  ? 'bg-bg-tertiary-strong text-text-primary border-border-default-dark'
                  : 'text-text-muted hover:text-text-tertiary hover:bg-bg-tertiary',
                index === 0 && 'rounded-l-md',
                index === workflowList.length - 1 && 'rounded-r-md',
              )}
            >
              <div className="relative">
                <LuWorkflow className="w-3.5 h-3.5" />
                <span
                  className="absolute -top-0.5 -right-1 w-1.5 h-1.5 rounded-full ring-1 ring-bg-secondary"
                  style={{ backgroundColor: workflow.color ?? getWorkflowColor(workflow.id) }}
                />
              </div>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
});

WorkflowSelector.displayName = 'WorkflowSelector';
