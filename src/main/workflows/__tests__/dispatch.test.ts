import { describe, expect, it, vi } from 'vitest';

import type { AgentProfile, WorkflowConfig, WorkflowRunInfo } from '@common/types';
import type { Task } from '@/task';

import { createWorkflowDispatcher, WorkflowCancelled, WorkflowError } from '../dispatch';

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

  it('case 1: primary success returns output, dispatchSubagent called once, hasProvider not consulted', async () => {
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

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
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      maxIterations: 8,
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, hasProvider, dispatchSubagent } = createStubTask(profile);
    hasProvider.mockReturnValue(true);

    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
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
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

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
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      maxIterations: 0,
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
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

  it('case 5: fallback error throws WorkflowError containing primary message and fallback failure info', async () => {
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, hasProvider, dispatchSubagent } = createStubTask(profile);
    hasProvider.mockReturnValue(true);

    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
      })
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
      });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(
      /Workflow agent 'DIGESTER' failed to complete its run/,
    );
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);
  });

  it('case 6: base profile object is not mutated by the override', async () => {
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, hasProvider, dispatchSubagent } = createStubTask(profile);
    hasProvider.mockReturnValue(true);

    dispatchSubagent
      .mockResolvedValueOnce({
        status: 'error',
        outputText: '',
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
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, dispatchSubagent } = createStubTask(profile);
    dispatchSubagent.mockResolvedValueOnce({
      status: 'error',
      outputText: '',
    });

    const dispatcher = createWorkflowDispatcher(task, fallbackConfig);
    await expect(
      dispatcher.agent('DIGESTER', 'test prompt', 'test description', { disableFallback: true }),
    ).rejects.toThrow(/failed to complete its run/);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
  });

  it('case 8: modelSlot fallback dispatches the fallback model directly with tripled iterations', async () => {
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      maxIterations: 8,
      subagent: { enabled: true },
    } as AgentProfile;

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
});
