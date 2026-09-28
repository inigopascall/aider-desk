import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactNode } from 'react';
import { DEFAULT_AGENT_PROFILE } from '@common/agent';
import { ApplicationAPI } from '@common/api';
import { AgentProfile } from '@common/types';

import { AgentsProvider, useAgents } from '../AgentsContext';

import { useApi } from '@/contexts/ApiContext';
import { createMockApi } from '@/__tests__/mocks/api';

vi.mock('@/contexts/ApiContext', () => ({
  useApi: vi.fn(),
}));

type ProfilesUpdatedListener = Parameters<ApplicationAPI['addAgentProfilesUpdatedListener']>[0];
type ProfilesUpdatedData = Parameters<ProfilesUpdatedListener>[0];

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const createProfile = (id: string, overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  ...DEFAULT_AGENT_PROFILE,
  id,
  name: id,
  projectDir: undefined,
  workflowAgent: false,
  ...overrides,
});

const wrapper = ({ children }: { children: ReactNode }) => <AgentsProvider>{children}</AgentsProvider>;

describe('AgentsContext', () => {
  let mockApi: ReturnType<typeof createMockApi>;
  const listeners: { profilesUpdated?: ProfilesUpdatedListener } = {};

  beforeEach(() => {
    vi.clearAllMocks();
    delete listeners.profilesUpdated;
    mockApi = createMockApi();
    mockApi.addAgentProfilesUpdatedListener.mockImplementation((listener) => {
      listeners.profilesUpdated = listener;
      return () => undefined;
    });
    vi.mocked(useApi).mockReturnValue(mockApi);
  });

  const renderAgents = async () => {
    const hook = renderHook(() => useAgents(), { wrapper });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook;
  };

  it('keeps the newest refresh result when responses arrive out of order', async () => {
    const { result } = await renderAgents();
    const older = createDeferred<AgentProfile[]>();
    const newer = createDeferred<AgentProfile[]>();
    mockApi.getAllAgentProfiles.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    let olderRefresh!: Promise<void>;
    let newerRefresh!: Promise<void>;
    act(() => {
      olderRefresh = result.current.refreshProfiles();
      newerRefresh = result.current.refreshProfiles();
    });

    await act(async () => {
      newer.resolve([createProfile('newer')]);
      await newerRefresh;
    });
    await act(async () => {
      older.resolve([createProfile('older')]);
      await olderRefresh;
    });

    expect(result.current.profiles.map((profile) => profile.id)).toEqual(['newer']);
    expect(result.current.loading).toBe(false);
  });

  it('keeps a pushed profiles update over a refresh response that started before it', async () => {
    const { result } = await renderAgents();
    const pending = createDeferred<AgentProfile[]>();
    mockApi.getAllAgentProfiles.mockReturnValueOnce(pending.promise);

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshProfiles();
    });

    expect(listeners.profilesUpdated).toBeDefined();
    act(() => {
      listeners.profilesUpdated?.({ profiles: [createProfile('pushed')] } as ProfilesUpdatedData);
    });
    expect(result.current.profiles.map((profile) => profile.id)).toEqual(['pushed']);

    await act(async () => {
      pending.resolve([createProfile('stale')]);
      await refresh;
    });

    expect(result.current.profiles.map((profile) => profile.id)).toEqual(['pushed']);
    expect(result.current.loading).toBe(false);
  });

  it('getProfiles returns the project and global profiles and excludes workflow agents', async () => {
    mockApi.getAllAgentProfiles.mockResolvedValue([
      createProfile('project-a', { projectDir: '/proj/a' }),
      createProfile('project-b', { projectDir: '/proj/b' }),
      createProfile('global'),
      createProfile('workflow', { workflowAgent: true }),
    ]);

    const { result } = await renderAgents();

    expect(result.current.getProfiles('/proj/a').map((profile) => profile.id)).toEqual(['project-a', 'global']);
  });
});
