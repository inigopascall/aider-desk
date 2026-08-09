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
        lines.push('## User', '', text, '');
        totalChars += text.length;
      }
    } else if (msg.role === MessageRole.Assistant) {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        lines.push('## Assistant', '', text, '');
        totalChars += text.length;
      }
    }
    // Tool messages and reasoning are skipped entirely.
  }

  const result = lines.join('\n');
  return result.length > MAX_CONVERSATION_CHARS ? result.slice(0, MAX_CONVERSATION_CHARS) : result;
}