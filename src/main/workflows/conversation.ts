import { ContextMessage, MessageRole } from '@common/types';
import { extractTextContent } from '@common/utils';

const MAX_CONVERSATION_CHARS = 40_000;

/**
 * Renders the task's persisted conversation into a bounded text transcript
 * suitable for injection into workflow agent prompts. Only user and assistant
 * text content is preserved; tool messages, reasoning, and image parts are
 * stripped, and the total length is capped at `MAX_CONVERSATION_CHARS`
 * characters (truncated from the end, so the oldest messages are kept).
 */
export function formatConversation(messages: ContextMessage[]): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const msg of messages) {
    if (totalChars >= MAX_CONVERSATION_CHARS) break;

    if (msg.role === MessageRole.User) {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        lines.push('=== USER TURN ===', '', text, '');
        totalChars += text.length;
      }
    } else if (msg.role === MessageRole.Assistant) {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        lines.push('=== ASSISTANT TURN ===', '', text, '');
        totalChars += text.length;
      }
    }
    // Tool messages and reasoning are skipped entirely.
  }

  const result = lines.join('\n');
  return result.length > MAX_CONVERSATION_CHARS ? result.slice(0, MAX_CONVERSATION_CHARS) : result;
}

export const SUMMARIZE_MIN_CHARS = 8_000;
export const SUMMARIZE_MIN_TURNS = 5;
export const RECENT_TURNS_KEPT = 4;

/**
 * Filters a message list down to the text-bearing user and assistant turns
 * that `formatConversation` would render. Tool messages, reasoning, and
 * image-only parts are excluded, mirroring the transcript criterion.
 */
export function filterConversationTurns(messages: ContextMessage[]): ContextMessage[] {
  return messages.filter((msg) => {
    if (msg.role === MessageRole.User) {
      return extractTextContent(msg.content).trim().length > 0;
    }
    if (msg.role === MessageRole.Assistant) {
      return extractTextContent(msg.content).trim().length > 0;
    }
    return false;
  });
}

/**
 * Splits a conversation into a summarizable `tail` (older turns) and a
 * verbatim `recent` remainder. Below the size/turn thresholds the whole
 * conversation is returned as `recent` with an empty tail. Otherwise the
 * split keeps the most recent user turn inside `recent` so the latest
 * instruction is always preserved verbatim.
 */
export function splitConversationForSummary(messages: ContextMessage[]): {
  tail: ContextMessage[];
  recent: ContextMessage[];
  turns: number;
} {
  const turns = filterConversationTurns(messages);
  if (turns.length < SUMMARIZE_MIN_TURNS || formatConversation(turns).length <= SUMMARIZE_MIN_CHARS) {
    return { tail: [], recent: turns, turns: turns.length };
  }
  let start = Math.max(0, turns.length - RECENT_TURNS_KEPT);
  const lastUserIndex = turns.reduce((acc, msg, index) => (msg.role === MessageRole.User ? index : acc), -1);
  if (lastUserIndex >= 0) {
    start = Math.min(start, lastUserIndex);
  }
  return { tail: turns.slice(0, start), recent: turns.slice(start), turns: turns.length };
}
