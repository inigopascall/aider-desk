import fs from 'fs/promises';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import { generateText } from 'ai';
import {
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
  getTaskLastMessagePreview,
  getTaskNavigationSettings,
  getTaskNumber,
  getTaskSummary,
  isTaskNameLocked,
} from '@common/types';
import { compareBaseDirs, extractProviderModel, normalizeBaseDir } from '@common/utils';

import { TextEmbedder } from './embeddings';
import { setTaskNavigationEventListener } from './hooks';
import { setTaskNavigationManager } from './instance';
import { ConversationEntry, collapseWhitespace, hashText, toConversationEntries, toIndexedContent, truncateText } from './message-text';
import { ContextFingerprint, IndexMessageRow, IndexedTaskInfo, KeywordHit, SearchIndex, VectorWrite, buildFtsQuery } from './search-index';
import {
  SUMMARY_SYSTEM_PROMPT,
  applySummaryUpdate,
  buildSummaryPrompt,
  chunkEntries,
  cleanTitle,
  findCurrentTopicIndex,
  getUnsummarizedEntries,
  markDetachedTopics,
  parseSummaryResponse,
  sectionTopics,
  selectTopicsToSection,
} from './summary-model';

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

type ChainName = 'summary' | 'numbering' | 'scan' | 'embedding';

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

export interface TaskNavigationManagerDependencies {
  store: Store;
  projectManager: ProjectManager;
  modelManager: ModelManager;
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

const toIndexRows = (entries: ConversationEntry[]): IndexMessageRow[] =>
  entries.map((entry) => ({ messageId: entry.id, role: entry.role, content: toIndexedContent(entry), timestamp: entry.timestamp }));

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
  private readonly index = new SearchIndex(SEARCH_INDEX_FILE);
  private readonly embedder = new TextEmbedder();
  private readonly knownStates = new Map<string, string | undefined>();
  private readonly infoSignatures = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly highWaterMarks = new Map<string, number>();
  private readonly pendingSummaries = new Set<string>();
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

  constructor(private readonly dependencies: TaskNavigationManagerDependencies) {}

  init(): void {
    try {
      this.index.open();
    } catch (error) {
      this.error = describeError(error);
      logger.error('[TaskNavigation] Failed to open the search index', { file: SEARCH_INDEX_FILE, error: this.error });
    }

    this.lastSettings = this.getSettings();
    setTaskNavigationEventListener(this.handleEvent);

    for (const project of this.dependencies.projectManager.getProjects()) {
      this.scheduleNumbering(project.baseDir);
    }
    this.schedule('startup-scan', STARTUP_SCAN_DELAY_MS, () => this.enqueueScan(null));
  }

  dispose(): void {
    this.disposed = true;
    setTaskNavigationEventListener(null);
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
        if (group.hits.length < MAX_HITS_PER_TASK && !group.hits.some((existing) => existing.messageId === hit.messageId)) {
          group.hits.push({ messageId: hit.messageId, role: hit.role, snippet: hit.snippet, timestamp: hit.timestamp, matchedBy: 'keyword' });
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
    const entries = toConversationEntries(await task.getContextMessages());

    if (settings.searchIndexEnabled && this.index.isOpen()) {
      const fingerprint = await statFingerprint(getContextPath(task.task.baseDir, taskId));
      this.index.replaceTask(toIndexedInfo(task.task), toIndexRows(entries), fingerprint);
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

  private async generate(modelId: string, projectDir: string, sessionId: string, systemPrompt: string, prompt: string): Promise<string> {
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
      abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      providerOptions: modelManager.getProviderOptions(provider, modelName),
      ...modelManager.getProviderParameters(provider, modelName),
    });
    return result.text;
  }

  /**
   * Extends the task's topic map with the messages it does not cover yet (or rebuilds it), divides the topics that
   * closed into sections, then saves the topic map, the last-message preview and, unless the title is locked, the
   * regenerated title.
   */
  private async summarize(baseDir: string, taskId: string, rebuild: boolean): Promise<TaskData | null> {
    const task = this.findTask(baseDir, taskId);
    if (!task) {
      return null;
    }

    const settings = this.getSettings();
    const entries = toConversationEntries(await task.getContextMessages());
    const existing = rebuild ? undefined : getTaskSummary(task.task);
    let topics: TaskTopic[] = markDetachedTopics(existing?.topics ?? [], entries);
    let title = existing?.title ?? '';
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
            const prompt = buildSummaryPrompt(getDisplayName(task.task), title, topics, chunk);
            const response = await this.generate(modelId, task.task.baseDir, taskId, SUMMARY_SYSTEM_PROMPT, prompt);
            const update = parseSummaryResponse(response);
            if (!update) {
              failure = new Error('The model did not return a valid topic map');
              logger.warn('[TaskNavigation] Unparseable topic map response', { taskId, modelId, response: (response ?? '').slice(0, 300) });
              break;
            }
            topics = applySummaryUpdate(topics, chunk, update);
            title = cleanTitle(update.title) || title;
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
            const entries = toConversationEntries(readContextMessages(await fs.readFile(contextPath, 'utf8')));
            this.index.replaceTask(info, toIndexRows(entries), fingerprint);
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
          messageId: message.messageId,
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
