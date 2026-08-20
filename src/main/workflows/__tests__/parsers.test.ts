import { describe, expect, it } from 'vitest';

import {
  DELETE_MARKER,
  ParseError,
  parseArbiterResponse,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseEditSpecBlocks,
  serializeFileEdits,
  validateEditChains,
  type FileEditInstruction,
} from '../parsers';

describe('DELETE_MARKER constant', () => {
  it('equals [DEPRECATED: PLEASE DELETE]', () => {
    expect(DELETE_MARKER).toBe('[DEPRECATED: PLEASE DELETE]');
  });
});

describe('parseDigesterResponse', () => {
  it('parses YES with research brief and irrelevant files', () => {
    const text = [
      'VERDICT: YES',
      '',
      '=== RESEARCH BRIEF ===',
      'Look up new React 19 hooks API',
      '',
      '=== IRRELEVANT CONTEXT FILES ===',
      'src/legacy/old.ts',
      'src/unused/util.ts',
    ].join('\n');
    const result = parseDigesterResponse(text);
    expect(result).toEqual({
      verdict: 'YES',
      researchBrief: 'Look up new React 19 hooks API',
      irrelevantFiles: ['src/legacy/old.ts', 'src/unused/util.ts'],
    });
  });

  it('parses YES with RESEARCH BRIEF: NONE as null', () => {
    const text = [
      'VERDICT: YES',
      '',
      '=== RESEARCH BRIEF ===',
      'NONE',
      '',
      '=== IRRELEVANT CONTEXT FILES ===',
      'NONE',
    ].join('\n');
    const result = parseDigesterResponse(text);
    expect(result).toEqual({
      verdict: 'YES',
      researchBrief: null,
      irrelevantFiles: [],
    });
  });

  it('parses YES with sections absent', () => {
    const text = 'VERDICT: YES';
    const result = parseDigesterResponse(text);
    expect(result).toEqual({
      verdict: 'YES',
      researchBrief: null,
      irrelevantFiles: [],
    });
  });

  it('parses YES wrapped in a 4-backtick fence', () => {
    const text = ['````', 'VERDICT: YES', '', '=== RESEARCH BRIEF ===', 'NONE', '````'].join('\n');
    const result = parseDigesterResponse(text);
    expect(result.verdict).toBe('YES');
    expect(result.researchBrief).toBeNull();
  });

  it('parses NO with investigation and research briefs', () => {
    const text = [
      'VERDICT: NO',
      '',
      '=== INVESTIGATION BRIEF ===',
      'Search for auth handler usages',
      '',
      '=== RESEARCH BRIEF ===',
      'OAuth2 token refresh semantics',
    ].join('\n');
    const result = parseDigesterResponse(text);
    expect(result).toEqual({
      verdict: 'NO',
      investigationBrief: 'Search for auth handler usages',
      researchBrief: 'OAuth2 token refresh semantics',
    });
  });

  it('throws on NO without investigation brief', () => {
    const text = 'VERDICT: NO';
    expect(() => parseDigesterResponse(text)).toThrow(ParseError);
  });
});

describe('parseDecompositorResponse / parseEditSpecBlocks', () => {
  it('parses multiple blocks for one file in document order with correct ids/types', () => {
    const text = [
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: edit: src/file.ts ==',
      'Replace line 5 with: const x = 1;',
      '',
      '== EDIT 2: edit: src/file.ts ==',
      'Replace line 10 with: const y = 2;',
      '',
      '=== EDITS SUMMARY ===',
      '- `src/file.ts`: updated x and y',
    ].join('\n');

    const result = parseDecompositorResponse(text);
    expect(result.edits).toHaveLength(2);
    expect(result.edits[0]).toEqual({
      id: 1,
      path: 'src/file.ts',
      type: 'EDIT',
      instructions: 'Replace line 5 with: const x = 1;',
    });
    expect(result.edits[1]).toEqual({
      id: 2,
      path: 'src/file.ts',
      type: 'EDIT',
      instructions: 'Replace line 10 with: const y = 2;',
    });
    expect(result.summary).toBe('- `src/file.ts`: updated x and y');
  });

  it('preserves instruction bodies with fenced code and backticks verbatim', () => {
    const codeBlock = '```typescript\nconst greeting = `Hello ${name}`;\n```';
    const text = [
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: create: src/greet.ts ==',
      codeBlock,
      '',
      '=== EDITS SUMMARY ===',
      '- `src/greet.ts`: created greeting module',
    ].join('\n');

    const result = parseDecompositorResponse(text);
    expect(result.edits[0].instructions).toBe(codeBlock);
  });

  it('handles case-insensitive ops (CREATE / Edit / delete)', () => {
    const text = [
      '== EDIT 1: CREATE: src/new.ts ==',
      'Write this content verbatim.',
      '',
      '== EDIT 2: Edit: src/edit.ts ==',
      'Update imports.',
      '',
      '== EDIT 3: delete: src/del.ts ==',
      'Deprecate file.',
    ].join('\n');

    const edits = parseEditSpecBlocks(text);
    expect(edits).toHaveLength(3);
    expect(edits[0].type).toBe('NEW');
    expect(edits[1].type).toBe('EDIT');
    expect(edits[2].type).toBe('DELETE');
  });

  it('throws on duplicate edit ids', () => {
    const text = [
      '== EDIT 1: edit: src/a.ts ==',
      'First change',
      '',
      '== EDIT 1: edit: src/b.ts ==',
      'Second change',
    ].join('\n');
    expect(() => parseEditSpecBlocks(text)).toThrow(/duplicate edit id/);
  });

  it('throws on absolute path', () => {
    const text = [
      '== EDIT 1: edit: /etc/passwd ==',
      'Change',
    ].join('\n');
    expect(() => parseEditSpecBlocks(text)).toThrow(/invalid file path/);
  });

  it('throws on .. path', () => {
    const text = [
      '== EDIT 1: edit: ../outside.ts ==',
      'Change',
    ].join('\n');
    expect(() => parseEditSpecBlocks(text)).toThrow(/invalid file path/);
  });

  it('throws on empty instructions', () => {
    const text = [
      '== EDIT 1: edit: src/a.ts ==',
      '',
      '== EDIT 2: edit: src/b.ts ==',
      'Some instructions',
    ].join('\n');
    expect(() => parseEditSpecBlocks(text)).toThrow(/instructions must not be empty/);
  });

  it('throws on unknown operation', () => {
    const text = [
      '== EDIT 1: rename: src/a.ts ==',
      'Some instructions',
    ].join('\n');
    expect(parseEditSpecBlocks(text)).toEqual([]);
  });

  it('throws on zero edits in decompositor response', () => {
    const text = [
      '=== EDIT SPECS ===',
      '',
      '=== EDITS SUMMARY ===',
      '- none',
    ].join('\n');
    expect(() => parseDecompositorResponse(text)).toThrow(/at least one edit specification is required/);
  });

  it('throws on missing EDITS SUMMARY marker', () => {
    const text = [
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: create: src/a.ts ==',
      'Instructions',
    ].join('\n');
    expect(() => parseDecompositorResponse(text)).toThrow(/markers/);
  });

  it('throws on EDITS SUMMARY of NONE', () => {
    const text = [
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: create: src/a.ts ==',
      'Instructions',
      '',
      '=== EDITS SUMMARY ===',
      'NONE',
    ].join('\n');
    expect(() => parseDecompositorResponse(text)).toThrow(/must not be empty or NONE/);
  });

  it('ensures specs section ends at summary marker and does not absorb summary into last block', () => {
    const text = [
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: edit: src/a.ts ==',
      'Change x to y.',
      '',
      '=== EDITS SUMMARY ===',
      '- `src/a.ts`: changed x to y',
    ].join('\n');
    const result = parseDecompositorResponse(text);
    expect(result.edits[0].instructions).toBe('Change x to y.');
    expect(result.summary).toBe('- `src/a.ts`: changed x to y');
  });
});

describe('serializeFileEdits', () => {
  it('round-trips through parseEditSpecBlocks', () => {
    const originalEdits: FileEditInstruction[] = [
      { id: 1, path: 'src/create.ts', type: 'NEW', instructions: 'const a = `hello`;' },
      { id: 2, path: 'src/edit.ts', type: 'EDIT', instructions: 'replace foo with bar\nconst b = 2;' },
      { id: 3, path: 'src/delete.ts', type: 'DELETE', instructions: DELETE_MARKER },
    ];

    const serialized = serializeFileEdits(originalEdits);
    const parsed = parseEditSpecBlocks(serialized);

    expect(parsed).toEqual(originalEdits);
  });
});

describe('validateEditChains', () => {
  it('allows create followed by edit on missing file', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/new.ts', type: 'NEW', instructions: 'initial' },
      { id: 2, path: 'src/new.ts', type: 'EDIT', instructions: 'tweak' },
    ];
    const problems = validateEditChains(edits, new Set());
    expect(problems.size).toBe(0);
  });

  it('rejects edit of a missing file when first op is not NEW', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/missing.ts', type: 'EDIT', instructions: 'tweak' },
    ];
    const problems = validateEditChains(edits, new Set());
    expect(problems.get('src/missing.ts')).toBe('file does not exist and the first edit is not a create');
  });

  it('rejects create targeting an existing file', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/exists.ts', type: 'NEW', instructions: 'initial' },
    ];
    const problems = validateEditChains(edits, new Set(['src/exists.ts']));
    expect(problems.get('src/exists.ts')).toBe('create targets an existing file');
  });

  it('rejects multiple creates for one file', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/new.ts', type: 'NEW', instructions: 'first' },
      { id: 2, path: 'src/new.ts', type: 'NEW', instructions: 'second' },
    ];
    const problems = validateEditChains(edits, new Set());
    expect(problems.get('src/new.ts')).toBe('multiple create edits for one file');
  });

  it('rejects create when not the first op in its chain', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/file.ts', type: 'EDIT', instructions: 'edit first' },
      { id: 2, path: 'src/file.ts', type: 'NEW', instructions: 'create later' },
    ];
    const problems = validateEditChains(edits, new Set(['src/file.ts']));
    expect(problems.get('src/file.ts')).toBe('create targets an existing file');
  });

  it('allows delete as terminal operation', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/old.ts', type: 'EDIT', instructions: 'final edit' },
      { id: 2, path: 'src/old.ts', type: 'DELETE', instructions: DELETE_MARKER },
    ];
    const problems = validateEditChains(edits, new Set(['src/old.ts']));
    expect(problems.size).toBe(0);
  });

  it('rejects edit following delete in the same chain', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/file.ts', type: 'DELETE', instructions: DELETE_MARKER },
      { id: 2, path: 'src/file.ts', type: 'EDIT', instructions: 'after delete' },
    ];
    const problems = validateEditChains(edits, new Set(['src/file.ts']));
    expect(problems.get('src/file.ts')).toBe('edit follows a delete in the same chain');
  });

  it('keeps independent valid chains unaffected by a sibling invalid chain', () => {
    const edits: FileEditInstruction[] = [
      { id: 1, path: 'src/valid.ts', type: 'EDIT', instructions: 'valid edit' },
      { id: 2, path: 'src/missing.ts', type: 'EDIT', instructions: 'invalid edit' },
    ];
    const problems = validateEditChains(edits, new Set(['src/valid.ts']));
    expect(problems.has('src/valid.ts')).toBe(false);
    expect(problems.has('src/missing.ts')).toBe(true);
  });
});

describe('parseArbiterResponse', () => {
  it('parses response with review summary, edits, and edits summary', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'The changes look solid overall but need one fix.',
      '',
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: edit: src/fix.ts ==',
      'Fix the return value.',
      '',
      '=== EDITS SUMMARY ===',
      '- `src/fix.ts`: fixed return value',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('The changes look solid overall but need one fix.');
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].path).toBe('src/fix.ts');
    expect(result.editsSummary).toBe('- `src/fix.ts`: fixed return value');
  });

  it('parses clean arbiter response with NONE for edit specs', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'All requirements met and tests pass cleanly.',
      '',
      '=== EDIT SPECS ===',
      'NONE',
      '',
      '=== EDITS SUMMARY ===',
      'NONE',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('All requirements met and tests pass cleanly.');
    expect(result.edits).toHaveLength(0);
    expect(result.editsSummary).toBeNull();
  });

  it('throws when REVIEW SUMMARY marker is missing or empty', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      '',
      '=== EDIT SPECS ===',
      'NONE',
    ].join('\n');
    expect(() => parseArbiterResponse(text)).toThrow(ParseError);
  });

  it('throws when edits are present but EDITS SUMMARY is NONE or missing', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'Needs edits',
      '',
      '=== EDIT SPECS ===',
      '',
      '== EDIT 1: edit: src/fix.ts ==',
      'Fix return value.',
      '',
      '=== EDITS SUMMARY ===',
      'NONE',
    ].join('\n');
    expect(() => parseArbiterResponse(text)).toThrow(/EDITS SUMMARY/);
  });
});

describe('parseEditorResponse', () => {
  it('parses DONE', () => {
    expect(parseEditorResponse('DONE')).toEqual({ outcome: 'DONE' });
    expect(parseEditorResponse('```\nDONE\n```')).toEqual({ outcome: 'DONE' });
  });

  it('parses FAILED with reason', () => {
    expect(parseEditorResponse('FAILED: anchor not found')).toEqual({
      outcome: 'FAILED',
      detail: 'anchor not found',
    });
  });

  it('parses unrecognized output as UNKNOWN with excerpt', () => {
    const raw = 'Here is what I did: I modified the file and added some stuff.';
    const result = parseEditorResponse(raw);
    expect(result.outcome).toBe('UNKNOWN');
    expect(result.detail).toBe(raw.slice(0, 200));
  });
});
