import { describe, expect, it, vi } from 'vitest';

import { Store } from '../store';

import type { ProjectData, ProjectSettings } from '@common/types';

vi.mock('@/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/utils', () => ({
  getFreshProjectSettings: vi.fn((_store: unknown, _models: unknown, baseDir: string) => ({
    mainModel: `fresh-model-for:${baseDir}`,
    agentProfileId: 'default',
    modelEditFormats: {},
    currentMode: 'agent',
    updatedFilesGroupMode: 'flat',
    disabledRuleFiles: [],
    disabledRepositoryMappingFiles: [],
    disabledSkills: [],
    contextSidebarSectionsOrder: [],
    contextSidebarSectionsHidden: [],
  })),
}));

const settingsFor = (mainModel: string, overrides: Partial<ProjectSettings> = {}): ProjectSettings => ({
  mainModel,
  agentProfileId: 'profile',
  modelEditFormats: {},
  currentMode: 'agent',
  updatedFilesGroupMode: 'grouped',
  disabledRuleFiles: [],
  disabledRepositoryMappingFiles: [],
  disabledSkills: ['skill'],
  contextSidebarSectionsOrder: ['files'],
  contextSidebarSectionsHidden: [],
  ...overrides,
});

const createStore = (openProjects: ProjectData[]) => {
  const data = new Map<string, unknown>([['openProjects', openProjects]]);
  const store = new Store();
  (store as unknown as { store: unknown }).store = {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => data.set(key, value),
  };
  return { store, data };
};

const projectA: ProjectData = { baseDir: '/projects/a', active: true, settings: settingsFor('model-a') };
const projectB: ProjectData = { baseDir: '/projects/b', active: false, settings: settingsFor('model-b') };

describe('Store project settings', () => {
  it('getProjectSettings for an unknown project returns fresh defaults, not the active project settings', () => {
    const { store } = createStore([projectA]);

    const settings = store.getProjectSettings('/projects/unknown');

    expect(settings).not.toEqual(projectA.settings);
    expect(settings.mainModel).toBe('fresh-model-for:/projects/unknown');
    expect(settings.disabledSkills).toEqual([]);
  });

  it('saveProjectSettings for an unknown project throws', () => {
    const { store, data } = createStore([projectA]);

    expect(() => store.saveProjectSettings('/projects/unknown', settingsFor('x'))).toThrow(/No open project found/);
    expect(data.get('openProjects')).toEqual([projectA]);
  });

  it('saveProjectSettings for an open project stores the settings', () => {
    const { store } = createStore([projectA, projectB]);

    store.saveProjectSettings('/projects/b', settingsFor('model-b2'));

    expect(store.getProjectSettings('/projects/b').mainModel).toBe('model-b2');
  });

  it('updateOpenProjectsOrder keeps open projects missing from the request, after the requested ones', () => {
    const { store } = createStore([projectA, projectB]);

    const ordered = store.updateOpenProjectsOrder(['/projects/b']);

    expect(ordered.map((project) => project.baseDir)).toEqual(['/projects/b', '/projects/a']);
    expect(store.getOpenProjects().map((project) => project.baseDir)).toEqual(['/projects/b', '/projects/a']);
  });
});
