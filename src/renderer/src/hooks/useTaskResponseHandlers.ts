import { useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { isResponseMessage } from '@common/types';

import type { ResponseChunkData, ResponseCompletedData, Message, ReflectedMessage, ResponseMessage } from '@common/types';

import { useApi } from '@/contexts/ApiContext';
import { setMessages, touchTaskActivity } from '@/stores/taskStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { flushCommandOutput } from './useTaskCommandHandlers';

const STREAM_FLUSH_INTERVAL_MS = 250;

const processingResponseMessageMap = new Map<string, ResponseMessage>();
const responseChunkBuffers = new Map<string, ResponseChunkData[]>();
const responseChunkFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const rawResponseContentMap = new Map<string, string>();
const taskUsePlainTextMap = new Map<string, boolean>();

function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/([*_`\[\]()#+.!>~|-])/g, '\\$1');
}

export const cleanupProcessingResponseMessage = (taskId: string) => {
  processingResponseMessageMap.delete(taskId);
  rawResponseContentMap.delete(taskId);
  taskUsePlainTextMap.delete(taskId);
  // Clear any pending flush timer
  const timer = responseChunkFlushTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    responseChunkFlushTimers.delete(taskId);
  }
  // Clear any buffered chunks
  responseChunkBuffers.delete(taskId);
};

/**
 * Applies a single response chunk to the task's messages.
 * This is the core logic extracted from handleResponseChunk to support both
 * immediate and buffered application of chunks.
 */
function applyResponseChunk(taskId: string, { messageId, chunk, reasoning, reflectedMessage, promptContext }: ResponseChunkData): void {
  touchTaskActivity(taskId);
  const timestamp = Date.now();
  const usePlainText = taskUsePlainTextMap.get(taskId) ?? false;
  if (usePlainText) {
    rawResponseContentMap.set(taskId, (rawResponseContentMap.get(taskId) || '') + chunk);
  }
  const displayedChunk = usePlainText ? escapeMarkdown(chunk) : chunk;

  let processingMessage = processingResponseMessageMap.get(taskId);
  if (processingMessage?.id === messageId) {
    processingMessage = {
      ...processingMessage,
      content: processingMessage.content + displayedChunk,
      reasoning: reasoning ? (processingMessage.reasoning || '') + reasoning : processingMessage.reasoning,
      promptContext,
    };
    processingResponseMessageMap.set(taskId, processingMessage);
    setMessages(taskId, (prevMessages) =>
      prevMessages.map((message) => {
        if (message.id === messageId && isResponseMessage(message)) {
          return {
            ...message,
            content: message.content + displayedChunk,
            reasoning: reasoning ? (message.reasoning || '') + reasoning : message.reasoning,
            promptContext,
          };
        }
        return message;
      }),
    );
  } else {
    setMessages(taskId, (prevMessages) => {
      const existingMessageIndex = prevMessages.findIndex((message) => message.id === messageId);
      const newMessages: Message[] = [];

      if (reflectedMessage) {
        const reflected: ReflectedMessage = {
          id: uuidv4(),
          type: 'reflected-message',
          content: reflectedMessage,
          responseMessageId: messageId,
          promptContext,
        };

        newMessages.push(reflected);
      }

      if (existingMessageIndex === -1) {
        const newResponseMessage: ResponseMessage = {
          id: messageId,
          type: 'response',
          content: displayedChunk,
          reasoning: reasoning || undefined,
          promptContext,
          timestamp,
        };
        processingResponseMessageMap.set(taskId, newResponseMessage);
        newMessages.push(newResponseMessage);

        return prevMessages.filter((message) => message.type !== 'loading').concat(...newMessages);
      } else {
        return prevMessages.map((message) => {
          if (message.id === messageId && isResponseMessage(message)) {
            return {
              ...message,
              content: message.content + displayedChunk,
              reasoning: reasoning ? (message.reasoning || '') + reasoning : message.reasoning,
              promptContext,
            };
          }
          return message;
        });
      }
    });
  }
}

/**
 * Buffers a response chunk for later flushing.
 * If no flush timer exists for this task, schedules one.
 */
function bufferResponseChunk(taskId: string, data: ResponseChunkData): void {
  let buffer = responseChunkBuffers.get(taskId);
  if (!buffer) {
    buffer = [];
    responseChunkBuffers.set(taskId, buffer);
  }
  buffer.push(data);

  // Schedule a flush if one isn't already scheduled
  if (!responseChunkFlushTimers.has(taskId)) {
    const timer = setTimeout(() => flushResponseChunks(taskId), STREAM_FLUSH_INTERVAL_MS);
    responseChunkFlushTimers.set(taskId, timer);
  }
}

/**
 * Flushes all buffered response chunks for a task.
 * Clears the buffer and timer, then applies each chunk in order.
 */
export function flushResponseChunks(taskId: string): void {
  const timer = responseChunkFlushTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    responseChunkFlushTimers.delete(taskId);
  }

  const buffer = responseChunkBuffers.get(taskId);
  if (buffer && buffer.length > 0) {
    responseChunkBuffers.delete(taskId);
    for (const data of buffer) {
      applyResponseChunk(taskId, data);
    }
  }
}

export const useTaskResponseHandlers = (baseDir: string, taskId: string) => {
  const api = useApi();
  const performanceMode = useSettingsStore((s) => s.settings?.performanceMode ?? true);

  useEffect(() => {
    taskUsePlainTextMap.set(taskId, performanceMode);
    return () => {
      taskUsePlainTextMap.delete(taskId);
    };
  }, [taskId, performanceMode]);

  const handleResponseChunk = useCallback(
    ({ messageId, chunk, reasoning, reflectedMessage, promptContext }: ResponseChunkData) => {
      flushCommandOutput(taskId);
      const processing = processingResponseMessageMap.get(taskId);
      // Buffer only if: throttling is enabled AND this is an append (not a new message or reflected message)
      const isAppend = performanceMode && !reflectedMessage && processing?.id === messageId;

      if (isAppend) {
        bufferResponseChunk(taskId, { messageId, chunk, reasoning, reflectedMessage, promptContext });
      } else {
        // Flush any buffered appends before handling non-append events
        flushResponseChunks(taskId);
        applyResponseChunk(taskId, { messageId, chunk, reasoning, reflectedMessage, promptContext });
      }
    },
    [taskId, performanceMode],
  );

  const handleResponseCompleted = useCallback(
    ({ messageId, usageReport, content, reasoning, reflectedMessage, promptContext, timestamp }: ResponseCompletedData) => {
      // Flush any buffered chunks before finalizing
      flushCommandOutput(taskId);
      flushResponseChunks(taskId);

      touchTaskActivity(taskId);
      const processingMessage = processingResponseMessageMap.get(taskId);

      if (content) {
        setMessages(taskId, (prevMessages) => {
          const responseMessage = prevMessages.find((message) => message.id === messageId) as ResponseMessage | undefined;
          if (responseMessage) {
            return prevMessages.map((message) =>
              message.id === messageId
                ? {
                    ...responseMessage,
                    content,
                    reasoning,
                    finished: true,
                    usageReport,
                    promptContext,
                    timestamp,
                  }
                : message,
            );
          } else {
            const messages: Message[] = [];
            if (reflectedMessage) {
              const reflected: ReflectedMessage = {
                id: uuidv4(),
                type: 'reflected-message',
                content: reflectedMessage,
                responseMessageId: messageId,
                promptContext,
              };
              messages.push(reflected);
            }

            const newResponseMessage: ResponseMessage = {
              id: messageId,
              type: 'response',
              content,
              reasoning,
              usageReport,
              promptContext,
              finished: true,
              timestamp,
            };
            messages.push(newResponseMessage);

            return prevMessages.filter((message) => message.type !== 'loading').concat(...messages);
          }
        });
      } else if (processingMessage && processingMessage.id === messageId) {
        processingMessage.usageReport = usageReport;
        processingMessage.promptContext = promptContext;
        processingMessage.content = content || rawResponseContentMap.get(taskId) || processingMessage.content;
        processingMessage.reasoning = reasoning || processingMessage.reasoning;
        setMessages(taskId, (prevMessages) => prevMessages.map((message) => (message.id === messageId ? processingMessage : message)));
      } else {
        setMessages(taskId, (prevMessages) => prevMessages.filter((message) => message.type !== 'loading'));
      }

      rawResponseContentMap.delete(taskId);
      taskUsePlainTextMap.delete(taskId);
      processingResponseMessageMap.delete(taskId);
    },
    [taskId],
  );

  useEffect(() => {
    const removeChunk = api.addResponseChunkListener(baseDir, taskId, handleResponseChunk);
    const removeCompleted = api.addResponseCompletedListener(baseDir, taskId, handleResponseCompleted);

    return () => {
      removeChunk();
      removeCompleted();
      // Flush any remaining buffered chunks on cleanup
      flushResponseChunks(taskId);
    };
  }, [api, baseDir, taskId, handleResponseChunk, handleResponseCompleted]);
};
