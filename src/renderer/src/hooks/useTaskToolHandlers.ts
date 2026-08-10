import { useCallback, useEffect } from 'react';
import { TODO_TOOL_CLEAR_ITEMS, TODO_TOOL_GET_ITEMS, TODO_TOOL_GROUP_NAME, TODO_TOOL_SET_ITEMS, TODO_TOOL_UPDATE_ITEM_COMPLETION } from '@common/tools';

import type { TodoItem, ToolData, ToolInputChunkData, ToolMessage } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { setMessages, setTodoItems, touchTaskActivity } from '@/stores/taskStore';
import { useSettingsStore } from '@/stores/settingsStore';

import { flushCommandOutput } from './useTaskCommandHandlers';

const STREAM_FLUSH_INTERVAL_MS = 200;

const activeToolInputIds = new Map<string, Set<string>>();
const toolInputChunkBuffers = new Map<string, ToolInputChunkData[]>();
const toolInputChunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Applies a single tool input chunk to the task's messages.
 * This is the core logic extracted from handleToolInputChunk to support both
 * immediate and buffered application of chunks.
 */
function applyToolInputChunk(taskId: string, { toolCallId, serverName, toolName, partialArgs, isComplete, promptContext }: ToolInputChunkData): void {
  setMessages(taskId, (prevMessages) => {
    const existingIndex = prevMessages.findIndex((m) => m.id === toolCallId);
    if (existingIndex !== -1) {
      const updated = [...prevMessages];
      const existing = updated[existingIndex] as ToolMessage;
      updated[existingIndex] = {
        ...existing,
        args: (partialArgs as Record<string, unknown>) || existing.args,
        isStreaming: !isComplete,
        promptContext: promptContext ?? existing.promptContext,
      } as ToolMessage;
      return updated;
    }
    const newToolMessage: ToolMessage = {
      id: toolCallId,
      type: 'tool',
      serverName: serverName || '',
      toolName: toolName || '',
      args: (partialArgs as Record<string, unknown>) || {},
      content: '',
      isStreaming: !isComplete,
      promptContext,
      timestamp: Date.now(),
    };
    const loadingMessages = prevMessages.filter((m) => m.type === 'loading');
    const nonLoadingMessages = prevMessages.filter((m) => m.type !== 'loading' && m.id !== toolCallId);
    return [...nonLoadingMessages, newToolMessage, ...loadingMessages];
  });
}

/**
 * Buffers a tool input chunk for later flushing.
 * If no flush timer exists for this task, schedules one.
 */
function bufferToolInputChunk(taskId: string, data: ToolInputChunkData): void {
  let buffer = toolInputChunkBuffers.get(taskId);
  if (!buffer) {
    buffer = [];
    toolInputChunkBuffers.set(taskId, buffer);
  }
  buffer.push(data);

  // Schedule a flush if one isn't already scheduled
  if (!toolInputChunkFlushTimers.has(taskId)) {
    const timer = setTimeout(() => flushToolInputChunks(taskId), STREAM_FLUSH_INTERVAL_MS);
    toolInputChunkFlushTimers.set(taskId, timer);
  }
}

/**
 * Flushes all buffered tool input chunks for a task.
 * Clears the buffer and timer, then applies each chunk in order.
 */
export function flushToolInputChunks(taskId: string): void {
  const timer = toolInputChunkFlushTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    toolInputChunkFlushTimers.delete(taskId);
  }

  const buffer = toolInputChunkBuffers.get(taskId);
  if (buffer && buffer.length > 0) {
    toolInputChunkBuffers.delete(taskId);
    for (const data of buffer) {
      applyToolInputChunk(taskId, data);
    }
  }
}

export const useTaskToolHandlers = (baseDir: string, taskId: string) => {
  const api = useApi();
  const performanceMode = useSettingsStore((s) => s.settings?.performanceMode ?? true);

  const handleTodoTool = useCallback(
    (toolName: string, args: Record<string, unknown> | undefined, response: string | undefined) => {
      try {
        switch (toolName) {
          case TODO_TOOL_SET_ITEMS: {
            if (args?.items && Array.isArray(args.items)) {
              setTodoItems(taskId, () => args.items as TodoItem[]);
            }
            break;
          }
          case TODO_TOOL_GET_ITEMS: {
            if (response) {
              try {
                const parsedResponse = JSON.parse(response);
                if (parsedResponse.items && Array.isArray(parsedResponse.items)) {
                  setTodoItems(taskId, () => parsedResponse.items);
                }
              } catch {
                if (response.includes('No todo items found')) {
                  setTodoItems(taskId, () => []);
                }
              }
            }
            break;
          }
          case TODO_TOOL_UPDATE_ITEM_COMPLETION: {
            if (args?.name && typeof args.completed === 'boolean') {
              setTodoItems(taskId, (prev) => prev.map((item) => (item.name === args.name ? { ...item, completed: args.completed as boolean } : item)));
            }
            break;
          }
          case TODO_TOOL_CLEAR_ITEMS: {
            setTodoItems(taskId, () => []);
            break;
          }
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Error handling TODO tool:', error);
      }
    },
    [taskId],
  );

  const handleToolInputChunk = useCallback(
    ({ toolCallId, serverName, toolName, partialArgs, isComplete, promptContext }: ToolInputChunkData) => {
      if (serverName === TODO_TOOL_GROUP_NAME) {
        return;
      }

      flushCommandOutput(taskId);
      touchTaskActivity(taskId);
      const ids = activeToolInputIds.get(taskId) ?? new Set<string>();
      if (!activeToolInputIds.has(taskId)) activeToolInputIds.set(taskId, ids);

      // Buffer only if: throttling is enabled AND this is an update (tool already created)
      const isUpdate = performanceMode && ids.has(toolCallId);

      if (isUpdate) {
        bufferToolInputChunk(taskId, { toolCallId, serverName, toolName, partialArgs, isComplete, promptContext });
      } else {
        // Flush any buffered updates before handling new tool creation
        flushToolInputChunks(taskId);
        ids.add(toolCallId);
        applyToolInputChunk(taskId, { toolCallId, serverName, toolName, partialArgs, isComplete, promptContext });
      }
    },
    [taskId, performanceMode],
  );

  const handleTool = useCallback(
    ({ id, serverName, toolName, args, response, usageReport, promptContext, finished, timestamp }: ToolData) => {
      // Flush any buffered arg updates before finalizing
      flushCommandOutput(taskId);
      flushToolInputChunks(taskId);

      touchTaskActivity(taskId);
      if (serverName === TODO_TOOL_GROUP_NAME) {
        handleTodoTool(toolName, args as Record<string, unknown>, response);
        return;
      }

      // Remove the tool ID from active set since it's now complete
      activeToolInputIds.get(taskId)?.delete(id);

      const createNewToolMessage = (): ToolMessage => {
        return {
          id,
          type: 'tool',
          serverName,
          toolName,
          args: (args as Record<string, unknown> | undefined) || {},
          content: response || '',
          usageReport,
          promptContext,
          finished,
          timestamp,
        };
      };

      setMessages(taskId, (prevMessages) => {
        const loadingMessages = prevMessages.filter((message) => message.type === 'loading');
        const nonLoadingMessages = prevMessages.filter((message) => message.type !== 'loading' && message.id !== id);
        const toolMessageIndex = prevMessages.findIndex((message) => message.id === id);
        const toolMessage = prevMessages[toolMessageIndex] as ToolMessage;

        if (toolMessage) {
          const updatedMessages = [...prevMessages];
          updatedMessages[toolMessageIndex] = {
            ...createNewToolMessage(),
            ...toolMessage,
            args: args || toolMessage.args,
            content: response || '',
            usageReport,
            promptContext,
            finished,
            isStreaming: false,
          } as ToolMessage;
          return updatedMessages;
        } else {
          return [...nonLoadingMessages, createNewToolMessage(), ...loadingMessages];
        }
      });
    },
    [taskId, handleTodoTool],
  );

  useEffect(() => {
    const removeListener = api.addToolListener(baseDir, taskId, handleTool);

    return () => {
      removeListener();
      // Clean up timers and buffers for this task
      const timer = toolInputChunkFlushTimers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        toolInputChunkFlushTimers.delete(taskId);
      }
      toolInputChunkBuffers.delete(taskId);
      activeToolInputIds.delete(taskId);
    };
  }, [api, baseDir, taskId, handleTool]);

  useEffect(() => {
    const removeToolInputListener = api.addToolInputChunkListener(baseDir, taskId, handleToolInputChunk);
    return () => {
      removeToolInputListener();
      // Flush any remaining buffered chunks on cleanup
      flushToolInputChunks(taskId);
    };
  }, [api, baseDir, taskId, handleToolInputChunk]);
};
