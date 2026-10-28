import { describe, expect, it } from 'vitest';
import { ContextManifestEntry, ContextManifestSection, ContextUsageCategoryId, TokensInfoData } from '@common/types';

import { buildContextFileTokenUsage } from '../context-token-usage';

import { CONTEXT_USAGE_COLORS, getContextUsageDisplay } from '@/components/project/context-usage-layout';

const category = (id: ContextUsageCategoryId, items: Array<{ id: string; tokens: number }>) => ({
  id,
  tokens: items.reduce((sum, item) => sum + item.tokens, 0),
  items: items.map((item) => ({ ...item, label: item.id })),
});

const snapshot = (agentTokens: number, categories: ReturnType<typeof category>[]): TokensInfoData => ({
  baseDir: '/project',
  taskId: 'task',
  chatHistory: { tokens: 0, cost: 0 },
  files: {},
  repoMap: { tokens: 0, cost: 0 },
  systemMessages: { tokens: 0, cost: 0 },
  agent: { tokens: agentTokens, cost: 0 },
  contextBreakdown: { categories, totalTokens: categories.reduce((sum, item) => sum + item.tokens, 0) },
});

const entry = (path: string, options: Partial<Pick<ContextManifestEntry, 'selected' | 'delivery' | 'readOnly' | 'status'>> = {}): ContextManifestEntry => ({
  path,
  displayPath: path,
  readOnly: false,
  selected: true,
  delivery: 'content',
  ...options,
});

const sections = (files: ContextManifestEntry[] = [entry('/project/ro.ts', { readOnly: true }), entry('src/edit.ts')]): ContextManifestSection[] => [
  { id: 'rules', placement: 'system-prompt', entries: [entry('rules.md')] },
  { id: 'mappings', placement: 'messages-after-history', entries: [entry('map.md')] },
  { id: 'files', placement: 'messages-after-history', entries: files },
];

describe('buildContextFileTokenUsage', () => {
  it('scales real breakdowns and reports section, row, colour, and maximum totals', () => {
    const tokensInfo = snapshot(2000, [
      category('rules', [{ id: 'rules.md', tokens: 100 }]),
      category('repoMappings', [{ id: 'map.md', tokens: 200 }]),
      category('readOnlyFiles', [{ id: '/project/ro.ts', tokens: 50 }]),
      category('editableFiles', [{ id: 'src/edit.ts', tokens: 150 }]),
      category('conversation', [{ id: 'conversation', tokens: 500 }]),
    ]);
    const result = buildContextFileTokenUsage(tokensInfo, 'agent', sections(), '/project');

    expect(result.totals).toEqual({ rules: 200, mappings: 400, files: 400 });
    expect(result.entries).toEqual({
      rules: { 'rules.md': { tokens: 200, color: CONTEXT_USAGE_COLORS.rules } },
      mappings: { 'map.md': { tokens: 400, color: CONTEXT_USAGE_COLORS.repoMappings } },
      files: {
        '/project/ro.ts': { tokens: 100, color: CONTEXT_USAGE_COLORS.readOnlyFiles },
        'src/edit.ts': { tokens: 300, color: CONTEXT_USAGE_COLORS.editableFiles },
      },
    });
    expect(result.maxTokens).toBe(400);
    const fileContexts = sections()
      .find((section) => section.id === 'files')!
      .entries.map(({ path, readOnly }) => ({ path, readOnly }));
    const segments = getContextUsageDisplay(tokensInfo, 'agent', fileContexts).segments;
    const fileTotal = segments
      .filter((segment) => segment.id === 'readOnlyFiles' || segment.id === 'editableFiles')
      .reduce((sum, segment) => sum + segment.scaledTokens, 0);
    expect(result.totals.files).toBe(fileTotal);
  });

  it('returns empty totals for absent or incomplete breakdowns and zero totals for empty breakdowns', () => {
    expect(buildContextFileTokenUsage(null, 'agent', sections(), '/project')).toEqual({
      totals: {},
      entries: { rules: {}, mappings: {}, files: {} },
      maxTokens: 0,
    });
    expect(buildContextFileTokenUsage({ ...snapshot(0, []), contextBreakdown: undefined }, 'agent', sections(), '/project')).toEqual({
      totals: {},
      entries: { rules: {}, mappings: {}, files: {} },
      maxTokens: 0,
    });
    expect(buildContextFileTokenUsage(snapshot(0, []), 'agent', sections(), '/project').totals).toEqual({ rules: 0, mappings: 0, files: 0 });
  });

  it('filters unticked, undelivered, and over-budget rows while retaining path-only rows and snapshot headers', () => {
    const result = buildContextFileTokenUsage(
      snapshot(400, [
        category('editableFiles', [
          { id: 'unticked.ts', tokens: 10 },
          { id: 'path.ts', tokens: 10 },
          { id: 'none.ts', tokens: 10 },
          { id: 'over.ts', tokens: 10 },
        ]),
      ]),
      'agent',
      sections([
        entry('unticked.ts', { selected: false }),
        entry('path.ts', { delivery: 'path-only' }),
        entry('none.ts', { delivery: 'none' }),
        entry('over.ts', { status: { kind: 'over-budget' } }),
      ]),
      '/project',
    );
    expect(result.totals).toEqual({ rules: 0, mappings: 0, files: 400 });
    expect(result.entries.files).toEqual({ 'path.ts': { tokens: 100, color: CONTEXT_USAGE_COLORS.editableFiles } });
  });

  it('matches safe absolute, relative, dot, and backslash paths without basename aliases', () => {
    const actual = snapshot(10, [category('readOnlyFiles', [{ id: '/project/src/a.ts', tokens: 10 }])]);
    expect(buildContextFileTokenUsage(actual, 'agent', sections([entry('/project/src/a.ts', { readOnly: true })]), '/project').entries.files).toEqual({
      '/project/src/a.ts': { tokens: 10, color: CONTEXT_USAGE_COLORS.readOnlyFiles },
    });
    const aliases = sections([entry('src\\a.ts', { readOnly: true }), entry('./src/a.ts', { readOnly: true })]);
    const aliasesUsage = buildContextFileTokenUsage(actual, 'agent', aliases, '/project');
    expect(aliasesUsage.entries.files).toEqual({
      'src\\a.ts': { tokens: 10, color: CONTEXT_USAGE_COLORS.readOnlyFiles },
      './src/a.ts': { tokens: 10, color: CONTEXT_USAGE_COLORS.readOnlyFiles },
    });
    const unrelated = sections([entry('other/a.ts', { readOnly: true }), entry('/outside/a.ts', { readOnly: true })]);
    expect(buildContextFileTokenUsage(actual, 'agent', unrelated, '/project').entries.files).toEqual({});
  });

  it('uses Aider file accounting in code mode without inventing rule estimates', () => {
    const tokensInfo: TokensInfoData = {
      ...snapshot(0, []),
      files: { 'src/a.ts': { tokens: 100, cost: 0 } },
      contextBreakdown: undefined,
    };
    const result = buildContextFileTokenUsage(tokensInfo, 'code', sections([entry('src/a.ts', { readOnly: true })]), '/project');
    expect(result.totals).toEqual({ rules: 0, mappings: 0, files: 100 });
    expect(result.entries).toEqual({
      rules: {},
      mappings: {},
      files: { 'src/a.ts': { tokens: 100, color: CONTEXT_USAGE_COLORS.readOnlyFiles } },
    });
  });

  it('uses the sum of rounded file segments for fractional scaling', () => {
    const tokensInfo = snapshot(10, [category('readOnlyFiles', [{ id: 'ro.ts', tokens: 1 }]), category('editableFiles', [{ id: 'edit.ts', tokens: 2 }])]);
    const display = getContextUsageDisplay(tokensInfo, 'agent', [
      { path: 'ro.ts', readOnly: true },
      { path: 'edit.ts', readOnly: false },
    ]);
    const expected = display.segments
      .filter((segment) => segment.id === 'readOnlyFiles' || segment.id === 'editableFiles')
      .reduce((sum, segment) => sum + segment.scaledTokens, 0);
    const fileSections = sections([entry('ro.ts', { readOnly: true }), entry('edit.ts')]);
    expect(buildContextFileTokenUsage(tokensInfo, 'agent', fileSections, '/project').totals.files).toBe(expected);
  });
});
