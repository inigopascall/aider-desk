import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '@common/types';

import {
  extractSearchReplacePairs,
  parseConfirmerResponse,
  parseDigesterResponse,
  parseEditCommands,
  parseFileEditBlocks,
  parseReviewerResponse,
  ParseError,
  validateFileEditInstruction,
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

describe('parseFileEditBlocks — instruction validation', () => {
  it('rejects TYPE: NEW with prose instructions (no fence)', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/ThreadOutlineWindow.tsx',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      'Create a new component that renders the thread outline window. It should display the list of threads, allow selecting one, and show the selected thread details in a side panel.',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(/verbatim file content/);
  });

  it('strips the fence from TYPE: NEW content', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/new.ts',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      '````',
      'export const answer = 42;',
      '````',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits[0].type).toBe('NEW');
    expect(result.edits[0].instructions).toBe('export const answer = 42;');
  });

  it('preserves triple-backtick fences inside a 4-backtick NEW fence', () => {
    const content = ['# README', '', '```ts', 'const x = 1;', '```'].join('\n');
    const text = [
      '=== FILE EDIT ===',
      'PATH: README.md',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      '````',
      content,
      '````',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits[0].instructions).toBe(content);
  });

  it('rejects TYPE: NEW with an empty fenced block', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/empty.ts',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      '````',
      '',
      '````',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(/NEW file content must not be empty/);
  });

  it('rejects TYPE: EDIT with prose outside the commands', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'const old = 1;',
      '```',
      'REPLACE:',
      '```',
      'const new = 1;',
      '```',
      'Also update the imports at the top of the file.',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(/found prose outside the commands/);
  });

  it('accepts TYPE: EDIT with valid SEARCH/REPLACE and INSERT commands, verbatim', () => {
    const instructions = [
      'SEARCH:',
      '```',
      'const old = 1;',
      '```',
      'REPLACE:',
      '```',
      'const new = 1;',
      '```',
      'INSERT:',
      '```',
      'const added = 2;',
      '```',
    ].join('\n');
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      instructions,
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits[0].type).toBe('EDIT');
    expect(result.edits[0].instructions).toBe(instructions);
  });

  it('rejects TYPE: EDIT with a SEARCH not followed by REPLACE', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'const old = 1;',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(ParseError);
  });

  it('rejects TYPE: EDIT with an orphan REPLACE', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'REPLACE:',
      '```',
      'const new = 1;',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(ParseError);
  });

  it('rejects TYPE: DELETE with non-empty instructions', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/old.ts',
      'TYPE: DELETE',
      'INSTRUCTIONS:',
      'remove this file',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseFileEditBlocks(text)).toThrow(/TYPE DELETE requires an empty INSTRUCTIONS body/);
  });

  it('rejects a DEFICIENT confirmer response carrying a prose NEW block', () => {
    const text = [
      '=== VERDICT ===',
      'DEFICIENT',
      '',
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      'Write a module that exports a helper function.',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseConfirmerResponse(text)).toThrow(ParseError);
  });

  it('rejects a reviewer response carrying a prose NEW rectification block', () => {
    const text = [
      '=== FINDINGS ===',
      '### Correctness verifier findings and reviewer disposition',
      '| Item | Verifier Claim | Severity | Reviewer Disposition | Reviewer Rationale | Action Required |',
      '| 1 | x | HIGH | Accepted | y | Yes |',
      '',
      '=== CONSIDERATIONS ===',
      'NONE',
      '',
      '=== RECTIFICATION EDITS ===',
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: NEW',
      'INSTRUCTIONS:',
      'Create a new utility module with a helper function.',
      '=== END FILE EDIT ===',
    ].join('\n');
    expect(() => parseReviewerResponse(text)).toThrow(ParseError);
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

  it('pairs commands fenced with 4 backticks identically to 3-backtick fences', () => {
    const text = [
      'SEARCH:',
      '````',
      'const a = 1;',
      '````',
      'REPLACE:',
      '````',
      'const b = 1;',
      '````',
    ].join('\n');
    const pairs = extractSearchReplacePairs(text);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].search).toContain('const a = 1;');
    expect(pairs[0].replace).toContain('const b = 1;');
  });
});

describe('validateFileEditInstruction', () => {
  it('returns a reason for prose-only EDIT instructions', () => {
    const edit: FileEditInstruction = {
      path: 'src/a.ts',
      type: 'EDIT',
      instructions: 'Replace the old function with a new one.',
    };
    expect(validateFileEditInstruction(edit)).not.toBeNull();
  });

  it('returns null for valid EDIT commands', () => {
    const edit: FileEditInstruction = {
      path: 'src/a.ts',
      type: 'EDIT',
      instructions: 'SEARCH:\n```\nold\n```\nREPLACE:\n```\nnew\n```',
    };
    expect(validateFileEditInstruction(edit)).toBeNull();
  });

  it('returns a reason for empty NEW instructions', () => {
    const edit: FileEditInstruction = { path: 'src/a.ts', type: 'NEW', instructions: '' };
    expect(validateFileEditInstruction(edit)).not.toBeNull();
  });

  it('returns a reason for non-empty DELETE instructions', () => {
    const edit: FileEditInstruction = { path: 'src/a.ts', type: 'DELETE', instructions: 'remove this' };
    expect(validateFileEditInstruction(edit)).not.toBeNull();
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
describe('empty fenced blocks and scanner tolerance', () => {
  it('parses an empty REPLACE block mid-stream', () => {
    const body = [
      'SEARCH:',
      '```',
      'const a = 1;',
      '```',
      'REPLACE:',
      '```',
      'const a2 = 1;',
      '```',
      'SEARCH:',
      '```',
      'const b = 1;',
      '```',
      'REPLACE:',
      '```',
      '```',
      'SEARCH:',
      '```',
      'const c = 1;',
      '```',
      'REPLACE:',
      '```',
      'const c2 = 1;',
      '```',
    ].join('\n');
    const commands = parseEditCommands(body);
    expect(commands).toHaveLength(6);
    expect(commands[3]).toEqual({ kind: 'REPLACE', content: '' });
  });

  it('accepts an EDIT whose final REPLACE block is empty', () => {
    const text = [
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'const old = 1;',
      '```',
      'REPLACE:',
      '```',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0].type).toBe('EDIT');
  });

  it('parses empty blocks fenced with 4 backticks', () => {
    const body = [
      'SEARCH:',
      '````',
      'const a = 1;',
      '````',
      'REPLACE:',
      '````',
      '````',
    ].join('\n');
    const commands = parseEditCommands(body);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual({ kind: 'REPLACE', content: '' });
  });

  it('tolerates a blank line between a label and its fence', () => {
    const body = [
      'SEARCH:',
      '',
      '```',
      'const a = 1;',
      '```',
      'REPLACE:',
      '',
      '```',
      'const b = 1;',
      '```',
    ].join('\n');
    const commands = parseEditCommands(body);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ kind: 'SEARCH', content: 'const a = 1;' });
    expect(commands[1]).toEqual({ kind: 'REPLACE', content: 'const b = 1;' });
  });

  it('keeps a 3-backtick line inside a 4-backtick block as content', () => {
    const body = [
      'SEARCH:',
      '````',
      'const code = `x`;',
      '```',
      'const more = 1;',
      '````',
      'REPLACE:',
      '````',
      'const y = 1;',
      '````',
    ].join('\n');
    const commands = parseEditCommands(body);
    expect(commands).toHaveLength(2);
    expect(commands[0].content).toContain('```');
    expect(commands[0].content).toContain('const more = 1;');
  });

  it('rejects an unclosed fenced block', () => {
    const body = [
      'SEARCH:',
      '````',
      'const a = 1;',
      '```',
      'const b = 1;',
    ].join('\n');
    expect(() => parseEditCommands(body)).toThrow(/never closed/);
  });

  it('rejects a label not followed by a fenced block', () => {
    const body = [
      'SEARCH:',
      '```',
      'const a = 1;',
      '```',
      'REPLACE:',
      'const b = 1;',
    ].join('\n');
    expect(() => parseEditCommands(body)).toThrow(/not followed by a fenced code block/);
  });

  it('pairs a SEARCH with a truly empty REPLACE', () => {
    const text = [
      'SEARCH:',
      '```',
      'const old = 1;',
      '```',
      'REPLACE:',
      '```',
      '```',
    ].join('\n');
    const pairs = extractSearchReplacePairs(text);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].search).toContain('const old = 1;');
    expect(pairs[0].replace).toBe('');
  });

  it('accepts a DEFICIENT verdict carrying an empty-REPLACE corrective edit', () => {
    const text = [
      '=== VERDICT ===',
      'DEFICIENT',
      '',
      '=== FILE EDIT ===',
      'PATH: src/a.ts',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '```',
      'const stale = 1;',
      '```',
      'REPLACE:',
      '```',
      '```',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseConfirmerResponse(text);
    expect(result.verdict).toBe('DEFICIENT');
    if (result.verdict === 'DEFICIENT') {
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0].type).toBe('EDIT');
    }
  });

  it('flags still-present content that an empty REPLACE was meant to delete', () => {
    const edit: FileEditInstruction = {
      path: 'src/a.ts',
      type: 'EDIT',
      instructions: 'SEARCH:\n```\nconst staleOldValue = 1;\n```\nREPLACE:\n```\n```',
    };
    const result = verifyEditAlignment(edit, 'const staleOldValue = 1;', { insertions: 5, deletions: 5 });
    expect(result.suspicious).toBe(true);
    expect(result.reasons).toContain('content slated for removal is still present');
  });

  it('accepts a DIGESTER verdict wrapped in a 4-backtick fence', () => {
    const text = ['````', 'VERDICT: YES', '````'].join('\n');
    const result = parseDigesterResponse(text);
    expect(result.verdict).toBe('YES');
    expect(result.irrelevantFiles).toEqual([]);
  });

  it('parses the reported-sample shape with empty REPLACE blocks and mid-line backticks', () => {
    const taskMenuLine = 'data-testid={`task-menu-${task.id}`}';
    const text = [
      '=== AMBIGUITIES ===',
      'NONE',
      '',
      '=== FILE EDIT ===',
      'PATH: src/components/TaskList.tsx',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'SEARCH:',
      '````',
      'const oldA = 1;',
      '````',
      'REPLACE:',
      '````',
      '````',
      'SEARCH:',
      '````',
      taskMenuLine,
      '````',
      'REPLACE:',
      '````',
      `${taskMenuLine} // updated`,
      '````',
      'SEARCH:',
      '````',
      'const oldB = 2;',
      '````',
      'REPLACE:',
      '````',
      '````',
      '=== END FILE EDIT ===',
      '',
      '=== FILE EDIT ===',
      'PATH: src/components/TaskView.tsx',
      'TYPE: EDIT',
      'INSTRUCTIONS:',
      'INSERT:',
      '````',
      'const inserted = true;',
      '````',
      '=== END FILE EDIT ===',
    ].join('\n');
    const result = parseFileEditBlocks(text);
    expect(result.edits).toHaveLength(2);
    expect(result.edits[0].type).toBe('EDIT');
    expect(result.edits[1].instructions).toContain('INSERT:');
  });
});
