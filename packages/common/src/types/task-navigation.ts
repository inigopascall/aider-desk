/**
 * Task navigation: rolling topic maps, stable task numbers, global search and the quick task switcher.
 *
 * Task-level data lives in TaskData.metadata under TASK_NAVIGATION_METADATA_KEYS, so the persisted task schema is unchanged.
 */

/** A display-only sub-header of a finished topic, summarising a run of its messages. */
export interface TaskTopicSection {
  /** One-line title of the section, five to twelve words. */
  summary: string;
  /** Id of the section's first message. The section runs up to the next section's start, or to the end of the topic. */
  startMessageId: string;
  /** Set while the section is compacted into one recap; startMessageId keeps pointing at the original first message. */
  compaction?: TopicCompactionInfo;
}

export interface TaskTopic {
  /** Ultra-condensed summary of the topic, at most about twenty words. */
  summary: string;
  /** Ids of the context messages (user and assistant) in this topic, in conversation order. */
  messageIds: string[];
  /** The topic's messages were compacted or cleared out of the conversation; the topic is kept for history only. */
  detached?: boolean;
  /** Sections of a finished topic, in conversation order; the first starts at the topic's first message. The current topic has none. */
  sections?: TaskTopicSection[];
  /** True once sectioning was done or deliberately skipped; false while it is pending after a failed model call. */
  sectioned?: boolean;
  /** Set while the whole topic is compacted into one recap; messageIds keep pointing at the original messages. */
  compaction?: TopicCompactionInfo;
}

export interface TaskSummary {
  /** Title reflecting the most recent focus of the conversation, four to ten words. */
  title: string;
  /** Plain-language description of the whole task, about thirty to forty words. */
  description?: string;
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
  /** Number of a task's most recent topics shown on each quick switcher row. */
  quickSwitcherTopicCount: number;
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
  quickSwitcherTopicCount: 1,
  projectPrefixes: {},
};

export const TASK_NAVIGATION_METADATA_KEYS = {
  taskNumber: 'taskNumber',
  taskSummary: 'taskSummary',
  nameLocked: 'nameLocked',
  lastMessagePreview: 'lastMessagePreview',
  compactionArchives: 'compactionArchives',
} as const;

type WithMetadata = { metadata?: Record<string, unknown> };

export const getTaskNavigationSettings = (settings?: { taskNavigation?: Partial<TaskNavigationSettings> } | null): TaskNavigationSettings => {
  const configured = settings?.taskNavigation ?? {};
  const defaults = DEFAULT_TASK_NAVIGATION_SETTINGS;
  const count = Number(configured.quickSwitcherCount ?? defaults.quickSwitcherCount);
  const topicCount = Number(configured.quickSwitcherTopicCount ?? defaults.quickSwitcherTopicCount);
  return {
    autoSummarize: configured.autoSummarize ?? defaults.autoSummarize,
    summaryModel: configured.summaryModel || null,
    autoRegenerateTitle: configured.autoRegenerateTitle ?? defaults.autoRegenerateTitle,
    searchIndexEnabled: configured.searchIndexEnabled ?? defaults.searchIndexEnabled,
    conceptSearchEnabled: configured.conceptSearchEnabled ?? defaults.conceptSearchEnabled,
    quickSwitcherCount: Number.isFinite(count) ? Math.min(20, Math.max(3, Math.round(count))) : defaults.quickSwitcherCount,
    quickSwitcherTopicCount: Number.isFinite(topicCount) ? Math.min(4, Math.max(1, Math.round(topicCount))) : defaults.quickSwitcherTopicCount,
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

// Topic compaction

/** Prefix of the ids of the two messages that stand in for a compacted topic or section: the marker and the recap. */
export const TOPIC_COMPACTION_ID_PREFIX = 'topic-compaction-';
const TOPIC_COMPACTION_PROMPT_SUFFIX = '-prompt';
/** Levels of detail of a compaction, from the shortest recap (1) to the most detailed (5). */
export const TOPIC_COMPACTION_LEVELS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_TOPIC_COMPACTION_LEVEL = 3;

export interface TopicCompactionTarget {
  topicIndex: number;
  sectionIndex?: number;
  /** First message id of the target as the caller saw it; the call fails if it no longer matches. */
  firstMessageId: string;
}

export interface TopicCompactionOptions {
  level: number;
  instructions?: string;
}

export type TopicCompactionBlockReason =
  | 'running'
  | 'current-topic'
  | 'detached'
  | 'not-contiguous'
  | 'already-compacted'
  | 'inside-compacted-topic'
  | 'too-few-messages'
  | 'tool-pairs'
  | 'not-found'
  | 'no-model';

/** Every block reason. The message of an error thrown for a refusal starts with one of them followed by `: `. */
export const TOPIC_COMPACTION_BLOCK_REASONS: readonly TopicCompactionBlockReason[] = [
  'running',
  'current-topic',
  'detached',
  'not-contiguous',
  'already-compacted',
  'inside-compacted-topic',
  'too-few-messages',
  'tool-pairs',
  'not-found',
  'no-model',
];

export interface TopicCompactionPreview {
  compactable: boolean;
  reason?: TopicCompactionBlockReason;
  firstMessageId?: string;
  /** Stored id of the first message after the stretch (an entry or a marker), or null when the stretch ends the conversation. */
  endBeforeMessageId?: string | null;
  messageCount: number;
  sourceCharacters: number;
  targetCharacters: Record<number, number>;
}

export interface TopicCompactionInfo {
  /** Id of the compaction; its original messages are kept in `topic-compactions/<id>.json` in the task folder. */
  id: string;
  level: number;
  compactedAt: string;
  summaryMessageId: string;
  promptMessageId: string;
  /** Stored messages replaced by the recap. */
  messageCount: number;
  sourceCharacters: number;
  summaryCharacters: number;
  model?: string;
  /** The recap is no longer in the conversation, for example after a built-in compaction; the original messages are kept. */
  lost?: boolean;
}

export interface CompactionArchiveInfo {
  id: string;
  createdAt: string;
  reason: 'built-in-compaction' | 'before-restore';
}

export const getCompactionSummaryMessageId = (compactionId: string): string => `${TOPIC_COMPACTION_ID_PREFIX}${compactionId}`;

export const getCompactionPromptMessageId = (compactionId: string): string => `${TOPIC_COMPACTION_ID_PREFIX}${compactionId}${TOPIC_COMPACTION_PROMPT_SUFFIX}`;

/** True for the id of a compaction's recap or of its marker. */
export const isTopicCompactionMessageId = (id: string): boolean =>
  typeof id === 'string' && id.startsWith(TOPIC_COMPACTION_ID_PREFIX) && id.length > TOPIC_COMPACTION_ID_PREFIX.length;

export const isTopicCompactionPromptMessageId = (id: string): boolean =>
  isTopicCompactionMessageId(id) &&
  id.endsWith(TOPIC_COMPACTION_PROMPT_SUFFIX) &&
  id.length > TOPIC_COMPACTION_ID_PREFIX.length + TOPIC_COMPACTION_PROMPT_SUFFIX.length;

export const getTopicCompactionIdFromMessageId = (id: string): string | undefined => {
  if (!isTopicCompactionMessageId(id)) {
    return undefined;
  }
  const rest = id.slice(TOPIC_COMPACTION_ID_PREFIX.length);
  return isTopicCompactionPromptMessageId(id) ? rest.slice(0, -TOPIC_COMPACTION_PROMPT_SUFFIX.length) : rest;
};

/** Recap length per level: a ratio of the source characters, clamped between a minimum and a maximum. */
const COMPACTION_LENGTHS: Record<number, { ratio: number; min: number; max: number }> = {
  1: { ratio: 0.03, min: 300, max: 800 },
  2: { ratio: 0.08, min: 600, max: 2500 },
  3: { ratio: 0.15, min: 1000, max: 6000 },
  4: { ratio: 0.27, min: 1500, max: 14000 },
  5: { ratio: 0.45, min: 2000, max: 40000 },
};

/** Rounds a level to an integer from 1 to 5; anything that is not a number gives the default level. */
export const normalizeTopicCompactionLevel = (level: number): number => {
  const rounded = Math.round(Number(level));
  return Number.isFinite(rounded) ? Math.min(5, Math.max(1, rounded)) : DEFAULT_TOPIC_COMPACTION_LEVEL;
};

/**
 * Target length of a recap in characters: the level's ratio of the source characters, clamped to the level's minimum and
 * maximum, then capped at the larger of 200 and 60% of the source, rounded to the nearest 50.
 */
export const getCompactionTargetCharacters = (level: number, sourceCharacters: number): number => {
  const lengths = COMPACTION_LENGTHS[normalizeTopicCompactionLevel(level)];
  const source = Math.max(0, Number(sourceCharacters) || 0);
  const clamped = Math.min(lengths.max, Math.max(lengths.min, lengths.ratio * source));
  const capped = Math.min(clamped, Math.max(200, 0.6 * source));
  return Math.round(capped / 50) * 50;
};

const BLOCK_REASON_PATTERN = new RegExp(`(?:^|[\\s:])(${TOPIC_COMPACTION_BLOCK_REASONS.join('|')}): `);

/** Finds the block reason in an error message, also when a transport prefixed it (for example Electron's IPC). */
export const getTopicCompactionBlockReason = (errorMessage: string): TopicCompactionBlockReason | undefined => {
  const match = BLOCK_REASON_PATTERN.exec(errorMessage ?? '');
  return match ? (match[1] as TopicCompactionBlockReason) : undefined;
};

export const getCompactionArchives = (task: WithMetadata): CompactionArchiveInfo[] => {
  const value = task.metadata?.[TASK_NAVIGATION_METADATA_KEYS.compactionArchives];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === 'object' && typeof item.id === 'string') as CompactionArchiveInfo[];
};

/** True when a topic or a section of the task's topic map holds a compaction record, including a lost one. */
export const taskHasTopicCompactions = (task: WithMetadata): boolean =>
  (getTaskSummary(task)?.topics ?? []).some((topic) => !!topic.compaction || (topic.sections ?? []).some((section) => !!section.compaction));
