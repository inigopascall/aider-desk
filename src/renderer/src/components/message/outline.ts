import {
  AssistantGroupMessage,
  Group,
  isAssistantGroupMessage,
  isGroupMessage,
  isReflectedMessage,
  isResponseMessage,
  isToolMessage,
  isUserMessage,
  isWorkflowRunMessage,
  LocalizedString,
  Message,
  ToolMessage,
} from '@common/types';

export type OutlineItemKind = 'user' | 'response' | 'assistant-group' | 'tool' | 'group' | 'workflow-run' | 'reflected';

export interface OutlineItem {
  /** Message id — the bookmark key and the outline row key. */
  id: string;
  /** Top-level processed-message id to scroll to (equals `id` for depth 0). */
  scrollTargetId: string;
  kind: OutlineItemKind;
  title: string;
  /** 0 = top-level row, 1 = child inside a group / assistant group. */
  depth: number;
  /** Whether this row represents a genuine top-level conversation message that may be bookmarked. */
  bookmarkable: boolean;
}

export interface Outline {
  items: OutlineItem[];
  /** IDs of genuine top-level conversation messages eligible for bookmarks and stale-bookmark pruning. */
  bookmarkableMessageIds: Set<string>;
}

type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

const flashTimeouts = new WeakMap<HTMLElement, number>();

export const getGroupDisplayName = (name: string | LocalizedString | undefined, t: TranslateFn): string => {
  if (!name) {
    return t('messages.group');
  }

  if (typeof name === 'string') {
    return t(name || 'messages.group');
  }

  return t(name.key, name.params || {});
};

export const truncateTitle = (text: string, max = 80): string => {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
};

export const extractFirstLine = (content: string): string => {
  const line = content
    .split('\n')
    .map((value) => value.trim())
    .find(Boolean);

  if (!line) {
    return '';
  }

  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/^`+|`+$/g, '')
    .trim();
};

export const deriveToolTitle = (message: ToolMessage): string => {
  const argumentKeys = [
    'filePath',
    'path',
    'file_path',
    'command',
    'pattern',
    'query',
    'searchTerm',
    'url',
    'name',
    'skillName',
    'taskId',
    'prompt',
    'description',
  ];

  for (const key of argumentKeys) {
    const value = message.args[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return `${message.toolName}: ${String(value)}`;
    }
  }

  return `${message.serverName}: ${message.toolName}`;
};

export const flashMessageElement = (element: HTMLElement) => {
  const classes = ['ring-2', 'ring-amber-400/70', 'rounded-md'];
  const previousTimeout = flashTimeouts.get(element);

  if (previousTimeout !== undefined) {
    window.clearTimeout(previousTimeout);
  }

  element.classList.add(...classes);
  flashTimeouts.set(
    element,
    window.setTimeout(() => {
      element.classList.remove(...classes);
      flashTimeouts.delete(element);
    }, 1200),
  );
};

export const buildOutline = (processedMessages: Message[], t: TranslateFn): Outline => {
  const items: OutlineItem[] = [];
  const bookmarkableMessageIds = new Set<string>();

  const addItem = (id: string, scrollTargetId: string, kind: OutlineItemKind, title: string, depth: number, bookmarkable: boolean) => {
    items.push({
      id,
      scrollTargetId,
      kind,
      title: truncateTitle(title || t('messages.outline.untitled')),
      depth,
      bookmarkable,
    });
    if (bookmarkable) {
      bookmarkableMessageIds.add(id);
    }
  };

  const responseTitle = (message: { content: string; reasoning?: string }) =>
    extractFirstLine(message.content) || extractFirstLine(message.reasoning ?? '') || t('messages.outline.untitled');

  const addMessage = (message: Message, scrollTargetId = message.id, depth = 0, bookmarkable = depth === 0) => {
    if (isUserMessage(message)) {
      addItem(message.id, scrollTargetId, 'user', extractFirstLine(message.content) || t('messages.outline.untitled'), depth, bookmarkable);
      return;
    }

    if (isResponseMessage(message)) {
      addItem(message.id, scrollTargetId, 'response', responseTitle(message), depth, bookmarkable);
      return;
    }

    if (isToolMessage(message)) {
      addItem(message.id, scrollTargetId, 'tool', deriveToolTitle(message), depth, bookmarkable);
      return;
    }

    if (isWorkflowRunMessage(message)) {
      addItem(message.id, scrollTargetId, 'workflow-run', `${message.workflowName} — ${message.logs.length} events`, depth, bookmarkable);
      return;
    }

    if (isReflectedMessage(message)) {
      addItem(message.id, scrollTargetId, 'reflected', t('reflectedMessage.title'), depth, bookmarkable);
      return;
    }

    if (isAssistantGroupMessage(message)) {
      const assistantGroup = message as AssistantGroupMessage;
      addItem(assistantGroup.id, scrollTargetId, 'assistant-group', responseTitle(assistantGroup.responseMessage), depth, bookmarkable);
      assistantGroup.toolMessages.forEach((toolMessage) => addMessage(toolMessage, assistantGroup.id, 1, false));
      return;
    }

    if (isGroupMessage(message)) {
      const group = message as { id: string; group: Group; children: Message[] };
      addItem(group.id, scrollTargetId, 'group', getGroupDisplayName(group.group.name, t), depth, false);
    }
  };

  processedMessages.forEach((message) => addMessage(message));

  return { items, bookmarkableMessageIds };
};
