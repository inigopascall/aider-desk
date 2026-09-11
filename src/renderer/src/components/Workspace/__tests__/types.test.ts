import { describe, expect, it } from 'vitest';

import { applyContextFilesDisabled } from '../types';

describe('applyContextFilesDisabled', () => {
  it('marks matching files (path-separator agnostic) and leaves others by reference', () => {
    const a = { path: 'src/a.ts' };
    const b = { path: 'src\\b.ts' };
    const c = { path: 'src/c.ts', disabled: true };

    const result = applyContextFilesDisabled([a, b, c], ['src/a.ts', 'src/b.ts'], true);

    expect(result[0]).toEqual({ path: 'src/a.ts', disabled: true });
    expect(result[1]).toEqual({ path: 'src\\b.ts', disabled: true });
    expect(result[2]).toBe(c);
  });

  it('re-enables files when disabled is false', () => {
    expect(applyContextFilesDisabled([{ path: 'x.ts', disabled: true }], ['x.ts'], false)).toEqual([
      { path: 'x.ts', disabled: false },
    ]);
  });
});
