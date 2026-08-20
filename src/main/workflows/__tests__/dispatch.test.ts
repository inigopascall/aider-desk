import { describe, expect, it, vi } from 'vitest';

import type { AgentProfile, WorkflowRunInfo } from '@common/types';
import type { Task } from '@/task';

import { createWorkflowDispatcher, WorkflowCancelled, WorkflowError } from '../dispatch';

describe('createWorkflowDispatcher fallback logic', () => {
  const dummyRun: WorkflowRunInfo = {
    runId: 'run-1',
    workflowId: 'dev-pipeline',
    workflowName: 'Dev Pipeline',
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

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(result).toBe('output from primary');
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
    expect(hasProvider).not.toHaveBeenCalled();
  });

  it('case 2: primary error triggers fallback dispatch with fallback model and suffixed description', async () => {
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

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    const result = await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(result).toBe('output from fallback');
    expect(dispatchSubagent).toHaveBeenCalledTimes(2);

    const fallbackCallArgs = dispatchSubagent.mock.calls[1];
    const fallbackProfile = fallbackCallArgs[0] as AgentProfile;
    const fallbackDescription = fallbackCallArgs[2] as string;

    expect(fallbackProfile.provider).toBe('9router');
    expect(fallbackProfile.model).toBe('openai-compatible-opencode-go/deepseek-v4-flash');
    expect(fallbackDescription).toBe('test description (fallback)');
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

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(WorkflowCancelled);
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
  });

  it('case 4: hasProvider false throws WorkflowError mentioning provider not configured', async () => {
    const profile: AgentProfile = {
      id: 'digester-id',
      name: 'DIGESTER',
      provider: 'openrouter',
      model: 'primary-model',
      subagent: { enabled: true },
    } as AgentProfile;

    const { task, hasProvider, dispatchSubagent } = createStubTask(profile);
    hasProvider.mockReturnValue(false);

    dispatchSubagent.mockResolvedValueOnce({
      status: 'error',
      outputText: '',
    });

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(
      /Fallback provider '9router' is not configured/,
    );
    expect(dispatchSubagent).toHaveBeenCalledTimes(1);
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

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    await expect(dispatcher.agent('DIGESTER', 'test prompt', 'test description')).rejects.toThrow(
      /Fallback '9router\/openai-compatible-opencode-go\/deepseek-v4-flash' also failed/,
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

    const dispatcher = createWorkflowDispatcher(task, dummyRun);
    await dispatcher.agent('DIGESTER', 'test prompt', 'test description');

    expect(profile.provider).toBe('openrouter');
    expect(profile.model).toBe('primary-model');
  });
});
