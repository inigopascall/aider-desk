import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepositoryMappingsManager } from '../mappings-manager';

vi.mock('@/logger', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { default: logger, logger };
});

type ManagerOptions = ConstructorParameters<typeof RepositoryMappingsManager>[0];
type Settings = {
  repositoryMappings: {
    autoRegenerate: boolean;
    outlineDescriptions: boolean;
    laravelEnabled: boolean;
    laravelCommandTemplate?: string;
    outlineRules?: string[];
  };
  taskNavigation: { summaryModel: string };
  taskSettings: Record<string, unknown>;
};

const managers: RepositoryMappingsManager[] = [];
const directories: string[] = [];

const setup = async (
  configuration: Settings,
  generate?: ManagerOptions['generate'],
  projectManager?: ManagerOptions['projectManager'],
  projectRules: string[] = [],
) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mappings-'));
  directories.push(directory);
  const store = { getSettings: () => configuration, getProjectSettings: () => ({ outlineRules: projectRules }) } as unknown as ManagerOptions['store'];
  const projects = projectManager ?? ({ getProjects: () => [] } as unknown as ManagerOptions['projectManager']);
  const eventManager = { sendRepositoryMappingsUpdated: vi.fn() } as unknown as ManagerOptions['eventManager'];
  const modelManager = {} as unknown as ManagerOptions['modelManager'];
  const manager = new RepositoryMappingsManager({ store, projectManager: projects, modelManager, eventManager, generate });
  managers.push(manager);
  return { directory, manager, configuration };
};

const settings = (overrides: Partial<Settings['repositoryMappings']> = {}): Settings => {
  return {
    repositoryMappings: { autoRegenerate: false, outlineDescriptions: false, laravelEnabled: false, outlineRules: [], ...overrides },
    taskNavigation: { summaryModel: 'p/m' },
    taskSettings: {},
  };
};

const writeFiles = async (directory: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
};

const laravelJson = () => {
  return JSON.stringify({
    php: '8.4',
    laravel: '13.0',
    error: null,
    sections: {
      routes: { ok: true, data: [{ method: 'GET|HEAD', uri: 'users', action: 'App\\Http\\Controllers\\UserController@index', middleware: ['api'] }] },
      schema: { ok: true, data: { driver: 'mysql', connection: 'mysql', tables: {} } },
      models: { ok: false, error: 'boom' },
    },
  });
};

const laravelSetup = async () => {
  const json = laravelJson();
  const template = `cat >/dev/null && printf '%s' '${json}'`;
  const result = await setup(settings({ laravelEnabled: true, laravelCommandTemplate: template }));
  await writeFiles(result.directory, { 'composer.json': JSON.stringify({ require: { 'laravel/framework': '^13.0' } }) });
  return result;
};

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.dispose();
  }
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('RepositoryMappingsManager', () => {
  it('generates and incrementally updates an outline', async () => {
    const { directory, manager } = await setup(settings());
    await writeFiles(directory, { 'src/a.ts': '', 'index.ts': '' });
    let state = await manager.runGenerators(directory, false);
    const file = path.join(directory, '.aider-desk/mappings/outline.md');
    const first = await fs.readFile(file, 'utf8');
    expect(first).toContain('./\n');
    expect(first).toContain('src/\n  a.ts');
    expect(state.generators.outline.files['.aider-desk/mappings/outline.md'].status).toBe('fresh');
    await manager.runGenerators(directory, false);
    expect(await fs.readFile(file, 'utf8')).toBe(first);
    await writeFiles(directory, { 'src/b.ts': '' });
    state = await manager.runGenerators(directory, false);
    expect(await fs.readFile(file, 'utf8')).toContain('a.ts');
    expect(await fs.readFile(file, 'utf8')).toContain('b.ts');
    expect(state.generators.outline.files['.aider-desk/mappings/outline.md'].status).toBe('fresh');
  });

  it('notifies tasks after generating an outline-only mapping', async () => {
    const task = { sendContextManifestUpdated: vi.fn().mockResolvedValue(undefined), updateAgentEstimatedTokens: vi.fn().mockResolvedValue(undefined) };
    const project = { baseDir: '', forEachTask: (callback: (value: typeof task) => void) => callback(task) };
    const { directory, manager } = await setup(settings(), undefined, {
      getProjects: () => [{ ...project, baseDir: directory }],
    } as unknown as ManagerOptions['projectManager']);

    await manager.runGenerators(directory, false);

    expect(task.sendContextManifestUpdated).toHaveBeenCalled();
    expect(task.updateAgentEstimatedTokens).toHaveBeenCalled();
  });

  it('merges global and project outline rules', async () => {
    const { directory, manager } = await setup(settings({ outlineRules: ['src'] }), undefined, undefined, ['!lib']);
    await writeFiles(directory, { 'src/a.ts': '', 'lib/x.ts': '', 'other.ts': '' });
    await manager.runGenerators(directory, false);
    const outline = await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8');
    expect(outline).toContain('src/ (1 folders, 1 files)');
    expect(outline).not.toContain('lib/');
  });

  it('uses generated and README descriptions', async () => {
    const generate = vi.fn(async (_m: string, _b: string, _s: string, prompt: string) =>
      JSON.stringify(Object.fromEntries([...prompt.matchAll(/^## (.+)$/gm)].map((m) => [m[1], `about ${m[1]}`]))),
    );
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['docs'] }), generate);
    await writeFiles(directory, { 'src/a.ts': '', 'lib/x.ts': '', 'docs/README.md': '# Docs\n\nProject documentation lives here. More.', 'docs/guide.md': '' });
    await manager.runGenerators(directory, false);
    const outline = await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8');
    expect(outline).toContain('src/ — about src');
    expect(outline).toContain('docs/ — Project documentation lives here.');
    expect(generate.mock.calls.some((call) => call[3].includes('## docs'))).toBe(false);
    generate.mockClear();
    await writeFiles(directory, { 'src/b.ts': '' });
    await manager.runGenerators(directory, false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][3]).toContain('## src');
    expect(generate.mock.calls[0][3]).not.toContain('## lib');
  });

  it('exports Laravel mappings', async () => {
    const { directory, manager } = await laravelSetup();
    const state = await manager.runGenerators(directory, false);
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/routes.md'), 'utf8')).toContain('UserController@index');
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/schema.md'), 'utf8')).toBeTruthy();
    await expect(fs.access(path.join(directory, '.aider-desk/mappings/models.md'))).rejects.toThrow();
    expect(state.generators.laravel.message).toContain('models.md: boom');
  }, 20000);

  it('marks existing Laravel files stale after export failure', async () => {
    const { directory, manager, configuration } = await laravelSetup();
    await manager.runGenerators(directory, false);
    const file = path.join(directory, '.aider-desk/mappings/routes.md');
    const previous = await fs.readFile(file, 'utf8');
    configuration.repositoryMappings.laravelCommandTemplate = 'cat >/dev/null; echo nope >&2; exit 3';
    const state = await manager.runGenerators(directory, true);
    expect(await fs.readFile(file, 'utf8')).toBe(previous);
    expect(state.generators.laravel.files['.aider-desk/mappings/routes.md'].status).toBe('stale');
  }, 20000);

  it('does not run Laravel without composer.json', async () => {
    const { directory, manager } = await setup(settings({ laravelEnabled: true }));
    const state = await manager.runGenerators(directory, false);
    expect(state.generators.laravel).toBeUndefined();
    expect(state.generators.outline.message).toBeUndefined();
  });

  it('regenerates successfully or returns the export error', async () => {
    const clean = await setup(settings());
    expect((await clean.manager.regenerate(clean.directory)).success).toBe(true);
    const result = await laravelSetup();
    await result.manager.runGenerators(result.directory, false);
    result.configuration.repositoryMappings.laravelCommandTemplate = 'cat >/dev/null; echo nope >&2; exit 3';
    const regenerated = await result.manager.regenerate(result.directory);
    expect(regenerated.success).toBe(false);
    expect(regenerated.error).toContain('exited 3');
  }, 20000);

  it('rebuilds on outline rule changes during an unforced run', async () => {
    const { directory, manager, configuration } = await setup(settings());
    await writeFiles(directory, { 'src/a.ts': '', 'other.ts': '' });
    await manager.runGenerators(directory, false);
    configuration.repositoryMappings.outlineRules = ['src'];
    await manager.runGenerators(directory, false);
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8')).toContain('src/ (1 folders, 1 files)');
  });

  it('sends collapsed subtree paths and excerpts in description prompts', async () => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => '{"src":"source"}');
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['src'] }), generate);
    await writeFiles(directory, { 'src/a.ts': 'const source = true;', 'src/nested/b.ts': '' });
    await manager.runGenerators(directory, false);
    expect(generate.mock.calls[0][3]).toContain('## src');
    expect(generate.mock.calls[0][3]).toContain('nested/b.ts');
    expect(generate.mock.calls[0][3]).toContain('--- a.ts\nconst source = true;');
  });

  it('prefers README descriptions over model descriptions', async () => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => '{"docs":"model"}');
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['src'] }), generate);
    await writeFiles(directory, { 'docs/README.md': '# Docs\n\nReadme description.', 'docs/a.ts': '' });
    await manager.runGenerators(directory, false);
    const outline = await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8');
    expect(outline).toContain('docs/ — Readme description.');
    expect(generate).not.toHaveBeenCalled();
  });

  it('reuses unchanged description cache entries', async () => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => '{"src":"source"}');
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['src'] }), generate);
    await writeFiles(directory, { 'src/a.ts': '' });
    await manager.runGenerators(directory, false);
    generate.mockClear();
    await manager.runGenerators(directory, true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('invalidates only the changed description cache entry', async () => {
    const generate = vi.fn(async (_m: string, _b: string, _s: string, prompt: string) =>
      JSON.stringify(Object.fromEntries([...prompt.matchAll(/^## (.+)$/gm)].map((m) => [m[1], 'source']))),
    );
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['src'] }), generate);
    await writeFiles(directory, { 'src/a.ts': '', 'lib/b.ts': '' });
    await manager.runGenerators(directory, false);
    generate.mockClear();
    await writeFiles(directory, { 'src/c.ts': '' });
    await manager.runGenerators(directory, false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][3]).toContain('## src');
  });

  it('keeps excluded paths out of generated requests', async () => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => '{}');
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['!private'] }), generate);
    await writeFiles(directory, { 'private/secret.ts': '', 'src/a.ts': '' });
    await manager.runGenerators(directory, false);
    expect(generate.mock.calls.every((call) => !call[3].includes('private'))).toBe(true);
  });

  it.each([
    ['README without punctuation', 'Project documentation describes this extension'],
    [
      'punctuated first sentence after twenty one words',
      'Our project contains words that make the first sentence long enough to exceed the short README threshold while still ending here. More documentation follows.',
    ],
    ['This extension sentence', 'This extension provides useful project documentation. More documentation follows.'],
    ['It sentence', 'It provides useful project documentation. More documentation follows.'],
  ])('sends %s README context before source excerpts', async (_name, readme) => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => JSON.stringify({ docs: 'Generated purpose.' }));
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['docs'] }), generate);
    await writeFiles(directory, {
      'docs/A.ts': 'const a = true;',
      'docs/B.ts': 'const b = true;',
      'docs/C.ts': 'const c = true;',
      'docs/README.md': readme,
    });
    await manager.runGenerators(directory, false);
    const prompt = generate.mock.calls[0][3];
    expect(prompt).toContain(`--- README.md\n${readme}`);
    expect(prompt.indexOf(`--- README.md\n${readme}`)).toBeLessThan(prompt.indexOf('--- A.ts'));
    expect(prompt).not.toContain('--- C.ts');
    const outline = await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8');
    expect(outline).toContain('docs/ — Generated purpose.');
  });

  it('includes a long README excerpt in the model request', async () => {
    const readme = `This documentation ${'extraordinarily'.repeat(12)}.`;
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => JSON.stringify({ docs: 'Generated purpose.' }));
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['docs'] }), generate);
    await writeFiles(directory, { 'docs/A.ts': '', 'docs/README.md': readme });
    await manager.runGenerators(directory, false);
    expect(generate.mock.calls[0][3]).toContain(`--- README.md\n${readme}`);
    expect(readme.length).toBeGreaterThan(160);
  });

  it('accepts a short punctuated README with long words without calling the model', async () => {
    const readme = `Documentation ${'extraordinarily'.repeat(12)}.`;
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => JSON.stringify({ docs: 'Generated purpose.' }));
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['docs'] }), generate);
    await writeFiles(directory, { 'docs/A.ts': '', 'docs/README.md': readme });
    await manager.runGenerators(directory, false);
    expect(generate).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8')).toContain(`docs/ — ${readme}`);
    expect(readme.length).toBeGreaterThan(160);
  });

  it('retries missing project-agent descriptions after a failed partial response', async () => {
    const generate = vi
      .fn<NonNullable<ManagerOptions['generate']>>()
      .mockResolvedValueOnce(JSON.stringify({ 'global-agents': 'Global rules.' }))
      .mockResolvedValueOnce(JSON.stringify({ 'project-agents': 'Project rules.' }));
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['global-agents/', 'project-agents/'] }), generate);
    await writeFiles(directory, { 'global-agents/editor/config.json': '{}', 'project-agents/api/config.json': '{}' });
    const first = await manager.runGenerators(directory, false);
    const cache = JSON.parse(await fs.readFile(path.join(directory, '.aider-desk/mappings/.outline-descriptions.json'), 'utf8'));
    expect(Object.keys(cache.dirs)).toEqual(['global-agents']);
    expect(first.generators.outline.message).toContain('Missing descriptions for: project-agents');
    expect(first.generators.outline.lastFailureAt).toBeTruthy();
    expect(first.generators.outline.fingerprint).toBeUndefined();
    const stateFile = path.join(directory, '.aider-desk/mappings/.state.json');
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    saved.generators.outline.lastFailureAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await fs.writeFile(stateFile, JSON.stringify(saved));
    const second = await manager.runGenerators(directory, false);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][3]).toContain('project-agents');
    expect(generate.mock.calls[1][3]).not.toContain('global-agents');
    expect(second.generators.outline.message).toBeUndefined();
    expect(second.generators.outline.lastFailureAt).toBeUndefined();
    const repairedCache = JSON.parse(await fs.readFile(path.join(directory, '.aider-desk/mappings/.outline-descriptions.json'), 'utf8'));
    expect(Object.keys(repairedCache.dirs)).toEqual(['global-agents', 'project-agents']);
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8')).toContain(
      'project-agents/ — Project rules. (1 folders, 1 files)',
    );
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['empty object', '{}'],
  ])('treats %s as a failed description response', async (_name, response) => {
    const generate = vi.fn<NonNullable<ManagerOptions['generate']>>(async () => response);
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['docs'] }), generate);
    await writeFiles(directory, { 'docs/config.json': '{}' });
    const state = await manager.runGenerators(directory, false);
    expect(state.generators.outline.message).toContain('Missing descriptions for: docs');
    expect(state.generators.outline.fingerprint).toBeUndefined();
  });

  it('does not permanently skip a forced partial refresh after prior success', async () => {
    const generate = vi
      .fn<NonNullable<ManagerOptions['generate']>>()
      .mockResolvedValueOnce(JSON.stringify({ global: 'Global rules.', project: 'Project rules.' }))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(JSON.stringify({ project: 'Project rules repaired.' }));
    const { directory, manager } = await setup(settings({ outlineDescriptions: true, outlineRules: ['global', 'project'] }), generate);
    await writeFiles(directory, { 'global/config.json': '{}', 'project/config.json': '{}' });
    await manager.runGenerators(directory, false);
    const cache = path.join(directory, '.aider-desk/mappings/.outline-descriptions.json');
    const descriptions = JSON.parse(await fs.readFile(cache, 'utf8'));
    delete descriptions.dirs.project;
    await fs.writeFile(cache, JSON.stringify(descriptions));
    const failed = await manager.runGenerators(directory, true);
    expect(failed.generators.outline.fingerprint).toBeUndefined();
    expect(failed.generators.outline.message).toContain('Missing descriptions for: project');
    const stateFile = path.join(directory, '.aider-desk/mappings/.state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.generators.outline.lastFailureAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await fs.writeFile(stateFile, JSON.stringify(state));
    const repaired = await manager.runGenerators(directory, false);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(repaired.generators.outline.message).toBeUndefined();
    expect(await fs.readFile(path.join(directory, '.aider-desk/mappings/outline.md'), 'utf8')).toContain('project/ — Project rules repaired.');
  });
});
