import { type ContextMessage, type ContextAssistantMessage } from '@common/types';
import type { ModelMessage } from 'ai';
import logger from '@/logger';

/**
 * Reads the recorded producing model of a message, falling back to the usage
 * report's model field. Returns `undefined` when neither source is available
 * (legacy messages persisted before provenance tracking existed).
 */
export const getMessageSourceModelId = (message: ContextMessage | ModelMessage): string | undefined => {
  const msg = message as ContextAssistantMessage & { usageReport?: { model?: string } };
  if (msg.model && typeof msg.model === 'string' && msg.model.trim().length > 0) {
    return msg.model;
  }
  if (msg.usageReport?.model && typeof msg.usageReport.model === 'string' && msg.usageReport.model.trim().length > 0) {
    return msg.usageReport.model;
  }
  return undefined;
};

/**
 * Returns an outbound copy of `messages` safe to send to `targetModelId`.
 * Messages known to originate from `targetModelId` are returned by reference,
 * untouched. Messages from a different (or unknown) model have their
 * model-bound provider payloads stripped from the copy.
 */
export const sanitizeMessagesForModel = <T extends ModelMessage | ContextMessage>(
  messages: readonly T[],
  targetModelId: string,
): T[] => {
  let sanitizedCount = 0;
  let droppedCount = 0;

  const result: T[] = [];

  for (const message of messages) {
    // User and system messages never carry model-bound continuation state
    if (message.role === 'user' || message.role === 'system') {
      result.push(message as T);
      continue;
    }

    const sourceModelId = getMessageSourceModelId(message);

    // If the message was produced by the target model, pass through by reference
    if (sourceModelId === targetModelId) {
      result.push(message as T);
      continue;
    }

    // Sanitise: strip providerOptions from message and parts
    sanitizedCount++;

    const sanitised = sanitizeMessage(message as T);

    if (sanitised === null) {
      // Message was dropped (empty assistant with only empty reasoning parts)
      droppedCount++;
      continue;
    }

    result.push(sanitised);
  }

  if (sanitizedCount > 0 || droppedCount > 0) {
    logger.debug('Sanitized model-bound provider payloads for outbound request', {
      targetModelId,
      totalMessages: messages.length,
      sanitizedCount,
      droppedCount,
    });
  }

  return result;
};

/**
 * Sanitises a single message by removing providerOptions at the message and
 * part level, and dropping empty reasoning parts. Returns `null` if the
 * resulting message should be omitted entirely.
 */
function sanitizeMessage<T extends ModelMessage | ContextMessage>(message: T): T | null {
  const hasMessageLevelOptions = 'providerOptions' in message && message.providerOptions !== undefined;
  const content = message.content;

  // String content messages have no part-level providerOptions
  if (typeof content === 'string') {
    if (!hasMessageLevelOptions) {
      // Nothing to strip — return the original reference
      return message;
    }
    // Create a copy with providerOptions removed
    const copy: Record<string, unknown> = { ...message };
    delete copy.providerOptions;
    return copy as T;
  }

  // Array content: process each part
  const parts: Array<Record<string, unknown>> = [];
  let partsChanged = false;

  for (const part of content as Array<Record<string, unknown>>) {
    const partCopy = { ...part };

    // Remove part-level providerOptions
    if ('providerOptions' in partCopy && partCopy.providerOptions !== undefined) {
      delete partCopy.providerOptions;
      if (!partsChanged) partsChanged = true;
    }

    // Drop reasoning parts whose text is empty after trimming (encrypted-only)
    if (partCopy.type === 'reasoning' && typeof partCopy.text === 'string' && partCopy.text.trim().length === 0) {
      partsChanged = true;
      continue; // skip this part
    }

    parts.push(partCopy);
  }

  // For assistant messages: if the result is completely empty, drop the whole message
  if (message.role === 'assistant' && parts.length === 0) {
    // Only drop if there are no string-based content alternatives (which can't happen here since we're in array branch)
    return null;
  }

  // If nothing actually changed, return the original reference
  if (!partsChanged && !hasMessageLevelOptions) {
    return message;
  }

  // Build the copy
  const copy: Record<string, unknown> = { ...message };
  delete copy.providerOptions;
  copy.content = parts;

  return copy as T;
}
