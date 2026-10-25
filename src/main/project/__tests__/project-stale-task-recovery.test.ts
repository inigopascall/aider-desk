// Mock all dependencies BEFORE importing the test file
vi.mock('@/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@/store');
vi.mock('@/agent');
vi.mock('@/data-manager');
vi.mock('@/models');
vi.mock('@/custom-commands');
vi.mock('@/telemetry');
vi.mock('@/events');
vi.mock('@/project/migrations');
vi.mock('@/worktrees');
vi.mock('@/memory/memory-manager');
vi.mock('@/prompts');
vi.mock('@/extensions/extension-manager');
vi.mock('@/task/aider-manager');
vi.mock('@/task/context-manager');
vi.mock('@/skills/skill-manager');
vi.mock('@/constants', () => ({
  PROBE_BINARY_PATH: '/probe',
  AIDER_DESK_TASKS_DIR: '.aider-desk/tasks',
  AIDER_DESK_DIR: '.aider-desk',
  AIDER_DESK_TODOS_FILE: 'todos.json',
  AIDER_DESK_WORKFLOW_EVENTS_FILE: 'workflow-events.jsonl',
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
  AIDER_DESK_DATA_DIR: '/data',
  AIDER_DESK_CACHE_DIR: '/data/cache',
  LOGS_DIR: '/logs',
}));
vi.mock('@/utils');
vi.mock('@/utils/atomic-write');
vi.mock('fs/promises', () => {
  const mocks = {
    readFile: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    appendFile: vi.fn(),
    unlink: vi.fn(),
    copyFile: vi.fn(),
  };
  return { ...mocks, default: mocks };
});
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid'),
}));

import * as fs from 'fs/promises';

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DefaultTaskState, TaskData } from '@common/types';

import { Project } from '../project';

import { INTERNAL_TASK_ID } from '@/task';
import { atomicWriteJsonFile } from '@/utils/atomic-write';

const createTaskData = (id: string, state?: DefaultTaskState): TaskData => ({
  id,
  baseDir: '/test/project',
  name: id,
  archived: false,
  aiderTotalCost: 0,
  agentTotalCost: 0,
  mainModel: '',
  currentMode: 'agent',
  weakModelLocked: false,
  parentId: null,
  state,
});

describe('Project - stale task recovery on initial load', () => {
  const baseDir = '/test/project';

  // Persisted states for the disk-backed tasks loaded during project startup
  const taskStates: Record<string, DefaultTaskState> = {
    'task-in-progress': DefaultTaskState.InProgress,
    'task-todo': DefaultTaskState.Todo,
    'task-review': DefaultTaskState.ReadyForReview,
    'task-done': DefaultTaskState.Done,
    'task-interrupted': DefaultTaskState.Interrupted,
  };

  let project: Project;
  let mockEventManager: {
    sendTaskUpdated: Mock;
    sendTaskCreated: Mock;
    sendTaskDeleted: Mock;
    sendProjectStarted: Mock;
    sendContextFilesUpdated: Mock;
    sendInputHistoryUpdated: Mock;
  };
  let mockExtensionManager: {
    dispatchEvent: Mock;
    reloadProjectExtensions: Mock;
    stopProjectWatcher: Mock;
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Simulate a project directory containing persisted task folders
    vi.mocked(fs.stat).mockResolvedValue({} as any);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.appendFile).mockResolvedValue(undefined);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.copyFile).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: 'task-in-progress', isDirectory: () => true },
      { name: 'task-todo', isDirectory: () => true },
      { name: 'task-review', isDirectory: () => true },
      { name: 'task-done', isDirectory: () => true },
      { name: 'task-interrupted', isDirectory: () => true },
      { name: 'internal', isDirectory: () => true },
    ] as any);
    (vi.mocked(fs.readFile) as Mock).mockImplementation(async (filePath: any) => {
      const match = String(filePath).match(/tasks\/([^/]+)\/settings\.json$/);
      const taskId = match?.[1];
      const state = taskId ? taskStates[taskId] : undefined;
      if (state) {
        return JSON.stringify({ id: taskId, name: taskId, state, createdAt: '2024-01-01T00:00:00.000Z' });
      }
      return '{}';
    });

    mockEventManager = {
      sendTaskUpdated: vi.fn(),
      sendTaskCreated: vi.fn(),
      sendTaskDeleted: vi.fn(),
      sendProjectStarted: vi.fn(),
      sendContextFilesUpdated: vi.fn(),
      sendInputHistoryUpdated: vi.fn(),
    };
    mockExtensionManager = {
      dispatchEvent: vi.fn(() => Promise.resolve({} as any)),
      reloadProjectExtensions: vi.fn(() => Promise.resolve()),
      stopProjectWatcher: vi.fn(),
    };

    project = new Project(
      baseDir,
      { getSettings: vi.fn(() => ({ taskSettings: {}, aider: { options: '' } })), getProjectSettings: vi.fn(() => ({})) } as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getAgentExecutions: vi.fn(() => []),
        saveAgentExecution: vi.fn(),
        deleteAgentExecution: vi.fn(),
      } as any,
      mockEventManager as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockExtensionManager as any,
      {} as any,
    );

    // Wait for the initial load (including stale state recovery) to finish
    await (project as any).tasksLoadingPromise;
  });

  it('converts a persisted IN_PROGRESS task to INTERRUPTED with an ISO interruptedAt during initial load', async () => {
    const task = project.getTask('task-in-progress');
    expect(task).not.toBeNull();

    expect(task!.task.state).toBe(DefaultTaskState.Interrupted);
    expect(typeof task!.task.interruptedAt).toBe('string');
    expect(Number.isNaN(Date.parse(task!.task.interruptedAt!))).toBe(false);
    expect(new Date(task!.task.interruptedAt!).toISOString()).toBe(task!.task.interruptedAt);

    // The conversion is written through the normal save/update path
    expect(mockEventManager.sendTaskUpdated).toHaveBeenCalledWith(task!.task);
    const settingsWrite = vi.mocked(atomicWriteJsonFile).mock.calls.find(([filePath]) => String(filePath).endsWith('settings.json'));
    expect(settingsWrite).toBeDefined();
    const written = settingsWrite![1] as TaskData;
    expect(written.state).toBe(DefaultTaskState.Interrupted);
    expect(written.interruptedAt).toBe(task!.task.interruptedAt);
  });

  it('leaves non-processing persisted states unchanged', async () => {
    const expectations: Array<[string, DefaultTaskState]> = [
      ['task-todo', DefaultTaskState.Todo],
      ['task-review', DefaultTaskState.ReadyForReview],
      ['task-done', DefaultTaskState.Done],
      ['task-interrupted', DefaultTaskState.Interrupted],
    ];

    for (const [taskId, state] of expectations) {
      const task = project.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.task.state).toBe(state);
      expect(task!.task.interruptedAt).toBeUndefined();
    }

    // Only the stale IN_PROGRESS task was updated during startup
    expect(mockEventManager.sendTaskUpdated).toHaveBeenCalledTimes(1);
    expect((mockEventManager.sendTaskUpdated.mock.calls[0][0] as TaskData).id).toBe('task-in-progress');
  });

  it('never recovers the internal task through the startup path', async () => {
    const internalTask = project.getInternalTask();
    expect(internalTask).not.toBeNull();
    expect(internalTask!.task.id).toBe(INTERNAL_TASK_ID);
    expect(internalTask!.task.state).not.toBe(DefaultTaskState.Interrupted);

    const updatedIds = mockEventManager.sendTaskUpdated.mock.calls.map((call) => (call[0] as TaskData).id);
    expect(updatedIds).not.toContain(INTERNAL_TASK_ID);
  });

  it('emits the normal task update event and preserves context history', async () => {
    expect(mockEventManager.sendTaskUpdated).toHaveBeenCalledTimes(1);
    const updated = mockEventManager.sendTaskUpdated.mock.calls[0][0] as TaskData;
    expect(updated.id).toBe('task-in-progress');
    expect(updated.state).toBe(DefaultTaskState.Interrupted);

    // Recovery must not delete, clear, or rewrite the task context
    const contextWrites = vi.mocked(fs.writeFile).mock.calls.filter(([filePath]) => String(filePath).endsWith('context.json'));
    expect(contextWrites).toHaveLength(0);

    const contextManager = (project.getTask('task-in-progress') as any).contextManager;
    expect(contextManager.clearMessages).not.toHaveBeenCalled();
    expect(contextManager.clearContextFiles).not.toHaveBeenCalled();
    expect(contextManager.delete).not.toHaveBeenCalled();
    expect(contextManager.setContextMessages).not.toHaveBeenCalled();
    expect(contextManager.setContextFiles).not.toHaveBeenCalled();
  });
});

describe('Project - loadTasks stale recovery orchestration', () => {
  let project: Project;
  let internalTask: { resetContext: Mock; recoverStaleInProgressState: Mock };
  let diskTask1: { resetContext: Mock; recoverStaleInProgressState: Mock };
  let diskTask2: { resetContext: Mock; recoverStaleInProgressState: Mock };

  beforeEach(() => {
    vi.clearAllMocks();

    internalTask = {
      resetContext: vi.fn().mockResolvedValue(undefined),
      recoverStaleInProgressState: vi.fn().mockResolvedValue(false),
    };
    diskTask1 = {
      resetContext: vi.fn().mockResolvedValue(undefined),
      recoverStaleInProgressState: vi.fn().mockResolvedValue(true),
    };
    diskTask2 = {
      resetContext: vi.fn().mockResolvedValue(undefined),
      recoverStaleInProgressState: vi.fn().mockResolvedValue(false),
    };

    project = Object.create(Project.prototype) as Project;
    Object.assign(project, {
      baseDir: '/test/project',
      tasks: new Map(),
      tasksLoadingPromise: Promise.resolve(),
      eventManager: { sendTaskUpdated: vi.fn() },
    });

    const projectInternals = project as unknown as {
      prepareTask: (taskId: string) => Promise<unknown>;
      getTaskIdsFromDisk: () => Promise<string[]>;
    };
    vi.spyOn(projectInternals, 'prepareTask').mockImplementation(async (taskId: string) => {
      if (taskId === INTERNAL_TASK_ID) {
        return internalTask;
      }
      if (taskId === 'task-1') {
        return diskTask1;
      }
      return diskTask2;
    });
    vi.spyOn(projectInternals, 'getTaskIdsFromDisk').mockResolvedValue(['task-1', 'task-2']);
  });

  it('calls stale recovery for every disk-backed task during initial load', async () => {
    await (project as any).loadTasks();

    expect(diskTask1.recoverStaleInProgressState).toHaveBeenCalledTimes(1);
    expect(diskTask2.recoverStaleInProgressState).toHaveBeenCalledTimes(1);
  });

  it('never calls stale recovery for the internal task during initial load', async () => {
    await (project as any).loadTasks();

    expect(internalTask.recoverStaleInProgressState).not.toHaveBeenCalled();
    expect(internalTask.resetContext).toHaveBeenCalledTimes(1);
  });
});

describe('Project - reloadTasksInternal live task protection', () => {
  let project: Project;
  let tasks: Map<string, { task: TaskData; reloadFromDisk: Mock; close: Mock }>;
  let eventManager: { sendTaskCreated: Mock; sendTaskDeleted: Mock; sendTaskUpdated: Mock };

  beforeEach(() => {
    vi.clearAllMocks();

    tasks = new Map();
    eventManager = {
      sendTaskCreated: vi.fn(),
      sendTaskDeleted: vi.fn(),
      sendTaskUpdated: vi.fn(),
    };
    project = Object.create(Project.prototype) as Project;
    Object.assign(project, {
      tasks,
      tasksLoadingPromise: Promise.resolve(),
      eventManager,
    });
  });

  it('does not recover or alter a live in-memory IN_PROGRESS task during reload', async () => {
    const inProgressTask = {
      task: createTaskData('in-progress', DefaultTaskState.InProgress),
      reloadFromDisk: vi.fn(),
      close: vi.fn(),
    };
    tasks.set('in-progress', inProgressTask);

    const projectInternals = project as unknown as {
      getTaskIdsFromDisk: () => Promise<string[]>;
    };
    vi.spyOn(projectInternals, 'getTaskIdsFromDisk').mockResolvedValue(['in-progress']);

    await project.reloadTasks();

    expect(inProgressTask.reloadFromDisk).not.toHaveBeenCalled();
    expect(inProgressTask.close).not.toHaveBeenCalled();
    expect(inProgressTask.task.state).toBe(DefaultTaskState.InProgress);
    expect(inProgressTask.task.interruptedAt).toBeUndefined();
    expect(eventManager.sendTaskUpdated).not.toHaveBeenCalled();
    expect(eventManager.sendTaskDeleted).not.toHaveBeenCalled();
  });
});