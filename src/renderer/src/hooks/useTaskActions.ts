import { useCallback, useMemo } from 'react';

import { updateTaskState, clearSession, setMessages, setWorkflowLogs, setHasWorkflowHistory } from '@/stores/taskStore';
import { convertTaskStateMessages } from '@/utils/task-messages';
import { setTaskAllFiles } from '@/stores/taskFilesStore';
import { useProjectStore } from '@/stores/projectStore';
import { getTaskDir } from '@/utils/task-utils';
import { useApi } from '@/contexts/ApiContext';

type UseTaskActionsParams = {
  baseDir: string;
};

export const useTaskActions = ({ baseDir }: UseTaskActionsParams) => {
  const api = useApi();

  const loadTask = useCallback(
    async (taskId: string) => {
      try {
        updateTaskState(taskId, { loading: true });

        const hasWorkflowHistory = useProjectStore.getState().projectTasksMap.get(baseDir)?.find((t) => t.id === taskId)?.hasWorkflowHistory === true;
        const [state, workflow] = await Promise.all([
          api.loadTask(baseDir, taskId),
          hasWorkflowHistory
            ? api.loadWorkflowLogs(baseDir, taskId).catch((error) => {
                // eslint-disable-next-line no-console
                console.error('Failed to load workflow logs:', error);
                return null;
              })
            : Promise.resolve(null),
        ]);

        const { messages: stateMessages, files, todoItems, question, queuedPrompts } = state;
        const messages = convertTaskStateMessages(stateMessages);

        setMessages(taskId, (existingMessages) => [
          ...messages,
          ...existingMessages.filter((existingMessage) => !messages.some((message) => message.id === existingMessage.id)),
        ]);
        setHasWorkflowHistory(taskId, hasWorkflowHistory);
        setWorkflowLogs(taskId, workflow?.logs ?? []);
        updateTaskState(taskId, {
          loading: false,
          loaded: true,
          contextFiles: files,
          todoItems: todoItems || [],
          question,
          queuedPrompts,
          lastActiveAt: new Date(),
        });
      } catch (error) {
        updateTaskState(taskId, { loading: false });
        // eslint-disable-next-line no-console
        console.error('Failed to load task:', error);
      }
    },
    [api, baseDir],
  );

  const resetTask = useCallback(
    (taskId: string) => {
      api.resetTask(baseDir, taskId);
      clearSession(taskId);
      setMessages(taskId, () => []);
    },
    [api, baseDir],
  );

  const restartAiderConnector = useCallback(
    (taskId: string) => {
      api.restartAiderConnector(baseDir, taskId);
    },
    [api, baseDir],
  );

  const answerQuestion = useCallback(
    (taskId: string, answer: string) => {
      api.answerQuestion(baseDir, taskId, answer);
      updateTaskState(taskId, { question: null });
    },
    [api, baseDir],
  );

  const interruptResponse = useCallback(
    (taskId: string, interruptId?: string) => {
      api.interruptResponse(baseDir, taskId, interruptId);
      updateTaskState(taskId, {
        question: null,
      });
    },
    [api, baseDir],
  );

  const updateTaskAgentProfile = useCallback(
    (taskId: string, agentProfileId: string, provider: string, model: string) => {
      void api.updateTask(baseDir, taskId, {
        agentProfileId,
        provider,
        model,
      });
    },
    [api, baseDir],
  );

  const refreshAllFiles = useCallback(
    async (taskId: string, useGit = true) => {
      const refreshedFiles = await api.getAllFiles(baseDir, taskId, useGit);
      const tasks = useProjectStore.getState().projectTasksMap.get(baseDir) || [];
      const task = tasks.find((t) => t.id === taskId);
      const taskDir = task ? getTaskDir(task) : baseDir;
      setTaskAllFiles(taskId, taskDir, refreshedFiles);
    },
    [api, baseDir],
  );

  const refreshContextFiles = useCallback(
    async (taskId: string) => {
      await api.refreshContextFiles(baseDir, taskId);
    },
    [api, baseDir],
  );

  const refreshTask = useCallback(
    async (taskId: string) => {
      try {
        const hasWorkflowHistory = useProjectStore.getState().projectTasksMap.get(baseDir)?.find((t) => t.id === taskId)?.hasWorkflowHistory === true;
        const [state, workflow] = await Promise.all([
          api.loadTask(baseDir, taskId),
          hasWorkflowHistory
            ? api.loadWorkflowLogs(baseDir, taskId).catch((error) => {
                // eslint-disable-next-line no-console
                console.error('Failed to load workflow logs:', error);
                return null;
              })
            : Promise.resolve(null),
        ]);

        const { messages: stateMessages, files, todoItems, question, queuedPrompts } = state;
        const messages = convertTaskStateMessages(stateMessages);

        setMessages(taskId, () => messages);
        setHasWorkflowHistory(taskId, hasWorkflowHistory);
        setWorkflowLogs(taskId, workflow?.logs ?? []);
        updateTaskState(taskId, {
          loaded: true,
          contextFiles: files,
          todoItems: todoItems || [],
          question,
          queuedPrompts,
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to refresh task:', error);
      }
    },
    [api, baseDir],
  );

  return useMemo(
    () => ({
      loadTask,
      clearSession,
      resetTask,
      restartAiderConnector,
      answerQuestion,
      interruptResponse,
      updateTaskAgentProfile,
      refreshAllFiles,
      refreshContextFiles,
      refreshTask,
    }),
    [loadTask, resetTask, restartAiderConnector, answerQuestion, interruptResponse, updateTaskAgentProfile, refreshAllFiles, refreshContextFiles, refreshTask],
  );
};
