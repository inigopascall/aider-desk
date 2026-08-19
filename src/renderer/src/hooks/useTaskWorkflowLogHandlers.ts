import { useCallback, useEffect, useRef } from 'react';

import type { WorkflowLogData } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { appendWorkflowLog, clearWorkflowRuns, setHasWorkflowHistory, setWorkflowLogs, touchTaskActivity } from '@/stores/taskStore';

export const useTaskWorkflowLogHandlers = (baseDir: string, taskId: string, enabled: boolean) => {
  const api = useApi();
  const lastSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const { logs } = await api.loadWorkflowLogs(baseDir, taskId);
      setWorkflowLogs(taskId, logs);
      lastSequenceRef.current = logs.reduce((max, log) => Math.max(max, log.sequence), 0);
    } catch (error) {
      // Errors leave existing state untouched.
      // eslint-disable-next-line no-console
      console.error('Failed to refresh workflow logs:', error);
    }
  }, [api, baseDir, taskId]);

  const handleWorkflowLog = useCallback(
    (data: WorkflowLogData) => {
      touchTaskActivity(taskId);
      setHasWorkflowHistory(taskId, true);
      appendWorkflowLog(taskId, data);

      // Gap logic: idempotent late delivery, self-healing on dropped events.
      if (data.sequence <= lastSequenceRef.current) {
        return;
      }
      if (data.sequence > lastSequenceRef.current + 1) {
        void refresh();
        return;
      }
      lastSequenceRef.current = data.sequence;
    },
    [taskId, refresh],
  );

  useEffect(() => {
    if (!enabled) {
      clearWorkflowRuns(taskId);
      return;
    }
    void refresh(); // hydrate on enable — covers the race before the first live event
    return api.addWorkflowLogListener(baseDir, taskId, handleWorkflowLog);
  }, [api, baseDir, taskId, enabled, refresh, handleWorkflowLog]);
};
