import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProfile, WorkflowConfig, WorkflowRunInfo } from '@common/types';
import type { Task } from '@/task';

import { createWorkflowDispatcher, WorkflowCancelled, WorkflowError } from '../dispatch';
import type { WorkflowLogger } from '../types';

const { mockFindEnabledSubagent, mockApplyModelOverride } = vi.hoisted(() => ({
  mockFindEnabledSubagent: vi.fn(),
  mockApplyModelOverride: vi.fn(),
}));

// Mock workflow-agent lookup and model override resolution at module boundaries so
// dispatcher tests never depend on profile storage or real provider configuration.
vi.mock('@/agent/subagent', () => ({
  findEnabledSubagent: mockFindEnabledSubagent,
}));

vi.mock('../model-config', () => ({
  applyModelOverride: mockApplyModelOverride,
}));

describe('createWorkflowDispatcher fallback logic', () => {
  const dummyRun: WorkflowRunInfo = {
    runId: 'run-1',
    workflowId: 'dev-pipeline',
    workflowName: 'Dev Pipeline',
  };

  const fallbackConfig: WorkflowConfig = {
    agentModels: {
      DIGESTER: {
        fallback: '9router/openai-compatible-opencode-go/deepseek-v4-flash',
      },
    },
  };

  const baseProfile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
    ({
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      maxIterations: 8,
      subagent: { enabled: true },
      ...overrides,
    }) as AgentProfile;

  const createStubTask = (profile: AgentProfile) => {
    const hasProvider = vi.fn();
    const dispatchSubagent = vi.fn();
    const task = {
      getProject: () => ({
        getWorkflowAgentProfiles: () => [profile],
      }),
      hasProvider,
      dispatchSubagent,
    } as unknown as Task;

    return { task, hasProvider, dispatchSubagent };
  };

  const createStubLogger = () => {
    const warning = vi.fn();
    const log = {
      run: dummyRun,
      info: vi.fn(),
      warning,
      error: vi.fn(),
      summary: vi.fn(),
    } as unknown as WorkflowLogger;
    return { log, warning };
  };

  beforeEach(() => {
    mockFindEnabledSubagent.mockReset();
    mockFindEnabledSubagent.mockImplementation((profiles: AgentProfile[], subagentId: string) =>
      profiles.find((p) => p.id === subagentId || p.name === subagentId),
    );

    mockApplyModelOverride.mockReset();
    mockApplyModelOverride.mockImplementation(
      (profile: AgentProfile, role: string, config: WorkflowConfig | undefined, slot: 'primary' | 'fallback') => {
        const modelId = config?.agentModels?.[role]?.[slot];
        if (!modelId || modelId.trim().length === 0) {
          return profile;
        }
        const [provider, ...modelParts] = modelId.split('/');
        return { ...profile, provider, model: modelParts.join('/') };
      },
    );
  });

  it('case 1: primary success returns output, dispatchSubagent called once, hasProvider not consulted', async () => {
    const profile = baseProfile();
    const { task, hasProvider, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'success',
      outputText: 'output from primary',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(result).toBe('output from primary');
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(hasProvider).not.toHaveBeenCalled();
  });

  it('case 2: primary error retries with the configured fallback model and triples a finite iteration budget', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: '529: Provider overloaded. Retry later.',
      })
      .mockResolvedValueOnce({
        status: 'success',
        outputText: 'output from fallback',
      });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(result).toBe('output from fallback');
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);

    const fallbackCallArgs = dispatchSubagent.mock.calls[1];
    const fallbackProfile = fallbackCallArgs[0] as AgentProfile;
    const fallbackDescription = fallbackCallArgs[2] as string;

    expect(fallbackProfile.provider).toBe('9router');
    expect(fallbackProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
    expect(fallbackProfile.maxIterations).toBe(profile.maxIterations * 3);
    expect(fallbackDescription).toBe('test description');
  });

  it('case 3: primary cancelled throws WorkflowCancelled without fallback dispatch', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'cancelled',
      outputText: '',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(WorkflowCancelled);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
  });

  it('case 4: fallback preserves an unlimited iteration budget', async () => {
    const profile = baseProfile({ maxIterations: 0 });
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: '529: Provider overloaded. Retry later.',
      })
      .mockResolvedValueOnce({
        status: 'success',
        outputText: 'output from fallback',
      });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    const fallbackProfile = dispatchSubagent.mock.calls[1][0] as AgentProfile;
    expect(fallbackProfile.maxIterations).toBe(0);
  });

  it('case 5: fallback error throws WorkflowError containing the fallback errorDetail', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: '529: Provider overloaded. Retry later.',
      })
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: 'fallback provider unreachable',
      });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(
      /fallback provider unreachable/,
    );
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);
  });

  it('case 6: base profile object is not mutated by the override', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: '529: Provider overloaded. Retry later.',
      })
      .mockResolvedValueOnce({
        status: 'success',
        outputText: 'output from fallback',
      });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(profile.provider).toBe('openrouter');
    expect(profile.model).toBe('primary-model');
  });

  it('case 7: disableFallback suppresses the automatic retry', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'error',
      outputText: '',
      errorDetail: '529: Provider overloaded. Retry later.',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(
      dispatcher.agent('DIGESTER', 'test prompt', 'test description', { disableFallback: true }),
    ).rejects.toThrow(/529: Provider overloaded/);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
  });

  it('case 8: modelSlot fallback dispatches the fallback model directly with tripled iterations', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'success',
      outputText: 'output from fallback slot',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description', { modelSlot: 'fallback' });

    expect(result).toBe('output from fallback slot');
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);

    const fallbackProfile = dispatchSubagent.mock.calls[0][0] as AgentProfile;
    expect(fallbackProfile.provider).toBe('9router');
    expect(fallbackProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
    expect(fallbackProfile.maxIterations).toBe(profile.maxIterations * 3);
  });

  it('retries once with a distinct fallback model, returns fallback output, and logs one fallback warning with the 529 detail', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    const { log, warning } = createStubLogger();
    const errorDetail = '529: Provider overloaded. Please retry later.';

    dispatchSubagent
      .mockResolvedValueOnce({ status: 'error', outputText: '', errorDetail })
      .mockResolvedValueOnce({ status: 'success', outputText: 'output from fallback' });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig, log);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(result).toBe('output from fallback');
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(errorDetail));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('retrying with fallback 9router/openai-compatible-opencode-go/deepseek-v4-flash'),
    );

    const fallbackProfile = dispatchSubagent.mock.calls[1][0] as AgentProfile;
    expect(fallbackProfile.provider).toBe('9router');
    expect(fallbackProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
  });

  it('does not retry when primary and fallback resolve to the same provider/model', async () => {
    // Force both slots to resolve to the same profile even though a fallback is configured.
    mockApplyModelOverride.mockImplementation((profile: AgentProfile) => profile);

    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'error',
      outputText: '',
      errorDetail: '529: Provider overloaded. Retry later.',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(
      /529: Provider overloaded/,
    );
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
  });

  it('surfaces the supplied errorDetail as the WorkflowError message, including the 529 detail', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    const errorDetail = '529: Upstream provider overloaded. Retry later.';
    dispatchSubagent.mockResolvedValueOnce({ status: 'error', outputText: '', errorDetail });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    const error = await dispatcher
      .agent('DIGESTER', 'test prompt', 'test description', { disableFallback: true })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).message).toBe(errorDetail);
    expect((error as WorkflowError).message).toContain('529');
  });

  it('persist-primary disabled: primary failure goes straight to the distinct fallback with no persist-primary retry', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    const onPersistPrimaryRetry = vi.fn();
    const config: WorkflowConfig = {
      ...fallbackConfig,
      persistPrimary: { DIGESTER: false },
    };

    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
        errorDetail: '529: Provider overloaded. Retry later.',
      })
      .mockResolvedValueOnce({
        status: 'success',
        outputText: 'output from fallback',
      });

    const dispatcher = createWorkflowDispatcher(task, config);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description', { onPersistPrimaryRetry });

    expect(result).toBe('output from fallback');
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);
    expect(onPersistPrimaryRetry).not.toHaveBeenCalled();

    // The second dispatch targets the distinct fallback model — no extra primary retry happened.
    const secondProfile = dispatchSubagent.mock.calls[1][0] as AgentProfile;
    expect(secondProfile.provider).toBe('9router');
    expect(secondProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
    expect(secondProfile.maxIterations).toBe(profile.maxIterations * 3);
  });

  it('persist-primary enabled: primary failure retries the primary model and invokes the retry telemetry hook', async () => {
    vi.useFakeTimers();
    try {
      const profile = baseProfile();
      const { task, dispatchSubagent } = createStubTask(profile);
      const { log, warning } = createStubLogger();
      const onPersistPrimaryRetry = vi.fn();
      const config: WorkflowConfig = {
        ...fallbackConfig,
        persistPrimary: { DIGESTER: true },
      };

      dispatchSubagent
        .mockResolvedValueOnce({
          status: 'error',
          outputText: '',
          errorDetail: '529: Provider overloaded. Retry later.',
        })
        .mockResolvedValueOnce({
          status: 'success',
          outputText: 'output from primary retry',
        });

      const dispatcher = createWorkflowDispatcher(task, config, log);
      const promise = dispatcher.agent('DIGESTER', 'test prompt', 'test description', { onPersistPrimaryRetry });

      // Let the initial failure settle so the persist-primary backoff timer is scheduled.
      await vi.advanceTimersByTimeAsync(0);
      // Fire the backoff timer (5s ± 10% jitter) so the primary retry runs without real delay.
      await vi.advanceTimersByTimeAsync(6_000);

      await expect(promise).resolves.toBe('output from primary retry');
      expect(dispatchSubagent).toHaveBeenCalledTimes(2);
      expect(onPersistPrimaryRetry).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('persist-primary retry 1/5'));

      // Both dispatches target the primary model — the fallback was never used.
      const firstProfile = dispatchSubagent.mock.calls[0][0] as AgentProfile;
      const secondProfile = dispatchSubagent.mock.calls[1][0] as AgentProfile;
      expect(firstProfile.provider).toBe('openrouter');
      expect(firstProfile.model).toBe('primary-model');
      expect(secondProfile.provider).toBe('openrouter');
      expect(secondProfile.model).toBe('primary-model');
    } finally {
      vi.useRealTimers();
    }
  });

  it('persist-primary enabled: a failing explicit fallback-slot dispatch is attempted exactly once', async () => {
    const profile = baseProfile();
    const { task, dispatchSubagent } = createStubTask(profile);
    const onPersistPrimaryRetry = vi.fn();
    const config: WorkflowConfig = {
      ...fallbackConfig,
      persistPrimary: { DIGESTER: true },
    };

    dispatchSubagent.mockResolvedValueOnce({
      status: 'error',
      outputText: '',
      errorDetail: 'fallback slot unreachable',
    });

    const dispatcher = createWorkflowDispatcher(task, config);
    await expect(
      dispatcher.agent('DIGESTER', 'test prompt', 'test description', {
        modelSlot: 'fallback',
        onPersistPrimaryRetry,
      }),
    ).rejects.toThrow(/fallback slot unreachable/);

    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(onPersistPrimaryRetry).not.toHaveBeenCalled();

    const fallbackProfile = dispatchSubagent.mock.calls[0][0] as AgentProfile;
    expect(fallbackProfile.provider).toBe('9router');
    expect(fallbackProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
  });
});