import { ContextMessage, isTopicCompactionMessageId, isTopicCompactionPromptMessageId } from '@common/types';
import { extractServerNameToolName, extractTextContent } from '@common/utils';

/** A user or assistant message reduced to the text that the task-navigation features work with. */
export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Tool calls made with or after the message, as short `tool: argument` labels. */
  tools: string[];
  timestamp?: number;
}

const TOOL_ARGUMENT_KEYS = [
  'filePath',
  'path',
  'file_path',
  'command',
  'pattern',
  'query',
  'searchTerm',
  'url',
  'skillName',
  'subagentId',
  'description',
  'name',
  'taskId',
];
const MAX_TOOLS_PER_ENTRY = 40;
export const MAX_INDEXED_TEXT_LENGTH = 20000;

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const truncateText = (text: string, maxLength: number): string => (text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text);

export const describeToolCall = (toolName: string, input: unknown): string => {
  const [, name] = extractServerNameToolName(toolName);
  const label = name || toolName;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of TOOL_ARGUMENT_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return `${label}: ${truncateText(collapseWhitespace(value), 120)}`;
      }
    }
  }
  return label;
};

export interface ConversationEntryOptions {
  /** Include the recaps of topic compactions as assistant entries, as the search index does. Their markers are always left out. */
  includeCompactionSummaries?: boolean;
}

/**
 * Reduces context messages to user and assistant entries with text. Tool results are dropped; tool calls from
 * assistant messages without text are attached to the preceding entry. The marker and recap messages of topic
 * compactions are left out, unless includeCompactionSummaries keeps the recap.
 */
export const toConversationEntries = (messages: ContextMessage[], options: ConversationEntryOptions = {}): ConversationEntry[] => {
  const entries: ConversationEntry[] = [];

  for (const message of messages) {
    if (message.role === 'tool' || !message.id) {
      continue;
    }
    if (isTopicCompactionMessageId(message.id) && (isTopicCompactionPromptMessageId(message.id) || !options.includeCompactionSummaries)) {
      continue;
    }

    const text = extractTextContent(message.content).trim();
    const tools: string[] = [];
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          tools.push(describeToolCall(part.toolName, part.input));
        }
      }
    }

    if (text) {
      entries.push({
        id: message.id,
        role: message.role,
        text,
        tools: tools.slice(0, MAX_TOOLS_PER_ENTRY),
        timestamp: message.timestamp,
      });
    } else if (tools.length > 0 && entries.length > 0) {
      const previous = entries[entries.length - 1];
      previous.tools = [...previous.tools, ...tools].slice(0, MAX_TOOLS_PER_ENTRY);
    }
  }

  return entries;
};

/** Text stored in the keyword index for an entry: its text followed by its tool labels. */
export const toIndexedContent = (entry: ConversationEntry): string => {
  const text = truncateText(entry.text, MAX_INDEXED_TEXT_LENGTH);
  return entry.tools.length > 0 ? `${text}\n${entry.tools.join('\n')}` : text;
};

/** Short, stable hash used to detect changed text without storing comparisons. */
export const hashText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
};
