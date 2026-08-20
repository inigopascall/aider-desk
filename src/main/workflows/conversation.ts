import { ContextMessage, MessageRole } from '@common/types';
import { extractTextContent } from '@common/utils';

/**
 * Renders the complete persisted user and assistant conversation into a
 * transcript for workflow agents. Tool messages, reasoning-only content, and
 * image payloads are intentionally excluded.
 */
export function formatConversation(messages: ContextMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === MessageRole.User) {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        lines.push('=== USER TURN ===', '', text, '');
      }
    } else if (msg.role === MessageRole.Assistant) {
      const text = extractTextContent(msg.content).trim();
      if (text) {
        lines.push('=== ASSISTANT TURN ===', '', text, '');
      }
    }
  }

  return lines.join('\n');
}
