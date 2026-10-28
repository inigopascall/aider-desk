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
import { transformMessages } from './message-preparation/transformations';

import type { AgentProfile } from '@common/types';
import type { ModelMessage } from 'ai';

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
const SUBAGENT_PROMPT_LABEL_MAX_LENGTH = 120;

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

type MessageForEstimate = {
  id: string;
  role: string;
  content: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A short human-readable label for a conversation message: its first text, or the tools it calls or answers. */
export const describeContextMessage = (message: MessageForEstimate): string => {
  const content = message.content;
  if (typeof content === 'string') {
    return truncateLabel(collapseWhitespace(content));
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content.filter(isRecord);
  const textPart = parts.find((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0);
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

const estimateMessageItem = (message: MessageForEstimate, scrollTargetId?: string): ContextUsageItem => ({
  id: message.id,
  label: describeContextMessage(message),
  detail: message.role,
  ...(scrollTargetId ? { scrollTargetId } : {}),
  tokens: estimateMessageTokens([{ role: message.role, content: message.content }]),
});

export const estimateContextMessageItem = (message: ContextMessage): ContextUsageItem => {
  const [transformed] = transformMessages([message] as ModelMessage[]) as unknown as MessageForEstimate[];
  return estimateMessageItem(transformed);
};

const getPartInput = (part: Record<string, unknown>): Record<string, unknown> | undefined =>
  part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : undefined;

const subagentLabel = (part: Record<string, unknown>, profiles: Pick<AgentProfile, 'id' | 'name'>[]): string => {
  const input = getPartInput(part);
  const id = typeof input?.subagentId === 'string' ? input.subagentId : undefined;
  const profile = profiles.find((candidate) => candidate.id === id || candidate.name.toLowerCase().replace(/\s+/g, '-') === id);
  const name = profile?.name ?? (id || 'Unknown');
  const prompt = typeof input?.prompt === 'string' ? input.prompt.split(/\r?\n/).find((line) => line.trim()) : undefined;
  return `Subagent: ${name} | ${truncateLabel(collapseWhitespace(prompt ?? '').slice(0, SUBAGENT_PROMPT_LABEL_MAX_LENGTH - 1))}`;
};

export const estimateConversationItems = (messages: ContextMessage[], profiles: Pick<AgentProfile, 'id' | 'name'>[]): ContextUsageItem[] => {
  const transformed = transformMessages(messages as ModelMessage[]) as unknown as MessageForEstimate[];
  const calls = new Map<string, Record<string, unknown>>();
  const messageParts = (message: MessageForEstimate): Record<string, unknown>[] => (Array.isArray(message.content) ? message.content.filter(isRecord) : []);
  for (const message of transformed) {
    for (const part of messageParts(message)) {
      if (part.type === 'tool-call' && typeof part.toolCallId === 'string') {
        calls.set(part.toolCallId, part);
      }
    }
  }
  return transformed.flatMap((message) => {
    const parts = messageParts(message);
    if (!parts.length && !Array.isArray(message.content)) {
      return [estimateMessageItem(message, message.id)];
    }
    if (message.role === 'tool') {
      return parts
        .filter((part) => typeof part.toolCallId === 'string')
        .map((part) => {
          const call = calls.get(part.toolCallId as string);
          const label = call?.toolName === 'subagents---run_task' ? subagentLabel(call, profiles) : String(part.toolName ?? call?.toolName ?? '');
          const itemMessage = { ...message, content: [part] };
          return { ...estimateMessageItem(itemMessage, part.toolCallId as string), id: `${message.id}:${part.toolCallId}`, label };
        });
    }
    const callParts = parts.filter((part) => part.type === 'tool-call' && typeof part.toolCallId === 'string');
    const residual = parts.filter((part) => part.type !== 'tool-call');
    return [
      ...(residual.length ? [estimateMessageItem({ ...message, content: residual }, message.id)] : []),
      ...callParts.map((part) => ({
        ...estimateMessageItem({ ...message, content: [part] }, part.toolCallId as string),
        id: `${message.id}:${part.toolCallId}`,
        label: part.toolName === 'subagents---run_task' ? subagentLabel(part, profiles) : String(part.toolName ?? ''),
      })),
    ];
  });
};

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
