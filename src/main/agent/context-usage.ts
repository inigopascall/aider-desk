import { encode } from 'gpt-tokenizer/model/gpt-4o';
import {
  CONTEXT_USAGE_CATEGORY_IDS,
  ContextMessage,
  ContextUsageBreakdown,
  ContextUsageCategory,
  ContextUsageCategoryId,
  ContextUsageItem,
} from '@common/types';
import { extractServerNameToolName } from '@common/utils';

import { estimateMessageTokens } from './utils';

export interface ToolDefinitionForEstimate {
  name: string;
  /** A string, or a function the SDK resolves later; JSON.stringify omits the latter, as in the request estimate. */
  description?: unknown;
  inputSchema: unknown;
}

export interface ContextUsageInput {
  /** Tokens of the whole system prompt, including the rules it embeds. */
  systemPromptTokens: number;
  rules: ContextUsageItem[];
  tools: ContextUsageItem[];
  repoMappings: ContextUsageItem[];
  readOnlyFiles: ContextUsageItem[];
  editableFiles: ContextUsageItem[];
  conversation: ContextUsageItem[];
}

export const SYSTEM_PROMPT_ITEM_ID = 'system-prompt';

const MESSAGE_LABEL_MAX_LENGTH = 80;

export const countTextTokens = (text: string): number => encode(text).length;

const sumTokens = (items: ContextUsageItem[]): number => items.reduce((sum, item) => sum + item.tokens, 0);

/** One item per tool group (MCP server, built-in toolset or extension), sized by its serialised definitions. */
export const groupToolTokensByServer = (toolDefinitions: ToolDefinitionForEstimate[]): ContextUsageItem[] => {
  const groups = new Map<string, number>();
  for (const definition of toolDefinitions) {
    const [serverName] = extractServerNameToolName(definition.name);
    const tokens = countTextTokens(JSON.stringify(definition, null, 2));
    groups.set(serverName, (groups.get(serverName) ?? 0) + tokens);
  }
  return [...groups.entries()].map(([serverName, tokens]) => ({
    id: serverName,
    label: serverName,
    tokens,
  }));
};

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

const truncateLabel = (text: string): string => (text.length > MESSAGE_LABEL_MAX_LENGTH ? `${text.slice(0, MESSAGE_LABEL_MAX_LENGTH - 1)}…` : text);

/** A short human-readable label for a conversation message: its first text, or the tools it calls or answers. */
export const describeContextMessage = (message: ContextMessage): string => {
  const content: unknown = message.content;
  if (typeof content === 'string') {
    return truncateLabel(collapseWhitespace(content));
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content as Array<Record<string, unknown>>;
  const textPart = parts.find((part) => part.type === 'text' && typeof part.text === 'string' && (part.text as string).trim().length > 0);
  if (textPart) {
    return truncateLabel(collapseWhitespace(textPart.text as string));
  }

  const toolNames = [
    ...new Set(
      parts
        .filter((part) => (part.type === 'tool-call' || part.type === 'tool-result') && typeof part.toolName === 'string')
        .map((part) => part.toolName as string),
    ),
  ];
  return truncateLabel(toolNames.join(', '));
};

export const estimateContextMessageItem = (message: ContextMessage): ContextUsageItem => ({
  id: message.id,
  label: describeContextMessage(message),
  detail: message.role,
  tokens: estimateMessageTokens([{ role: message.role, content: message.content }]),
});

/**
 * Assembles the breakdown in drawing order. The rules are embedded in the system prompt, so the
 * system prompt category is what remains after subtracting them. Empty items and categories are dropped.
 */
export const buildContextUsageBreakdown = (input: ContextUsageInput): ContextUsageBreakdown => {
  const itemsByCategory: Record<ContextUsageCategoryId, ContextUsageItem[]> = {
    systemPrompt: [
      {
        id: SYSTEM_PROMPT_ITEM_ID,
        label: '',
        tokens: Math.max(0, input.systemPromptTokens - sumTokens(input.rules)),
      },
    ],
    rules: input.rules,
    tools: input.tools,
    repoMappings: input.repoMappings,
    readOnlyFiles: input.readOnlyFiles,
    editableFiles: input.editableFiles,
    conversation: input.conversation,
  };

  const categories: ContextUsageCategory[] = CONTEXT_USAGE_CATEGORY_IDS.map((id) => {
    const items = itemsByCategory[id].filter((item) => item.tokens > 0);
    return { id, tokens: sumTokens(items), items };
  }).filter((category) => category.tokens > 0);

  return {
    categories,
    totalTokens: categories.reduce((sum, category) => sum + category.tokens, 0),
  };
};
