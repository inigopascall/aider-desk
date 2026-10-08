/* eslint-disable import/order */
/**
 * Isolated regression tests for bounded task-state classification
 * (Task.determineTaskState) and its unconditional classifier cleanup.
 *
 * The private classifier is exercised through the repository's established
 * convention for testing private members (bracket access via `(task as any)`)
 * without changing production visibility. All agent/model behavior is mocked —
 * no real provider requests are issued and no wall-clock timing is relied upon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextAssistantMessage, ContextMessage, DefaultTaskState } from '@common/types';

// Mock dependencies BEFORE importing Task
vi.mock('@/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('{}'),
    stat: vi.fn().mockRejectedValue(new Error('File not found')),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue('{}'),
  stat: vi.fn().mockRejectedValue(new Error('File not found')),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils', () => ({
  fileExists: vi.fn().mockResolvedValue(false),
  filterIgnoredFiles: vi.fn().mockResolvedValue([]),
  execWithShellPath: vi.fn(),
  getEnvironmentVariablesForAider: vi.fn(() => ({})),
  isDirectory: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/constants', () => ({
  PROBE_BINARY_PATH: '/probe',
  AIDER_DESK_TASKS_DIR: '.aider-desk/tasks',
  AIDER_DESK_WORKFLOW_EVENTS_FILE: 'workflow-events.jsonl',
  AIDER_DESK_DIR: '.aider-desk',
  AIDER_DESK_TODOS_FILE: 'todos.json',
  AIDER_DESK_RULES_DIR: 'rules',
  AIDER_DESK_PROJECT_RULES_DIR: '.aider-desk/rules',
  AIDER_DESK_GLOBAL_RULES_DIR: '/home/.aider-desk/rules',
  AIDER_DESK_COMMANDS_DIR: '.aider-desk/commands',
  AIDER_DESK_PROMPTS_DIR: '.aider-desk/prompts',
  AIDER_DESK_BUILTIN_PROMPTS_DIR: '/resources/prompts',
  AIDER_DESK_GLOBAL_PROMPTS_DIR: '/home/.aider-desk/prompts',
  AIDER_DESK_AGENTS_DIR: '.aider-desk/agents',
  AIDER_DESK_TMP_DIR: '.aider-desk/tmp',
  AIDER_DESK_WATCH_FILES_LOCK: '.aider-desk/watch-files.lock',
  WORKTREE_BRANCH_PREFIX: 'aider-desk/task/',
  AIDER_DESK_MEMORY_FILE: '/data/memory.db',
  LOGS_DIR: '/logs',
}));

vi.mock('@/agent', () => ({
  Agent: class {
    run = vi.fn();
    dispose = vi.fn();
    generateText = vi.fn();
  },
  McpManager: class {},
  AgentProfileManager: class {},
}));

vi.mock('@/task/aider-manager', () => ({
  AiderManager: class {
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn();
    sendUpdateAiderModels = vi.fn();
  },
}));

vi.mock('@/prompts', () => ({
  PromptsManager: class {},
}));

vi.mock('@/data-manager', () => ({
  DataManager: class {},
}));

vi.mock('@/telemetry', () => ({
  TelemetryManager: class {},
}));

vi.mock('@/models', () => ({
  ModelManager: class {},
}));

vi.mock('@/events', () => ({
  EventManager: class {
    sendTaskUpdated = vi.fn();
    sendTaskCreated = vi.fn();
    sendTaskDeleted = vi.fn();
    sendTaskInitialized = vi.fn();
    sendContextFilesUpdated = vi.fn();
    sendContextInfoUpdated = vi.fn();
    sendLog = vi.fn();
  },
}));

vi.mock('@/memory/memory-manager', () => ({
  MemoryManager: class {},
}));

vi.mock('@/worktrees', () => ({
  WorktreeManager: class {},
}));

vi.mock('@/custom-commands', () => ({
  CustomCommandManager: class {},
}));

vi.mock('@/skills/skill-manager', () => ({
  SkillManager: class {
    getSkills = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('@/store', () => ({
  Store: class {},
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

import { Task, TASK_STATE_DETERMINATION_TIMEOUT_MS } from '../task';
import logger from '@/logger';

describe('Task - task-state determination (determineTaskState)', () => {
  let task: Task;
  let mockAgentProfileManager: { getProfile: ReturnType<typeof vi.fn> };

  const baseDir = '/test/project';
  const taskId = 'test-task-id';

  const createTask = () => {
    const mockProject = {
      baseDir,
      getProjectSettings: vi.fn(() => ({
        mainModel: 'default-model',
        agentProfileId: 'default-profile',
        modelEditFormats: {},
        currentMode: 'agent',
        autonomyModeLocked: false,
      })),
      isWorktreeSharedWithOtherTasks: vi.fn(() => false),
    };

    const mockStore = {
      getSettings: vi.fn(() => ({
        taskSettings: {
          smartTaskState: true,
          autoGenerateTaskName: false,
          showTaskStateActions: true,
          worktreeSymlinkFolders: [],
          contextCompactingThreshold: { percentage: 0.8, tokens: 100000 },
          contextCompactionType: 'smart',
          taskNameModel: null,
          taskStateModel: null,
          commitMessageModel: null,
          defaultWorkingMode: 'local',
          worktreeBranchPrefix: 'aider-desk/task/',
          renameBranchOnNameGeneration: false,
        },
      })),
    };

    mockAgentProfileManager = {
      getProfile: vi.fn(() => ({
        id: 'default-profile',
        provider: 'test-provider',
        model: 'test-model',
      })),
    };

    const mockEventManager = {
      sendTaskUpdated: vi.fn(),
      sendTaskCreated: vi.fn(),
      sendTaskDeleted: vi.fn(),
      sendTaskInitialized: vi.fn(),
      sendContextFilesUpdated: vi.fn(),
      sendContextInfoUpdated: vi.fn(),
      sendLog: vi.fn(),
    };

    const mockPromptsManager = {
      getUpdateTaskStatePrompt: vi.fn().mockResolvedValue('You are a task state classifier.'),
    };

    const mockExtensionManager = {
      isInitialized: vi.fn(() => false),
      dispatchEvent: vi.fn().mockImplementation((_event: string, payload: unknown) => Promise.resolve(payload)),
    };

    return new Task(
      mockProject as any,
      taskId,
      mockStore as any,
      {} as any,
      {} as any,
      {} as any,
      mockAgentProfileManager as any,
      {} as any,
      {} as any,
      mockEventManager as any,
      {} as any,
      {} as any,
      {} as any,
      mockPromptsManager as any,
      mockExtensionManager as any,
      {} as any,
      { agentProfileId: 'default-profile' } as any,
    );
  };

  const createResultMessages = (content = 'The task is complete.'): ContextMessage[] => [
    {
      id: 'assistant-1',
      role: 'assistant',
      content,
    } as ContextAssistantMessage,
  ];

  const getGenerateTextMock = () => (task as any).agent.generateText as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    task = createTask();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful classification', () => {
    it('preserves a valid classifier response returned before the deadline as the task-state result', async () => {
      getGenerateTextMock().mockResolvedValue(DefaultTaskState.ReadyForImplementation);

      const result = await (task as any).determineTaskState(createResultMessages());

      expect(result).toBe(DefaultTaskState.ReadyForImplementation);
      expect((task as any).isDeterminingTaskState).toBe(false);
    });

    it('invokes the classifier with an abort signal and abortable=false', async () => {
      getGenerateTextMock().mockResolvedValue(DefaultTaskState.ReadyForReview);

      await (task as any).determineTaskState(createResultMessages());

      expect(getGenerateTextMock()).toHaveBeenCalledWith(
        'test-provider/test-model',
        'You are a task state classifier.',
        expect.stringContaining('<agent-response>'),
        baseDir,
        [],
        false,
        expect.any(AbortSignal),
        'test-task-id',
      );
    });

    it('finishes the "Updating task state..." loading log after successful classification', async () => {
      const addLogMessageSpy = vi.spyOn(task, 'addLogMessage');
      getGenerateTextMock().mockResolvedValue(DefaultTaskState.MoreInfoNeeded);

      await (task as any).determineTaskState(createResultMessages());

      expect(addLogMessageSpy).toHaveBeenCalledWith('loading', 'Updating task state...');
      expect(addLogMessageSpy).toHaveBeenCalledWith('loading', undefined, true);
    });

    it('rejects an invalid classifier response and falls back to null', async () => {
      getGenerateTextMock().mockResolvedValue('NOT_A_VALID_STATE');

      const result = await (task as any).determineTaskState(createResultMessages());

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid task state returned'), expect.objectContaining({ answer: 'NOT_A_VALID_STATE' }));
      expect((task as any).isDeterminingTaskState).toBe(false);
    });
  });

  describe('classifier timeout', () => {
    it('aborts a non-resolving classifier at exactly TASK_STATE_DETERMINATION_TIMEOUT_MS, returns null, and keeps the READY_FOR_REVIEW fallback available', async () => {
      vi.useFakeTimers();
      try {
        const addLogMessageSpy = vi.spyOn(task, 'addLogMessage');
        const generateTextMock = getGenerateTextMock();
        let capturedSignal: AbortSignal | undefined;

        generateTextMock.mockImplementation(
          (_modelId: string, _system: string, _prompt: string, _dir: string, _msgs: unknown[], _abortable: boolean, signal: AbortSignal) => {
            capturedSignal = signal;
            return new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve(undefined));
            });
          },
        );

        const resultPromise = (task as any).determineTaskState(createResultMessages());

        // Flush microtasks so the classifier invocation happens (no timers fired yet)
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(generateTextMock).toHaveBeenCalled();
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);
        expect((task as any).isDeterminingTaskState).toBe(true);

        // Just before the deadline the classifier is still pending
        await vi.advanceTimersByTimeAsync(TASK_STATE_DETERMINATION_TIMEOUT_MS - 1);
        expect(capturedSignal?.aborted).toBe(false);

        // Exactly at the deadline the classifier is aborted
        await vi.advanceTimersByTimeAsync(1);
        expect(capturedSignal?.aborted).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith('Task state determination timed out', expect.objectContaining({ timeoutMs: TASK_STATE_DETERMINATION_TIMEOUT_MS }));

        const result = await resultPromise;
        expect(result).toBeNull();

        // The caller's ordinary fallback still applies
        expect(result || DefaultTaskState.ReadyForReview).toBe(DefaultTaskState.ReadyForReview);

        // Cleanup is unconditional
        expect((task as any).isDeterminingTaskState).toBe(false);
        expect(addLogMessageSpy).toHaveBeenCalledWith('loading', 'Updating task state...');
        expect(addLogMessageSpy).toHaveBeenCalledWith('loading', undefined, true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not change a completed task state to INTERRUPTED on classifier timeout', async () => {
      vi.useFakeTimers();
      try {
        task.task.state = DefaultTaskState.InProgress;
        const generateTextMock = getGenerateTextMock();
        generateTextMock.mockImplementation(
          (_modelId: string, _system: string, _prompt: string, _dir: string, _msgs: unknown[], _abortable: boolean, signal: AbortSignal) => {
            return new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve(undefined));
            });
          },
        );

        const resultPromise = (task as any).determineTaskState(createResultMessages());
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(TASK_STATE_DETERMINATION_TIMEOUT_MS);
        const result = await resultPromise;

        expect(result).toBeNull();
        expect(task.task.state).toBe(DefaultTaskState.InProgress);
        expect(task.task.state).not.toBe(DefaultTaskState.Interrupted);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('thrown provider error', () => {
    it('returns null, finishes the loading log, and resets the guard when the provider throws', async () => {
      const addLogMessageSpy = vi.spyOn(task, 'addLogMessage');
      getGenerateTextMock().mockRejectedValue(new Error('provider exploded'));

      const result = await (task as any).determineTaskState(createResultMessages());

      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Error determining task state:', expect.any(Error));
      expect((task as any).isDeterminingTaskState).toBe(false);
      expect(addLogMessageSpy).toHaveBeenCalledWith('loading', 'Updating task state...');
      expect(addLogMessageSpy).toHaveBeenCalledWith('loading', undefined, true);
    });
  });
});