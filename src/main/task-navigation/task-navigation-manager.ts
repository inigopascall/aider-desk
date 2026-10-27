import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

import { generateText } from 'ai';
import {
  CompactionArchiveInfo,
  ContextMessage,
  DefaultTaskState,
  GlobalSearchMessageHit,
  GlobalSearchResponse,
  GlobalSearchTaskResult,
  SEARCH_TASK_ROW_MESSAGE_ID,
  SearchIndexStatus,
  SettingsData,
  TASK_NAVIGATION_METADATA_KEYS,
  TaskCreatedData,
  TaskData,
  TaskLastMessagePreview,
  TaskNavigationSettings,
  TaskSummary,
  TaskTopic,
  TaskTopicEstimates,
  TopicCompactionOptions,
  TopicCompactionPreview,
  TopicCompactionTarget,
  getCompactionArchives,
  getTaskLastMessagePreview,
  getTaskNavigationSettings,
  getTaskNumber,
  getTaskSummary,
  isTaskNameLocked,
  normalizeTopicCompactionLevel,
} from '@common/types';
import { compareBaseDirs, extractProviderModel, normalizeBaseDir } from '@common/utils';

import { TextEmbedder } from './embeddings';
import { setTaskNavigationContextReplaceListener, setTaskNavigationEventListener } from './hooks';
import { setTaskNavigationManager } from './instance';
import { ConversationEntry, collapseWhitespace, hashText, toConversationEntries, toIndexedContent, truncateText } from './message-text';
import { ContextFingerprint, IndexMessageRow, IndexedTaskInfo, KeywordHit, SearchIndex, VectorWrite, buildFtsQuery } from './search-index';
import {
  SUMMARY_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
  applySummaryUpdate,
  buildSummaryPrompt,
  buildTitlePrompt,
  chunkEntries,
  cleanDescription,
  cleanTitle,
  findCurrentTopicIndex,
  getUnsummarizedEntries,
  markDetachedTopics,
  parseSummaryResponse,
  sectionTopics,
  selectTopicsToSection,
} from './summary-model';
import {
  CompactionReconcileResult,
  TopicCompactionError,
  applyTopicCompaction,
  applyTopicCompactionUndo,
  buildCompactionRequest,
  buildTopicCompactionPreview,
  cleanCompactionOutput,
  collectCompactionIndexEntries,
  findCompactionRecord,
  findRemovedCompactionSummaries,
  getBlockedPreview,
  planTopicCompaction,
  reconcileCompactions,
  selectTopicsKeptOnRebuild,
} from './topic-compaction';
import { estimateCompactionSourceTokens, estimateTaskTopics } from './topic-estimates';
import {
  deleteCompactionSidecar,
  isCompactionArchiveId,
  isSafeCompactionFileId,
  listCompactionSidecars,
  readCompactionArchive,
  readCompactionSidecar,
  writeCompactionArchive,
  writeCompactionSidecar,
} from './topic-compaction-store';

import type { ModelManager } from '@/models';
import type { Project, ProjectManager } from '@/project';
import type { Store } from '@/store';
import type { Task } from '@/task';

import { AIDER_DESK_DATA_DIR, AIDER_DESK_TASKS_DIR, DB_FILE_PATH } from '@/constants';
import logger from '@/logger';

const INTERNAL_TASK_ID = 'internal';
const GENERATING_NAME = '<<generating>>';

const SEARCH_INDEX_FILE = path.join(AIDER_DESK_DATA_DIR, 'task-navigation.db');
const DISCOVERY_MARKER_FILE = path.join(AIDER_DESK_DATA_DIR, 'task-navigation.discovered');

const STARTUP_SCAN_DELAY_MS = 20_000;
const PROJECT_SCAN_DELAY_MS = 5_000;
const POST_PROMPT_DELAY_MS = 2_500;
const INFO_UPDATE_DELAY_MS = 1_000;
const NUMBERING_DELAY_MS = 500;
const EMBEDDING_DELAY_MS = 1_500;
const SCAN_YIELD_MS = 5;
const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARY_CHUNK_CHARACTERS = 48_000;
const PREVIEW_LENGTH = 240;
const MAX_USER_VECTORS_PER_TASK = 200;
const USER_VECTOR_TEXT_LENGTH = 400;
const MIN_USER_VECTOR_WORDS = 3;
const MIN_CONCEPT_SCORE = 0.32;
const RRF_K = 60;
const MAX_HITS_PER_TASK = 5;
const MAX_CONCEPT_HITS_PER_TASK = 2;
const KEYWORD_HIT_LIMIT = 400;
const CONCEPT_MATCH_LIMIT = 80;
const CONCEPT_SNIPPET_LENGTH = 220;
const DEFAULT_RESULT_LIMIT = 30;
const COUNTS_CACHE_MS = 10_000;
const COMPACTION_TIMEOUT_MS = 300_000;
/** Built-in compaction clears the task metadata just after it replaces the conversation; the archive is recorded after that. */
const ARCHIVE_METADATA_DELAY_MS = 1_500;

type ChainName = 'summary' | 'numbering' | 'scan' | 'embedding';

interface CompactionReservation {
  taskKey: string;
  topicFirstMessageId: string;
  sectionStartMessageId?: string;
  rawMessageIds: string[];
}

type IndexCounts = { tasks: number; messages: number; vectors: number };

interface SearchGroup {
  baseDir: string;
  taskId: string;
  keywordRank?: number;
  conceptRank?: number;
  conceptHits: number;
  hits: GlobalSearchMessageHit[];
  matchedBy: Set<'keyword' | 'concept'>;
}

export type TaskNavigationGenerate = (
  modelId: string,
  projectDir: string,
  sessionId: string,
  systemPrompt: string,
  prompt: string,
  timeoutMs: number,
) => Promise<string>;

export interface TaskNavigationManagerDependencies {
  store: Store;
  projectManager: ProjectManager;
  modelManager: ModelManager;
  /** Search index to use instead of the one in the data directory. */
  searchIndex?: SearchIndex;
  /** Text generation to use instead of the configured providers. */
  generate?: TaskNavigationGenerate;
  /** Delay before the archive made before a built-in compaction is recorded in the task metadata. */
  archiveMetadataDelayMs?: number;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const taskKey = (baseDir: string, taskId: string): string => `${normalizeBaseDir(baseDir)}::${taskId}`;

const countWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const getDisplayName = (task: TaskData): string => (task.name === GENERATING_NAME ? '' : task.name || '');

const getContextPath = (baseDir: string, taskId: string): string => path.join(baseDir, AIDER_DESK_TASKS_DIR, taskId, 'context.json');

const getSettingsPath = (baseDir: string, taskId: string): string => path.join(baseDir, AIDER_DESK_TASKS_DIR, taskId, 'settings.json');

const toIndexedInfo = (task: TaskData): IndexedTaskInfo => {
  const summary = getTaskSummary(task);
  return {
    baseDir: normalizeBaseDir(task.baseDir),
    taskId: task.id,
    name: getDisplayName(task),
    taskNumber: getTaskNumber(task),
    state: task.state,
    archived: task.archived === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    topics: summary?.topics.map((topic) => topic.summary),
  };
};

const getInfoSignature = (info: IndexedTaskInfo): string =>
  JSON.stringify([info.name, info.taskNumber ?? null, info.state ?? null, info.archived === true, info.topics ?? []]);

const toIndexRow = (entry: ConversationEntry): IndexMessageRow => ({
  messageId: entry.id,
  role: entry.role,
  content: toIndexedContent(entry),
  timestamp: entry.timestamp,
});

/**
 * Index rows of a task: its user and assistant entries with the recaps of topic compactions, and the original messages of
 * the compactions in effect, read from their sidecars, each pointing at the outermost recap as its scroll target.
 */
export const loadTaskIndexRows = async (baseDir: string, taskId: string, messages: ContextMessage[]): Promise<IndexMessageRow[]> => {
  const rows = toConversationEntries(messages, { includeCompactionSummaries: true }).map(toIndexRow);
  const sidecars = await listCompactionSidecars(baseDir, taskId);
  for (const { entry, scrollTarget } of collectCompactionIndexEntries(messages, sidecars)) {
    rows.push({ ...toIndexRow(entry), scrollTarget });
  }
  return rows;
};

const buildPreview = (entries: ConversationEntry[]): TaskLastMessagePreview | undefined => {
  const last = entries[entries.length - 1];
  return last ? { role: last.role, text: truncateText(collapseWhitespace(last.text), PREVIEW_LENGTH) } : undefined;
};

const readContextMessages = (raw: string): ContextMessage[] => {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed as ContextMessage[];
  }
  if (parsed && typeof parsed === 'object') {
    const record = parsed as { contextMessages?: unknown; messages?: unknown };
    if (Array.isArray(record.contextMessages)) {
      return record.contextMessages as ContextMessage[];
    }
    if (Array.isArray(record.messages)) {
      return record.messages as ContextMessage[];
    }
  }
  return [];
};

const statFingerprint = async (filePath: string): Promise<ContextFingerprint | null> => {
  try {
    const stat = await fs.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
};

const isSameFingerprint = (first?: ContextFingerprint | null, second?: ContextFingerprint | null): boolean =>
  !!first && !!second && first.size === second.size && Math.abs(first.mtimeMs - second.mtimeMs) < 1;

/**
 * Owns the task navigation features in the main process: per-project task numbers, rolling topic maps with
 * regenerated titles, the last-message preview, and the global search index (keyword and concept).
 *
 * It observes task events through the EventManager bridge and works in the background; nothing in the agent
 * loop waits for it.
 */
export class TaskNavigationManager {
  private readonly index: SearchIndex;
  private readonly embedder = new TextEmbedder();
  private readonly knownStates = new Map<string, string | undefined>();
  private readonly infoSignatures = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly highWaterMarks = new Map<string, number>();
  private readonly pendingSummaries = new Set<string>();
  /** Tasks whose conversation this manager is replacing itself; the safeguard against built-in compaction ignores them. */
  private readonly ownReplacements = new Set<string>();
  private archiveJobs = 0;
  private readonly chains: Record<ChainName, Promise<unknown>> = {
    summary: Promise.resolve(),
    numbering: Promise.resolve(),
    scan: Promise.resolve(),
    embedding: Promise.resolve(),
  };
  private lastSettings: TaskNavigationSettings | null = null;
  private scanning = false;
  private scanDone = 0;
  private scanTotal = 0;
  private embeddingJobs = 0;
  private error: string | undefined;
  private disposed = false;
  private countsCache: { at: number; value: IndexCounts } | null = null;
  private readonly compactionReservations = new Map<string, CompactionReservation>();
  private readonly deferredCompactionSummaries = new Map<string, { baseDir: string; taskId: string }>();

  constructor(private readonly dependencies: TaskNavigationManagerDependencies) {
    this.index = dependencies.searchIndex ?? new SearchIndex(SEARCH_INDEX_FILE);
  }

  init(): void {
    try {
      this.index.open();
    } catch (error) {
      this.error = describeError(error);
      logger.error('[TaskNavigation] Failed to open the search index', { file: SEARCH_INDEX_FILE, error: this.error });
    }

    this.lastSettings = this.getSettings();
    setTaskNavigationEventListener(this.handleEvent);
    setTaskNavigationContextReplaceListener(this.handleContextReplace);

    for (const project of this.dependencies.projectManager.getProjects()) {
      this.scheduleNumbering(project.baseDir);
    }
    this.schedule('startup-scan', STARTUP_SCAN_DELAY_MS, () => this.enqueueScan(null));
  }

  dispose(): void {
    this.disposed = true;
    this.compactionReservations.clear();
    this.deferredCompactionSummaries.clear();
    setTaskNavigationEventListener(null);
    setTaskNavigationContextReplaceListener(null);
    setTaskNavigationManager(null);
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.index.close();
  }

  // Public API

  async search(query: string, limit = DEFAULT_RESULT_LIMIT): Promise<GlobalSearchResponse> {
    const trimmed = (query ?? '').trim();
    const settings = this.getSettings();
    if (!trimmed || !settings.searchIndexEnabled || !this.index.isOpen()) {
      return { query: trimmed, results: [], status: this.getStatus() };
    }

    const maxResults = Math.min(100, Math.max(1, Math.round(Number(limit) || DEFAULT_RESULT_LIMIT)));
    const groups = new Map<string, SearchGroup>();
    const getGroup = (baseDir: string, taskId: string): SearchGroup => {
      const key = taskKey(baseDir, taskId);
      let group = groups.get(key);
      if (!group) {
        group = { baseDir, taskId, conceptHits: 0, hits: [], matchedBy: new Set() };
        groups.set(key, group);
      }
      return group;
    };

    let keywordRank = 0;
    const addKeywordHits = (hits: KeywordHit[]) => {
      for (const hit of hits) {
        const group = getGroup(hit.baseDir, hit.taskId);
        if (group.keywordRank === undefined) {
          group.keywordRank = keywordRank++;
        }
        group.matchedBy.add('keyword');
        // An original message of a topic compaction is shown at the recap that stands in for it
        const messageId = hit.scrollTarget ?? hit.messageId;
        if (group.hits.length < MAX_HITS_PER_TASK && !group.hits.some((existing) => existing.messageId === messageId)) {
          group.hits.push({ messageId, role: hit.role, snippet: hit.snippet, timestamp: hit.timestamp, matchedBy: 'keyword' });
        }
      }
    };

    const allTermsQuery = buildFtsQuery(trimmed, 'all');
    if (allTermsQuery) {
      addKeywordHits(this.runKeywordSearch(allTermsQuery));
    }
    const anyTermQuery = buildFtsQuery(trimmed, 'any');
    if (anyTermQuery && anyTermQuery !== allTermsQuery && groups.size < 10) {
      addKeywordHits(this.runKeywordSearch(anyTermQuery));
    }

    if (settings.conceptSearchEnabled && trimmed.length >= 3 && !this.embedder.isUnavailable()) {
      try {
        const vector = await this.embedder.embed(trimmed);
        if (vector) {
          let conceptRank = 0;
          for (const match of this.index.searchVectors(vector, CONCEPT_MATCH_LIMIT, MIN_CONCEPT_SCORE)) {
            const group = getGroup(match.baseDir, match.taskId);
            if (group.conceptRank === undefined) {
              group.conceptRank = conceptRank++;
            }
            group.matchedBy.add('concept');
            if (group.conceptHits < MAX_CONCEPT_HITS_PER_TASK && !group.hits.some((existing) => existing.messageId === match.messageId)) {
              group.hits.push({
                messageId: match.messageId,
                role: match.kind === 'user' ? 'user' : 'task',
                snippet: truncateText(match.text, CONCEPT_SNIPPET_LENGTH),
                matchedBy: 'concept',
              });
              group.conceptHits++;
            }
          }
        }
      } catch (error) {
        logger.warn('[TaskNavigation] Concept search failed', { error: describeError(error) });
      }
    }

    const scored = [...groups.values()]
      .map((group) => ({
        group,
        score:
          (group.keywordRank === undefined ? 0 : 1 / (RRF_K + group.keywordRank)) + (group.conceptRank === undefined ? 0 : 1 / (RRF_K + group.conceptRank)),
      }))
      .sort((first, second) => second.score - first.score);

    const results: GlobalSearchTaskResult[] = [];
    for (const { group, score } of scored) {
      if (results.length >= maxResults) {
        break;
      }
      const info = this.index.getTask(group.baseDir, group.taskId);
      if (!info) {
        continue;
      }
      results.push({
        baseDir: info.baseDir,
        taskId: info.taskId,
        name: info.name,
        taskNumber: info.taskNumber,
        state: info.state,
        archived: info.archived,
        updatedAt: info.updatedAt,
        score,
        matchedBy: [...group.matchedBy],
        hits: group.hits,
        topics: info.topics ?? [],
      });
    }

    return { query: trimmed, results, status: this.getStatus() };
  }

  getStatus(): SearchIndexStatus {
    const settings = this.getSettings();
    const counts = this.getCounts();
    return {
      state: !settings.searchIndexEnabled ? 'disabled' : this.error ? 'error' : this.scanning ? 'indexing' : 'idle',
      tasksIndexed: this.scanning ? this.scanDone : counts.tasks,
      tasksTotal: this.scanning ? this.scanTotal : counts.tasks,
      messagesIndexed: counts.messages,
      vectorsIndexed: counts.vectors,
      conceptSearchAvailable: settings.conceptSearchEnabled && !this.embedder.isUnavailable() && counts.vectors > 0,
      embedding: this.embeddingJobs > 0,
      error: this.error,
    };
  }

  /** Index row counts, cached briefly because the status is polled while the search is open. */
  private getCounts(): IndexCounts {
    const empty: IndexCounts = { tasks: 0, messages: 0, vectors: 0 };
    if (!this.index.isOpen()) {
      return empty;
    }
    const now = Date.now();
    if (this.countsCache && now - this.countsCache.at < COUNTS_CACHE_MS) {
      return this.countsCache.value;
    }
    try {
      const value = this.index.counts();
      this.countsCache = { at: now, value };
      return value;
    } catch (error) {
      this.error = describeError(error);
      return empty;
    }
  }

  async rebuildIndex(): Promise<SearchIndexStatus> {
    this.countsCache = null;
    if (this.index.isOpen()) {
      this.index.clearFingerprints();
    }
    this.enqueueScan(null).catch((error) => logger.warn('[TaskNavigation] Index rebuild failed', { error: describeError(error) }));
    const status = this.getStatus();
    return status.state === 'idle' ? { ...status, state: 'indexing' } : status;
  }

  /** Rebuilds the topic map of a task from scratch. Resolves with the saved task data. */
  regenerateTaskSummary(baseDir: string, taskId: string): Promise<TaskData | null> {
    return this.queueSummary(baseDir, taskId, true);
  }

  /** Names the task from its whole conversation, on request only. Resolves with the saved task data. */
  regenerateTaskTitle(baseDir: string, taskId: string): Promise<TaskData | null> {
    return this.enqueue('summary', () => this.runTitleGeneration(baseDir, taskId));
  }

  private async runTitleGeneration(baseDir: string, taskId: string): Promise<TaskData | null> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return null;
    }
    const entries = toConversationEntries(await task.getContextMessages());
    if (entries.length === 0) {
      throw new Error('The task has no messages to name it from');
    }
    const modelId = await this.resolveSummaryModel(task, this.getSettings());
    if (!modelId) {
      throw new Error('No model is available for task titles');
    }
    const summary = getTaskSummary(task.task);
    const prompt = buildTitlePrompt(entries, summary?.topics ?? [], summary?.description ?? '');
    const response = await this.generate(modelId, task.task.baseDir, taskId, TITLE_SYSTEM_PROMPT, prompt);
    const title = cleanTitle((response ?? '').split('\n').find((line) => line.trim()) ?? '');
    if (!title) {
      throw new Error('The model returned an empty title');
    }
    logger.info('[TaskNavigation] Regenerated the task title', { taskId, modelId });
    return task.saveTask({ name: title }, false);
  }

  // Topic compaction

  /** Returns local topic occupancy estimates without invoking a model. */
  async getTaskTopicEstimates(baseDir: string, taskId: string): Promise<TaskTopicEstimates> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return { topics: [] };
    }
    const messages = await task.getContextMessages();
    const summary = getTaskSummary(task.task);
    return summary ? estimateTaskTopics(messages, summary.topics) : { topics: [] };
  }

  /** Whether a topic or section can be compacted, its size and the recap length per level. A refusal is returned, never thrown. */
  async previewTopicCompaction(baseDir: string, taskId: string, target: TopicCompactionTarget): Promise<TopicCompactionPreview> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return getBlockedPreview('not-found');
    }
    if (task.task.state === DefaultTaskState.InProgress) {
      return getBlockedPreview('running');
    }
    const summary = getTaskSummary(task.task);
    if (!summary) {
      return getBlockedPreview('not-found');
    }
    const messages = await task.getContextMessages();
    const preview = buildTopicCompactionPreview(messages, summary.topics, target);
    if (preview.compactable) {
      const planned = planTopicCompaction(messages, summary.topics, target);
      try {
        this.assertNoCompactionOverlap(
          baseDir,
          taskId,
          summary.topics[target.topicIndex].messageIds[0],
          target.sectionIndex === undefined ? undefined : summary.topics[target.topicIndex].sections?.[target.sectionIndex]?.startMessageId,
          planned.stretch.messageIds,
        );
      } catch (error) {
        if (error instanceof TopicCompactionError) {
          return getBlockedPreview(error.reason);
        }
        throw error;
      }
      preview.sourceTokens = estimateCompactionSourceTokens(planned.stretch.messages);
    }
    if (preview.compactable && !(await this.resolveSummaryModel(task, this.getSettings()))) {
      return getBlockedPreview('no-model');
    }
    return preview;
  }

  /**
   * Compacts a finished topic, or a section of one, into a recap written by the topic map model. The original messages
   * are kept in a sidecar file in the task folder. Resolves with the saved task data; on any failure nothing changes.
   */
  async compactTopic(baseDir: string, taskId: string, target: TopicCompactionTarget, options: TopicCompactionOptions): Promise<TaskData> {
    const reservationId = randomUUID();
    const prepared = await this.enqueue('summary', async () => {
      if (this.disposed) {
        throw new Error('Task navigation is disposed');
      }
      const task = this.requireIdleTask(baseDir, taskId);
      const messages = await task.getContextMessages();
      this.assertNotRunning(task);
      const summary = structuredClone(this.requireTaskSummary(task));
      const plan = planTopicCompaction(structuredClone(messages), summary.topics, target);
      const topicFirstMessageId = summary.topics[target.topicIndex].messageIds[0];
      const sectionStartMessageId =
        target.sectionIndex === undefined ? undefined : summary.topics[target.topicIndex].sections![target.sectionIndex].startMessageId;
      this.assertNoCompactionOverlap(baseDir, taskId, topicFirstMessageId, sectionStartMessageId, plan.stretch.messageIds);
      const reservation = { taskKey: taskKey(baseDir, taskId), topicFirstMessageId, sectionStartMessageId, rawMessageIds: [...plan.stretch.messageIds] };
      this.compactionReservations.set(reservationId, reservation);
      return { task, summary, plan, reservation };
    });
    try {
      return await this.runTopicCompaction(baseDir, taskId, target, options, prepared);
    } finally {
      this.compactionReservations.delete(reservationId);
      const key = taskKey(baseDir, taskId);
      if (!this.disposed && ![...this.compactionReservations.values()].some((reservation) => reservation.taskKey === key)) {
        const deferred = this.deferredCompactionSummaries.get(key);
        if (deferred) {
          this.deferredCompactionSummaries.delete(key);
          this.queueSummary(deferred.baseDir, deferred.taskId, false).catch((error) =>
            logger.warn('[TaskNavigation] Deferred topic map update failed', {
              baseDir: deferred.baseDir,
              taskId: deferred.taskId,
              error: describeError(error),
            }),
          );
        }
      }
    }
  }

  /** Puts the original messages of a compaction back in place of its recap. Resolves with the saved task data. */
  undoTopicCompaction(baseDir: string, taskId: string, compactionId: string): Promise<TaskData> {
    return this.enqueue('summary', () => this.runTopicCompactionUndo(baseDir, taskId, compactionId));
  }

  /** Puts back a conversation archived before a built-in compaction; the current conversation is archived first. */
  restoreCompactionArchive(baseDir: string, taskId: string, archiveId: string): Promise<TaskData> {
    return this.enqueue('summary', () => this.runArchiveRestore(baseDir, taskId, archiveId));
  }

  private requireIdleTask(baseDir: string, taskId: string): Task {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      throw new TopicCompactionError('not-found', 'the task is not open');
    }
    this.assertNotRunning(task);
    return task;
  }

  private assertNotRunning(task: Task): void {
    if (task.task.state === DefaultTaskState.InProgress) {
      throw new TopicCompactionError('running', 'the task is running');
    }
  }

  private assertNoCompactionOverlap(
    baseDir: string,
    taskId: string,
    topicFirstMessageId: string,
    sectionStartMessageId: string | undefined,
    rawMessageIds: string[],
    ignoreId?: string,
  ): void {
    const key = taskKey(baseDir, taskId);
    const ids = new Set(rawMessageIds);
    for (const [reservationId, reservation] of this.compactionReservations) {
      if (reservationId === ignoreId || reservation.taskKey !== key) {
        continue;
      }
      const logicalOverlap =
        reservation.topicFirstMessageId === topicFirstMessageId &&
        (reservation.sectionStartMessageId === undefined || sectionStartMessageId === undefined || reservation.sectionStartMessageId === sectionStartMessageId);
      const rawOverlap = reservation.rawMessageIds.some((id) => ids.has(id));
      if (logicalOverlap || rawOverlap) {
        throw new TopicCompactionError('compacting', `the target overlaps another compaction for ${key}`);
      }
    }
  }

  private requireTaskSummary(task: Task): TaskSummary {
    const summary = getTaskSummary(task.task);
    if (!summary) {
      throw new TopicCompactionError('not-found', 'the task has no topic map');
    }
    return summary;
  }

  /** Replaces the task's conversation; the safeguard against built-in compaction ignores the replacement. */
  private async replaceConversation(task: Task, messages: ContextMessage[]): Promise<void> {
    const key = taskKey(task.task.baseDir, task.task.id);
    this.ownReplacements.add(key);
    try {
      await task.replaceContextMessages(messages);
    } finally {
      this.ownReplacements.delete(key);
    }
  }

  private async saveTopics(task: Task, topics: TaskTopic[]): Promise<TaskData> {
    const summary = this.requireTaskSummary(task);
    return task.saveTask({ metadata: { ...(task.task.metadata ?? {}), [TASK_NAVIGATION_METADATA_KEYS.taskSummary]: { ...summary, topics } } }, false);
  }

  private async deleteSidecars(baseDir: string, taskId: string, compactionIds: string[]): Promise<void> {
    for (const compactionId of compactionIds) {
      try {
        await deleteCompactionSidecar(baseDir, taskId, compactionId);
      } catch (error) {
        logger.warn('[TaskNavigation] Failed to delete a compaction sidecar', { taskId, compactionId, error: describeError(error) });
      }
    }
  }

  private async runTopicCompaction(
    baseDir: string,
    taskId: string,
    _target: TopicCompactionTarget,
    options: TopicCompactionOptions,
    prepared: { task: Task; summary: TaskSummary; plan: ReturnType<typeof planTopicCompaction>; reservation: CompactionReservation },
  ): Promise<TaskData> {
    const modelId = await this.resolveSummaryModel(prepared.task, this.getSettings());
    if (!modelId) {
      throw new TopicCompactionError('no-model', 'no model is available for topic maps');
    }

    const level = normalizeTopicCompactionLevel(options.level);
    const instructions = options.instructions?.trim() || undefined;
    const request = buildCompactionRequest(getDisplayName(prepared.task.task), prepared.summary.topics, prepared.plan, level, instructions);
    const response = await this.generate(modelId, prepared.task.task.baseDir, taskId, request.systemPrompt, request.prompt, COMPACTION_TIMEOUT_MS);
    const recap = cleanCompactionOutput(response);
    if (!recap) {
      throw new Error('The model returned an empty recap');
    }

    return this.enqueue('summary', async () => {
      if (this.disposed) {
        throw new Error('Task navigation is disposed');
      }
      const task = this.requireIdleTask(baseDir, taskId);
      const messages = await task.getContextMessages();
      this.assertNotRunning(task);
      const summary = this.requireTaskSummary(task);
      const topicIndex = summary.topics.findIndex((topic) => topic.messageIds[0] === prepared.reservation.topicFirstMessageId);
      if (topicIndex < 0) {
        throw new TopicCompactionError('not-found', 'the topic no longer exists');
      }
      let sectionIndex: number | undefined;
      if (prepared.reservation.sectionStartMessageId !== undefined) {
        sectionIndex = (summary.topics[topicIndex].sections ?? []).findIndex(
          (section) => section.startMessageId === prepared.reservation.sectionStartMessageId,
        );
        if (sectionIndex < 0) {
          throw new TopicCompactionError('not-found', 'the section no longer exists');
        }
      }
      const relocatedTarget: TopicCompactionTarget = {
        topicIndex,
        ...(sectionIndex === undefined ? {} : { sectionIndex }),
        firstMessageId: _target.firstMessageId,
      };
      const freshPlan = planTopicCompaction(messages, summary.topics, relocatedTarget);
      if (JSON.stringify(freshPlan.stretch.messages) !== JSON.stringify(prepared.plan.stretch.messages)) {
        throw new TopicCompactionError('not-found', 'the compaction target changed');
      }
      const result = applyTopicCompaction({
        messages,
        topics: summary.topics,
        target: relocatedTarget,
        compactionId: randomUUID(),
        recap,
        level,
        model: modelId,
        instructions,
        expectedMessageIds: prepared.plan.stretch.messageIds,
      });

      const taskBaseDir = task.task.baseDir;
      const metadata = structuredClone(task.task.metadata ?? {});
      await writeCompactionSidecar(taskBaseDir, taskId, result.sidecar);
      let replacementAttempted = false;
      try {
        this.assertNotRunning(task);
        const currentMessages = await task.getContextMessages();
        this.assertNotRunning(task);
        if (
          JSON.stringify(currentMessages) !== JSON.stringify(messages) ||
          JSON.stringify(this.requireTaskSummary(task).topics) !== JSON.stringify(summary.topics)
        ) {
          throw new TopicCompactionError('not-found', 'the conversation changed');
        }
        replacementAttempted = true;
        await this.replaceConversation(task, result.messages);
        const saved = await this.saveTopics(task, result.topics);
        try {
          await this.reindexTask(task);
        } catch (error) {
          logger.warn('[TaskNavigation] Failed to re-index a task after compaction', { taskId, error: describeError(error) });
        }
        logger.info('[TaskNavigation] Compacted a topic', { taskId, compactionId: result.info.id, messages: result.info.messageCount, level, modelId });
        return saved;
      } catch (error) {
        if (!replacementAttempted) {
          await this.deleteSidecars(taskBaseDir, taskId, [result.sidecar.id]);
          throw error;
        }
        let conversationRestored = false;
        try {
          await this.replaceConversation(task, messages);
          conversationRestored = true;
        } catch (restoreError) {
          logger.error('[TaskNavigation] Failed to put the conversation back after a failed compaction; original messages were retained in the sidecar', {
            taskId,
            compactionId: result.sidecar.id,
            originalsRetained: true,
            error: describeError(restoreError),
          });
        }
        await task
          .saveTask({ metadata }, false)
          .catch((restoreError) =>
            logger.error('[TaskNavigation] Failed to restore task metadata after a failed compaction', { taskId, error: describeError(restoreError) }),
          );
        if (conversationRestored) {
          await this.deleteSidecars(taskBaseDir, taskId, [result.sidecar.id]);
        }
        throw error;
      }
    });
  }

  private async runTopicCompactionUndo(baseDir: string, taskId: string, compactionId: string): Promise<TaskData> {
    if (!isSafeCompactionFileId(compactionId)) {
      throw new TopicCompactionError('not-found', 'the topic map has no such compaction');
    }
    const task = this.requireIdleTask(baseDir, taskId);
    const summary = this.requireTaskSummary(task);
    const record = findCompactionRecord(summary.topics, compactionId);
    if (record) {
      const topic = summary.topics[record.topicIndex];
      this.assertNoCompactionOverlap(
        baseDir,
        taskId,
        topic.messageIds[0],
        record.sectionIndex === undefined ? undefined : topic.sections?.[record.sectionIndex]?.startMessageId,
        [record.info.promptMessageId, record.info.summaryMessageId],
      );
    }
    const taskBaseDir = task.task.baseDir;
    const sidecar = await readCompactionSidecar(taskBaseDir, taskId, compactionId);
    if (!sidecar) {
      throw new TopicCompactionError('not-found', 'the original messages of this compaction are missing');
    }

    const result = applyTopicCompactionUndo(await task.getContextMessages(), summary.topics, compactionId, sidecar.originalMessages);
    await this.replaceConversation(task, result.messages);
    const saved = await this.saveTopics(task, result.topics);
    await this.deleteSidecars(taskBaseDir, taskId, [compactionId]);
    logger.info('[TaskNavigation] Undid a topic compaction', { taskId, compactionId });
    await this.reindexTask(task);
    return saved;
  }

  private async runArchiveRestore(baseDir: string, taskId: string, archiveId: string): Promise<TaskData> {
    if (!isCompactionArchiveId(archiveId)) {
      throw new TopicCompactionError('not-found', 'the archive does not exist');
    }
    const task = this.requireIdleTask(baseDir, taskId);
    if ([...this.compactionReservations.values()].some((reservation) => reservation.taskKey === taskKey(baseDir, taskId))) {
      throw new TopicCompactionError('compacting', 'wait for this task’s compactions to finish');
    }
    const taskBaseDir = task.task.baseDir;
    const archive = await readCompactionArchive(taskBaseDir, taskId, archiveId);
    if (!archive) {
      throw new TopicCompactionError('not-found', 'the archive does not exist');
    }

    const info = await writeCompactionArchive(taskBaseDir, taskId, 'before-restore', await task.getContextMessages());
    await this.replaceConversation(task, archive.messages);
    const metadata: Record<string, unknown> = {
      ...(task.task.metadata ?? {}),
      [TASK_NAVIGATION_METADATA_KEYS.compactionArchives]: [...getCompactionArchives(task.task), info],
    };
    const summary = getTaskSummary(task.task);
    let deleted: string[] = [];
    if (summary) {
      const reconciled = this.reconcileTopics(summary.topics, archive.messages);
      metadata[TASK_NAVIGATION_METADATA_KEYS.taskSummary] = { ...summary, topics: reconciled.topics };
      deleted = reconciled.deletedCompactionIds;
    }
    const saved = await task.saveTask({ metadata }, false);
    await this.deleteSidecars(taskBaseDir, taskId, deleted);
    logger.info('[TaskNavigation] Restored a conversation archive', { taskId, archiveId, archivedCurrentAs: info.id });
    await this.reindexTask(task);
    return saved;
  }

  /**
   * Safeguard against built-in compaction: when a replacement of the conversation that this manager did not make removes
   * the recap of a topic compaction, the previous conversation is archived in the task folder at once, and the archive is
   * recorded in the task metadata once the replacement has settled.
   */
  private readonly handleContextReplace = (baseDir: string, taskId: string, previousMessages: unknown[], nextMessages: unknown[]): void => {
    if (this.disposed || !baseDir || !taskId || this.ownReplacements.has(taskKey(baseDir, taskId))) {
      return;
    }
    if (findRemovedCompactionSummaries(previousMessages, nextMessages).length === 0) {
      return;
    }

    let messages: ContextMessage[];
    try {
      messages = JSON.parse(JSON.stringify(previousMessages)) as ContextMessage[];
    } catch {
      messages = [...previousMessages] as ContextMessage[];
    }
    const navigationMetadata = this.captureNavigationMetadata(baseDir, taskId);
    const archived = writeCompactionArchive(baseDir, taskId, 'built-in-compaction', messages);
    archived.catch((error) =>
      logger.error('[TaskNavigation] Failed to archive the conversation before a built-in compaction', { taskId, error: describeError(error) }),
    );
    this.archiveJobs++;
    this.schedule(
      `compaction-archive:${taskKey(baseDir, taskId)}:${this.archiveJobs}`,
      this.dependencies.archiveMetadataDelayMs ?? ARCHIVE_METADATA_DELAY_MS,
      () => this.enqueue('summary', async () => this.recordArchive(baseDir, taskId, await archived, navigationMetadata)),
    );
  };

  /** The task navigation metadata of a task. Built-in compaction clears the task metadata; recordArchive puts it back. */
  private captureNavigationMetadata(baseDir: string, taskId: string): Record<string, unknown> {
    const metadata = this.findTask(baseDir, taskId)?.task.metadata ?? {};
    const keys: string[] = Object.values(TASK_NAVIGATION_METADATA_KEYS);
    return JSON.parse(JSON.stringify(Object.fromEntries(keys.filter((key) => key in metadata).map((key) => [key, metadata[key]])))) as Record<string, unknown>;
  }

  /** Records an archive made before a built-in compaction, puts back the cleared task navigation metadata, and reconciles its compactions. */
  private async recordArchive(baseDir: string, taskId: string, info: CompactionArchiveInfo, navigationMetadata: Record<string, unknown>): Promise<void> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return;
    }
    // Keys that hold a value again are kept, except the task number: a number given since then is replaced by the captured one
    const metadata: Record<string, unknown> = { ...(task.task.metadata ?? {}) };
    for (const [key, value] of Object.entries(navigationMetadata)) {
      if (metadata[key] === undefined || key === TASK_NAVIGATION_METADATA_KEYS.taskNumber) {
        metadata[key] = value;
      }
    }
    metadata[TASK_NAVIGATION_METADATA_KEYS.compactionArchives] = [...getCompactionArchives({ metadata }), info];
    const summary = getTaskSummary({ metadata });
    let deleted: string[] = [];
    if (summary) {
      const reconciled = this.reconcileTopics(summary.topics, await task.getContextMessages());
      metadata[TASK_NAVIGATION_METADATA_KEYS.taskSummary] = { ...summary, topics: reconciled.topics };
      deleted = reconciled.deletedCompactionIds;
    }
    await task.saveTask({ metadata }, false);
    await this.deleteSidecars(task.task.baseDir, taskId, deleted);
    logger.info('[TaskNavigation] Archived the conversation before a built-in compaction', { taskId, archiveId: info.id });
  }

  /** Brings compaction records and detached flags in line with the stored conversation. */
  private reconcileTopics(topics: TaskTopic[], messages: ContextMessage[]): CompactionReconcileResult {
    const storedIds = messages.map((message) => message.id);
    const reconciled = reconcileCompactions(topics, storedIds);
    return { ...reconciled, topics: markDetachedTopics(reconciled.topics, toConversationEntries(messages), storedIds) };
  }

  /** Re-indexes a task at once, after a compaction, an undo or a restore. */
  private async reindexTask(task: Task): Promise<void> {
    if (!this.getSettings().searchIndexEnabled || !this.index.isOpen()) {
      return;
    }
    try {
      const { baseDir, id } = task.task;
      const info = toIndexedInfo(task.task);
      const fingerprint = await statFingerprint(getContextPath(baseDir, id));
      this.index.replaceTask(info, await loadTaskIndexRows(baseDir, id, await task.getContextMessages()), fingerprint);
      this.infoSignatures.set(taskKey(baseDir, id), getInfoSignature(info));
      this.countsCache = null;
      this.queueEmbedding(baseDir, id);
    } catch (error) {
      logger.warn('[TaskNavigation] Failed to re-index a task', { taskId: task.task.id, error: describeError(error) });
    }
  }

  // Events

  private readonly handleEvent = (eventType: string, data: unknown): void => {
    if (this.disposed || !data) {
      return;
    }
    switch (eventType) {
      case 'task-updated':
        this.onTaskUpdated(data as TaskData);
        break;
      case 'task-created':
        this.onTaskCreated((data as TaskCreatedData).task);
        break;
      case 'task-deleted':
        this.onTaskDeleted(data as TaskData);
        break;
      case 'project-started':
        this.onProjectStarted((data as { baseDir: string }).baseDir);
        break;
      case 'settings-updated':
        this.onSettingsUpdated(data as SettingsData);
        break;
      default:
        break;
    }
  };

  private onTaskUpdated(task: TaskData): void {
    if (!task?.id || !task.baseDir || task.id === INTERNAL_TASK_ID) {
      return;
    }
    const key = taskKey(task.baseDir, task.id);
    const previousState = this.knownStates.get(key);
    this.knownStates.set(key, task.state);

    if (previousState === DefaultTaskState.InProgress && task.state !== DefaultTaskState.InProgress) {
      this.schedule(`post-prompt:${key}`, POST_PROMPT_DELAY_MS, () => this.afterPrompt(task.baseDir, task.id));
    }
    if (task.createdAt && getTaskNumber(task) === undefined) {
      this.scheduleNumbering(task.baseDir);
    }
    this.schedule(`info:${key}`, INFO_UPDATE_DELAY_MS, () => this.updateIndexedInfo(task.baseDir, task.id));
  }

  private onTaskCreated(task: TaskData | undefined): void {
    if (!task?.id || !task.baseDir || task.id === INTERNAL_TASK_ID) {
      return;
    }
    // Duplicated and forked tasks arrive with a copy of the source task's number
    this.scheduleNumbering(task.baseDir);
    this.schedule(`info:${taskKey(task.baseDir, task.id)}`, INFO_UPDATE_DELAY_MS, () => this.updateIndexedInfo(task.baseDir, task.id));
  }

  private onTaskDeleted(task: TaskData): void {
    if (!task?.id || !task.baseDir) {
      return;
    }
    const key = taskKey(task.baseDir, task.id);
    this.knownStates.delete(key);
    this.infoSignatures.delete(key);
    if (this.index.isOpen()) {
      try {
        this.index.deleteTask(normalizeBaseDir(task.baseDir), task.id);
      } catch (error) {
        logger.warn('[TaskNavigation] Failed to remove a deleted task from the search index', { taskId: task.id, error: describeError(error) });
      }
    }
  }

  private onProjectStarted(baseDir: string | undefined): void {
    if (!baseDir) {
      return;
    }
    this.scheduleNumbering(baseDir);
    this.schedule(`project-scan:${normalizeBaseDir(baseDir)}`, PROJECT_SCAN_DELAY_MS, () => this.enqueueScan([baseDir]));
  }

  private onSettingsUpdated(settings: SettingsData): void {
    const next = getTaskNavigationSettings(settings);
    const previous = this.lastSettings;
    this.lastSettings = next;
    if (!previous) {
      return;
    }
    if (next.searchIndexEnabled && !previous.searchIndexEnabled) {
      this.schedule('settings-scan', 1_000, () => this.enqueueScan(null));
    } else if (next.conceptSearchEnabled && !previous.conceptSearchEnabled) {
      this.schedule('settings-embedding', 1_000, () => this.queueEmbeddingForAll());
    }
  }

  // Scheduling helpers

  private getSettings(): TaskNavigationSettings {
    return getTaskNavigationSettings(this.dependencies.store.getSettings());
  }

  private schedule(key: string, delayMs: number, work: () => unknown): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.disposed) {
          return;
        }
        Promise.resolve()
          .then(work)
          .catch((error) => logger.warn('[TaskNavigation] Background work failed', { key, error: describeError(error) }));
      }, delayMs),
    );
  }

  private enqueue<T>(chain: ChainName, work: () => Promise<T>): Promise<T> {
    const run = this.chains[chain].then(work);
    this.chains[chain] = run.catch(() => undefined);
    return run;
  }

  private findProject(baseDir: string): Project | undefined {
    return this.dependencies.projectManager.getProjects().find((project) => compareBaseDirs(project.baseDir, baseDir));
  }

  private findTask(baseDir: string, taskId: string): Task | undefined {
    return this.findProject(baseDir)?.getTask(taskId) ?? undefined;
  }

  private async patchTaskMetadata(baseDir: string, taskId: string, patch: Record<string, unknown>): Promise<TaskData | null> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return null;
    }
    return task.saveTask({ metadata: { ...(task.task.metadata ?? {}), ...patch } }, false);
  }

  // Task numbers

  private scheduleNumbering(baseDir: string): void {
    this.schedule(`numbering:${normalizeBaseDir(baseDir)}`, NUMBERING_DELAY_MS, () => this.enqueue('numbering', () => this.assignTaskNumbers(baseDir)));
  }

  private getIndexedTaskNumber(baseDir: string, taskId: string): number | undefined {
    if (!this.index.isOpen()) {
      return undefined;
    }
    try {
      return this.index.getTask(normalizeBaseDir(baseDir), taskId)?.taskNumber;
    } catch {
      return undefined;
    }
  }

  /** Numbers every saved task of a project that has no number, oldest first, and renumbers duplicates. */
  private async assignTaskNumbers(baseDir: string): Promise<void> {
    const project = this.findProject(baseDir);
    if (!project) {
      return;
    }

    const tasks = (await project.getTasks()).filter((task) => task.createdAt && task.id !== INTERNAL_TASK_ID);
    tasks.sort((first, second) => (first.createdAt ?? '').localeCompare(second.createdAt ?? '') || first.id.localeCompare(second.id));

    const projectKey = normalizeBaseDir(project.baseDir);
    let highest = this.highWaterMarks.get(projectKey) ?? 0;
    const byNumber = new Map<number, TaskData[]>();
    for (const task of tasks) {
      const taskNumber = getTaskNumber(task);
      if (taskNumber !== undefined) {
        highest = Math.max(highest, taskNumber);
        byNumber.set(taskNumber, [...(byNumber.get(taskNumber) ?? []), task]);
      }
    }

    const toNumber = new Set<string>(tasks.filter((task) => getTaskNumber(task) === undefined).map((task) => task.id));
    for (const [taskNumber, candidates] of byNumber) {
      if (candidates.length < 2) {
        continue;
      }
      const owner = candidates.find((task) => this.getIndexedTaskNumber(project.baseDir, task.id) === taskNumber) ?? candidates[0];
      candidates.filter((task) => task !== owner).forEach((task) => toNumber.add(task.id));
    }

    let assigned = 0;
    for (const task of tasks) {
      if (!toNumber.has(task.id)) {
        continue;
      }
      highest += 1;
      await this.patchTaskMetadata(project.baseDir, task.id, { [TASK_NAVIGATION_METADATA_KEYS.taskNumber]: highest });
      assigned++;
    }
    this.highWaterMarks.set(projectKey, highest);

    if (assigned > 0) {
      logger.info('[TaskNavigation] Assigned task numbers', { baseDir: project.baseDir, assigned, highest });
    }
  }

  // After a prompt

  private async afterPrompt(baseDir: string, taskId: string): Promise<void> {
    const task = this.findTask(baseDir, taskId);
    if (!task || task.task.state === DefaultTaskState.InProgress) {
      return;
    }

    const settings = this.getSettings();
    const messages = await task.getContextMessages();
    const entries = toConversationEntries(messages);

    if (settings.searchIndexEnabled && this.index.isOpen()) {
      const fingerprint = await statFingerprint(getContextPath(task.task.baseDir, taskId));
      this.index.replaceTask(toIndexedInfo(task.task), await loadTaskIndexRows(task.task.baseDir, taskId, messages), fingerprint);
      this.infoSignatures.set(taskKey(task.task.baseDir, taskId), getInfoSignature(toIndexedInfo(task.task)));
      this.queueEmbedding(task.task.baseDir, taskId);
    }

    if (settings.autoSummarize && entries.length > 0) {
      this.queueSummary(baseDir, taskId, false).catch((error) =>
        logger.warn('[TaskNavigation] Topic map update failed', { baseDir, taskId, error: describeError(error) }),
      );
    } else {
      await this.savePreview(task, entries);
    }
  }

  private async savePreview(task: Task, entries: ConversationEntry[]): Promise<void> {
    const preview = buildPreview(entries);
    const existing = getTaskLastMessagePreview(task.task);
    if (!preview || (existing && existing.role === preview.role && existing.text === preview.text)) {
      return;
    }
    await task.saveTask({ metadata: { ...(task.task.metadata ?? {}), [TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview]: preview } }, false);
  }

  // Topic maps

  private queueSummary(baseDir: string, taskId: string, rebuild: boolean): Promise<TaskData | null> {
    const key = taskKey(baseDir, taskId);
    if (!rebuild && this.pendingSummaries.has(key)) {
      return Promise.resolve(null);
    }
    this.pendingSummaries.add(key);
    return this.enqueue('summary', async () => {
      this.pendingSummaries.delete(key);
      if ([...this.compactionReservations.values()].some((reservation) => reservation.taskKey === key)) {
        if (rebuild) {
          throw new TopicCompactionError('compacting', 'wait for this task’s compactions to finish');
        }
        this.deferredCompactionSummaries.set(key, { baseDir, taskId });
        return null;
      }
      return this.summarize(baseDir, taskId, rebuild);
    });
  }

  private async resolveSummaryModel(task: Task, settings: TaskNavigationSettings): Promise<string | null> {
    if (settings.summaryModel) {
      return settings.summaryModel;
    }
    const taskNameModel = this.dependencies.store.getSettings().taskSettings?.taskNameModel;
    if (taskNameModel) {
      return taskNameModel;
    }
    const profile = await task.getTaskAgentProfile();
    return profile ? `${profile.provider}/${profile.model}` : null;
  }

  private async generate(
    modelId: string,
    projectDir: string,
    sessionId: string,
    systemPrompt: string,
    prompt: string,
    timeoutMs = SUMMARY_TIMEOUT_MS,
  ): Promise<string> {
    if (this.dependencies.generate) {
      return this.dependencies.generate(modelId, projectDir, sessionId, systemPrompt, prompt, timeoutMs);
    }
    const { modelManager, store } = this.dependencies;
    const [providerId, modelName] = extractProviderModel(modelId);
    const provider = modelManager.getProviders().find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }

    const model = await modelManager.createLlm(provider, modelName, store.getSettings(), projectDir, undefined, systemPrompt, undefined, sessionId);
    const result = await generateText({
      model,
      instructions: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions: modelManager.getProviderOptions(provider, modelName),
      ...modelManager.getProviderParameters(provider, modelName),
    });
    return result.text;
  }

  /**
   * Extends the task's topic map with the messages it does not cover yet (or rebuilds it), divides the topics that
   * closed into sections, then saves the topic map, the last-message preview and, only when automatic titles are enabled
   * and the title is not manually locked, the regenerated title.
   */
  private async summarize(baseDir: string, taskId: string, rebuild: boolean): Promise<TaskData | null> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return null;
    }

    const settings = this.getSettings();
    const messages = await task.getContextMessages();
    const entries = toConversationEntries(messages);
    const stored = getTaskSummary(task.task);
    const existing = rebuild ? undefined : stored;
    // A rebuild keeps the topics up to the last compacted one, so that their compactions can still be undone
    const reconciled = this.reconcileTopics(rebuild ? selectTopicsKeptOnRebuild(stored?.topics ?? []) : (existing?.topics ?? []), messages);
    let topics: TaskTopic[] = reconciled.topics;
    let title = existing?.title ?? '';
    let description = existing?.description ?? '';
    let lastSummarizedMessageId = existing?.lastSummarizedMessageId;
    let model = existing?.model;
    let generated = false;
    let failure: unknown;
    const previousCurrentIndex = findCurrentTopicIndex(topics);
    const previousCount = topics.length;

    const pending = getUnsummarizedEntries(entries, topics);
    if (pending.length > 0) {
      const modelId = await this.resolveSummaryModel(task, settings);
      if (!modelId) {
        failure = new Error('No model is available for topic maps');
      } else {
        try {
          for (const chunk of chunkEntries(pending, SUMMARY_CHUNK_CHARACTERS)) {
            const prompt = buildSummaryPrompt(getDisplayName(task.task), title, topics, chunk, description);
            const response = await this.generate(modelId, task.task.baseDir, taskId, SUMMARY_SYSTEM_PROMPT, prompt);
            const update = parseSummaryResponse(response);
            if (!update) {
              failure = new Error('The model did not return a valid topic map');
              logger.warn('[TaskNavigation] Unparseable topic map response', { taskId, modelId, response: (response ?? '').slice(0, 300) });
              break;
            }
            topics = applySummaryUpdate(topics, chunk, update);
            title = cleanTitle(update.title) || title;
            description = cleanDescription(update.description) || description;
            lastSummarizedMessageId = chunk[chunk.length - 1].entry.id;
            model = modelId;
            generated = true;
          }
        } catch (error) {
          failure = error;
          logger.warn('[TaskNavigation] Topic map generation failed', { baseDir, taskId, modelId, error: describeError(error) });
        }
      }
    }

    if (rebuild && failure && !generated) {
      throw failure instanceof Error ? failure : new Error(describeError(failure));
    }

    const sectionCandidates = generated || pending.length === 0 ? selectTopicsToSection(topics, previousCurrentIndex, previousCount) : [];
    if (sectionCandidates.length > 0) {
      const sectionModelId = generated && model ? model : await this.resolveSummaryModel(task, settings);
      if (sectionModelId) {
        const sectioning = await sectionTopics(
          topics,
          sectionCandidates,
          entries,
          (systemPrompt, prompt) => this.generate(sectionModelId, task.task.baseDir, taskId, systemPrompt, prompt),
          SUMMARY_CHUNK_CHARACTERS,
        );
        topics = sectioning.topics;
        for (const warning of sectioning.warnings) {
          logger.warn(`[TaskNavigation] ${warning.message}`, { taskId, modelId: sectionModelId, ...warning.details });
        }
        if (sectioning.done > 0) {
          logger.info('[TaskNavigation] Sectioned topics', { taskId, topics: sectioning.done, withSections: sectioning.withSections, calls: sectioning.calls });
        }
      }
    }

    const current = task.task;
    const metadata: Record<string, unknown> = { ...(current.metadata ?? {}) };
    if (topics.length > 0) {
      const summary: TaskSummary = {
        title,
        ...(description ? { description } : {}),
        topics,
        lastSummarizedMessageId,
        generatedAt: generated || !existing ? new Date().toISOString() : existing.generatedAt,
        model,
      };
      metadata[TASK_NAVIGATION_METADATA_KEYS.taskSummary] = summary;
    } else if (rebuild) {
      delete metadata[TASK_NAVIGATION_METADATA_KEYS.taskSummary];
    }
    const preview = buildPreview(entries);
    if (preview) {
      metadata[TASK_NAVIGATION_METADATA_KEYS.lastMessagePreview] = preview;
    }

    const updates: Partial<TaskData> = { metadata };
    if (settings.autoRegenerateTitle && generated && title && !isTaskNameLocked(current) && current.name !== GENERATING_NAME && current.name !== title) {
      updates.name = title;
    }

    if (updates.name === undefined && JSON.stringify(metadata) === JSON.stringify(current.metadata ?? {})) {
      return current;
    }

    const saved = await task.saveTask(updates, false);
    await this.deleteSidecars(saved.baseDir, saved.id, reconciled.deletedCompactionIds);
    this.queueEmbedding(saved.baseDir, saved.id);
    return saved;
  }

  // Search index

  private runKeywordSearch(ftsQuery: string): KeywordHit[] {
    try {
      return this.index.keywordSearch(ftsQuery, KEYWORD_HIT_LIMIT);
    } catch (error) {
      logger.debug('[TaskNavigation] Keyword search failed', { ftsQuery, error: describeError(error) });
      return [];
    }
  }

  private updateIndexedInfo(baseDir: string, taskId: string): void {
    if (!this.getSettings().searchIndexEnabled || !this.index.isOpen()) {
      return;
    }
    const task = this.findTask(baseDir, taskId)?.task;
    if (!task || !task.createdAt) {
      return;
    }

    const info = toIndexedInfo(task);
    const signature = getInfoSignature(info);
    const key = taskKey(baseDir, taskId);
    if (this.infoSignatures.get(key) === signature) {
      return;
    }

    const previous = this.index.getTask(info.baseDir, info.taskId);
    this.index.updateTaskInfo(info);
    this.infoSignatures.set(key, signature);
    if (!previous || previous.name !== info.name || JSON.stringify(previous.topics ?? []) !== JSON.stringify(info.topics ?? [])) {
      this.queueEmbedding(info.baseDir, info.taskId);
    }
  }

  private enqueueScan(baseDirs: string[] | null): Promise<void> {
    return this.enqueue('scan', () => this.scan(baseDirs));
  }

  /** Brings the index in line with the task folders on disk. Null scans every known project. */
  private async scan(baseDirs: string[] | null): Promise<void> {
    if (this.disposed || !this.index.isOpen() || !this.getSettings().searchIndexEnabled) {
      return;
    }

    const started = Date.now();
    const fullScan = baseDirs === null;
    const projectDirs = fullScan ? await this.collectProjectDirs() : baseDirs.map((baseDir) => normalizeBaseDir(baseDir));
    const plans: Array<{ baseDir: string; taskIds: string[] }> = [];
    for (const baseDir of projectDirs) {
      const taskIds = await this.listTaskIdsOnDisk(baseDir);
      if (taskIds) {
        plans.push({ baseDir, taskIds });
      }
    }

    this.scanning = true;
    this.scanDone = 0;
    this.scanTotal = plans.reduce((total, plan) => total + plan.taskIds.length, 0);
    let reindexed = 0;
    try {
      for (const plan of plans) {
        if (this.disposed) {
          return;
        }
        reindexed += await this.scanProject(plan.baseDir, plan.taskIds);
      }
    } finally {
      this.scanning = false;
      this.countsCache = null;
    }

    logger.info('[TaskNavigation] Search index scan finished', {
      projects: plans.length,
      tasks: this.scanTotal,
      reindexed,
      ms: Date.now() - started,
    });

    if (fullScan) {
      this.queueEmbeddingForAll();
    }
  }

  private async scanProject(baseDir: string, taskIds: string[]): Promise<number> {
    const project = this.findProject(baseDir);
    const liveTasks = new Map<string, TaskData>();
    if (project) {
      for (const task of await project.getTasks()) {
        liveTasks.set(task.id, task);
      }
    }

    const onDisk = new Set(taskIds);
    for (const indexed of this.index.listTasks(baseDir)) {
      if (!onDisk.has(indexed.taskId)) {
        this.index.deleteTask(baseDir, indexed.taskId);
      }
    }

    let reindexed = 0;
    for (const taskId of taskIds) {
      if (this.disposed) {
        break;
      }
      try {
        const task = liveTasks.get(taskId) ?? (await this.readTaskData(baseDir, taskId));
        if (task) {
          const info: IndexedTaskInfo = { ...toIndexedInfo(task), baseDir };
          const contextPath = getContextPath(baseDir, taskId);
          const fingerprint = await statFingerprint(contextPath);
          if (fingerprint && !isSameFingerprint(fingerprint, this.index.getFingerprint(baseDir, taskId))) {
            const messages = readContextMessages(await fs.readFile(contextPath, 'utf8'));
            this.index.replaceTask(info, await loadTaskIndexRows(baseDir, taskId, messages), fingerprint);
            reindexed++;
            await delay(SCAN_YIELD_MS);
          } else {
            const existing = this.index.getTask(baseDir, taskId);
            if (!existing || getInfoSignature(existing) !== getInfoSignature(info)) {
              this.index.updateTaskInfo(info);
            }
          }
          this.infoSignatures.set(taskKey(baseDir, taskId), getInfoSignature(info));
        }
      } catch (error) {
        logger.debug('[TaskNavigation] Skipped a task while indexing', { baseDir, taskId, error: describeError(error) });
      }
      this.scanDone++;
      if (this.scanDone % 25 === 0) {
        await delay(0);
      }
    }
    return reindexed;
  }

  private async readTaskData(baseDir: string, taskId: string): Promise<TaskData | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(getSettingsPath(baseDir, taskId), 'utf8')) as TaskData;
      return { ...parsed, id: taskId, baseDir };
    } catch {
      return null;
    }
  }

  private async listTaskIdsOnDisk(baseDir: string): Promise<string[] | null> {
    try {
      const entries = await fs.readdir(path.join(baseDir, AIDER_DESK_TASKS_DIR), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && entry.name !== INTERNAL_TASK_ID).map((entry) => entry.name);
    } catch {
      return null;
    }
  }

  private async collectProjectDirs(): Promise<string[]> {
    const dirs = new Set<string>();
    // Only absolute paths: the usage history also holds relative project paths, which would index a project twice
    const add = (baseDir: string | null | undefined) => {
      if (baseDir && path.isAbsolute(baseDir)) {
        dirs.add(normalizeBaseDir(baseDir));
      }
    };
    const { store, projectManager } = this.dependencies;
    store.getOpenProjects().forEach((project) => add(project.baseDir));
    store.getRecentProjects().forEach(add);
    projectManager.getProjects().forEach((project) => add(project.baseDir));
    this.index.listTasks().forEach((task) => add(task.baseDir));
    (await this.discoverHistoricalProjects()).forEach(add);
    return [...dirs];
  }

  /** On the first run, finds every project that appears in the usage history so its conversations get indexed. */
  private async discoverHistoricalProjects(): Promise<string[]> {
    try {
      await fs.access(DISCOVERY_MARKER_FILE);
      return [];
    } catch {
      // First run: discover the projects below.
    }

    let projects: string[] = [];
    try {
      const database = new DatabaseSync(DB_FILE_PATH, { readOnly: true });
      try {
        const rows = database.prepare('SELECT DISTINCT project FROM messages').all() as unknown as Array<{ project: string | null }>;
        projects = rows.map((row) => row.project).filter((project): project is string => typeof project === 'string' && project.length > 0);
      } finally {
        database.close();
      }
    } catch (error) {
      logger.warn('[TaskNavigation] Could not read project history from the usage database', { error: describeError(error) });
    }

    try {
      await fs.writeFile(DISCOVERY_MARKER_FILE, new Date().toISOString());
    } catch (error) {
      logger.warn('[TaskNavigation] Could not write the project discovery marker', { error: describeError(error) });
    }
    return projects;
  }

  // Concept search vectors

  private queueEmbedding(baseDir: string, taskId: string): void {
    const settings = this.getSettings();
    if (!settings.searchIndexEnabled || !settings.conceptSearchEnabled || this.embedder.isUnavailable()) {
      return;
    }
    const indexDir = normalizeBaseDir(baseDir);
    this.schedule(`embedding:${taskKey(indexDir, taskId)}`, EMBEDDING_DELAY_MS, () => this.enqueue('embedding', () => this.embedTask(indexDir, taskId)));
  }

  private queueEmbeddingForAll(): void {
    const settings = this.getSettings();
    if (!settings.searchIndexEnabled || !settings.conceptSearchEnabled || this.embedder.isUnavailable() || !this.index.isOpen()) {
      return;
    }
    this.enqueue('embedding', async () => {
      const started = Date.now();
      this.embeddingJobs++;
      try {
        for (const task of this.index.listTasks()) {
          if (this.disposed || this.embedder.isUnavailable()) {
            break;
          }
          await this.embedTask(task.baseDir, task.taskId);
        }
      } finally {
        this.embeddingJobs--;
      }
      logger.info('[TaskNavigation] Concept index up to date', { ms: Date.now() - started });
    }).catch((error) => logger.warn('[TaskNavigation] Concept indexing failed', { error: describeError(error) }));
  }

  /** Embeds the task's title, topics and user prompts whose text changed since they were last embedded. */
  private async embedTask(baseDir: string, taskId: string): Promise<void> {
    const settings = this.getSettings();
    if (this.disposed || !this.index.isOpen() || !settings.conceptSearchEnabled || this.embedder.isUnavailable()) {
      return;
    }
    const info = this.index.getTask(baseDir, taskId);
    if (!info) {
      return;
    }

    const desired: Array<Omit<VectorWrite, 'vector' | 'textHash'>> = [];
    if (info.name) {
      desired.push({ slot: 'title', messageId: SEARCH_TASK_ROW_MESSAGE_ID, kind: 'title', text: info.name });
    }
    (info.topics ?? []).forEach((summary, index) => {
      if (summary) {
        desired.push({ slot: `topic:${index}`, messageId: SEARCH_TASK_ROW_MESSAGE_ID, kind: 'topic', text: summary });
      }
    });
    this.index
      .getUserMessages(baseDir, taskId)
      .filter((message) => countWords(message.content) >= MIN_USER_VECTOR_WORDS)
      .slice(-MAX_USER_VECTORS_PER_TASK)
      .forEach((message) => {
        desired.push({
          slot: `user:${message.messageId}`,
          messageId: message.scrollTarget ?? message.messageId,
          kind: 'user',
          text: truncateText(collapseWhitespace(message.content), USER_VECTOR_TEXT_LENGTH),
        });
      });

    const existing = this.index.getVectorHashes(baseDir, taskId);
    const keepSlots = new Set(desired.map((item) => item.slot));
    const writes: VectorWrite[] = [];
    for (const item of desired) {
      const textHash = hashText(item.text);
      if (existing.get(item.slot) === textHash) {
        continue;
      }
      const vector = await this.embedder.embed(item.text);
      if (!vector) {
        return;
      }
      writes.push({ ...item, textHash, vector });
      if (writes.length % 16 === 0) {
        await delay(0);
      }
    }

    const hasRemovals = [...existing.keys()].some((slot) => !keepSlots.has(slot));
    if (writes.length > 0 || hasRemovals) {
      this.index.writeVectors(baseDir, taskId, writes, keepSlots);
    }
  }
}

export const initTaskNavigation = (dependencies: TaskNavigationManagerDependencies): TaskNavigationManager => {
  const manager = new TaskNavigationManager(dependencies);
  setTaskNavigationManager(manager);
  manager.init();
  return manager;
};
