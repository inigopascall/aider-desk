import { describe, expect, it } from 'vitest';

import {
  ParseError,
  computeWaves,
  parseArbiterResponse,
  parseAssignmentsResponse,
  parseDigesterResponse,
  parseEditorResult,
  serializeAssignment,
  validateAssignments,
  type FileAssignment,
} from '../parsers';

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

describe('parseAssignmentsResponse', () => {
  it('parses multiple assignments with sections and dependencies', () => {
    const text = [
      '=== ASSIGNMENTS ===',
      '',
      '== ASSIGNMENT 1: MODIFY: src/file.ts ==',
      'DEPENDS ON: none',
      'FILES TO READ FIRST FOR CONTEXT:',
      '- src/contracts/fix.ts',
      'RELEVANT CONTRACTS AND PATTERNS:',
      '- `fixValue()` returns the mapped result.',
      'OBJECTIVE:',
      'Update the auth handler to use the new token API.',
      'INSTRUCTIONS:',
      '- Replace the token refresh call with refreshToken()',
      '- Update the error handling to match the new contract',
      'ACCEPTANCE CRITERIA:',
      '- No references to oldToken() remain',
      '- refreshToken() is called with the session id',
      '',
      '== ASSIGNMENT 2: CREATE: src/new-file.ts ==',
      'DEPENDS ON: 1',
      'OBJECTIVE:',
      'Create the new token module.',
      'INSTRUCTIONS:',
      '- Export function refreshToken(sessionId: string)',
      'ACCEPTANCE CRITERIA:',
      '- Module exports refreshToken',
      '',
      '=== SUMMARY ===',
      '- src/file.ts: updated auth handler',
      '- src/new-file.ts: created token module',
    ].join('\n');

    const result = parseAssignmentsResponse(text);
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0]).toEqual({
      id: 1,
      path: 'src/file.ts',
      operation: 'MODIFY',
      contextFiles: ['src/contracts/fix.ts'],
      relevantContracts: ['`fixValue()` returns the mapped result.'],
      objective: 'Update the auth handler to use the new token API.',
      instructions: ['Replace the token refresh call with refreshToken()', 'Update the error handling to match the new contract'],
      acceptanceCriteria: ['No references to oldToken() remain', 'refreshToken() is called with the session id'],
      dependsOn: [],
    });
    expect(result.assignments[1].dependsOn).toEqual([1]);
    expect(result.summary).toContain('src/file.ts: updated auth handler');
  });

  it('handles case-insensitive operations and DELETE with header only', () => {
    const text = [
      '== ASSIGNMENT 1: modify: src/a.ts ==',
      'OBJECTIVE:',
      'Tweak a.',
      'INSTRUCTIONS:',
      '- Change x',
      'ACCEPTANCE CRITERIA:',
      '- x changed',
      '',
      '== ASSIGNMENT 2: DELETE: src/old.ts ==',
    ].join('\n');

    const result = parseAssignmentsResponse(text);
    expect(result.assignments[0].operation).toBe('MODIFY');
    expect(result.assignments[0].contextFiles).toEqual([]);
    expect(result.assignments[0].relevantContracts).toEqual([]);
    expect(result.assignments[1]).toEqual({
      id: 2,
      path: 'src/old.ts',
      operation: 'DELETE',
      contextFiles: [],
      relevantContracts: [],
      objective: '',
      instructions: [],
      acceptanceCriteria: [],
      dependsOn: [],
    });
  });

  it('parses and normalizes contextual files and relevant contracts', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
      'FILES TO READ FIRST FOR CONTEXT:',
      '- ./src\\contracts\\a.ts',
      '- src/contracts/a.ts',
      'RELEVANT CONTRACTS AND PATTERNS:',
      '- `createA()` accepts one string argument.',
      '- Tests mock it with `vi.spyOn(...)`.',
      'OBJECTIVE:',
      'Update a.',
    ].join('\n');

    expect(parseAssignmentsResponse(text).assignments[0]).toMatchObject({
      contextFiles: ['src/contracts/a.ts'],
      relevantContracts: ['`createA()` accepts one string argument.', 'Tests mock it with `vi.spyOn(...)`.'],
    });
  });

  it.each([
    '/absolute/file.ts',
    'C:\\absolute\\file.ts',
    '../outside.ts',
    'src/../../outside.ts',
  ])('rejects invalid context file path %s', (contextPath) => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
      'FILES TO READ FIRST FOR CONTEXT:',
      `- ${contextPath}`,
      'OBJECTIVE:',
      'Update a.',
    ].join('\n');

    expect(() => parseAssignmentsResponse(text)).toThrow(/invalid context file path/);
  });

  it('defaults missing context and contract sections to empty arrays', () => {
    const result = parseAssignmentsResponse(['== ASSIGNMENT 1: MODIFY: src/a.ts ==', 'OBJECTIVE:', 'Update a.'].join('\n'));
    expect(result.assignments[0].contextFiles).toEqual([]);
    expect(result.assignments[0].relevantContracts).toEqual([]);
  });

  it('treats NONE context and contract bullets as empty arrays', () => {
    const result = parseAssignmentsResponse(
      [
        '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
        'FILES TO READ FIRST FOR CONTEXT:',
        '- NONE',
        'RELEVANT CONTRACTS AND PATTERNS:',
        '- NONE',
        'OBJECTIVE:',
        'Update a.',
      ].join('\n'),
    );
    expect(result.assignments[0].contextFiles).toEqual([]);
    expect(result.assignments[0].relevantContracts).toEqual([]);
  });

  it('defaults missing INSTRUCTIONS and ACCEPTANCE CRITERIA to empty arrays', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
      'OBJECTIVE:',
      'Just change the return type.',
    ].join('\n');

    const result = parseAssignmentsResponse(text);
    expect(result.assignments[0].instructions).toEqual([]);
    expect(result.assignments[0].acceptanceCriteria).toEqual([]);
  });

  it('throws on missing OBJECTIVE for MODIFY', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
      'INSTRUCTIONS:',
      '- Change x',
    ].join('\n');
    expect(() => parseAssignmentsResponse(text)).toThrow(/OBJECTIVE is required/);
  });

  it('throws on zero assignments', () => {
    expect(() => parseAssignmentsResponse('=== ASSIGNMENTS ===\n\n=== SUMMARY ===\n- none')).toThrow(/no assignments found/);
  });

  it('throws on malformed assignment header', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY src/a.ts ==',
      'OBJECTIVE:',
      'Broken header',
    ].join('\n');
    expect(() => parseAssignmentsResponse(text)).toThrow(/malformed assignment header/);
  });

  it('throws on invalid path', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: /etc/passwd ==',
      'OBJECTIVE:',
      'Change',
    ].join('\n');
    expect(() => parseAssignmentsResponse(text)).toThrow(/invalid file path/);
  });

  it('does not absorb the SUMMARY section into the last assignment body', () => {
    const text = [
      '== ASSIGNMENT 1: MODIFY: src/a.ts ==',
      'OBJECTIVE:',
      'Change x to y.',
      'INSTRUCTIONS:',
      '- Change x',
      'ACCEPTANCE CRITERIA:',
      '- x changed',
      '',
      '=== SUMMARY ===',
      '- src/a.ts: changed x to y',
    ].join('\n');

    const result = parseAssignmentsResponse(text);
    expect(result.assignments[0].instructions).toEqual(['Change x']);
    expect(result.assignments[0].acceptanceCriteria).toEqual(['x changed']);
    expect(result.summary).toBe('- src/a.ts: changed x to y');
  });
});

describe('buildEditorPrompt path contract', () => {
  it('exposes only project-relative assignment paths', async () => {
    const { buildEditorPrompt } = await import('../definitions/dev-pipeline-core');
    const assignment: FileAssignment = {
      id: 1,
      path: 'src/file.ts',
      operation: 'MODIFY',
      contextFiles: ['src/contracts/token.ts'],
      relevantContracts: ['`refreshToken()` accepts a session id.'],
      objective: 'Update the handler.',
      instructions: ['Use refreshToken'],
      acceptanceCriteria: ['No old calls remain'],
      dependsOn: [],
    };

    const prompt = buildEditorPrompt(assignment);

    expect(prompt).toContain("The assignment path 'src/file.ts' is the only writable file.");
    expect(prompt).toContain('- src/contracts/token.ts');
    expect(prompt).toContain('must be passed to file tools exactly as written');
    expect(prompt).not.toContain('resolved absolute');
    expect(prompt).not.toContain('RESOLVED FILES');
    expect(prompt).not.toContain('.aider-desk/tasks/');
  });
});

describe('serializeAssignment', () => {
  it('round-trips through parseAssignmentsResponse', () => {
    const assignment: FileAssignment = {
      id: 1,
      path: 'src/file.ts',
      operation: 'MODIFY',
      contextFiles: ['src/contracts/token.ts', 'src/file.test.ts'],
      relevantContracts: ['`refreshToken(sessionId: string)` returns the refreshed token', 'Tests mock `refreshToken` with `vi.spyOn`'],
      objective: 'Update the handler.',
      instructions: ['Replace the call', 'Fix the error path'],
      acceptanceCriteria: ['No old calls remain'],
      dependsOn: [2, 3],
    };

    const serialized = serializeAssignment(assignment);
    const parsed = parseAssignmentsResponse(serialized);
    expect(parsed.assignments).toEqual([assignment]);
  });
});

describe('validateAssignments', () => {
  const base = (overrides: Partial<FileAssignment>): FileAssignment => ({
    id: 1,
    path: 'src/a.ts',
    operation: 'MODIFY',
    contextFiles: [],
    relevantContracts: [],
    objective: 'obj',
    instructions: [],
    acceptanceCriteria: [],
    dependsOn: [],
    ...overrides,
  });

  it('flags duplicate ids and duplicate paths', () => {
    const assignments = [
      base({ id: 1, path: 'src/a.ts' }),
      base({ id: 1, path: 'src/b.ts' }),
      base({ id: 2, path: 'src/a.ts' }),
    ];
    const problems = validateAssignments(assignments, new Set(['src/a.ts', 'src/b.ts']));
    expect(problems.get(1)).toBe('duplicate assignment id');
    expect(problems.get(2)).toBe('duplicate path');
  });

  it('flags dependsOn referencing a nonexistent id or itself', () => {
    const assignments = [
      base({ id: 1, dependsOn: [99] }),
      base({ id: 2, path: 'src/b.ts', dependsOn: [2] }),
    ];
    const problems = validateAssignments(assignments, new Set(['src/a.ts', 'src/b.ts']));
    expect(problems.get(1)).toBe('depends on nonexistent assignment 99');
    expect(problems.get(2)).toBe('assignment depends on itself');
  });

  it('flags MODIFY of a missing file and CREATE of an existing file', () => {
    const assignments = [
      base({ id: 1, operation: 'MODIFY', path: 'src/missing.ts' }),
      base({ id: 2, path: 'src/exists.ts', operation: 'CREATE' }),
    ];
    const problems = validateAssignments(assignments, new Set(['src/exists.ts']));
    expect(problems.get(1)).toBe('MODIFY targets a file that does not exist');
    expect(problems.get(2)).toBe('CREATE targets an existing file');
  });

  it('flags membership in a dependency cycle', () => {
    const assignments = [
      base({ id: 1, dependsOn: [2] }),
      base({ id: 2, path: 'src/b.ts', dependsOn: [1] }),
    ];
    const problems = validateAssignments(assignments, new Set(['src/a.ts', 'src/b.ts']));
    expect(problems.get(1)).toBe('dependency cycle');
    expect(problems.get(2)).toBe('dependency cycle');
  });

  it('does not flag DELETE of a missing path', () => {
    const assignments = [base({ id: 1, operation: 'DELETE', path: 'src/absent.ts' })];
    const problems = validateAssignments(assignments, new Set());
    expect(problems.size).toBe(0);
  });
});

describe('computeWaves', () => {
  const base = (overrides: Partial<FileAssignment>): FileAssignment => ({
    id: 1,
    path: 'src/a.ts',
    operation: 'MODIFY',
    contextFiles: [],
    relevantContracts: [],
    objective: 'obj',
    instructions: [],
    acceptanceCriteria: [],
    dependsOn: [],
    ...overrides,
  });

  it('layers independent assignments into one wave', () => {
    const assignments = [
      base({ id: 1, path: 'src/a.ts' }),
      base({ id: 2, path: 'src/b.ts' }),
    ];
    const waves = computeWaves(assignments);
    expect(waves).toHaveLength(1);
    expect(waves[0].map((a) => a.id).sort()).toEqual([1, 2]);
  });

  it('orders dependent assignments into sequential waves', () => {
    const assignments = [
      base({ id: 1, path: 'src/types.ts' }),
      base({ id: 2, path: 'src/consumer.ts', dependsOn: [1] }),
      base({ id: 3, path: 'src/test.ts', dependsOn: [2] }),
    ];
    const waves = computeWaves(assignments);
    expect(waves.map((w) => w.map((a) => a.id))).toEqual([[1], [2], [3]]);
  });

  it('treats dependencies on ids outside the input as satisfied', () => {
    const assignments = [base({ id: 1, dependsOn: [99] })];
    const waves = computeWaves(assignments);
    expect(waves).toHaveLength(1);
    expect(waves[0][0].id).toBe(1);
  });
});

describe('parseArbiterResponse', () => {
  it('parses review summary with assignments and an arbitrate-again marker', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'The changes look solid overall but need one fix.',
      '',
      '=== ARBITRATE AGAIN ===',
      'YES',
      '',
      '=== ASSIGNMENTS ===',
      '',
      '== ASSIGNMENT 1: MODIFY: src/fix.ts ==',
      'DEPENDS ON: none',
      'OBJECTIVE:',
      'Fix the return value.',
      'INSTRUCTIONS:',
      '- Return the mapped result',
      'ACCEPTANCE CRITERIA:',
      '- Returns mapped result',
      '',
      '=== SUMMARY ===',
      '- src/fix.ts: fixed return value',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('The changes look solid overall but need one fix.');
    expect(result.reviewSummary).not.toContain('ARBITRATE AGAIN');
    expect(result.reviewSummary).not.toContain('YES');
    expect(result.arbitrateAgain).toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].path).toBe('src/fix.ts');
    expect(result.assignments[0].operation).toBe('MODIFY');
  });

  it('parses a clean review with no assignments section', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'All requirements met and tests pass cleanly.',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('All requirements met and tests pass cleanly.');
    expect(result.assignments).toHaveLength(0);
    expect(result.arbitrateAgain).toBe(false);
  });

  it('parses a clean review with an empty assignments section', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'All good.',
      '',
      '=== ASSIGNMENTS ===',
      'NONE',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.assignments).toHaveLength(0);
    expect(result.arbitrateAgain).toBe(false);
  });

  it('parses an explicit NO arbitrate-again marker as false', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'One issue remains but no follow-up round is needed.',
      '',
      '=== ARBITRATE AGAIN ===',
      'NO',
      '',
      '=== ASSIGNMENTS ===',
      'NONE',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('One issue remains but no follow-up round is needed.');
    expect(result.arbitrateAgain).toBe(false);
    expect(result.assignments).toHaveLength(0);
  });

  it('coerces YES arbitrate-again to false when no assignments are present', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      'Needs another pass, but no concrete assignments were produced.',
      '',
      '=== ARBITRATE AGAIN ===',
      'YES',
      '',
      '=== ASSIGNMENTS ===',
      'NONE',
    ].join('\n');

    const result = parseArbiterResponse(text);
    expect(result.reviewSummary).toBe('Needs another pass, but no concrete assignments were produced.');
    expect(result.arbitrateAgain).toBe(false);
    expect(result.assignments).toHaveLength(0);
  });

  it('throws when REVIEW SUMMARY marker is missing or empty', () => {
    const text = [
      '=== REVIEW SUMMARY ===',
      '',
      '=== ASSIGNMENTS ===',
      'NONE',
    ].join('\n');
    expect(() => parseArbiterResponse(text)).toThrow(ParseError);
  });
});

describe('parseEditorResult', () => {
  it('parses DONE from the final line without a complaint', () => {
    expect(parseEditorResult('RESULT: DONE')).toEqual({ status: 'DONE', contextComplaint: undefined });
    expect(parseEditorResult('Some notes.\n\nRESULT: DONE')).toEqual({ status: 'DONE', contextComplaint: undefined });
  });

  it('treats CONTEXT COMPLAINT: NONE as no complaint', () => {
    expect(parseEditorResult('CONTEXT COMPLAINT: NONE\nRESULT: DONE')).toEqual({
      status: 'DONE',
      contextComplaint: undefined,
    });
  });

  it('parses the final context complaint for a successful result', () => {
    expect(parseEditorResult('CONTEXT COMPLAINT: missing old file\nCONTEXT COMPLAINT: needed src/helper.ts\nRESULT: DONE')).toEqual({
      status: 'DONE',
      contextComplaint: 'needed src/helper.ts',
    });
  });

  it('parses BLOCKED with complaint and reason', () => {
    expect(parseEditorResult('CONTEXT COMPLAINT: omitted src/types.ts\nRESULT: BLOCKED: cannot satisfy objective in one file')).toEqual({
      status: 'BLOCKED',
      detail: 'cannot satisfy objective in one file',
      contextComplaint: 'omitted src/types.ts',
    });
  });

  it('scans from the end and tolerates trailing prose', () => {
    const raw = 'RESULT: DONE\n\n(notes after the result line)';
    const result = parseEditorResult(raw);
    expect(result.status).toBe('DONE');
  });

  it('finds complaint and result lines surrounded by prose', () => {
    const result = parseEditorResult('Before.\nCONTEXT COMPLAINT: located src/mock.ts via grep\nAfter.\nRESULT: DONE\nTrailing.');
    expect(result).toEqual({
      status: 'DONE',
      contextComplaint: 'located src/mock.ts via grep',
    });
  });

  it('returns UNKNOWN when no RESULT line is present', () => {
    const result = parseEditorResult('Here is what I did: I modified the file.');
    expect(result.status).toBe('UNKNOWN');
  });
});
