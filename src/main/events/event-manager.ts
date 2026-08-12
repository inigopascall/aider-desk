import { Socket } from 'socket.io';
import {
  ContextFile,
  InputHistoryData,
  ProviderProfile,
  LogData,
  SystemLogData,
  ModelsData,
  NotificationData,
  QuestionData,
  QuestionAnsweredData,
  ResponseChunkData,
  ResponseCompletedData,
  CommandOutputData,
  TerminalData,
  TerminalExitData,
  ToolData,
  ToolInputChunkData,
  TokensInfoData,
  UserMessageData,
  MessageRemovedData,
  VersionsInfo,
  AutocompletionData,
  ProviderModelsData,
  ProvidersUpdatedData,
  SettingsData,
  TaskData,
  ClearTaskData,
  ProjectSettings,
  AgentProfile,
  AgentProfilesUpdatedData,
  McpServersData,
  WorktreeIntegrationStatus,
  WorktreeIntegrationStatusUpdatedData,
  TaskCreatedData,
  UpdatedFile,
  UpdatedFilesUpdatedData,
  QueuedPromptData,
  QueuedPromptsUpdatedData,
  SkillDefinition,
  SkillsUpdatedData,
  CommandsData,
  ExtensionUIRefreshData,
  ModalOverlayUrlData,
  ContextInfoData,
  WorkflowLogData,
  WorkflowLogsUpdatedData,
} from '@common/types';

import type { WindowManager } from '@/window-manager';

import logger from '@/logger';

export interface EventsConnectorConfig {
  eventTypes?: string[];
  baseDirs?: string[];
  readonly?: boolean;
  streamMode?: 'live' | 'coalesced';
  streamFlushIntervalMs?: number;
}

/**
 * A pending event held in the coalescing buffer before being flushed to a connector.
 */
interface PendingEvent {
  type: string;
  data: unknown;
  taskId?: string;
}

export interface EventsConnector extends EventsConnectorConfig {
  socket: Socket;
  /** Buffered events awaiting flush, keyed by `${eventType}::${coalesceKey}`. */
  pending: Map<string, PendingEvent>;
  /** Timer for the next scheduled flush, or null if none scheduled. */
  flushTimer: NodeJS.Timeout | null;
  /** Resolved stream mode (defaults to 'coalesced' if not specified). */
  resolvedStreamMode: 'live' | 'coalesced';
  /** Resolved flush interval in milliseconds, clamped to [MIN, MAX]. */
  resolvedFlushIntervalMs: number;
}

type EventListener = (event: { type: string; data: unknown }) => void;

const EVENT_BUFFER_SIZE = 200;

/** Default interval at which coalesced events are flushed to each connector. */
const DEFAULT_STREAM_FLUSH_INTERVAL_MS = 2500;
/** Minimum allowed flush interval (prevents excessive timer churn). */
const MIN_STREAM_FLUSH_INTERVAL_MS = 50;
/** Maximum allowed flush interval (prevents stale data). */
const MAX_STREAM_FLUSH_INTERVAL_MS = 30_000;
/** If a single coalesced entry exceeds this character count, flush immediately. */
const MAX_COALESCED_ENTRY_CHARS = 262_144;

// ── Coalescing strategy helpers ──────────────────────────────────────────────

/** Builds a composite key from baseDir + taskId for grouping events by task. */
const taskKey = (d: any): string => `${d?.baseDir ?? ''}|${d?.taskId ?? ''}`;

/** Merge function that simply replaces the previous value with the next. */
const latest = (_prev: any, next: any) => next;

/** Extracts the taskId from an event payload, checking both `taskId` and `id`. */
const getEventTaskId = (d: any): string | undefined =>
  d && typeof d === 'object' ? (d.taskId ?? d.id) : undefined;

/**
 * Merges two response-chunk events by concatenating their `chunk` and `reasoning`
 * fields. Used when multiple text deltas for the same message are coalesced.
 */
const mergeResponseChunk = (prev: any, next: any) => ({
  ...next,
  chunk: (prev.chunk ?? '') + (next.chunk ?? ''),
  reasoning:
    prev.reasoning || next.reasoning
      ? (prev.reasoning ?? '') + (next.reasoning ?? '')
      : undefined,
});

/**
 * Merges two command-output events by concatenating `output` and preserving
 * the earliest `timestamp`.
 */
const mergeCommandOutput = (prev: any, next: any) => ({
  ...next,
  output: (prev.output ?? '') + (next.output ?? ''),
  timestamp: prev.timestamp ?? next.timestamp,
});

/**
 * Merges two tool events, preferring `next` for most fields but preserving
 * the earliest `timestamp` and falling back to `prev` for optional fields.
 */
const mergeTool = (prev: any, next: any) => ({
  ...prev,
  ...next,
  args: next.args ?? prev.args,
  response: next.response ?? prev.response,
  usageReport: next.usageReport ?? prev.usageReport,
  promptContext: next.promptContext ?? prev.promptContext,
  finished: next.finished ?? prev.finished,
  timestamp: prev.timestamp ?? next.timestamp,
});

/**
 * Strategy table: for each coalesceable event type, a function that computes
 * a grouping key from the event data (or returns null for "send immediately"),
 * and a merge function that combines a previous and next event with the same key.
 *
 * Events not listed here are always sent immediately (no coalescing).
 */
interface CoalesceStrategy {
  key: (d: any) => string | null;
  merge: (prev: any, next: any) => any;
}

const COALESCE_STRATEGIES: Record<string, CoalesceStrategy> = {
  'response-chunk': {
    key: (d) => (d.reflectedMessage ? null : `${taskKey(d)}|${d.messageId}`),
    merge: mergeResponseChunk,
  },
  'tool-input-chunk': {
    key: (d) => `${taskKey(d)}|${d.toolCallId}`,
    merge: latest,
  },
  tool: {
    key: (d) => `${taskKey(d)}|${d.id}`,
    merge: mergeTool,
  },
  'command-output': {
    key: (d) => `${taskKey(d)}|${d.command}`,
    merge: mergeCommandOutput,
  },
  log: {
    key: (d) =>
      d.level === 'loading' && !d.finished
        ? `${taskKey(d)}|${d.promptContext?.group?.id ?? ''}`
        : null,
    merge: latest,
  },
  'update-tokens-info': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'update-autocompletion': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'context-files-updated': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'updated-files-updated': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'skills-updated': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'worktree-integration-status-updated': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'queued-prompts-updated': {
    key: (d) => taskKey(d),
    merge: latest,
  },
  'task-updated': {
    key: (d) => `${d.baseDir}|${d.id}`,
    merge: latest,
  },
};

export class EventManager {
  private eventsConnectors: EventsConnector[] = [];
  private sseListeners: Map<string, Set<EventListener>> = new Map();
  private eventBuffer: { type: string; data: unknown }[] = [];

  constructor(private readonly windowManager?: WindowManager) {}

  // Project lifecycle events
  sendProjectStarted(baseDir: string): void {
    const data = { baseDir };
    this.sendToWindows('project-started', data);
    this.broadcastToEventConnectors('project-started', data);
  }

  sendClearTask(baseDir: string, taskId: string, clearMessages: boolean, clearFiles: boolean): void {
    const data: ClearTaskData = {
      baseDir,
      taskId,
      clearMessages,
      clearSession: clearFiles,
    };
    this.sendToWindows('clear-task', data);
    this.broadcastToEventConnectors('clear-task', data);
  }

  sendContextInfoUpdated(data: ContextInfoData): void {
    this.sendToWindows('context-info-updated', data);
    this.broadcastToEventConnectors('context-info-updated', data);
  }

  // File management events
  sendFileAdded(baseDir: string, taskId: string, file: ContextFile): void {
    const data = {
      baseDir,
      taskId,
      file,
    };
    this.sendToWindows('file-added', data);
    this.broadcastToEventConnectors('file-added', data);
  }

  sendContextFilesUpdated(baseDir: string, taskId: string, files: ContextFile[]): void {
    const data = {
      baseDir,
      taskId,
      files,
    };
    this.sendToWindows('context-files-updated', data);
    this.broadcastToEventConnectors('context-files-updated', data);
  }

  sendUpdatedFilesUpdated(baseDir: string, taskId: string, files: UpdatedFile[]): void {
    const data: UpdatedFilesUpdatedData = {
      baseDir,
      taskId,
      files,
    };
    this.sendToWindows('updated-files-updated', data);
    this.broadcastToEventConnectors('updated-files-updated', data);
  }

  sendSkillsUpdated(baseDir: string, taskId: string, skills: SkillDefinition[]): void {
    const data: SkillsUpdatedData = {
      baseDir,
      taskId,
      skills,
    };
    this.sendToWindows('skills-updated', data);
    this.broadcastToEventConnectors('skills-updated', data);
  }

  // Response events
  sendResponseChunk(data: ResponseChunkData): void {
    this.sendToWindows('response-chunk', data);
    this.broadcastToEventConnectors('response-chunk', data);
  }

  sendResponseCompleted(data: ResponseCompletedData): void {
    this.sendToWindows('response-completed', data);
    this.broadcastToEventConnectors('response-completed', data);
  }

  // Question events
  sendAskQuestion(questionData: QuestionData): void {
    this.sendToWindows('ask-question', questionData);
    this.broadcastToEventConnectors('ask-question', questionData);
  }

  sendQuestionAnswered(baseDir: string, taskId: string, question: QuestionData, answer: string, userInput?: string): void {
    const data: QuestionAnsweredData = {
      baseDir,
      taskId,
      question,
      answer,
      userInput,
    };
    this.sendToWindows('question-answered', data);
    this.broadcastToEventConnectors('question-answered', data);
  }

  // Autocompletion events
  sendUpdateAutocompletion(baseDir: string, taskId: string, words?: string[], allFiles?: string[]): void {
    const data: AutocompletionData = {
      baseDir,
      taskId,
      words,
      allFiles,
    };
    this.sendToWindows('update-autocompletion', data);
    this.broadcastToEventConnectors('update-autocompletion', data);
  }

  // Queue events
  sendQueuedPromptsUpdated(baseDir: string, taskId: string, queuedPrompts: QueuedPromptData[]): void {
    const data: QueuedPromptsUpdatedData = {
      baseDir,
      taskId,
      queuedPrompts,
    };
    this.sendToWindows('queued-prompts-updated', data);
    this.broadcastToEventConnectors('queued-prompts-updated', data);
  }

  // Aider models events
  sendUpdateAiderModels(_baseDir: string, _taskId: string, modelsData: ModelsData): void {
    const data = modelsData;
    this.sendToWindows('update-aider-models', data);
    this.broadcastToEventConnectors('update-aider-models', data);
  }

  // Command events
  sendCommandOutput(baseDir: string, taskId: string, command: string, output: string): void {
    const data: CommandOutputData = {
      baseDir,
      taskId,
      command,
      output,
      timestamp: Date.now(),
    };
    this.sendToWindows('command-output', data);
    this.broadcastToEventConnectors('command-output', data);
  }

  // Log events
  sendLog(data: LogData): void {
    this.sendToWindows('log', data);
    this.broadcastToEventConnectors('log', data);
  }

  sendWorkflowLog(data: WorkflowLogData): void {
    this.sendToWindows('workflow-log', data);
    this.broadcastToEventConnectors('workflow-log', data);
  }

  sendWorkflowLogsUpdated(data: WorkflowLogsUpdatedData): void {
    this.sendToWindows('workflow-logs-updated', data);
    this.broadcastToEventConnectors('workflow-logs-updated', data);
  }

  // System log events (application-wide logs)
  sendSystemLog(data: SystemLogData): void {
    this.sendToWindows('system-log', data);
    this.broadcastToEventConnectors('system-log', data, false);
  }

  // Tool events
  sendTool(data: ToolData): void {
    this.sendToWindows('tool', data);
    this.broadcastToEventConnectors('tool', data);
  }

  sendToolInputChunk(data: ToolInputChunkData): void {
    this.sendToWindows('tool-input-chunk', data);
    this.broadcastToEventConnectors('tool-input-chunk', data);
  }

  // User message events
  sendUserMessage(data: UserMessageData): void {
    this.sendToWindows('user-message', data);
    this.broadcastToEventConnectors('user-message', data);
  }

  // Tokens info events
  sendUpdateTokensInfo(tokensInfo: TokensInfoData): void {
    this.sendToWindows('update-tokens-info', tokensInfo);
    this.broadcastToEventConnectors('update-tokens-info', tokensInfo);
  }

  // Input history events
  sendInputHistoryUpdated(baseDir: string, taskId: string, inputHistory: string[]): void {
    const data: InputHistoryData = {
      baseDir,
      taskId,
      inputHistory,
    };
    this.sendToWindows('input-history-updated', data);
    this.broadcastToEventConnectors('input-history-updated', data);
  }

  // Commands events
  sendCommandsUpdated(data: CommandsData): void {
    this.sendToWindows('commands-updated', data);
    this.broadcastToEventConnectors('commands-updated', data);
  }

  sendCustomCommandError(baseDir: string, taskId: string, error: string): void {
    const data = {
      baseDir,
      taskId,
      error,
    };
    this.sendToWindows('custom-command-error', data);
    this.broadcastToEventConnectors('custom-command-error', data);
  }

  sendWorktreeIntegrationStatusUpdated(baseDir: string, taskId: string, status: WorktreeIntegrationStatus | null): void {
    const data: WorktreeIntegrationStatusUpdatedData = {
      baseDir,
      taskId,
      status,
    };
    logger.debug('Sending worktree integration status updated', data);
    this.sendToWindows('worktree-integration-status-updated', data);
    this.broadcastToEventConnectors('worktree-integration-status-updated', data);
  }

  // Terminal events
  sendTerminalData(data: TerminalData): void {
    this.sendToWindows('terminal-data', data);
    this.broadcastToEventConnectors('terminal-data', data);
  }

  sendTerminalExit(data: TerminalExitData): void {
    this.sendToWindows('terminal-exit', data);
    this.broadcastToEventConnectors('terminal-exit', data);
  }

  // Versions events
  sendVersionsInfoUpdated(versionsInfo: VersionsInfo): void {
    this.sendToWindows('versions-info-updated', versionsInfo);
    this.broadcastToEventConnectors('versions-info-updated', versionsInfo);
  }

  sendSettingsUpdated(settings: SettingsData): void {
    this.sendToWindows('settings-updated', settings);
    this.broadcastToEventConnectors('settings-updated', settings);
  }

  // Provider events
  sendProvidersUpdated(providers: ProviderProfile[]): void {
    const data: ProvidersUpdatedData = {
      providers,
    };
    this.sendToWindows('providers-updated', data);
    this.broadcastToEventConnectors('providers-updated', data);
  }

  sendProviderModelsUpdated(data: ProviderModelsData): void {
    this.sendToWindows('provider-models-updated', data);
    this.broadcastToEventConnectors('provider-models-updated', data);
  }

  sendProjectSettingsUpdated(baseDir: string, settings: ProjectSettings): void {
    const data = { baseDir, settings };
    this.sendToWindows('project-settings-updated', data);
    this.broadcastToEventConnectors('project-settings-updated', data);
  }

  // Agent profile events
  sendAgentProfilesUpdated(profiles: AgentProfile[]): void {
    const data: AgentProfilesUpdatedData = {
      profiles,
    };
    this.sendToWindows('agent-profiles-updated', data);
    this.broadcastToEventConnectors('agent-profiles-updated', data);
  }

  // MCP servers events
  sendMcpServersUpdated(data: McpServersData): void {
    this.sendToWindows('mcp-servers-updated', data);
    this.broadcastToEventConnectors('mcp-servers-updated', data);
  }

  // Task lifecycle events
  sendTaskCreated(task: TaskData, activate?: boolean): void {
    const eventData: TaskCreatedData = {
      baseDir: task.baseDir,
      task,
      activate,
    };
    this.sendToWindows('task-created', eventData);
    this.broadcastToEventConnectors('task-created', eventData);
  }

  sendTaskInitialized(task: TaskData): void {
    this.sendToWindows('task-initialized', task);
    this.broadcastToEventConnectors('task-initialized', task);
  }

  sendTaskUpdated(task: TaskData): void {
    this.sendToWindows('task-updated', task);
    this.broadcastToEventConnectors('task-updated', task);
  }

  sendTaskStarted(task: TaskData): void {
    this.sendToWindows('task-started', task);
    this.broadcastToEventConnectors('task-started', task);
  }

  sendTaskCompleted(task: TaskData): void {
    this.sendToWindows('task-completed', task);
    this.broadcastToEventConnectors('task-completed', task);
  }

  sendTaskCancelled(task: TaskData): void {
    this.sendToWindows('task-cancelled', task);
    this.broadcastToEventConnectors('task-cancelled', task);
  }

  sendTaskDeleted(task: TaskData): void {
    this.sendToWindows('task-deleted', task);
    this.broadcastToEventConnectors('task-deleted', task);
  }

  sendTaskMessageRemoved(baseDir: string, taskId: string, messageIds: string[]): void {
    const data: MessageRemovedData = {
      baseDir,
      taskId,
      messageIds,
    };
    this.sendToWindows('message-removed', data);
    this.broadcastToEventConnectors('message-removed', data);
  }

  sendNotification(baseDir: string, title: string, body: string): void {
    const data: NotificationData = {
      title,
      body,
      baseDir,
    };
    this.sendToWindows('notification', data);
    this.broadcastToEventConnectors('notification', data);
  }

  subscribe(socket: Socket, config: EventsConnectorConfig): void {
    // Clear any existing connector's flush timer for the same socket (re-subscribe)
    for (const existing of this.eventsConnectors) {
      if (existing.socket.id === socket.id && existing.flushTimer) {
        clearTimeout(existing.flushTimer);
        existing.flushTimer = null;
      }
    }
    this.eventsConnectors = this.eventsConnectors.filter((connector) => connector.socket.id !== socket.id);

    const resolvedStreamMode = config.streamMode ?? 'coalesced';
    const resolvedFlushIntervalMs = Math.min(
      Math.max(config.streamFlushIntervalMs ?? DEFAULT_STREAM_FLUSH_INTERVAL_MS, MIN_STREAM_FLUSH_INTERVAL_MS),
      MAX_STREAM_FLUSH_INTERVAL_MS,
    );

    logger.info('Subscribing to events', {
      eventTypes: config.eventTypes,
      baseDirs: config.baseDirs,
      readonly: config.readonly,
      streamMode: resolvedStreamMode,
      streamFlushIntervalMs: resolvedFlushIntervalMs,
    });
    this.eventsConnectors.push({
      socket,
      eventTypes: config.eventTypes,
      baseDirs: config.baseDirs,
      readonly: config.readonly,
      pending: new Map(),
      flushTimer: null,
      resolvedStreamMode,
      resolvedFlushIntervalMs,
    });
  }

  unsubscribe(socket: Socket, log = true): void {
    const before = this.eventsConnectors.length;
    // Clear flush timers and pending maps for removed connectors
    this.eventsConnectors = this.eventsConnectors.filter((connector) => {
      if (connector.socket.id === socket.id) {
        if (connector.flushTimer) {
          clearTimeout(connector.flushTimer);
        }
        connector.pending.clear();
        return false;
      }
      return true;
    });
    if (log) {
      logger.info('Unsubscribed from events', {
        before,
        after: this.eventsConnectors.length,
      });
    }
  }

  private sendToWindows(eventType: string, data: unknown): void {
    if (!this.windowManager) {
      return;
    }

    const windows = this.windowManager.getAllWindows();
    if (windows.length === 0) {
      return;
    }

    // Send event to all open windows
    windows.forEach((window) => {
      if (!window.isDestroyed()) {
        window.webContents.send(eventType, data);
      }
    });
  }

  private broadcastToEventConnectors(eventType: string, data: unknown, log = true): void {
    if (log) {
      logger.debug('Broadcasting event to connectors:', {
        connectors: this.eventsConnectors.length,
        eventType,
      });
    }

    this.eventsConnectors.forEach((connector) => {
      // Filter by event types if specified
      if (connector.eventTypes && !connector.eventTypes.includes(eventType)) {
        if (log) {
          logger.debug('Skipping event broadcast to connector, event type not included:', { eventType, connectorEventTypes: connector.eventTypes });
        }
        return;
      }

      // Filter by base directories if specified
      const eventProjectDir =
        data && typeof data === 'object'
          ? ((data as { baseDir?: string; projectDir?: string }).baseDir ?? (data as { projectDir?: string }).projectDir)
          : undefined;
      if (connector.baseDirs && (!eventProjectDir || !connector.baseDirs.includes(eventProjectDir))) {
        if (log) {
          logger.debug('Skipping event broadcast to connector, base dir not included:', { baseDir: eventProjectDir, connectorBaseDirs: connector.baseDirs });
        }
        return;
      }

      this.dispatchToConnector(connector, eventType, data, log);
    });

    // Notify SSE listeners
    const event = { type: eventType, data };
    for (const listeners of this.sseListeners.values()) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // ignore broken listeners
        }
      }
    }

    // Buffer events for late-arriving SSE subscribers
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
      this.eventBuffer.shift();
    }
  }

  /**
   * Routes an event to a single connector, either immediately (live mode or
   * non-coalesceable events) or by buffering it in the connector's pending map
   * for a scheduled flush.
   */
  private dispatchToConnector(connector: EventsConnector, eventType: string, data: unknown, log: boolean): void {
    // Live mode: emit immediately
    if (connector.resolvedStreamMode !== 'coalesced') {
      this.emitToConnector(connector, eventType, data, log);
      return;
    }

    // Look up coalescing strategy for this event type
    const strategy = COALESCE_STRATEGIES[eventType];
    const key = strategy ? strategy.key(data) : null;

    // No strategy or key is null → send immediately, but first flush any
    // pending events for the same task to preserve ordering
    if (!strategy || key === null) {
      const taskId = getEventTaskId(data);
      if (taskId) {
        this.flushConnectorForTask(connector, taskId);
      }
      this.emitToConnector(connector, eventType, data, log);
      return;
    }

    // Buffer the event in the pending map
    const mapKey = `${eventType}::${key}`;
    const existing = connector.pending.get(mapKey);
    if (existing) {
      existing.data = strategy.merge(existing.data, data);
      // Re-set to preserve insertion order (Map.set on existing key does not change order)
      connector.pending.set(mapKey, existing);
    } else {
      connector.pending.set(mapKey, { type: eventType, data, taskId: getEventTaskId(data) });
    }

    // If the merged entry exceeds the size limit, flush immediately
    const mergedEntry = connector.pending.get(mapKey)!;
    const mergedData = mergedEntry.data as any;
    const entryLength =
      (typeof mergedData?.output === 'string' ? mergedData.output.length : 0) ||
      (typeof mergedData?.chunk === 'string' ? mergedData.chunk.length : 0);
    if (entryLength > MAX_COALESCED_ENTRY_CHARS) {
      this.flushConnector(connector);
      return;
    }

    // Otherwise, schedule a flush if one isn't already pending
    this.scheduleFlush(connector);
  }

  /**
   * Emits a single event to a connector's socket, handling disconnection errors.
   */
  private emitToConnector(connector: EventsConnector, type: string, data: unknown, log: boolean): void {
    try {
      if (log) {
        logger.debug('Broadcasting event to connector:', {
          eventType: type,
        });
      }
      connector.socket.emit('event', { type, data });
    } catch {
      // Remove disconnected sockets
      this.unsubscribe(connector.socket, log);
    }
  }

  /**
   * Schedules a deferred flush for a connector if no timer is already running.
   */
  private scheduleFlush(connector: EventsConnector): void {
    if (connector.flushTimer) {
      return;
    }
    connector.flushTimer = setTimeout(() => {
      this.flushConnector(connector);
    }, connector.resolvedFlushIntervalMs);
  }

  /**
   * Flushes all pending events for a connector, emitting them in insertion order.
   */
  private flushConnector(connector: EventsConnector): void {
    if (connector.flushTimer) {
      clearTimeout(connector.flushTimer);
      connector.flushTimer = null;
    }
    for (const entry of connector.pending.values()) {
      this.emitToConnector(connector, entry.type, entry.data, true);
    }
    connector.pending.clear();
  }

  /**
   * Flushes only the pending events belonging to a specific task, preserving
   * insertion order. Used before sending an immediate (non-coalesceable) event
   * to ensure the client sees buffered data before the new event arrives.
   */
  private flushConnectorForTask(connector: EventsConnector, taskId: string): void {
    for (const [mapKey, entry] of connector.pending) {
      if (entry.taskId === taskId) {
        this.emitToConnector(connector, entry.type, entry.data, true);
        connector.pending.delete(mapKey);
      }
    }
    if (connector.pending.size === 0 && connector.flushTimer) {
      clearTimeout(connector.flushTimer);
      connector.flushTimer = null;
    }
  }

  // Extension UI events
  sendExtensionUIRefresh(options: { projectDir?: string; extensionId?: string; componentId?: string; taskId?: string; reloadComponents?: boolean }): void {
    const data: ExtensionUIRefreshData = options;
    this.sendToWindows('extension-ui-refresh', data);
    this.broadcastToEventConnectors('extension-ui-refresh', data);
  }

  // Modal overlay URL events
  sendModalOverlayUrl(url: string): void {
    const data: ModalOverlayUrlData = { url };
    this.sendToWindows('modal-overlay-url', data);
    this.broadcastToEventConnectors('modal-overlay-url', data);
  }

  // Aider connector status events (Python install + per-task connector lifecycle)
  sendAiderConnectorStatus(status: import('@/python-dependencies-installer').PythonInstallStatus, baseDir?: string, taskId?: string): void {
    const data = { baseDir, taskId, status };
    this.sendToWindows('aider-connector-status', data);
    this.broadcastToEventConnectors('aider-connector-status', data);
  }

  // SSE event subscription for CLI streaming
  subscribeSSE(listenerId: string, listener: EventListener, replayBuffer = false): void {
    if (!this.sseListeners.has(listenerId)) {
      this.sseListeners.set(listenerId, new Set());
    }
    this.sseListeners.get(listenerId)!.add(listener);

    // Replay buffered events to late-arriving subscribers
    if (replayBuffer) {
      for (const event of this.eventBuffer) {
        try {
          listener(event);
        } catch {
          // ignore broken listeners
        }
      }
    }
  }

  unsubscribeSSE(listenerId: string, listener: EventListener): void {
    this.sseListeners.get(listenerId)?.delete(listener);
    if (this.sseListeners.get(listenerId)?.size === 0) {
      this.sseListeners.delete(listenerId);
    }
  }
}
