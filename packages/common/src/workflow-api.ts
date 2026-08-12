import type { ApplicationAPI } from './api';
import type { WorkflowLogData, WorkflowLogsUpdatedData } from './types';

export interface WorkflowLogAPI {
  addWorkflowLogListener: (baseDir: string, taskId: string, callback: (data: WorkflowLogData) => void) => () => void;
  addWorkflowLogsUpdatedListener: (baseDir: string, taskId: string, callback: (data: WorkflowLogsUpdatedData) => void) => () => void;
}

export type ApplicationAPIWithWorkflowLogs = ApplicationAPI & WorkflowLogAPI;