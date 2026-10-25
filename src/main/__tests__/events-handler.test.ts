import { describe, expect, it, vi } from 'vitest';

import { EventsHandler } from '../events-handler';

import type { AgentProfileManager } from '@/agent';
import type { Store } from '@/store';
import type { ModelManager } from '@/models';
import type { TelemetryManager } from '@/telemetry';
import type { ProjectData } from '@common/types';

describe('EventsHandler', () => {
  it('uses the default agent profile when the active project profile is scoped to another project', async () => {
    const activeProject = {
      baseDir: '/previous-project',
      active: true,
      settings: {
        agentProfileId: 'previous-project-profile',
      },
    } as unknown as ProjectData;
    const store = {
      getOpenProjects: vi.fn(() => [activeProject]),
      setOpenProjects: vi.fn(),
      getSettings: vi.fn(() => ({ aider: { options: '' }, taskSettings: {} })),
      getProviders: vi.fn(() => []),
    } as unknown as Store;
    const modelManager = {
      getProviderModels: vi.fn().mockResolvedValue({ models: [] }),
    } as unknown as ModelManager;
    const telemetryManager = {
      captureProjectOpened: vi.fn(),
    } as unknown as TelemetryManager;
    const agentProfileManager = {
      getDefaultAgentProfileId: vi.fn(() => 'default-profile'),
      getProfile: vi.fn(() => ({ id: 'previous-project-profile', projectDir: '/previous-project' })),
    } as unknown as AgentProfileManager;
    const eventsHandler = new EventsHandler(
      {} as never,
      store,
      {} as never,
      {} as never,
      {} as never,
      modelManager,
      telemetryManager,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      agentProfileManager,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await eventsHandler.addOpenProject('/new-project');

    expect(store.setOpenProjects).toHaveBeenCalledWith([
      { ...activeProject, active: false },
      expect.objectContaining({
        baseDir: '/new-project',
        active: true,
        settings: expect.objectContaining({ agentProfileId: 'default-profile' }),
      }),
    ]);
  });

  it('loadWorkflowLogs returns empty history for an unknown task', async () => {
    const projectManager = {
      getProject: vi.fn(() => ({
        getTask: vi.fn(() => undefined),
      })),
    } as never;
    const eventsHandler = new EventsHandler(
      projectManager,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await eventsHandler.loadWorkflowLogs('/project', 'unknown-task');

    expect(result).toEqual({ hasWorkflowHistory: false, logs: [] });
  });

  it('loadWorkflowLogs delegates to the task with its workflow-history flag', async () => {
    const task = {
      hasWorkflowHistory: vi.fn(() => true),
      loadWorkflowLogs: vi.fn().mockResolvedValue([{ id: 'log-1' }]),
    };
    const projectManager = {
      getProject: vi.fn(() => ({
        getTask: vi.fn(() => task),
      })),
    } as never;
    const eventsHandler = new EventsHandler(
      projectManager,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await eventsHandler.loadWorkflowLogs('/project', 'task-1');

    expect(task.hasWorkflowHistory).toHaveBeenCalled();
    expect(task.loadWorkflowLogs).toHaveBeenCalled();
    expect(result).toEqual({ hasWorkflowHistory: true, logs: [{ id: 'log-1' }] });
  });
});
