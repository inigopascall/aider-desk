import { createHash } from 'crypto';

import { describe, expect, it } from 'vitest';
import { getRepositoryMappingsSettings } from '@common/types';

import {
  applyOutlineRules,
  buildDescriptionPrompt,
  directoryFingerprint,
  groupOutlineDirectories,
  isOutlinePath,
  outlineFingerprint,
  parseDescriptionResponse,
  readmeDescription,
  renderOutline,
} from '../outline';

describe('outline', () => {
  it.each(['src/main/agent/agent.ts', 'README.md', '.gitignore', 'routes/api.php', 'src/.eslintrc'])('keeps %s', (file) => {
    expect(isOutlinePath(file)).toBe(true);
  });

  it.each([
    'src/__tests__/a.ts',
    'a.test.ts',
    'x.spec.tsx',
    'tests/Feature/A.php',
    '.github/workflows/ci.yml',
    'node_modules/x/index.js',
    'lang/en/auth.php',
    'src/locales/en.json',
    'logo.PNG',
    'package-lock.json',
    'composer.lock',
    'storage/logs/x.log',
    'public/build/app.js',
    'dist/a.js.map',
  ])('excludes %s', (file) => {
    expect(isOutlinePath(file)).toBe(false);
  });

  it('groups directories', () => {
    expect(groupOutlineDirectories(['b/z.ts', 'a/y.ts', 'a/x.ts', 'x.ts', 'a/x.ts', 'a/nested/z.ts'])).toEqual([
      { dir: '', files: ['x.ts'] },
      { dir: 'a', files: ['x.ts', 'y.ts'] },
      { dir: 'a/nested', files: ['z.ts'] },
      { dir: 'b', files: ['z.ts'] },
    ]);
  });

  it('excludes folders and descendants without changing its input', () => {
    const directories = groupOutlineDirectories(['src/a.ts', 'src/nested/b.ts', 'lib/c.ts', 'other.ts']);
    const before = structuredClone(directories);
    expect(applyOutlineRules(directories, ['!src']).directories).toEqual([
      { dir: '', files: ['other.ts'] },
      { dir: 'lib', files: ['c.ts'] },
    ]);
    expect(directories).toEqual(before);
  });

  it('collapses the outermost matching folder and counts only folders with outline files', () => {
    const directories = groupOutlineDirectories(['src/a.ts', 'src/nested/deep/b.ts']);
    const before = structuredClone(directories);
    expect(applyOutlineRules(directories, ['src/nested', 'src']).directories).toEqual([
      { dir: 'src', files: ['a.ts', 'nested/deep/b.ts'], collapsed: true, folderCount: 2, fileCount: 2 },
    ]);
    expect(directories).toEqual(before);
  });

  it('collapses direct children and synthesizes folders without their own files', () => {
    const directories = groupOutlineDirectories([
      'project-agents/index.json',
      'project-agents/api/agent.ts',
      'project-agents/api/nested/config.ts',
      'project-agents/web/sub/agent.ts',
    ]);
    expect(applyOutlineRules(directories, ['project-agents/*/']).directories).toEqual([
      { dir: 'project-agents', files: ['index.json'] },
      { dir: 'project-agents/api', files: ['agent.ts', 'nested/config.ts'], collapsed: true, folderCount: 2, fileCount: 2 },
      { dir: 'project-agents/web', files: ['sub/agent.ts'], collapsed: true, folderCount: 1, fileCount: 1 },
    ]);
  });

  it('matches unanchored names at any depth but anchors slash patterns', () => {
    const directories = groupOutlineDirectories(['feature/a.ts', 'src/feature/b.ts', 'x/src/feature/c.ts']);
    expect(applyOutlineRules(directories, ['feature']).directories.every((directory) => directory.collapsed)).toBe(true);
    expect(
      applyOutlineRules(directories, ['/feature'])
        .directories.filter((directory) => directory.collapsed)
        .map(({ dir }) => dir),
    ).toEqual(['feature']);
    expect(
      applyOutlineRules(directories, ['src/feature'])
        .directories.filter((directory) => directory.collapsed)
        .map(({ dir }) => dir),
    ).toEqual(['src/feature']);
  });

  it('groups paths in segment order and leaves an unmatched or empty rule unchanged', () => {
    const paths = [
      'root.ts',
      'task/migrations/001.ts',
      'cursor/src/proto/agent.ts',
      'cursor-sdk/index.ts',
      'task-navigation/index.ts',
      'cursor/index.ts',
      'task/index.ts',
    ];
    const directories = groupOutlineDirectories(paths);
    expect(directories.map((directory) => directory.dir)).toEqual([
      '',
      'cursor',
      'cursor/src/proto',
      'cursor-sdk',
      'task',
      'task/migrations',
      'task-navigation',
    ]);
    expect(applyOutlineRules(directories, [])).toEqual({ directories, rulesApplied: false });
    expect(applyOutlineRules(directories, ['missing'])).toEqual({ directories, rulesApplied: false });
    expect(applyOutlineRules(directories, ['cursor'])).toEqual({
      directories: [
        { dir: '', files: ['root.ts'] },
        { dir: 'cursor', files: ['index.ts', 'src/proto/agent.ts'], collapsed: true, folderCount: 2, fileCount: 2 },
        { dir: 'cursor-sdk', files: ['index.ts'] },
        { dir: 'task', files: ['index.ts'] },
        { dir: 'task/migrations', files: ['001.ts'] },
        { dir: 'task-navigation', files: ['index.ts'] },
      ],
      rulesApplied: true,
    });
  });

  it('applies unanchored and anchored file exclusions without mutating input', () => {
    const directories = groupOutlineDirectories(['_ide_helper.php', 'src/_ide_helper.php', 'src/a.ts', 'src/nested/_ide_helper.php', 'src/other/b.ts']);
    const before = structuredClone(directories);
    expect(applyOutlineRules(directories, ['!_ide_helper.php']).directories).toEqual([
      { dir: '', files: [] },
      { dir: 'src', files: ['a.ts'] },
      { dir: 'src/other', files: ['b.ts'] },
    ]);
    expect(applyOutlineRules(directories, ['!/_ide_helper.php']).directories).toEqual([
      { dir: '', files: [] },
      { dir: 'src', files: ['_ide_helper.php', 'a.ts'] },
      { dir: 'src/nested', files: ['_ide_helper.php'] },
      { dir: 'src/other', files: ['b.ts'] },
    ]);
    expect(applyOutlineRules(groupOutlineDirectories(['only/_ide_helper.php']), ['!_ide_helper.php']).directories).toEqual([]);
    expect(applyOutlineRules(directories, ['!_ide_helper.php/']).directories).toEqual(directories);
    expect(applyOutlineRules(directories, ['_ide_helper.php']).directories).toEqual(directories);
    expect(directories).toEqual(before);
  });

  it('retains explicit parent folders and counts only retained files and contributing folders', () => {
    const directories = [
      { dir: 'src', files: [] },
      { dir: 'src/nested', files: ['_ide_helper.php'] },
      { dir: 'src/other', files: ['b.ts'] },
      { dir: 'src', files: ['a.ts', '_ide_helper.php'] },
    ];
    expect(applyOutlineRules(directories, ['src/', '!_ide_helper.php']).directories).toEqual([
      { dir: 'src', files: ['a.ts', 'other/b.ts'], collapsed: true, folderCount: 2, fileCount: 2 },
    ]);
    expect(
      applyOutlineRules(
        [
          { dir: 'parent', files: [] },
          { dir: 'parent/child', files: ['a.ts'] },
        ],
        ['!missing'],
      ).directories,
    ).toEqual([
      { dir: 'parent', files: [] },
      { dir: 'parent/child', files: ['a.ts'] },
    ]);
  });

  it('ignores unmatched, empty and comment rules', () => {
    const directories = groupOutlineDirectories(['src/a.ts']);
    expect(applyOutlineRules(directories, ['missing', '', ' # comment', '!', '/', '!/'])).toEqual({ directories, rulesApplied: false });
  });

  it.each([
    ['src', '!src/private'],
    ['!src/private', 'src'],
  ])('gives exclusions precedence with rules %s and %s', (first, second) => {
    const directories = groupOutlineDirectories(['src/a.ts', 'src/private/b.ts', 'src/private/nested/c.ts']);
    expect(applyOutlineRules(directories, [first, second]).directories).toEqual([
      { dir: 'src', files: ['a.ts'], collapsed: true, folderCount: 1, fileCount: 1 },
    ]);
    expect(applyOutlineRules(directories, ['src', '!src']).directories).toEqual([]);
  });

  it('supports question marks, stars and globstars', () => {
    const directories = groupOutlineDirectories(['src/feature/a.ts', 'src/deep/feature/b.ts', 'src/deep/more/feature/c.ts']);
    expect(applyOutlineRules(directories, ['src/**/feature']).directories.every(({ collapsed }) => collapsed)).toBe(true);
    expect(
      applyOutlineRules(directories, ['src/*/feature'])
        .directories.filter(({ collapsed }) => collapsed)
        .map(({ dir }) => dir),
    ).toEqual(['src/deep/feature']);
    expect(applyOutlineRules(groupOutlineDirectories(['app/a.ts', 'apps/b.ts']), ['app?']).directories.filter(({ collapsed }) => collapsed)).toEqual([
      { dir: 'apps', files: ['b.ts'], collapsed: true, folderCount: 1, fileCount: 1 },
    ]);
  });

  it('escapes regular expression characters and literal rule prefixes', () => {
    const directories = groupOutlineDirectories(['a.b/a.ts', 'axb/b.ts', 'literal*/c.ts', '!literal/d.ts']);
    const collapsed = applyOutlineRules(directories, ['a.b', 'literal\\*', '\\!literal']).directories.filter((directory) => directory.collapsed);
    expect(collapsed.map(({ dir }) => dir).sort()).toEqual(['!literal', 'a.b', 'literal*']);
  });

  it('normalizes outline rules', () => {
    const rules = [null, 42, '  src/  ', '', '# comment', '   # comment', ' !vendor ', '\\#literal'] as unknown as string[];
    expect(getRepositoryMappingsSettings({ repositoryMappings: { outlineRules: rules } }).outlineRules).toEqual(['src/', '!vendor', '\\#literal']);
    expect(getRepositoryMappingsSettings().outlineRules).toEqual([]);
    expect(getRepositoryMappingsSettings({ repositoryMappings: { outlineRules: 42 as unknown as string[] } }).outlineRules).toEqual([]);
  });

  it('fingerprints directories, subtree paths and outline rules', () => {
    const directory = { dir: 'a', files: ['x.ts'] };
    expect(directoryFingerprint(directory)).toBe(directoryFingerprint({ ...directory }));
    expect(directoryFingerprint(directory)).not.toBe(directoryFingerprint({ dir: 'a', files: ['y.ts'] }));
    const collapsed = { dir: 'a', files: ['nested/y.ts', 'x.ts'], collapsed: true };
    const expected = createHash('sha1').update('collapsed:nested/y.ts\nx.ts').digest('hex');
    expect(directoryFingerprint(collapsed)).toBe(expected);
    expect(directoryFingerprint(collapsed)).not.toBe(directoryFingerprint({ ...collapsed, collapsed: false }));
    expect(directoryFingerprint(collapsed)).not.toBe(directoryFingerprint({ ...collapsed, files: ['other/y.ts', 'x.ts'] }));
    expect(outlineFingerprint([directory], JSON.stringify({ rules: [] }))).not.toBe(outlineFingerprint([directory], JSON.stringify({ rules: ['a'] })));
  });

  it('renders with and without descriptions', () => {
    const options = {
      header: 'H',
      directories: [{ dir: '', files: ['a.ts'] }],
      descriptions: { '': 'root' },
      maxTokens: 999,
      countTokens: (text: string) => text.length,
    };
    expect(renderOutline(options).text).toBe(
      '# Codebase outline\nH\nEvery source directory is listed with its files. Tests, locales, generated files and assets are left out; search the code for anything more.\n\n./ — root\n  a.ts\n',
    );
    expect(renderOutline({ ...options, descriptions: {} }).text).toContain('./\n');
  });

  it('includes the budget note only for budget-driven collapses and matches the report fixture', () => {
    const options = {
      header: 'H',
      directories: [{ dir: '', files: ['a.ts'] }],
      descriptions: {},
      maxTokens: 999,
      countTokens: (text: string) => text.length,
    };
    expect(renderOutline(options).text).toBe(
      '# Codebase outline\nH\nEvery source directory is listed with its files. Tests, locales, generated files and assets are left out; search the code for anything more.\n\n./\n  a.ts\n',
    );
    const rendered = renderOutline({ ...options, directories: [{ dir: 'one', files: ['a.ts', 'b.ts'] }], maxTokens: 1 });
    expect(rendered.text).toBe(
      '# Codebase outline\nH\nEvery source directory is listed with its files. Tests, locales, generated files and assets are left out; search the code for anything more.\nSome large folders show only a file count to fit the size limit; search the code for their files.\n\none/\n  (2 files)\n',
    );
    expect(renderOutline({ ...options, maxTokens: 999 }).text).not.toContain('Some large folders show only a file count');
    expect(renderOutline({ ...options, ...applyOutlineRules(groupOutlineDirectories(['one/a.ts', 'one/b.ts']), ['one']), maxTokens: 999 }).text).not.toContain(
      'Some large folders show only a file count',
    );
  });

  it('collapses both directories when the budget note overhead requires it', () => {
    const long = 'x'.repeat(200);
    const directories = [
      { dir: 'one', files: [`${long}a.ts`, `${long}b.ts`] },
      { dir: 'two', files: [`${long}c.ts`, `${long}d.ts`] },
    ];
    const countTokens = (text: string) => text.length + (text.includes('Some large folders show only a file count') ? 500 : 0);
    const rendered = renderOutline({ header: 'H', directories, descriptions: {}, maxTokens: 900, countTokens });
    expect(rendered.collapsed).toEqual(['one', 'two']);
  });

  it('renders rule summaries without listing their subtree', () => {
    const result = applyOutlineRules(groupOutlineDirectories(['agents/a.ts', 'agents/sub/b.ts']), ['agents']);
    const rendered = renderOutline({
      header: 'H',
      ...result,
      descriptions: { agents: 'API agents' },
      maxTokens: 999,
      countTokens: (text) => text.length,
    });
    expect(rendered.text).toContain('Some folders are summarised or left out by outline rules; search the code for their contents.');
    expect(rendered.text).toContain('\n\nagents/ — API agents (2 folders, 2 files)\n');
    expect(rendered.text).not.toContain('a.ts');
    expect(rendered.collapsed).toEqual([]);
  });

  it('does not charge hidden subtree file names to the render budget', () => {
    const result = applyOutlineRules(groupOutlineDirectories([`agents/${'x'.repeat(1000)}.ts`, 'normal/a.ts', 'normal/b.ts']), ['agents']);
    const options = { header: 'H', ...result, descriptions: {}, maxTokens: 9999, countTokens: (text: string) => text.length };
    const budget = renderOutline(options).text.length;
    const rendered = renderOutline({ ...options, maxTokens: budget });
    expect(rendered.collapsed).toEqual([]);
    expect(rendered.text).toContain('normal/\n  a.ts, b.ts');
  });

  it('collapses the largest non-rule directory first and leaves single files intact', () => {
    const result = renderOutline({
      header: 'H',
      directories: [
        { dir: 'one', files: ['a.ts'] },
        { dir: 'two', files: ['a.ts', 'b.ts'] },
        { dir: 'three', files: ['a.ts', 'b.ts', 'c.ts'] },
      ],
      descriptions: {},
      maxTokens: 1,
      countTokens: (text) => text.length,
    });
    expect(result.collapsed).toEqual(['three', 'two']);
    expect(result.text).toContain('one/\n  a.ts');
  });

  it('reads and cleans README descriptions', () => {
    expect(readmeDescription('# Title\n\n[![CI](https://x/badge.svg)](https://x)\n\nA useful tool. More text.')).toBe('A useful tool.');
    expect(readmeDescription('Short, punctuated text! Is it useful?')).toBe('Short, punctuated text!');
    expect(readmeDescription('Useful? More.')).toBe('Useful?');
    expect(
      readmeDescription('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.'),
    ).toBeTruthy();
    expect(
      readmeDescription(
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty one.',
      ),
    ).toBeUndefined();
    expect(readmeDescription('This /It is not a description.')).toBeUndefined();
    expect(readmeDescription('Unpunctuated title')).toBeUndefined();
    expect(
      readmeDescription(
        'Documentation has a deliberately long first sentence with enough words to exceed the accepted length limit even though it is followed by a short one. Short.',
      ),
    ).toBeUndefined();
    expect(readmeDescription(`${'longword '.repeat(25)}.`)).toBeUndefined();
    expect(readmeDescription('Runs [DOOM](https://en.wikipedia.org/wiki/Doom_(1993_video_game)).')).toBe('Runs DOOM.');
    expect(readmeDescription('A useful\ntool.')).toBe('A useful tool.');
    expect(readmeDescription('```\nignored.\n```\n\nVisible.')).toBe('Visible.');
    expect(readmeDescription('# Only')).toBeUndefined();
    expect(readmeDescription('---\nverified: 2026-10-27\n---\n\n# Title\n\nTopic maps for tasks. More.')).toBe('Topic maps for tasks.');
    expect(readmeDescription('# X\n\n> ⚠️ **Warning** banner\n\nReal text here.')).toBe('Real text here.');
    expect(readmeDescription('Uses [Tool](https://x.dev) with **bold** words. More.')).toBe('Uses Tool with bold words.');
    expect(readmeDescription('Uses [Tool](https://x.dev/a_(b_(c))).')).toBe('Uses Tool.');
    const longSentence = `Documentation ${'extraordinarily'.repeat(12)}.`;
    expect(readmeDescription(longSentence)).toBe(longSentence);
    expect(readmeDescription('It is rejected separately.')).toBeUndefined();
  });

  it('parses description responses', () => {
    expect(parseDescriptionResponse('```json\n{".":" root  area ","x":"unknown"}\n```', ['', 'x'])).toEqual({ '': 'root area', x: 'unknown' });
    expect(parseDescriptionResponse('prose {".":"root"} trailing', [''])).toEqual({ '': 'root' });
    expect(parseDescriptionResponse('garbage', [''])).toEqual({});
  });

  it('builds description prompts', () => {
    const request = { dir: '', files: ['a.ts'], excerpts: [{ file: 'a.ts', text: 'const a = 1' }] };
    expect(buildDescriptionPrompt([request]).prompt).toBe('## .\nFiles: a.ts\n--- a.ts\nconst a = 1');
    expect(buildDescriptionPrompt([{ dir: 'src', files: Array.from({ length: 61 }, (_, index) => `f${index}`), excerpts: [] }]).prompt).toContain(', …');
  });
});
