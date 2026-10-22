import { Message, TaskData, isLoadingMessage, isResponseMessage, isUserMessage } from '@common/types';

import { extractFirstLine, getGroupDisplayName, truncateTitle } from '@/components/message/outline';

export type Translate = Parameters<typeof getGroupDisplayName>[1];

export const GENERATING_TASK_NAME = '<<generating>>';

const BACKSLASH = String.fromCharCode(92);
const ACTIVITY_SCAN_LIMIT = 80;
const ACTIVITY_LENGTH = 160;

export const getProjectName = (baseDir: string): string => baseDir.split(BACKSLASH).join('/').split('/').filter(Boolean).pop() || baseDir;

export const getTaskTimestamp = (task: TaskData): string => task.updatedAt || task.createdAt || '';

export const tokenize = (text: string): string[] => text.toLowerCase().split(/\s+/).filter(Boolean);

export const formatRelativeTime = (value: string | number | undefined, locale?: string): string => {
  if (value === undefined || value === '') {
    return '';
  }
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time)) {
    return '';
  }

  const seconds = Math.round((time - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  } catch {
    formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  }

  if (absolute < 60) {
    return formatter.format(seconds, 'second');
  }
  if (absolute < 3600) {
    return formatter.format(Math.round(seconds / 60), 'minute');
  }
  if (absolute < 86400) {
    return formatter.format(Math.round(seconds / 3600), 'hour');
  }
  if (absolute < 86400 * 30) {
    return formatter.format(Math.round(seconds / 86400), 'day');
  }
  if (absolute < 86400 * 365) {
    return formatter.format(Math.round(seconds / (86400 * 30)), 'month');
  }
  return formatter.format(Math.round(seconds / (86400 * 365)), 'year');
};

/**
 * Describes what a running task is doing from its live messages: the latest subagent group of the current prompt
 * (for example `CODE RUNNER: Subagent finished ...`), otherwise the latest loading line or response.
 */
export const getTaskActivity = (messages: Message[], translate: Translate): string | undefined => {
  let latestText: string | undefined;
  const lowest = Math.max(0, messages.length - ACTIVITY_SCAN_LIMIT);

  for (let index = messages.length - 1; index >= lowest; index--) {
    const message = messages[index];
    const group = message.promptContext?.group;
    if (group?.name) {
      return truncateTitle(getGroupDisplayName(group.name, translate), ACTIVITY_LENGTH);
    }
    if (isUserMessage(message)) {
      break;
    }
    if (!latestText) {
      if (isLoadingMessage(message) && message.content) {
        latestText = message.content;
      } else if (isResponseMessage(message) && message.content.trim()) {
        latestText = extractFirstLine(message.content);
      }
    }
  }

  return latestText ? truncateTitle(latestText, ACTIVITY_LENGTH) : undefined;
};
