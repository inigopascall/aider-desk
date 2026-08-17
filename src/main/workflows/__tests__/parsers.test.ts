import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '@common/types';

import {
  extractSearchReplacePairs,
  parseFileEditBlocks,
  parseReviewerResponse,
  ParseError,
  verifyEditAlignment,
  type FileEditInstruction,
} from '../parsers';
import { splitConversationForSummary } from '../conversation';
import { extractAddedLinesByFile } from '../git-utils';

describe('parseFileEditBlocks', () => {
  it('accepts TYPE: DELETE with empty instructions', () => {
    const text = [
      '=== AMBIGUITIES ===',
      'NONE',
      '',
      '=== FILE EDIT ===',
      'PATH: src/old.ts',
      'TYPE: DELETE',
      'INSTRUCTIONS:',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({ path: 'src/old.ts', type: 'DELETE', instructions: '' });
  });

  it('rejects an unknown TYPE', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: RENAME',
      'INSTRUCTIONS:',
      'content',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(ParseError);
  });
});

describe('parseReviewerResponse', () => {
  const findings =
    '### Correctness verifier findings and reviewer disposition\n\n' +
    '| Item | Verifier Claim | Severity | Reviewer Disposition | Reviewer Rationale | Action Required |\n' +
    '| 1 | x | HIGH | Accepted | y | Yes |';

  it('parses a plan-only response', () => {
    const text = [
      '=== FINDINGS ===',
      findings,
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION PLAN ===',
      '# IMPLEMENTATION PLAN: Fix',
      '## File list',
      '### Files to modify',
      '- src/a.ts',
    ].join('\n');
    const result = parseReviewerResponse(text);
    expect(result.rectificationPlan).toContain('# IMPLEMENTATION PLAN: Fix');
    expect(result.rectificationEdits).toBeNull();
  });

  it('parses an edits-only response', () => {
    const text = [
      '=== FINDINGS ===',
      findings,
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION EDITS ===',
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'old',
      '```',
      'REPLACE:',
      '```',
      'new',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseReviewerResponse(text);
    expect(result.rectificationPlan).toBeNull();
    expect(result.rectificationEdits).toHaveLength(1);
    expect(result.rectificationEdits![0].path).toBe('src/a.ts');
  });

  it('maps a NONE rectification to null', () => {
    const text = [
      '=== FINDINGS ===',
      findings,
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION PLAN ===',
      'NONE',
    ].join('\n');
    const result = parseReviewerResponse(text);
    expect(result.rectificationPlan).toBeNull();
    expect(result.rectificationEdits).toBeNull();
  });

  it('throws when neither rectification marker is present', () => {
    const text = ['=== FINDINGS ===', findings, '', '=== CONSIDERATIONS ===', 'NONE'].join('\n');
    expect(() => parseReviewerResponse(text)).toThrow(ParseError);
  });

  it('lets edits win when both markers carry content', () => {
    const text = [
      '=== FINDINGS ===',
      findings,
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION PLAN ===',
      '# IMPLEMENTATION PLAN: Fix',
      '## File list',
      '### Files to modify',
      '- src/a.ts',
      '',
      '=== RECTIFICATION EDITS ===',
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'old',
      '```',
      'REPLACE:',
      '```',
      'new',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseReviewerResponse(text);
    expect(result.rectificationPlan).toBeNull();
    expect(result.rectificationEdits).toHaveLength(1);
  });

  it('throws when the EDITS marker yields zero blocks', () => {
    const text = [
      '=== FINDINGS ===',
      findings,
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION EDITS ===',
      'some text without file edit blocks',
    ].join('\n');
    expect(() => parseReviewerResponse(text)).toThrow(ParseError);
  });
});

describe('verifyEditAlignment', () => {
  const stats = { insertions: 10, deletions: 0 };

  it('flags a DELETE whose file still exists', () => {
    const edit: FileEditInstruction = { path: 'src/old.ts', type: 'DELETE', instructions: '' };
    const result = verifyEditAlignment(edit, 'still here', stats);
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('file still exists after deletion');
  });

  it('accepts a DELETE whose file is absent', () => {
    const edit: FileEditInstruction = { path: 'src/old.ts', type: 'DELETE', instructions: '' };
    const result = verifyEditAlignment(edit, null, stats);
    expect(result.suspicious).toBe(false);
  });

  it('flags invalid post-edit JSON', () => {
    const edit: FileEditInstruction = {
      path: 'config.json',
      type: 'EDIT',
      instructions: 'SEARCH:\n```\nold\n```\nREPLACE:\n```\nnew\n```',
    };
    const result = verifyEditAlignment(edit, '{ not valid json', stats);
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('post-edit JSON file does not parse');
  });

  it('flags a REPLACE block absent from the diff added lines', () => {
    const edit: FileEditInstruction = {
      path: 'src/a.ts',
      type: 'EDIT',
      instructions: 'SEARCH:\n```\nconst oldValue = 1;\n```\nREPLACE:\n```\nconst newValue = 2;\n```',
    };
    const addedLines = new Set(['const other = 3;']);
    const result = verifyEditAlignment(edit, 'const newValue = 2;', stats, addedLines);
    expect(result.suspicious).toBe(true);
    expect(result.reasons.some((r) => r.includes("appear in the diff's added lines"))).toBe(true);
  });

  it('flags SEARCH-only content still present after replacement', () => {
    const edit: FileEditInstruction = {
      path: 'src/a.ts',
      type: 'EDIT',
      instructions: 'SEARCH:\n```\nconst oldValue = 1;\nconst oldValue2 = 2;\n```\nREPLACE:\n```\nconst newValue = 1;\nconst newValue2 = 2;\n```',
    };
    const result = verifyEditAlignment(edit, 'const oldValue = 1;\nconst oldValue2 = 2;', stats);
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('content slated for removal is still present');
  });
});

describe('extractSearchReplacePairs', () => {
  it('pairs each SEARCH with its immediately following REPLACE', () => {
    const text = [
      'SEARCH:',
      '```',
      'const a = 1;',
      '```',
      'REPLACE:',
      '```',
      'const b = 1;',
      '```',
      'INSERT:',
      '```',
      'const c = 1;',
      '```',
      'SEARCH:',
      '```',
      'const d = 1;',
      '```',
      'REPLACE:',
      '```',
      'const e = 1;',
      '```',
    ].join('\n');
    const pairs = extractSearchReplacePairs(text);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].search).toContain('const a = 1;');
    expect(pairs[0].replace).toContain('const b = 1;');
    expect(pairs[1].search).toContain('const d = 1;');
    expect(pairs[1].replace).toContain('const e = 1;');
  });
});

describe('extractAddedLinesByFile', () => {
  it('attributes added lines to the correct files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '+const y = 2;',
      '+const z = 3;',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1 +1 @@',
      '+const w = 4;',
    ].join('\n');
    const result = extractAddedLinesByFile(diff);
    expect(result.get('src/a.ts')).toEqual(['const y = 2;', 'const z = 3;']);
    expect(result.get('src/b.ts')).toEqual(['const w = 4;']);
  });

  it('skips added lines for files deleted to /dev/null', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const gone = 1;',
      '-const gone2 = 2;',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+const fresh = 1;',
    ].join('\n');
    const result = extractAddedLinesByFile(diff);
    expect(result.get('src/old.ts') ?? []).toEqual([]);
    expect(result.get('src/new.ts')).toEqual(['const fresh = 1;']);
  });
});

describe('splitConversationForSummary', () => {
  const userMsg = (text: string): ContextMessage => ({ id: `u-${text.length}`, role: 'user', content: text });
  const assistantMsg = (text: string): ContextMessage => ({ id: `a-${text.length}`, role: 'assistant', content: text });

  it('passes through below-threshold conversations with an empty tail', () => {
    const messages = [userMsg('short user turn'), assistantMsg('short assistant turn')];
    const result = splitConversationForSummary(messages);
    expect(result.tail).toEqual([]);
    expect(result.recent).toHaveLength(2);
    expect(result.turns).toBe(2);
  });

  it('splits above-threshold conversations keeping the most recent user turn verbatim', () => {
    const long = 'x'.repeat(1200);
    const messages: ContextMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push(userMsg(`${long} user ${i}`));
      messages.push(assistantMsg(`${long} assistant ${i}`));
    }
    const result = splitConversationForSummary(messages);
    expect(result.turns).toBe(16);
    expect(result.tail.length).toBeGreaterThan(0);
    expect(result.recent.length).toBeGreaterThan(0);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')!;
    expect(result.recent).toContain(lastUser);
  });
});