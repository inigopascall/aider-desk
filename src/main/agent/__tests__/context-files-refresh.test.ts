import { describe, expect, it } from 'vitest';

import { buildContextFilesUpdateNote, diffContextFiles } from '../context-files-refresh';

import type { ContextFile } from '@common/types';

const file = (path: string, readOnly?: boolean): ContextFile => ({ path, readOnly });

describe('diffContextFiles', () => {
  it('returns empty lists for unchanged sets', () => {
    expect(diffContextFiles([file('a.ts')], [file('a.ts', false)])).toEqual({ added: [], removed: [] });
  });

  it('finds added and removed files', () => {
    const result = diffContextFiles([file('b.ts')], [file('a.ts')]);
    expect(result.added).toEqual([file('a.ts')]);
    expect(result.removed).toEqual([file('b.ts')]);
  });

  it('reports a read-only toggle in both lists', () => {
    const result = diffContextFiles([file('a.ts', true)], [file('a.ts', false)]);
    expect(result.added).toEqual([file('a.ts', false)]);
    expect(result.removed).toEqual([file('a.ts', true)]);
  });

  it('treats undefined and false read-only values as unchanged', () => {
    expect(diffContextFiles([file('a.ts')], [file('a.ts', false)])).toEqual({ added: [], removed: [] });
  });
});

describe('buildContextFilesUpdateNote', () => {
  it('returns null when there are no changes', () => {
    expect(buildContextFilesUpdateNote([], [], true)).toBeNull();
  });

  it('includes added read-only files and contents heading', () => {
    const note = buildContextFilesUpdateNote([file('a.ts', true)], [], true);
    expect(note).toContain('Added or changed (their current contents follow):');
    expect(note).toContain('- a.ts (read-only)');
  });

  it('omits removed section for a read-only toggle', () => {
    const note = buildContextFilesUpdateNote([file('a.ts', false)], [file('a.ts', true)], true);
    expect(note).not.toContain('Removed');
  });

  it('describes removed files without an added section', () => {
    const note = buildContextFilesUpdateNote([], [file('b.ts')], false);
    expect(note).toContain('Removed (disregard any earlier contents of these files):');
    expect(note).toContain('- b.ts');
    expect(note).not.toContain('Added or changed');
  });
});
