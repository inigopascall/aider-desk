import { describe, expect, it, vi } from 'vitest';

import { getDefaultProjectSettings } from '../environment';

import type { ProjectData, ProjectSettings } from '@common/types';
import type { Store } from '@/store';

vi.mock('@/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/telemetry', () => ({
  getLangfuseEnvironmentVariables: vi.fn(() => ({})),
  getPostHogAiderEnvironmentVariables: vi.fn(() => ({})),
}));

const activeSettings: ProjectSettings = {
  mainModel: 'active/main',
  weakModel: 'active/weak',
  architectModel: 'active/architect',
  reasoningEffort: 'high',
  thinkingTokens: '2k',
  currentMode: 'architect',
  agentProfileId: 'active-profile',
  modelEditFormats: { 'active/main': 'whole' },
  autonomyModeLocked: true,
  updatedFilesGroupMode: 'grouped',
  disabledRuleFiles: ['.aider-desk/rules/a.md'],
  disabledRepositoryMappingFiles: ['.aider-desk/mappings/map.md'],
  disabledSkills: ['skill'],
  contextSidebarSectionsOrder: ['files', 'rules'],
  contextSidebarSectionsHidden: ['skills'],
};

const createStore = (openProjects: ProjectData[]) =>
  ({
    getOpenProjects: vi.fn(() => openProjects),
    getSettings: vi.fn(() => ({ aider: { options: '' }, taskSettings: {} })),
    getProviders: vi.fn(() => []),
  }) as unknown as Store;

describe('getDefaultProjectSettings', () => {
  it('a newly opened project inherits only model and mode choices from the active project', () => {
    const store = createStore([{ baseDir: '/projects/active', active: true, settings: activeSettings }]);

    const settings = getDefaultProjectSettings(store, [], '/nonexistent/new-project', 'default-profile');

    expect(settings).toMatchObject({
      mainModel: 'active/main',
      weakModel: 'active/weak',
      architectModel: 'active/architect',
      reasoningEffort: 'high',
      thinkingTokens: '2k',
      currentMode: 'architect',
      agentProfileId: 'active-profile',
      modelEditFormats: { 'active/main': 'whole' },
    });
    expect(settings.disabledSkills).toEqual([]);
    expect(settings.contextSidebarSectionsOrder).toEqual([]);
    expect(settings.contextSidebarSectionsHidden).toEqual([]);
    expect(settings.disabledRuleFiles).toEqual([]);
    expect(settings.disabledRepositoryMappingFiles).toEqual([]);
    expect(settings.updatedFilesGroupMode).toBe('flat');
    expect(settings.autonomyModeLocked).toBe(false);
  });

  it('without an active project returns fresh defaults', () => {
    const store = createStore([]);

    const settings = getDefaultProjectSettings(store, [], '/nonexistent/new-project', 'default-profile');

    expect(settings.agentProfileId).toBe('default-profile');
    expect(settings.disabledSkills).toEqual([]);
    expect(settings.contextSidebarSectionsOrder).toEqual([]);
  });
});
