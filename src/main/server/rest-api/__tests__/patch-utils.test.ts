import { describe, expect, it } from 'vitest';

import { PatchProjectSettingsSchema, pickKeysPresentInBody } from '../patch-utils';

import type { ProjectSettings } from '@common/types';

const stored: ProjectSettings = {
  mainModel: 'provider/model',
  agentProfileId: 'profile-1',
  modelEditFormats: {},
  currentMode: 'agent',
  updatedFilesGroupMode: 'grouped',
  disabledRuleFiles: ['.aider-desk/rules/a.md'],
  disabledRepositoryMappingFiles: ['.aider-desk/mappings/map.md'],
  disabledSkills: [],
  contextSidebarSectionsOrder: ['files', 'rules'],
  contextSidebarSectionsHidden: ['skills'],
};

describe('PATCH /project/settings body handling', () => {
  it('a body with only disabledSkills leaves every other stored field unchanged', () => {
    const body = { projectDir: '/project', disabledSkills: ['x'] };
    const { projectDir, ...settings } = PatchProjectSettingsSchema.parse(body);

    const patch = pickKeysPresentInBody(settings, body);

    expect(projectDir).toBe('/project');
    expect(patch).toEqual({ disabledSkills: ['x'] });
    expect({ ...stored, ...patch }).toEqual({ ...stored, disabledSkills: ['x'] });
  });

  it('zod fills defaults for omitted fields, which is why the body keys are needed', () => {
    const parsed = PatchProjectSettingsSchema.parse({ projectDir: '/project' });
    expect(parsed).toHaveProperty('updatedFilesGroupMode', 'flat');
    expect(pickKeysPresentInBody(parsed, { projectDir: '/project' })).toEqual({ projectDir: '/project' });
  });

  it('returns nothing for a non-object body', () => {
    expect(pickKeysPresentInBody({ a: 1 }, null)).toEqual({});
  });
});
