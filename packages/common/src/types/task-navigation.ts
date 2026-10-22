/**
 * Task navigation: rolling topic maps, stable task numbers, global search and the quick task switcher.
 *
 * Task-level data lives in TaskData.metadata under TASK_NAVIGATION_METADATA_KEYS, so the persisted task schema is unchanged.
 */

export interface TaskTopic {
  /** Ultra-condensed summary of the topic, at most about twenty words. */
  summary: string;
  /** Ids of the context messages (user and assistant) in this topic, in conversation order. */
  messageIds: string[];
  /** The topic's messages were compacted or cleared out of the conversation; the topic is kept for history only. */
  detached?: boolean;
}

export interface TaskSummary {
  /** Title reflecting the most recent focus of the conversation, four to ten words. */
  title: string;
  /** Topics in chronological order. */
  topics: TaskTopic[];
  /** Id of the last context message covered by the summary. */
  lastSummarizedMessageId?: string;
  /** ISO timestamp of the generation. */
  generatedAt: string;
  /** Model id (`provider/model`) that produced the summary. */
  model?: string;
}

export interface TaskLastMessagePreview {
  role: 'user' | 'assistant';
  text: string;
}

export interface TaskNavigationSettings {
  /** Update the topic map after every finished prompt. */
  autoSummarize: boolean;
  /** Model id (`provider/model`) for topic maps. Null falls back to the task name model, then to the task's agent model. */
  summaryModel: string | null;
  /** Replace the task name with the topic map title unless the user renamed the task by hand. */
  autoRegenerateTitle: boolean;
  /** Maintain the global search index. */
  searchIndexEnabled: boolean;
  /** Embed task titles, topics and user prompts locally for concept search. */
  conceptSearchEnabled: boolean;
  /** Number of recent tasks the quick switcher shows when its filter is empty. */
  quickSwitcherCount: number;
  /** Task key prefix overrides, keyed by project base directory. */
  projectPrefixes: Record<string, string>;
}

export const DEFAULT_TASK_NAVIGATION_SETTINGS: TaskNavigationSettings = {
  autoSummarize: true,
  summaryModel: null,
  autoRegenerateTitle: true,
  searchIndexEnabled: true,
  conceptSearchEnabled: true,
  quickSwitcherCount: 6,
  projectPrefixes: {},
};

export const TASK_NAVIGATION_METADATA_KEYS = {
  taskNumber: 'taskNumber',
  taskSummary: 'taskSummary',
  nameLocked: 'nameLocked',
  lastMessagePreview: 'lastMessagePreview',
} as const;

type WithMetadata = { metadata?: Record<string, unknown> };

export const getTaskNavigationSettings = (settings?: { taskNavigation?: Partial<TaskNavigationSettings> } | null): TaskNavigationSettings => {
  const configured = settings?.taskNavigation ?? {};
  const defaults = DEFAULT_TASK_NAVIGATION_SETTINGS;
  const count = Number(configured.quickSwitcherCount ?? defaults.quickSwitcherCount);
  return {
    autoSummarize: configured.autoSummarize ?? defaults.autoSummarize,
    summaryModel: configured.summaryModel || null,
    autoRegenerateTitle: configured.autoRegenerateTitle ?? defaults.autoRegenerateTitle,
    searchIndexEnabled: configured.searchIndexEnabled ?? defaults.searchIndexEnabled,
    conceptSearchEnabled: configured.conceptSearchEnabled ?? defaults.conceptSearchEnabled,
    quickSwitcherCount: Number.isFinite(count) ? Math.min(20, Math.max(3, Math.round(count))) : defaults.quickSwitcherCount,
    projectPrefixes: { ...(configured.projectPrefixes ?? {}) },
  };
};

export const getTaskNumber = (task: WithMetadata): number | undefined => {
  const value = task.metadata?.[TASK_NAVIGATION_METADATA_KEYS.taskNumber];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
};

export const getTaskSummary = (task: WithMetadata): TaskSummary | undefined => {
  const value = task.metadata?.[TASK_NAVIGATION_METADATA_KEYS.taskSummary] as Partial<TaskSummary> | undefined;
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || !Array.isArray(value.topics)) {
    return undefined;
  }
  return value as TaskSummary;
};

export const isTaskNameLocked = (task: WithMetadata): boolean => task.metadata?.[TASK_NAVIGATION_METADATA_KEYS.nameLocked] === true;

export const getTaskLastMessagePreview = (task: WithMetadata): TaskLastMessagePreview | undefined => {
  const value = task.metadata?.[TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview] as Partial<TaskLastMessagePreview> | undefined;
  if (!value || typeof value !== 'object' || typeof value.text !== 'string' || (value.role !== 'user' && value.role !== 'assistant')) {
    return undefined;
  }
  return value as TaskLastMessagePreview;
};

const BACKSLASH = String.fromCharCode(92);

/** Normalises a project base directory for prefix lookups: backslashes become slashes and trailing slashes are removed. */
export const normalizeProjectKey = (baseDir: string): string => {
  let key = baseDir.split(BACKSLASH).join('/');
  while (key.length > 1 && key.endsWith('/')) {
    key = key.slice(0, -1);
  }
  return key;
};

/**
 * Derives a task key prefix from a project folder name: the initials of up to four words, or the first three
 * characters of a single-word name, upper-cased. `aider-desk-dev` gives `ADD`; `toggle` gives `TOG`.
 */
export const deriveProjectPrefix = (baseDir: string): string => {
  const folderName = normalizeProjectKey(baseDir).split('/').pop() ?? '';
  const words = folderName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) {
    return 'TASK';
  }
  if (words.length === 1) {
    return words[0].slice(0, 3).toUpperCase();
  }
  return words
    .slice(0, 4)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
};

export const getProjectPrefix = (baseDir: string, settings: TaskNavigationSettings): string => {
  const key = normalizeProjectKey(baseDir);
  const override = Object.entries(settings.projectPrefixes)
    .find(([dir]) => normalizeProjectKey(dir) === key)?.[1]
    ?.trim();
  return override ? override.slice(0, 8).toUpperCase() : deriveProjectPrefix(baseDir);
};

export const formatTaskKey = (prefix: string, taskNumber: number): string => `${prefix}-${String(taskNumber).padStart(3, '0')}`;

export const getTaskKey = (task: WithMetadata & { baseDir: string }, settings: TaskNavigationSettings): string | undefined => {
  const taskNumber = getTaskNumber(task);
  return taskNumber === undefined ? undefined : formatTaskKey(getProjectPrefix(task.baseDir, settings), taskNumber);
};

// Global search

/** Marks the start of a matched term inside a search snippet. */
export const SEARCH_SNIPPET_MATCH_START = String.fromCharCode(2);
/** Marks the end of a matched term inside a search snippet. */
export const SEARCH_SNIPPET_MATCH_END = String.fromCharCode(3);
/** Message id of the per-task row that indexes the task name and topic summaries. */
export const SEARCH_TASK_ROW_MESSAGE_ID = '__task__';

export type SearchHitRole = 'user' | 'assistant' | 'task';

export interface GlobalSearchMessageHit {
  messageId: string;
  role: SearchHitRole;
  /** Excerpt; keyword matches are wrapped in SEARCH_SNIPPET_MATCH_START and SEARCH_SNIPPET_MATCH_END. */
  snippet: string;
  timestamp?: number;
  matchedBy: 'keyword' | 'concept';
}

export interface GlobalSearchTaskResult {
  baseDir: string;
  taskId: string;
  name: string;
  taskNumber?: number;
  state?: string;
  archived?: boolean;
  updatedAt?: string;
  score: number;
  matchedBy: Array<'keyword' | 'concept'>;
  hits: GlobalSearchMessageHit[];
  topics: string[];
}

export interface SearchIndexStatus {
  state: 'idle' | 'indexing' | 'disabled' | 'error';
  tasksIndexed: number;
  tasksTotal: number;
  messagesIndexed: number;
  vectorsIndexed: number;
  conceptSearchAvailable: boolean;
  /** Background embedding for concept search is running. */
  embedding: boolean;
  error?: string;
}

export interface GlobalSearchResponse {
  query: string;
  results: GlobalSearchTaskResult[];
  status: SearchIndexStatus;
}
