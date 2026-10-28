import { describe, expect, it } from 'vitest';

import { buildContextManifest, toDisplayPath, type ContextManifestInput } from '../context-selection';

import type { AgentProfile, ContextSectionId, TaskContextManifest } from '@common/types';

const BASE = '/work/project';
const HOME = '/home/user';

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile =>
  ({ id: 'profile-1', includeContextFiles: true, includeRepoMappings: true, ...overrides }) as AgentProfile;

const input = (overrides: Partial<ContextManifestInput> = {}): ContextManifestInput => ({
  baseDir: BASE,
  taskId: 'task-1',
  mode: 'agent',
  profile: profile(),
  addRuleFiles: true,
  projectRulesDir: `${BASE}/.aider-desk/rules`,
  ruleFiles: [
    { path: '~/.aider-desk/rules/global.md', readOnly: true, source: 'global-rule' },
    { path: 'AGENTS.md', readOnly: true, source: 'project-rule' },
    { path: '.aider-desk/rules/project.md', readOnly: true, source: 'project-rule' },
  ],
  disabledRuleFiles: [],
  mappingFiles: [{ path: '.aider-desk/mappings/map.md', readOnly: true, source: 'repo-mapping' }],
  disabledMappingFiles: [],
  contextFiles: [{ path: 'src/edit.ts' }, { path: 'docs/ref.md', readOnly: true }, { path: 'img/logo.png' }],
  homeDir: HOME,
  ...overrides,
});

const section = (manifest: TaskContextManifest, id: ContextSectionId) => manifest.sections.find((candidate) => candidate.id === id)!;
const outcomes = (manifest: TaskContextManifest, id: ContextSectionId) =>
  section(manifest, id).entries.map((entry) => [entry.path, entry.delivery, entry.notSentReason]);

describe('buildContextManifest', () => {
  it('always lists rules, mappings and files, in that order', () => {
    expect(buildContextManifest(input()).sections.map((candidate) => candidate.id)).toEqual(['rules', 'mappings', 'files']);
  });

  it('agent mode with includeContextFiles on: content after history, read-only files first', () => {
    const manifest = buildContextManifest(input());
    expect(manifest.agentProfileId).toBe('profile-1');
    expect(section(manifest, 'rules').placement).toBe('system-prompt');
    expect(section(manifest, 'mappings').placement).toBe('messages-after-history');
    expect(section(manifest, 'files').placement).toBe('messages-after-history');
    expect(outcomes(manifest, 'files')).toEqual([
      ['docs/ref.md', 'content', undefined],
      ['src/edit.ts', 'content', undefined],
      ['img/logo.png', 'content', undefined],
    ]);
    expect(outcomes(manifest, 'mappings')).toEqual([['.aider-desk/mappings/map.md', 'content', undefined]]);
  });

  it('agent mode with includeContextFiles off: before history, non-image files path-only', () => {
    const manifest = buildContextManifest(input({ profile: profile({ includeContextFiles: false }) }));
    expect(section(manifest, 'mappings').placement).toBe('messages-before-history');
    expect(section(manifest, 'files').placement).toBe('messages-before-history');
    expect(outcomes(manifest, 'files')).toEqual([
      ['src/edit.ts', 'path-only', undefined],
      ['docs/ref.md', 'path-only', undefined],
      ['img/logo.png', 'content', undefined],
    ]);
  });

  it('includeRepoMappings off: mappings are not sent', () => {
    const manifest = buildContextManifest(input({ profile: profile({ includeRepoMappings: false }) }));
    expect(outcomes(manifest, 'mappings')).toEqual([['.aider-desk/mappings/map.md', 'none', 'profile-excludes-mappings']]);
  });

  it('Aider mode with addRuleFiles on: only project-rules-dir rules are sent, mappings never', () => {
    const manifest = buildContextManifest(input({ mode: 'code' }));
    expect(section(manifest, 'rules').placement).toBe('aider-context');
    expect(section(manifest, 'files').placement).toBe('aider-context');
    expect(outcomes(manifest, 'rules')).toEqual([
      ['~/.aider-desk/rules/global.md', 'none', 'aider-mode'],
      ['AGENTS.md', 'none', 'aider-mode'],
      ['.aider-desk/rules/project.md', 'content', undefined],
    ]);
    expect(outcomes(manifest, 'mappings')).toEqual([['.aider-desk/mappings/map.md', 'none', 'aider-mode']]);
    expect(section(manifest, 'files').entries.every((entry) => entry.delivery === 'content')).toBe(true);
  });

  it('Aider mode with addRuleFiles off: project-rules-dir rules are not sent', () => {
    const manifest = buildContextManifest(input({ mode: 'ask', addRuleFiles: false }));
    expect(outcomes(manifest, 'rules')).toEqual([
      ['~/.aider-desk/rules/global.md', 'none', 'aider-mode'],
      ['AGENTS.md', 'none', 'aider-mode'],
      ['.aider-desk/rules/project.md', 'none', 'aider-rule-files-disabled'],
    ]);
  });

  it('unticked entries are not sent, and unselected takes precedence over every other reason', () => {
    const manifest = buildContextManifest(
      input({
        mode: 'code',
        addRuleFiles: false,
        disabledRuleFiles: ['.aider-desk/rules/project.md'],
        disabledMappingFiles: ['.aider-desk/mappings/map.md'],
        contextFiles: [{ path: 'src/edit.ts', disabled: true }],
      }),
    );
    const rule = section(manifest, 'rules').entries.find((entry) => entry.path === '.aider-desk/rules/project.md')!;
    expect(rule).toMatchObject({ selected: false, delivery: 'none', notSentReason: 'unselected' });
    expect(section(manifest, 'mappings').entries[0]).toMatchObject({ selected: false, delivery: 'none', notSentReason: 'unselected' });
    expect(section(manifest, 'files').entries[0]).toMatchObject({ selected: false, delivery: 'none', notSentReason: 'unselected' });
  });

  it('applies status to a selected mapping entry', () => {
    const manifest = buildContextManifest(input({ mappingStatuses: { '.aider-desk/mappings/map.md': { kind: 'stale', message: 'outdated' } } }));
    expect(section(manifest, 'mappings').entries[0]).toMatchObject({ status: { kind: 'stale', message: 'outdated' } });
  });

  it('does not apply status to an unselected mapping entry', () => {
    const manifest = buildContextManifest(
      input({
        disabledMappingFiles: ['.aider-desk/mappings/map.md'],
        mappingStatuses: { '.aider-desk/mappings/map.md': { kind: 'over-budget' } },
      }),
    );
    expect(section(manifest, 'mappings').entries[0]).not.toHaveProperty('status');
  });

  it('includes mapping notices only when non-empty', () => {
    expect(section(buildContextManifest(input()), 'mappings')).not.toHaveProperty('notices');
    expect(section(buildContextManifest(input({ mappingNotices: ['generator failed'] })), 'mappings')).toMatchObject({ notices: ['generator failed'] });
  });

  it('applies truncated status to a context file', () => {
    const manifest = buildContextManifest(input({ fileStatuses: { 'src/edit.ts': { kind: 'truncated', message: 'too long' } } }));
    expect(section(manifest, 'files').entries.find((entry) => entry.path === 'src/edit.ts')).toMatchObject({
      status: { kind: 'truncated', message: 'too long' },
    });
  });

  it('sets notSentReason exactly when delivery is none', () => {
    for (const manifest of [buildContextManifest(input()), buildContextManifest(input({ mode: 'code', addRuleFiles: false }))]) {
      for (const entry of manifest.sections.flatMap((candidate) => candidate.entries)) {
        expect(entry.delivery === 'none').toBe(entry.notSentReason !== undefined);
      }
    }
  });

  it('lists a path that is both a rule and a context file only under rules', () => {
    const manifest = buildContextManifest(
      input({ contextFiles: [{ path: `${BASE}/AGENTS.md`, readOnly: true }, { path: `${HOME}/.aider-desk/rules/global.md` }, { path: 'src/edit.ts' }] }),
    );
    expect(section(manifest, 'rules').entries.map((entry) => entry.path)).toEqual([
      '~/.aider-desk/rules/global.md',
      'AGENTS.md',
      '.aider-desk/rules/project.md',
    ]);
    expect(section(manifest, 'files').entries.map((entry) => entry.path)).toEqual(['src/edit.ts']);
  });

  it('gives display paths project-relative, ~/ under home, otherwise absolute', () => {
    const manifest = buildContextManifest(input({ contextFiles: [{ path: `${BASE}/src/abs.ts` }, { path: `${HOME}/notes/n.md` }, { path: '/etc/hosts' }] }));
    expect(section(manifest, 'files').entries.map((entry) => entry.displayPath)).toEqual(['src/abs.ts', '~/notes/n.md', '/etc/hosts']);
    expect(section(manifest, 'rules').entries.map((entry) => entry.displayPath)).toEqual([
      '~/.aider-desk/rules/global.md',
      'AGENTS.md',
      '.aider-desk/rules/project.md',
    ]);
    expect(toDisplayPath('src/a.ts', BASE, HOME)).toBe('src/a.ts');
    expect(toDisplayPath('~/x.md', BASE, HOME)).toBe('~/x.md');
  });
});
