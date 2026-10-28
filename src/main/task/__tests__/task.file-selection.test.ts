import fs from 'fs/promises';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Task } from '../task';

import type { AgentProfile, ContextFile, ContextUsageCategory, ContextUsageCategoryId, TaskData } from '@common/types';

const ROOT = vi.hoisted(() => `/tmp/aider-desk-task-file-selection-${process.pid}`);

vi.mock('@/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/utils', async () => {
  const nodeFs = await import('fs/promises');
  const stat = (filePath: string) => nodeFs.stat(filePath).catch(() => null);
  return {
    fileExists: vi.fn(async (filePath: string) => (await stat(filePath)) !== null),
    isDirectory: vi.fn(async (filePath: string) => Boolean((await stat(filePath))?.isDirectory())),
    filterIgnoredFiles: vi.fn().mockResolvedValue([]),
    execWithShellPath: vi.fn(),
    getEnvironmentVariablesForAider: vi.fn(() => ({})),
  };
});

vi.mock('@/constants', () => ({
  PROBE_BINARY_PATH: '/probe',
  AIDER_DESK_TASKS_DIR: '.aider-desk/tasks',
  AIDER_DESK_WORKFLOW_EVENTS_FILE: 'workflow-events.jsonl',
  AIDER_DESK_DIR: '.aider-desk',
  AIDER_DESK_TODOS_FILE: 'todos.json',
  AIDER_DESK_RULES_DIR: 'rules',
  AIDER_DESK_PROJECT_RULES_DIR: '.aider-desk/rules',
  AIDER_DESK_GLOBAL_RULES_DIR: `${ROOT}/global-rules`,
  AIDER_DESK_PROJECT_MAPPINGS_DIR: '.aider-desk/mappings',
  AIDER_DESK_MAPPINGS_SCRIPT: '.aider-desk/mappings.sh',

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
    runAgent = vi.fn().mockResolvedValue([]);
    estimateTokens = vi.fn().mockResolvedValue(0);
    estimateTokensWithBreakdown = vi.fn().mockResolvedValue({ tokens: 0, breakdown: { categories: [], totalTokens: 0 } });
    dispose = vi.fn();
  },
  McpManager: class {},
  AgentProfileManager: class {},
}));

vi.mock('@/task/aider-manager', () => ({
  AiderManager: class {
    start = vi.fn();
    stop = vi.fn();
    dispose = vi.fn();
    isStarted = vi.fn(() => false);
    sendUpdateAiderModels = vi.fn();
  },
}));

vi.mock('@/prompts', () => ({ PromptsManager: class {} }));
vi.mock('@/data-manager', () => ({ DataManager: class {} }));
vi.mock('@/telemetry', () => ({ TelemetryManager: class {} }));
vi.mock('@/models', () => ({ ModelManager: class {} }));
vi.mock('@/events', () => ({ EventManager: class {} }));
vi.mock('@/memory/memory-manager', () => ({ MemoryManager: class {} }));
vi.mock('@/git', () => ({ GitManager: class {} }));
vi.mock('@/custom-commands', () => ({ CustomCommandManager: class {} }));
vi.mock('@/skills/skill-manager', () => ({
  SkillManager: class {
    getSkills = vi.fn().mockResolvedValue([]);
  },
}));
vi.mock('@/store', () => ({ Store: class {} }));

const PROJECT_DIR = `${ROOT}/project`;
const GLOBAL_RULES_DIR = `${ROOT}/global-rules`;
const PROFILE_RULE = `${ROOT}/profile-rules/p.md`;
const TASK_ID = 'task-1';
const TASK_SETTINGS_FILE = path.join(PROJECT_DIR, '.aider-desk/tasks', TASK_ID, 'settings.json');
const RULE_C = '.aider-desk/rules/c.md';
const RULE_Z = '.aider-desk/rules/z.md';
const MAP_ONE = '.aider-desk/mappings/one.md';
const MAP_TWO = '.aider-desk/mappings/two.md';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

const PROFILE = {
  id: 'profile-1',
  name: 'Profile',
  provider: 'provider',
  model: 'model',
  includeContextFiles: true,
  includeRepoMappings: true,
  ruleFiles: [],
  toolApprovals: {},
  subagent: {
    enabled: true,
    contextMemory: 'off',
    systemPrompt: '',
    invocationMode: 'on-demand',
    color: '#65a30d',
    description: '',
  },
} as unknown as AgentProfile;

const write = async (filePath: string, content = '# content\n') => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
};

const readSavedTask = async (): Promise<Partial<TaskData>> => JSON.parse(await fs.readFile(TASK_SETTINGS_FILE, 'utf8'));

const createTask = (initialTaskData?: Partial<TaskData>, projectSettings: Record<string, unknown> = {}) => {
  const settings = {
    agentProfileId: PROFILE.id,
    currentMode: 'agent',
    mainModel: 'main-model',
    modelEditFormats: {},
    disabledRuleFiles: [],
    disabledRepositoryMappingFiles: [],
    ...projectSettings,
  };
  const project = {
    baseDir: PROJECT_DIR,
    getProjectSettings: vi.fn(() => settings),
    isWorktreeSharedWithOtherTasks: vi.fn(() => false),
    addToInputHistory: vi.fn().mockResolvedValue(undefined),
  };
  const store = {
    getSettings: vi.fn(() => ({
      aider: {
        addRuleFiles: true,
        options: '',
        environmentVariables: '',
        autoCommits: true,
        cachingEnabled: false,
        watchFiles: false,
        confirmBeforeEdit: false,
      },
      taskSettings: {},
      promptBehavior: { requireCommandConfirmation: {} },
    })),
    getProjectSettings: vi.fn(() => settings),
    getProviders: vi.fn(() => []),
  };
  const extensionManager = {
    isInitialized: vi.fn(() => false),
    dispatchEvent: vi.fn(async (_event: string, payload: unknown) => payload),
  };
  const eventManager = {
    sendTaskUpdated: vi.fn(),
    sendContextFilesUpdated: vi.fn(),
    sendContextManifestUpdated: vi.fn(),
    sendContextInfoUpdated: vi.fn(),
    sendUpdateTokensInfo: vi.fn(),
    sendSkillsUpdated: vi.fn(),
    sendUpdateAutocompletion: vi.fn(),
  };
  const agentProfileManager = { getProfile: vi.fn(() => PROFILE) };

  const task = new Task(
    project as never,
    TASK_ID,
    store as never,
    {} as never,
    {} as never,
    {} as never,
    agentProfileManager as never,
    {} as never,
    {} as never,
    eventManager as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    extensionManager as never,
    {} as never,
    initialTaskData,
  );
  vi.spyOn(task, 'updateContextInfo').mockResolvedValue(undefined);
  vi.spyOn(task, 'updateAgentEstimatedTokens').mockResolvedValue(undefined);

  return { task, eventManager, extensionManager };
};

const contextManagerOf = (task: Task) =>
  (
    task as unknown as {
      contextManager: {
        load: () => Promise<void>;
        setContextFiles: (files: ContextFile[], save?: boolean) => void;
        getContextFiles: (includeDisabled?: boolean) => ContextFile[];
      };
    }
  ).contextManager;

const setContextFiles = async (task: Task, files: ContextFile[]) => {
  const contextManager = contextManagerOf(task);
  await contextManager.load();
  contextManager.setContextFiles(files, false);
};

const agentOf = (task: Task) => (task as unknown as { agent: { runAgent: ReturnType<typeof vi.fn> } }).agent;

describe('Task - per-task file selection', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await write(path.join(GLOBAL_RULES_DIR, 'b.md'));
    await write(path.join(GLOBAL_RULES_DIR, 'a.md'));
    await write(path.join(PROJECT_DIR, 'AGENTS.md'));
    await write(path.join(PROJECT_DIR, RULE_Z));
    await write(path.join(PROJECT_DIR, RULE_C));
    await write(path.join(PROJECT_DIR, MAP_ONE));
    await write(path.join(PROJECT_DIR, MAP_TWO));
    await write(path.join(PROJECT_DIR, 'src/a.ts'));
    await write(path.join(PROJECT_DIR, 'src/b.ts'));
    await write(PROFILE_RULE);
    await fs.mkdir(path.dirname(TASK_SETTINGS_FILE), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('refreshContextFiles updates estimated tokens and sends the manifest update', async () => {
    const { task, eventManager } = createTask();
    const updateAgentEstimatedTokens = vi.mocked(task.updateAgentEstimatedTokens);

    await task.refreshContextFiles();

    expect(eventManager.sendContextManifestUpdated).toHaveBeenCalled();
    expect(updateAgentEstimatedTokens).toHaveBeenCalled();
  });

  it('estimates the breakdown even when context usage is hidden', async () => {
    vi.useFakeTimers();
    try {
      const { task } = createTask();
      vi.mocked(task.updateAgentEstimatedTokens).mockRestore();
      vi.spyOn(task, 'updateTokensInfo').mockResolvedValue(undefined);
      const current = task['store'].getSettings();
      vi.mocked(task['store'].getSettings).mockReturnValue({ ...current, showContextUsageBar: false });
      const estimate = vi.mocked(task['agent'].estimateTokensWithBreakdown);

      await task.updateAgentEstimatedTokens();
      await vi.advanceTimersByTimeAsync(500);

      expect(estimate).toHaveBeenCalledWith(task, PROFILE, true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-estimates and publishes the remaining context after dropping all files', async () => {
    const { task, eventManager } = createTask();
    await task.waitForTaskDataLoad();
    await setContextFiles(task, [{ path: 'src/a.ts' }, { path: 'src/b.ts', readOnly: true }]);
    vi.mocked(task.updateAgentEstimatedTokens).mockRestore();

    const category = (id: ContextUsageCategoryId, tokens: number): ContextUsageCategory => ({
      id,
      tokens,
      items: [{ id: `${id}-item`, label: id, tokens }],
    });
    const residual: ContextUsageCategory[] = [
      category('systemPrompt', 40),
      category('rules', 10),
      category('tools', 50),
      category('repoMappings', 20),
      category('conversation', 30),
    ];
    const estimate = vi.mocked(task['agent'].estimateTokensWithBreakdown);
    estimate.mockImplementation(async (taskUnderEstimate) => {
      const files = await taskUnderEstimate.getContextFiles();
      const categories = [...residual];
      const editableTokens = files.filter((file) => !file.readOnly).length * 100;
      const readOnlyTokens = files.filter((file) => file.readOnly).length * 100;
      if (editableTokens > 0) {
        categories.push(category('editableFiles', editableTokens));
      }
      if (readOnlyTokens > 0) {
        categories.push(category('readOnlyFiles', readOnlyTokens));
      }
      const tokens = 150 + files.length * 100;
      return { tokens, breakdown: { categories, totalTokens: tokens } };
    });
    task.updateTokensInfo({
      agent: { tokens: 350, cost: 0 },
      contextBreakdown: {
        totalTokens: 350,
        categories: [...residual, category('editableFiles', 100), category('readOnlyFiles', 100)],
      },
    });
    eventManager.sendUpdateTokensInfo.mockClear();
    estimate.mockClear();

    vi.useFakeTimers();
    try {
      await task.runCommand('drop', false);
      await vi.advanceTimersByTimeAsync(600);

      expect(contextManagerOf(task).getContextFiles(true)).toEqual([]);
      expect(estimate).toHaveBeenCalledWith(task, PROFILE, true);
      expect(eventManager.sendUpdateTokensInfo).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ tokens: 150, tokensEstimated: true }),
          contextBreakdown: { categories: residual, totalTokens: 150 },
        }),
      );
      expect(eventManager.sendUpdateTokensInfo).not.toHaveBeenLastCalledWith(expect.objectContaining({ agent: expect.objectContaining({ tokens: 350 }) }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('sub-agents receive only enabled context files, and onSubagentStarted sees the same list', async () => {
    const { task, extensionManager } = createTask();
    await task.waitForTaskDataLoad();
    await setContextFiles(task, [{ path: 'src/a.ts', disabled: true }, { path: 'src/b.ts' }]);

    await task.runSubagent(PROFILE, 'Investigate', []);

    const passedFiles = agentOf(task).runAgent.mock.calls[0][6] as ContextFile[];
    expect(passedFiles.map((file) => file.path)).toEqual(['src/b.ts']);
    const started = extensionManager.dispatchEvent.mock.calls.find(([event]) => event === 'onSubagentStarted');
    expect((started?.[1] as { contextFiles: ContextFile[] }).contextFiles.map((file) => file.path)).toEqual(['src/b.ts']);
  });

  it('sub-agents drop disabled entries from caller-supplied context files too', async () => {
    const { task } = createTask();
    await task.waitForTaskDataLoad();

    await task.runSubagent(PROFILE, 'Investigate', [], [{ path: 'src/a.ts', disabled: true }, { path: 'src/b.ts' }]);

    expect(agentOf(task).runAgent.mock.calls[0][6]).toEqual([{ path: 'src/b.ts' }]);
  });

  it('getContextFiles(true, false) excludes rules unticked for the task; (true, true) includes them', async () => {
    const { task } = createTask({ disabledRuleFiles: [RULE_C], disabledRepositoryMappingFiles: [] });
    await task.waitForTaskDataLoad();

    const enabled = (await task.getContextFiles(true, false)).map((file) => file.path);
    const all = (await task.getContextFiles(true, true)).map((file) => file.path);

    expect(enabled).not.toContain(RULE_C);
    expect(enabled).toContain(RULE_Z);
    expect(all).toContain(RULE_C);
  });

  it('lists rule files sorted by name within the global and project groups, keeping group order', async () => {
    const realReaddir = fs.readdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, 'readdir').mockImplementation((async (...args: unknown[]) => {
      const result = await realReaddir(...args);
      return Array.isArray(result) && result.every((entry) => typeof entry === 'string') ? [...result].sort().reverse() : result;
    }) as never);
    const { task } = createTask();
    await task.waitForTaskDataLoad();

    const rules = await task.getRuleFilesAsContextFiles({ ...PROFILE, ruleFiles: [PROFILE_RULE] }, true);

    expect(rules.map((rule) => [rule.source, path.basename(rule.path)])).toEqual([
      ['global-rule', 'a.md'],
      ['global-rule', 'b.md'],
      ['project-rule', 'AGENTS.md'],
      ['project-rule', 'c.md'],
      ['project-rule', 'z.md'],
      ['agent-rule', 'p.md'],
    ]);
  });

  it('a task loaded from disk without the selection fields takes the project lists, persisted on the next save', async () => {
    await write(
      TASK_SETTINGS_FILE,
      JSON.stringify({ id: TASK_ID, baseDir: PROJECT_DIR, name: 'Old task', createdAt: CREATED_AT, mainModel: 'm', aiderTotalCost: 0, agentTotalCost: 0 }),
    );
    const { task } = createTask(undefined, { disabledRuleFiles: [RULE_C], disabledRepositoryMappingFiles: [MAP_ONE] });
    await task.waitForTaskDataLoad();

    expect(task.task.disabledRuleFiles).toEqual([RULE_C]);
    expect(task.task.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);

    await task.saveTask({ name: 'Renamed' });
    const saved = await readSavedTask();
    expect(saved.disabledRuleFiles).toEqual([RULE_C]);
    expect(saved.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);
  });

  it('a task loaded from disk with a legacy metadata reasoning level takes it as its reasoning override, persisted on the next save', async () => {
    await write(
      TASK_SETTINGS_FILE,
      JSON.stringify({
        id: TASK_ID,
        baseDir: PROJECT_DIR,
        name: 'Old task',
        createdAt: CREATED_AT,
        mainModel: 'm',
        aiderTotalCost: 0,
        agentTotalCost: 0,
        metadata: { reasoningEffort: 'high', other: 1 },
      }),
    );
    const { task } = createTask();
    await task.waitForTaskDataLoad();

    expect(task.task.reasoningOverride).toBe('high');
    expect(task.task.metadata).toEqual({ other: 1 });

    await task.saveTask({ name: 'Renamed' });
    const saved = await readSavedTask();
    expect(saved.reasoningOverride).toBe('high');
    expect(saved.metadata).toEqual({ other: 1 });
  });

  it('a task loaded from disk with the selection fields keeps its own lists', async () => {
    await write(
      TASK_SETTINGS_FILE,
      JSON.stringify({
        id: TASK_ID,
        baseDir: PROJECT_DIR,
        name: 'Task',
        createdAt: CREATED_AT,
        mainModel: 'm',
        aiderTotalCost: 0,
        agentTotalCost: 0,
        disabledRuleFiles: [],
        disabledRepositoryMappingFiles: [MAP_TWO],
      }),
    );
    const { task } = createTask(undefined, { disabledRuleFiles: [RULE_C], disabledRepositoryMappingFiles: [MAP_ONE] });
    await task.waitForTaskDataLoad();

    expect(task.task.disabledRuleFiles).toEqual([]);
    expect(task.task.disabledRepositoryMappingFiles).toEqual([MAP_TWO]);
  });

  it('rules and mappings honour the task lists and ignore the deprecated project lists', async () => {
    const { task } = createTask(
      { disabledRuleFiles: [RULE_C], disabledRepositoryMappingFiles: [MAP_ONE] },
      { disabledRuleFiles: [RULE_Z], disabledRepositoryMappingFiles: [MAP_TWO] },
    );
    await task.waitForTaskDataLoad();

    const rulePaths = (await task.getRuleFilesAsContextFiles(PROFILE)).map((rule) => rule.path);
    expect(rulePaths).toContain(RULE_Z);
    expect(rulePaths).not.toContain(RULE_C);
    expect((await task.getRepositoryMappingFiles()).map((file) => file.path)).toEqual([MAP_TWO]);
  });

  describe('setFileSelection', () => {
    it('rules and mappings update only their own list and persist it; unticking a rule keeps an unticked mapping', async () => {
      const { task, eventManager } = createTask({ name: 'Task', createdAt: CREATED_AT, disabledRuleFiles: [], disabledRepositoryMappingFiles: [] });
      await task.waitForTaskDataLoad();

      await task.setFileSelection('mappings', [MAP_ONE], false);
      await task.setFileSelection('rules', [RULE_C], false);

      expect(task.task.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);
      expect(task.task.disabledRuleFiles).toEqual([RULE_C]);
      const saved = await readSavedTask();
      expect(saved.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);
      expect(saved.disabledRuleFiles).toEqual([RULE_C]);
      expect((await task.getRepositoryMappingFiles()).map((file) => file.path)).toEqual([MAP_TWO]);
      expect(eventManager.sendContextManifestUpdated).toHaveBeenCalled();

      await task.setFileSelection('rules', [RULE_C], true);

      expect(task.task.disabledRuleFiles).toEqual([]);
      expect(task.task.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);
    });

    it("'files' sets disabled on the context entries without touching the rule or mapping lists", async () => {
      const { task } = createTask({ disabledRuleFiles: [], disabledRepositoryMappingFiles: [MAP_ONE] });
      await task.waitForTaskDataLoad();
      await setContextFiles(task, [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);

      await task.setFileSelection('files', ['src/a.ts'], false);

      expect(contextManagerOf(task).getContextFiles(true)).toEqual([{ path: 'src/a.ts', disabled: true }, { path: 'src/b.ts' }]);
      expect((await task.getContextFiles()).map((file) => file.path)).toEqual(['src/b.ts']);
      expect(task.task.disabledRuleFiles).toEqual([]);
      expect(task.task.disabledRepositoryMappingFiles).toEqual([MAP_ONE]);

      await task.setFileSelection('files', ['src/a.ts'], true);
      expect((await task.getContextFiles()).map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('unticking a rule also disables a context entry at the same path, and ticking re-enables it', async () => {
      const { task } = createTask({ disabledRuleFiles: [], disabledRepositoryMappingFiles: [] });
      await task.waitForTaskDataLoad();
      const ruleAsContextFile = path.join(PROJECT_DIR, RULE_C);
      await setContextFiles(task, [{ path: ruleAsContextFile, readOnly: true }, { path: 'src/a.ts' }]);

      await task.setFileSelection('rules', [RULE_C], false);

      expect(contextManagerOf(task).getContextFiles(true)).toEqual([{ path: ruleAsContextFile, readOnly: true, disabled: true }, { path: 'src/a.ts' }]);

      await task.setFileSelection('rules', [RULE_C], true);

      expect(contextManagerOf(task).getContextFiles(true)).toEqual([{ path: ruleAsContextFile, readOnly: true }, { path: 'src/a.ts' }]);
    });
  });
});
