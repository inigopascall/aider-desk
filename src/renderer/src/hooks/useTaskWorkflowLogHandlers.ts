import { useCallback, useEffect } from 'react';

import type { WorkflowLogData } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { setMessages, touchTaskActivity } from '@/stores/taskStore';
import { convertWorkflowLogToMessage } from '@/utils/task-messages';

export const useTaskWorkflowLogHandlers = (baseDir: string, taskId: string) => {
  const api = useApi();

  const handleWorkflowLog = useCallback(
    (data: WorkflowLogData) => {
      touchTaskActivity(taskId);
      const message = convertWorkflowLogToMessage(data);
      setMessages(taskId, (prevMessages) => [...prevMessages.filter((message) => message.type !== 'loading'), message]);
    },
    [taskId],
  );

  useEffect(() => {
    const removeListener = api.addWorkflowLogListener(baseDir, taskId, handleWorkflowLog);
    return () => {
      removeListener();
    };
  }, [api, baseDir, taskId, handleWorkflowLog]);
};
