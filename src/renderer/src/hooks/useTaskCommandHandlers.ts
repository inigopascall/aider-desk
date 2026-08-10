import { useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';

import type { CommandOutputData, CommandOutputMessage, Message } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { setMessages, touchTaskActivity } from '@/stores/taskStore';
import { useSettingsStore } from '@/stores/settingsStore';

const isCommandOutputMessage = (message: Message): message is CommandOutputMessage => {
  return message.type === 'command-output';
};

const STREAM_FLUSH_INTERVAL_MS = 250;
const commandOutputBuffers = new Map<string, CommandOutputData[]>();
const commandOutputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Applies a single command-output chunk to the task's messages.
 * This is the core logic extracted from handleCommandOutput to support both
 * immediate and buffered application of chunks.
 */
function applyCommandOutput(taskId: string, { command, output, timestamp }: CommandOutputData): void {
  setMessages(taskId, (prevMessages) => {
    const lastMessage = prevMessages[prevMessages.length - 1];

    if (lastMessage && isCommandOutputMessage(lastMessage) && lastMessage.command === command) {
      const updatedLastMessage: CommandOutputMessage = {
        ...lastMessage,
        content: lastMessage.content + output,
      };
      return prevMessages.slice(0, -1).concat(updatedLastMessage);
    } else {
      const commandOutputMessage: CommandOutputMessage = {
        id: uuidv4(),
        type: 'command-output',
        command,
        content: output,
        timestamp,
      };
      return prevMessages.filter((message) => message.type !== 'loading').concat(commandOutputMessage);
    }
  });
}

/**
 * Buffers a command-output chunk for later flushing.
 * If no flush timer exists for this task, schedules one.
 */
function bufferCommandOutput(taskId: string, data: CommandOutputData): void {
  let buffer = commandOutputBuffers.get(taskId);
  if (!buffer) {
    buffer = [];
    commandOutputBuffers.set(taskId, buffer);
  }
  buffer.push(data);

  // Schedule a flush if one isn't already scheduled
  if (!commandOutputFlushTimers.has(taskId)) {
    const timer = setTimeout(() => flushCommandOutput(taskId), STREAM_FLUSH_INTERVAL_MS);
    commandOutputFlushTimers.set(taskId, timer);
  }
}

/**
 * Flushes all buffered command-output chunks for a task.
 * Clears the buffer and timer, then applies each chunk in order.
 */
export function flushCommandOutput(taskId: string): void {
  const timer = commandOutputFlushTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    commandOutputFlushTimers.delete(taskId);
  }

  const buffer = commandOutputBuffers.get(taskId);
  if (buffer && buffer.length > 0) {
    commandOutputBuffers.delete(taskId);
    for (const data of buffer) {
      applyCommandOutput(taskId, data);
    }
  }
}

export const useTaskCommandHandlers = (baseDir: string, taskId: string) => {
  const api = useApi();
  const performanceMode = useSettingsStore((s) => s.settings?.performanceMode ?? true);

  const handleCommandOutput = useCallback(
    ({ command, output, timestamp }: CommandOutputData) => {
      touchTaskActivity(taskId);
      if (performanceMode) {
        bufferCommandOutput(taskId, { command, output, timestamp });
      } else {
        applyCommandOutput(taskId, { command, output, timestamp });
      }
    },
    [taskId, performanceMode],
  );

  useEffect(() => {
    const removeListener = api.addCommandOutputListener(baseDir, taskId, handleCommandOutput);

    return () => {
      removeListener();
      // Flush any remaining buffered output on cleanup
      flushCommandOutput(taskId);
      const timer = commandOutputFlushTimers.get(taskId);
      if (timer) {
        clearTimeout(timer);
        commandOutputFlushTimers.delete(taskId);
      }
      commandOutputBuffers.delete(taskId);
    };
  }, [api, baseDir, taskId, handleCommandOutput]);
};
