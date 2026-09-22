import { useShallow } from 'zustand/react/shallow';
import { ContextFile, ModelsData, QueuedPromptData, QuestionData, TodoItem, TokensInfoData, Message, WorkflowLogData, isLogMessage, isLoadingMessage } from '@common/types';
import { createWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/vanilla/shallow';
import { devtools } from 'zustand/middleware';
import { groupWorkflowLogsByRun } from '@/utils/workflow-messages';

export interface TaskState {
  loading: boolean;
  loaded: boolean;
  tokensInfo: TokensInfoData | null;
  question: QuestionData | null;
  todoItems: TodoItem[];
  contextFiles: ContextFile[];
  aiderModelsData: ModelsData | null;
  lastActiveAt: Date | null;
  queuedPrompts: QueuedPromptData[];
  canUndoContextChange: boolean;
}

export const EMPTY_TASK_STATE: TaskState = {
  loading: false,
  loaded: false,
  tokensInfo: null,
  question: null,
  todoItems: [],
  contextFiles: [],
  aiderModelsData: null,
  lastActiveAt: null,
  queuedPrompts: [],
  canUndoContextChange: false,
};

export const EMPTY_MESSAGES: Message[] = [];

export interface WorkflowRunState {
  runId: string;
  workflowId: string;
  workflowName: string;
  logs: WorkflowLogData[];
}

const taskPendingMessages = new Map<string, Message[]>();
const lastActiveAtThrottleMap = new Map<string, number>();
const TOUCH_THROTTLE_MS = 60_000;

interface TaskStore {
  taskStateMap: Map<string, TaskState>;
  taskMessagesMap: Map<string, Message[]>;
  taskWorkflowRunsMap: Map<string, WorkflowRunState[]>;
  taskHasWorkflowHistoryMap: Map<string, boolean>;

  updateTaskState: (taskId: string, updates: Partial<TaskState>) => void;
  setMessages: (taskId: string, updateMessages: (prev: Message[]) => Message[]) => void;
  setTodoItems: (taskId: string, updateTodoItems: (prev: TodoItem[]) => TodoItem[]) => void;
  setTokensInfo: (taskId: string, tokensInfo: TokensInfoData | null) => void;
  setQuestion: (taskId: string, question: QuestionData | null) => void;
  setAiderModelsData: (taskId: string, modelsData: ModelsData | null) => void;
  setQueuedPrompts: (taskId: string, queuedPrompts: QueuedPromptData[]) => void;
  setWorkflowLogs: (taskId: string, logs: WorkflowLogData[]) => void;
  appendWorkflowLog: (taskId: string, log: WorkflowLogData) => void;
  clearWorkflowRuns: (taskId: string) => void;
  setHasWorkflowHistory: (taskId: string, value: boolean) => void;
  clearSession: (taskId: string) => void;
  unloadTask: (taskId: string) => void;
  unloadTasks: (taskIds: string[]) => void;
}

const DEVTOOLS_OPTIONS = {
  name: 'TaskStore',
  enabled: import.meta.env.DEV,
  serialize: {
    options: {
      map: true,
      set: true,
    },
  },
};

export const useTaskStore = createWithEqualityFn<TaskStore>()(
  devtools(
    (set, get) => ({
      taskStateMap: new Map(),
      taskMessagesMap: new Map(),
      taskWorkflowRunsMap: new Map(),
      taskHasWorkflowHistoryMap: new Map(),

      updateTaskState: (taskId, updates) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, { ...current, ...updates });
          return { taskStateMap: newMap };
        }),

      setMessages: (taskId, updateMessages) => {
        const pendingMessages = taskPendingMessages.get(taskId);
        taskPendingMessages.set(taskId, updateMessages(pendingMessages || get().taskMessagesMap.get(taskId) || []));

        if (pendingMessages) {
          // we are already in a pending state, no need to update
          return;
        }
        requestAnimationFrame(() => {
          set((state) => {
            if (!taskPendingMessages.has(taskId)) {
              return state;
            }

            const newMessagesMap = new Map(state.taskMessagesMap);
            newMessagesMap.set(taskId, taskPendingMessages.get(taskId) || []);
            taskPendingMessages.delete(taskId);
            return { taskMessagesMap: newMessagesMap };
          });
        });
      },

      setTodoItems: (taskId, updateTodoItems) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, {
            ...current,
            todoItems: updateTodoItems(current.todoItems),
          });
          return { taskStateMap: newMap };
        }),

      setTokensInfo: (taskId, tokensInfo) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, { ...current, tokensInfo });
          return { taskStateMap: newMap };
        }),

      setQuestion: (taskId, question) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, { ...current, question });
          return { taskStateMap: newMap };
        }),

      setAiderModelsData: (taskId, modelsData) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, { ...current, aiderModelsData: modelsData });
          return { taskStateMap: newMap };
        }),

      setQueuedPrompts: (taskId, queuedPrompts) =>
        set((state) => {
          const newMap = new Map(state.taskStateMap);
          const current = newMap.get(taskId) || EMPTY_TASK_STATE;
          newMap.set(taskId, { ...current, queuedPrompts });
          return { taskStateMap: newMap };
        }),

      setWorkflowLogs: (taskId, logs) =>
        set((state) => {
          const newMap = new Map(state.taskWorkflowRunsMap);
          newMap.set(taskId, groupWorkflowLogsByRun(logs));
          return { taskWorkflowRunsMap: newMap };
        }),

      appendWorkflowLog: (taskId, log) =>
        set((state) => {
          const currentRuns = state.taskWorkflowRunsMap.get(taskId) || [];
          const existingRun = currentRuns.find((run) => run.runId === log.runId);
          if (existingRun) {
            if (existingRun.logs.some((l) => l.id === log.id)) {
              return state;
            }
            const newLogs = [...existingRun.logs, log].sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp);
            const newRuns = currentRuns.map((run) => (run.runId === log.runId ? { ...run, logs: newLogs } : run));
            const newMap = new Map(state.taskWorkflowRunsMap);
            newMap.set(taskId, newRuns);
            return { taskWorkflowRunsMap: newMap };
          }
          const newRuns = [...currentRuns, { runId: log.runId, workflowId: log.workflowId, workflowName: log.workflowName, logs: [log] }];
          const newMap = new Map(state.taskWorkflowRunsMap);
          newMap.set(taskId, newRuns);
          return { taskWorkflowRunsMap: newMap };
        }),

      clearWorkflowRuns: (taskId) =>
        set((state) => {
          if (!state.taskWorkflowRunsMap.has(taskId)) {
            return state;
          }
          const newMap = new Map(state.taskWorkflowRunsMap);
          newMap.delete(taskId);
          return { taskWorkflowRunsMap: newMap };
        }),

      setHasWorkflowHistory: (taskId, value) =>
        set((state) => {
          const newMap = new Map(state.taskHasWorkflowHistoryMap);
          newMap.set(taskId, value);
          return { taskHasWorkflowHistoryMap: newMap };
        }),

      clearSession: (taskId) =>
        set((state) => {
          const newStateMap = new Map(state.taskStateMap);
          const current = newStateMap.get(taskId) || EMPTY_TASK_STATE;

          newStateMap.set(taskId, {
            ...current,
            question: null,
            tokensInfo: null,
          });
          return { taskStateMap: newStateMap };
        }),

      unloadTask: (taskId) =>
        set((state) => {
          const newStateMap = new Map(state.taskStateMap);
          const newMessagesMap = new Map(state.taskMessagesMap);
          const newWorkflowRunsMap = new Map(state.taskWorkflowRunsMap);
          const newHasWorkflowHistoryMap = new Map(state.taskHasWorkflowHistoryMap);
          newStateMap.set(taskId, { ...EMPTY_TASK_STATE, loaded: false });
          newMessagesMap.delete(taskId);
          newWorkflowRunsMap.delete(taskId);
          newHasWorkflowHistoryMap.delete(taskId);
          taskPendingMessages.delete(taskId);
          lastActiveAtThrottleMap.delete(taskId);
          return {
            taskStateMap: newStateMap,
            taskMessagesMap: newMessagesMap,
            taskWorkflowRunsMap: newWorkflowRunsMap,
            taskHasWorkflowHistoryMap: newHasWorkflowHistoryMap,
          };
        }),

      unloadTasks: (taskIds) =>
        set((state) => {
          const newStateMap = new Map(state.taskStateMap);
          const newMessagesMap = new Map(state.taskMessagesMap);
          const newWorkflowRunsMap = new Map(state.taskWorkflowRunsMap);
          const newHasWorkflowHistoryMap = new Map(state.taskHasWorkflowHistoryMap);
          for (const taskId of taskIds) {
            newStateMap.set(taskId, { ...EMPTY_TASK_STATE, loaded: false });
            newMessagesMap.delete(taskId);
            newWorkflowRunsMap.delete(taskId);
            newHasWorkflowHistoryMap.delete(taskId);
            taskPendingMessages.delete(taskId);
            lastActiveAtThrottleMap.delete(taskId);
          }
          return {
            taskStateMap: newStateMap,
            taskMessagesMap: newMessagesMap,
            taskWorkflowRunsMap: newWorkflowRunsMap,
            taskHasWorkflowHistoryMap: newHasWorkflowHistoryMap,
          };
        }),
    }),
    DEVTOOLS_OPTIONS,
  ),
  shallow,
);

// Module-level action functions (no hook subscription required)
export const updateTaskState = (taskId: string, updates: Partial<TaskState>) => useTaskStore.getState().updateTaskState(taskId, updates);

export const setMessages = (taskId: string, updateMessages: (prev: Message[]) => Message[]) => useTaskStore.getState().setMessages(taskId, updateMessages);

export const removeMessageActionId = (taskId: string, messageId: string, actionId: string) =>
  setMessages(taskId, (prevMessages) =>
    prevMessages.map((message) =>
      message.id === messageId && (isLogMessage(message) || isLoadingMessage(message)) && message.actionIds
        ? { ...message, actionIds: message.actionIds.filter((id) => id !== actionId) }
        : message,
    ),
  );

export const setTodoItems = (taskId: string, updateTodoItems: (prev: TodoItem[]) => TodoItem[]) =>
  useTaskStore.getState().setTodoItems(taskId, updateTodoItems);

export const setTokensInfo = (taskId: string, tokensInfo: TokensInfoData | null) => useTaskStore.getState().setTokensInfo(taskId, tokensInfo);

export const setQuestion = (taskId: string, question: QuestionData | null) => useTaskStore.getState().setQuestion(taskId, question);

export const setAiderModelsData = (taskId: string, modelsData: ModelsData | null) => useTaskStore.getState().setAiderModelsData(taskId, modelsData);

export const setQueuedPrompts = (taskId: string, queuedPrompts: QueuedPromptData[]) => useTaskStore.getState().setQueuedPrompts(taskId, queuedPrompts);

export const setWorkflowLogs = (taskId: string, logs: WorkflowLogData[]) => useTaskStore.getState().setWorkflowLogs(taskId, logs);

export const appendWorkflowLog = (taskId: string, log: WorkflowLogData) => useTaskStore.getState().appendWorkflowLog(taskId, log);

export const clearWorkflowRuns = (taskId: string) => useTaskStore.getState().clearWorkflowRuns(taskId);

export const setHasWorkflowHistory = (taskId: string, value: boolean) => useTaskStore.getState().setHasWorkflowHistory(taskId, value);

export const clearSession = (taskId: string) => useTaskStore.getState().clearSession(taskId);

export const unloadTask = (taskId: string) => useTaskStore.getState().unloadTask(taskId);

export const unloadTasks = (taskIds: string[]) => useTaskStore.getState().unloadTasks(taskIds);

export const touchTaskActivity = (taskId: string) => {
  const state = useTaskStore.getState().taskStateMap.get(taskId);
  if (!state?.loaded) {
    return;
  }

  const now = Date.now();
  const lastUpdate = lastActiveAtThrottleMap.get(taskId);
  if (lastUpdate && now - lastUpdate < TOUCH_THROTTLE_MS) {
    return;
  }
  lastActiveAtThrottleMap.set(taskId, now);
  updateTaskState(taskId, { lastActiveAt: new Date() });
};

export const useOptimizedTaskState = (taskId: string) =>
  useTaskStore(
    useShallow((state) => {
      const { tokensInfo: _, todoItems: _ti, queuedPrompts: _qp, lastActiveAt: _la, ...optimizedTaskState } = state.taskStateMap.get(taskId) || EMPTY_TASK_STATE;
      return optimizedTaskState;
    }),
  );

export const useTaskTokensInfo = (taskId: string) => useTaskStore((state) => state.taskStateMap.get(taskId)?.tokensInfo ?? null);

export const useTaskFileTokensInfo = (taskId: string) => useTaskStore((state) => state.taskStateMap.get(taskId)?.tokensInfo?.files ?? null);

export const useTaskQuestion = (taskId: string) => useTaskStore((state) => state.taskStateMap.get(taskId)?.question ?? null);

export const useTaskTodoItems = (taskId: string) =>
  useTaskStore(useShallow((state) => state.taskStateMap.get(taskId)?.todoItems ?? EMPTY_TASK_STATE.todoItems));

export const useTaskQueuedPrompts = (taskId: string) =>
  useTaskStore(useShallow((state) => state.taskStateMap.get(taskId)?.queuedPrompts ?? EMPTY_TASK_STATE.queuedPrompts));

export const useTaskMessages = (taskId: string) => useTaskStore(useShallow((state) => state.taskMessagesMap.get(taskId) || EMPTY_MESSAGES));

export const useTaskLoaded = (taskId: string) => useTaskStore((state) => state.taskStateMap.get(taskId)?.loaded ?? false);

export const EMPTY_WORKFLOW_RUNS: WorkflowRunState[] = [];
export const useTaskWorkflowRuns = (taskId: string) =>
  useTaskStore(useShallow((state) => state.taskWorkflowRunsMap.get(taskId) ?? EMPTY_WORKFLOW_RUNS));
export const useTaskHasWorkflowHistory = (taskId: string) =>
  useTaskStore((state) => state.taskHasWorkflowHistoryMap.get(taskId) ?? false);
