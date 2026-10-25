import * as fs from 'fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskData } from '@common/types';

import { Project } from '../project';

import { INTERNAL_TASK_ID, Task } from '@/task';

vi.mock('@/logger');
vi.mock('@/store');
vi.mock('@/agent');
vi.mock('@/telemetry');
vi.mock('@/data-manager');
vi.mock('@/events');
vi.mock('@/models');
vi.mock('@/git');
vi.mock('@/memory/memory-manager');
vi.mock('@/prompts');
vi.mock('@/extensions/extension-manager');
vi.mock('@/task/aider-manager');
vi.mock('@/task/context-manager');
vi.mock('@/utils/atomic-write');
vi.mock('@/project/migrations');
vi.mock('fs/promises');
vi.mock('@/utils', () => ({
  determineMainModel: vi.fn(() => 'default-model'),
  determineWeakModel: vi.fn(() => null),
}));
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-task-id'),
}));

describe('Project - per-task file selection', () => {
  let project: Project;
  let tasksById: Map<string, unknown>;
  let prepareTask: ReturnType<typeof vi.fn>;

  const parentTask = {
    task: {
      id: 'parent-id',
      parentId: null,
      workingMode: 'local',
      mainModel: 'parent-model',
      disabledRuleFiles: ['.aider-desk/rules/a.md'],
      disabledRepositoryMappingFiles: ['.aider-desk/mappings/map.md'],
    } as TaskData,
    saveTask: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(fs.stat).mockRejectedValue(new Error('File not found'));
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    Task.prototype['resetContext'] = vi.fn().mockResolvedValue(undefined);

    project = new Project(
      '/test/dir',
      {
        getSettings: vi.fn(() => ({ taskSettings: {}, aider: { options: '' } })),
        getProviders: vi.fn(() => []),
        getProjectSettings: vi.fn(() => ({})),
      } as any,
      {} as any,
      { initializeForProject: vi.fn(), removeProject: vi.fn() } as any,
      {} as any,
      {} as any,
      { sendTaskCreated: vi.fn() } as any,
      { getProviderModels: vi.fn().mockResolvedValue({ models: [] }), getProviders: vi.fn(() => []) } as any,
      { getTaskWorktree: vi.fn().mockResolvedValue(null) } as any,
      { initializeForProject: vi.fn() } as any,
      {} as any,
      { watchProject: vi.fn() } as any,
      {
        reloadProjectExtensions: vi.fn(),
        stopWatchingProject: vi.fn(),
        dispatchEvent: vi.fn(() => Promise.resolve({ event: {}, blocked: false, modifiedResult: undefined })),
        getRegistry: vi.fn(() => ({
          addListener: vi.fn(),
          removeListener: vi.fn(),
        })),
      } as any,
      {} as any,
    );

    prepareTask = vi.fn((id, data) => ({
      task: { id: id || 'test-task-id', ...data },
      addFiles: vi.fn(),
      resetContext: vi.fn().mockResolvedValue(undefined),
      init: vi.fn().mockResolvedValue(undefined),
      duplicateFrom: vi.fn().mockResolvedValue(undefined),
    }));
    (project as any).prepareTask = prepareTask;

    tasksById = new Map<string, unknown>([
      [INTERNAL_TASK_ID, { getContextFiles: vi.fn().mockResolvedValue([]) }],
      ['parent-id', parentTask],
    ]);
    (project as any).getTask = vi.fn((id) => tasksById.get(id) ?? null);
  });

  it('a sub-task copies the parent rule and mapping selection', async () => {
    const subtask = await project.createNewTask({ parentId: 'parent-id' });

    expect(subtask.disabledRuleFiles).toEqual(['.aider-desk/rules/a.md']);
    expect(subtask.disabledRepositoryMappingFiles).toEqual(['.aider-desk/mappings/map.md']);
    expect(subtask.disabledRuleFiles).not.toBe(parentTask.task.disabledRuleFiles);
  });

  it('a new top-level task starts with everything ticked, even when the most recent task has unticked files', async () => {
    (project as any).getMostRecentTask = vi.fn(() => parentTask);

    const task = await project.createNewTask();

    expect(task.disabledRuleFiles).toEqual([]);
    expect(task.disabledRepositoryMappingFiles).toEqual([]);
  });

  it('a new top-level task with no task to inherit from starts with everything ticked', async () => {
    (project as any).getMostRecentTask = vi.fn(() => null);

    const task = await project.createNewTask();

    expect(task.disabledRuleFiles).toEqual([]);
    expect(task.disabledRepositoryMappingFiles).toEqual([]);
  });

  it('duplicateTask copies the rule and mapping selection', async () => {
    (project as any).tasks.set('source-id', {
      task: {
        id: 'source-id',
        name: 'Source',
        workingMode: 'local',
        disabledRuleFiles: ['.aider-desk/rules/a.md'],
        disabledRepositoryMappingFiles: ['.aider-desk/mappings/map.md'],
      } as TaskData,
    });

    const duplicate = await project.duplicateTask('source-id');

    expect(duplicate.disabledRuleFiles).toEqual(['.aider-desk/rules/a.md']);
    expect(duplicate.disabledRepositoryMappingFiles).toEqual(['.aider-desk/mappings/map.md']);
  });
});
