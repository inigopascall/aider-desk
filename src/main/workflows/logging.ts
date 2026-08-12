import { v4 as uuidv4 } from 'uuid';

import type { WorkflowRunInfo } from '@common/types';
import type { Task } from '@/task';

import type { WorkflowDefinition, WorkflowLogger } from './types';

export function createWorkflowRun(workflow: WorkflowDefinition): WorkflowRunInfo {
  return {
    runId: uuidv4(),
    workflowId: workflow.id,
    workflowName: workflow.name,
  };
}

export function createWorkflowLogger(task: Task, run: WorkflowRunInfo): WorkflowLogger {
  const emit = async (level: 'info' | 'warning' | 'error', message: string): Promise<void> => {
    await task.addWorkflowLogMessage(run, level, message);
  };

  return {
    run,
    info: (message) => emit('info', message),
    warning: (message) => emit('warning', message),
    error: (message) => emit('error', message),
    summary: (content, kind, label) => task.addWorkflowSummaryMessage(run, content, kind, label),
  };
}
