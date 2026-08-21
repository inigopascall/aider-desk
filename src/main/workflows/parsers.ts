/**
 * Pure parsing helpers for the imperative "Dev Pipeline" workflow.
 *
 * Every parser in this module is deliberately strict: the workflow agents are
 * instructed to emit a fixed, machine-readable output contract, and these
 * functions translate that contract into typed structures. When an agent
 * deviates from the contract, a `ParseError` is thrown so the dispatch layer
 * can retry with corrective feedback.
 */

/**
 * Raised when an agent's response does not conform to its expected output
 * contract. The message is surfaced back to the agent on retry.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Result of the DIGESTER subagent's evidence sufficiency check.
 */
export type DigesterResponse =
  | { verdict: 'YES'; researchBrief: string | null; irrelevantFiles: string[] }
  | { verdict: 'NO'; investigationBrief: string; researchBrief: string | null };

/**
 * Removes a single wrapping code fence (with or without a language tag) when
 * the entire response is fenced, and trims surrounding whitespace. This makes
 * the parsers tolerant of agents that wrap their structured output in a
 * markdown code block.
 */
export function stripCodeFences(text: string): string {
  let t = text.trim();
  const fenceMatch = t.match(/^(`{3,})[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/);
  if (fenceMatch) {
    t = fenceMatch[2].trim();
  }
  return t;
}

/**
 * Locates a marker (e.g. `=== EDIT SPECS ===`) case-insensitively and
 * tolerating flexible whitespace between words. Returns the character range
 * of the match, or `null` when the marker is absent.
 */
export function findMarker(text: string, marker: string): { start: number; end: number } | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/\s+/g, '\\s+');
  const re = new RegExp(flexible, 'i');
  const match = re.exec(text);
  if (!match) {
    return null;
  }
  return { start: match.index, end: match.index + match[0].length };
}

/**
 * Returns the text between `fromIndex` and the next occurrence of
 * `stopMarker` (or the end of the string when `stopMarker` is null).
 */
export function contentUntilMarker(text: string, fromIndex: number, stopMarker: string | null): string {
  if (stopMarker) {
    const stop = findMarker(text, stopMarker);
    if (stop && stop.start >= fromIndex) {
      return text.slice(fromIndex, stop.start);
    }
  }
  return text.slice(fromIndex);
}

/**
 * Parses a list of project-relative file paths from the lines of a section.
 * Empty lines, the word `NONE`, and lines beginning with `#`, `=`, `-` or a
 * backtick are skipped, and a leading `./` is stripped from each path.
 */
export function parsePathLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.toUpperCase() === 'NONE') {
      continue;
    }
    if (/^[#=\-`]/.test(line)) {
      continue;
    }
    let p = line;
    if (p.startsWith('./')) {
      p = p.slice(2);
    }
    result.push(p);
  }
  return result;
}

/**
 * Parses the DIGESTER's verdict response.
 *
 * The first non-empty line must be `VERDICT: YES` / `YES` or
 * `VERDICT: NO` / `NO`. A YES verdict may include optional
 * `=== RESEARCH BRIEF ===` and `=== IRRELEVANT CONTEXT FILES ===` sections.
 * A NO verdict must be followed by an `=== INVESTIGATION BRIEF ===` section
 * (non-empty) and an optional `=== RESEARCH BRIEF ===` section.
 */
export function parseDigesterResponse(text: string): DigesterResponse {
  const t = stripCodeFences(text);
  const firstNonEmpty = t
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!firstNonEmpty) {
    throw new ParseError('first line must be VERDICT: YES or VERDICT: NO');
  }

  const first = firstNonEmpty.toUpperCase();
  if (first === 'VERDICT: YES' || first === 'YES') {
    const researchMarker = findMarker(t, '=== RESEARCH BRIEF ===');
    const irrelevantMarker = findMarker(t, '=== IRRELEVANT CONTEXT FILES ===');

    let researchBrief: string | null = null;
    if (researchMarker) {
      const stopMarker = irrelevantMarker && irrelevantMarker.start > researchMarker.end ? '=== IRRELEVANT CONTEXT FILES ===' : null;
      const resContent = contentUntilMarker(t, researchMarker.end, stopMarker).trim();
      if (resContent.length > 0 && resContent.toUpperCase() !== 'NONE') {
        researchBrief = resContent;
      }
    }

    let irrelevantFiles: string[] = [];
    if (irrelevantMarker) {
      const stopMarker = researchMarker && researchMarker.start > irrelevantMarker.end ? '=== RESEARCH BRIEF ===' : null;
      const irrContent = contentUntilMarker(t, irrelevantMarker.end, stopMarker);
      irrelevantFiles = parsePathLines(irrContent.split('\n'));
    }

    return { verdict: 'YES', researchBrief, irrelevantFiles };
  }

  if (first === 'VERDICT: NO' || first === 'NO') {
    const invMarker = findMarker(t, '=== INVESTIGATION BRIEF ===');
    if (!invMarker) {
      throw new ParseError('VERDICT: NO requires an === INVESTIGATION BRIEF === marker');
    }
    const investigationBrief = contentUntilMarker(t, invMarker.end, '=== RESEARCH BRIEF ===').trim();
    if (investigationBrief.length === 0) {
      throw new ParseError('INVESTIGATION BRIEF must not be empty');
    }

    let researchBrief: string | null = null;
    const resMarker = findMarker(t, '=== RESEARCH BRIEF ===');
    if (resMarker) {
      const resContent = contentUntilMarker(t, resMarker.end, null).trim();
      if (resContent.length > 0 && resContent.toUpperCase() !== 'NONE') {
        researchBrief = resContent;
      }
    }

    return { verdict: 'NO', investigationBrief, researchBrief };
  }

  throw new ParseError('first line must be VERDICT: YES or VERDICT: NO');
}

/**
 * Parses the INVESTIGATOR's file-list response.
 *
 * Requires `=== FILES TO ADD ===` followed by `=== FILES TO REMOVE ===`
 * (in that order). The lines between the markers are project-relative paths.
 */
export function parseInvestigatorResponse(text: string): { add: string[]; remove: string[] } {
  const t = stripCodeFences(text);
  const addMarker = findMarker(t, '=== FILES TO ADD ===');
  const removeMarker = findMarker(t, '=== FILES TO REMOVE ===');

  if (!addMarker || !removeMarker) {
    throw new ParseError('response must contain === FILES TO ADD === and === FILES TO REMOVE === markers');
  }
  if (removeMarker.start < addMarker.end) {
    throw new ParseError('=== FILES TO REMOVE === must appear after === FILES TO ADD ===');
  }

  const addLines = t.slice(addMarker.end, removeMarker.start).split('\n');
  const removeLines = t.slice(removeMarker.end).split('\n');

  return {
    add: parsePathLines(addLines),
    remove: parsePathLines(removeLines),
  };
}

/**
 * Extracts the content of a `## UNKNOWNS: ...` section from a plan. The
 * content runs to the next `## ` heading or the end of the text. Returns
 * `null` when the section is absent, empty, or literally `NONE`.
 */
export function extractUnknownsSection(text: string, heading: string): string | null {
  const marker = findMarker(text, heading);
  if (!marker) {
    return null;
  }
  const rest = text.slice(marker.end);
  const nextHeading = rest.search(/^##\s/m);
  const content = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  if (content.length === 0 || content.toUpperCase() === 'NONE') {
    return null;
  }
  return content;
}

/**
 * Parses the GRAND-PLANNER's implementation plan for its title and any
 * declared unknowns. Never throws: the title falls back to
 * `'Implementation Plan'` and missing/empty unknown sections become `null`.
 */
export function parsePlanUnknowns(planText: string): {
  researchUnknowns: string | null;
  codebaseUnknowns: string | null;
  title: string;
} {
  const t = stripCodeFences(planText);

  let title = 'Implementation Plan';
  const titleMatch = t.match(/#\s*IMPLEMENTATION\s*PLAN:\s*(.*)/i);
  if (titleMatch && titleMatch[1].trim().length > 0) {
    title = titleMatch[1].trim();
  }

  const researchUnknowns = extractUnknownsSection(t, '## UNKNOWNS: RESEARCH REQUIRED');
  const codebaseUnknowns = extractUnknownsSection(t, '## UNKNOWNS: CODEBASE EVIDENCE REQUIRED');

  return { researchUnknowns, codebaseUnknowns, title };
}

/**
 * The operation a single file assignment performs. DELETE assignments are
 * executed by the host (real fs.rm) and never reach an editor agent.
 */
export type AssignmentOperation = 'CREATE' | 'MODIFY' | 'DELETE';

/**
 * A single self-contained per-file assignment produced by the DECOMPOSITOR
 * or ARBITER. Each assignment is executed by an independent editor agent
 * that sees only this block plus the file's live on-disk content.
 */
export interface FileAssignment {
  /** Unique positive integer in execution order. */
  id: number;
  /** Project-relative normalized path. */
  path: string;
  operation: AssignmentOperation;
  /** Other files the editor should read before implementing this assignment. */
  contextFiles: string[];
  /** Concrete implementation facts distilled from those files and the plan. */
  relevantContracts: string[];
  /** One short paragraph describing the required end state of the file. */
  objective: string;
  /** Semantic change instructions (no exact anchors or search/replace blocks). */
  instructions: string[];
  /** Concrete, checkable criteria against the final file. */
  acceptanceCriteria: string[];
  /** Ids of assignments that must complete first; empty when independent. */
  dependsOn: number[];
}

/**
 * Parses the DECOMPOSITOR's per-file assignment response.
 *
 * Assignment headers match `== ASSIGNMENT <n>: <CREATE|MODIFY|DELETE>: <path> ==`
 * (operation case-insensitive). Everything between headers belongs to that
 * assignment. Within a block, `DEPENDS ON:` (single line), `OBJECTIVE:`,
 * `INSTRUCTIONS:` and `ACCEPTANCE CRITERIA:` start sections; `- ` lines under
 * the latter two become array items and the objective is joined free text.
 * Missing INSTRUCTIONS/ACCEPTANCE CRITERIA default to `[]`; a missing
 * OBJECTIVE for CREATE/MODIFY is a ParseError; DELETE assignments need only
 * their header. An optional `=== SUMMARY ===` section becomes the summary.
 *
 * Duplicate ids and unknown dependency ids are NOT parse errors — they are
 * validation problems handled by `validateAssignments`, so one bad assignment
 * cannot kill the whole batch.
 */
export function parseAssignmentsResponse(raw: string): { assignments: FileAssignment[]; summary: string } {
  const t = stripCodeFences(raw);
  const lines = t.split(/\r?\n/);
  const headerRegex = /^==\s*ASSIGNMENT\s+(\d+):\s*(CREATE|MODIFY|DELETE):\s*(.+?)\s*==\s*$/i;

  interface HeaderMatch {
    lineIndex: number;
    idStr: string;
    opStr: string;
    pathStr: string;
  }

  const headers: HeaderMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^==\s*ASSIGNMENT/i.test(line)) {
      const match = line.match(headerRegex);
      if (!match) {
        throw new ParseError(`malformed assignment header: ${line.trim()}`);
      }
      headers.push({
        lineIndex: i,
        idStr: match[1],
        opStr: match[2].trim(),
        pathStr: match[3],
      });
    }
  }

  if (headers.length === 0) {
    throw new ParseError('no assignments found');
  }

  // Locate the optional === SUMMARY === section so it never leaks into the
  // last assignment's body.
  let summaryLineIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^===\s*SUMMARY\s*===\s*$/i.test(lines[i].trim())) {
      summaryLineIndex = i;
      break;
    }
  }
  const summary = summaryLineIndex < lines.length ? lines.slice(summaryLineIndex + 1).join('\n').trim() : '';

  const assignments: FileAssignment[] = [];

  for (let h = 0; h < headers.length; h++) {
    const current = headers[h];
    const nextLineIndex = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
    const bodyLines = lines.slice(current.lineIndex + 1, Math.min(nextLineIndex, summaryLineIndex));

    const id = parseInt(current.idStr, 10);
    if (isNaN(id) || id <= 0) {
      throw new ParseError(`ASSIGNMENT ${current.idStr}: id must be a positive integer`);
    }

    const opLower = current.opStr.toLowerCase();
    let operation: AssignmentOperation;
    if (opLower === 'create') {
      operation = 'CREATE';
    } else if (opLower === 'modify') {
      operation = 'MODIFY';
    } else {
      operation = 'DELETE';
    }

    let normalizedPath = current.pathStr.trim().replace(/\\/g, '/');
    if (normalizedPath.startsWith('./')) {
      normalizedPath = normalizedPath.slice(2);
    }
    if (
      normalizedPath.length === 0 ||
      normalizedPath.startsWith('/') ||
      /^[A-Za-z]:/.test(normalizedPath) ||
      normalizedPath.split('/').includes('..')
    ) {
      throw new ParseError(`ASSIGNMENT ${id}: invalid file path '${current.pathStr.trim()}'`);
    }

    let dependsOn: number[] = [];
    let objective = '';
    const contextFiles: string[] = [];
    const relevantContracts: string[] = [];
    const instructions: string[] = [];
    const acceptanceCriteria: string[] = [];
    let currentSection: 'contextFiles' | 'relevantContracts' | 'objective' | 'instructions' | 'acceptance' | null = null;

    for (const rawLine of bodyLines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      const dependsMatch = line.match(/^DEPENDS\s+ON\s*:\s*(.*)$/i);
      if (dependsMatch) {
        const value = dependsMatch[1].trim();
        if (value.length > 0 && value.toUpperCase() !== 'NONE') {
          dependsOn = value
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n));
        }
        continue;
      }

      if (/^FILES\s+TO\s+READ\s+FIRST\s+FOR\s+CONTEXT\s*:\s*$/i.test(line)) {
        currentSection = 'contextFiles';
        continue;
      }
      if (/^RELEVANT\s+CONTRACTS\s+AND\s+PATTERNS\s*:\s*$/i.test(line)) {
        currentSection = 'relevantContracts';
        continue;
      }
      if (/^OBJECTIVE\s*:\s*$/i.test(line)) {
        currentSection = 'objective';
        continue;
      }
      if (/^INSTRUCTIONS\s*:\s*$/i.test(line)) {
        currentSection = 'instructions';
        continue;
      }
      if (/^ACCEPTANCE\s+CRITERIA\s*:\s*$/i.test(line)) {
        currentSection = 'acceptance';
        continue;
      }

      if (currentSection === 'contextFiles') {
        if (line.startsWith('- ')) {
          let contextPath = line.slice(2).trim().replace(/\\/g, '/');
          if (contextPath.startsWith('./')) {
            contextPath = contextPath.slice(2);
          }
          if (contextPath.length > 0 && contextPath.toUpperCase() !== 'NONE' && !contextFiles.includes(contextPath)) {
            contextFiles.push(contextPath);
          }
        }
      } else if (currentSection === 'relevantContracts') {
        if (line.startsWith('- ')) {
          const contract = line.slice(2).trim();
          if (contract.length > 0 && contract.toUpperCase() !== 'NONE') {
            relevantContracts.push(contract);
          }
        }
      } else if (currentSection === 'objective') {
        objective = objective.length === 0 ? line : `${objective} ${line}`;
      } else if (currentSection === 'instructions') {
        if (line.startsWith('- ')) {
          instructions.push(line.slice(2).trim());
        }
      } else if (currentSection === 'acceptance') {
        if (line.startsWith('- ')) {
          acceptanceCriteria.push(line.slice(2).trim());
        }
      }
    }

    if (operation !== 'DELETE' && objective.trim().length === 0) {
      throw new ParseError(`ASSIGNMENT ${id}: OBJECTIVE is required for ${operation}`);
    }

    assignments.push({
      id,
      path: normalizedPath,
      operation,
      contextFiles,
      relevantContracts,
      objective: objective.trim(),
      instructions,
      acceptanceCriteria,
      dependsOn,
    });
  }

  return { assignments, summary };
}

/**
 * Parses the ARBITER's review report.
 *
 * Requires `=== REVIEW SUMMARY ===` with non-empty content. An optional
 * `=== ASSIGNMENTS ===` section is parsed with the same block parser as the
 * decompositor; absent or empty it yields zero assignments (a clean review).
 */
export function parseArbiterResponse(text: string): { reviewSummary: string; assignments: FileAssignment[] } {
  const t = stripCodeFences(text);

  const reviewMarker = findMarker(t, '=== REVIEW SUMMARY ===');
  if (!reviewMarker) {
    throw new ParseError('response must contain === REVIEW SUMMARY === marker');
  }

  const assignmentsMarker = findMarker(t, '=== ASSIGNMENTS ===');
  const reviewEnd = assignmentsMarker && assignmentsMarker.start >= reviewMarker.end ? assignmentsMarker.start : t.length;
  const reviewSummary = t.slice(reviewMarker.end, reviewEnd).trim();
  if (reviewSummary.length === 0) {
    throw new ParseError('=== REVIEW SUMMARY === must not be empty');
  }

  let assignments: FileAssignment[] = [];
  if (assignmentsMarker) {
    const body = t.slice(assignmentsMarker.end).trim();
    if (body.length > 0 && body.toUpperCase() !== 'NONE') {
      assignments = parseAssignmentsResponse(body).assignments;
    }
  }

  return { reviewSummary, assignments };
}

/**
 * Renders one assignment block in exactly the input format (header, DEPENDS
 * ON, OBJECTIVE, bulleted INSTRUCTIONS, bulleted ACCEPTANCE CRITERIA) for
 * embedding into editor prompts and target tables.
 */
export function serializeAssignment(a: FileAssignment): string {
  return [
    `== ASSIGNMENT ${a.id}: ${a.operation}: ${a.path} ==`,
    `DEPENDS ON: ${a.dependsOn.length > 0 ? a.dependsOn.join(', ') : 'none'}`,
    'FILES TO READ FIRST FOR CONTEXT:',
    ...(a.contextFiles.length > 0 ? a.contextFiles.map((filePath) => `- ${filePath}`) : ['- NONE']),
    'RELEVANT CONTRACTS AND PATTERNS:',
    ...(a.relevantContracts.length > 0 ? a.relevantContracts.map((contract) => `- ${contract}`) : ['- NONE']),
    'OBJECTIVE:',
    a.objective,
    'INSTRUCTIONS:',
    ...a.instructions.map((i) => `- ${i}`),
    'ACCEPTANCE CRITERIA:',
    ...a.acceptanceCriteria.map((c) => `- ${c}`),
  ].join('\n');
}

/**
 * Validates a batch of assignments against each other and against the current
 * disk state. Returns a map of assignment id -> problem description.
 *
 * Problems: duplicate id, duplicate path (second and later occurrences),
 * dependsOn referencing a nonexistent id or itself, membership in a
 * dependency cycle, MODIFY of a missing file, and CREATE of an existing file.
 * DELETE of a missing path is NOT a problem — it is handled idempotently at
 * runtime.
 */
export function validateAssignments(assignments: FileAssignment[], existingPaths: Set<string>): Map<number, string> {
  const problems = new Map<number, string>();
  const seenIds = new Set<number>();
  const seenPaths = new Set<string>();
  const ids = new Set(assignments.map((a) => a.id));

  for (const a of assignments) {
    if (seenIds.has(a.id)) {
      problems.set(a.id, 'duplicate assignment id');
    }
    seenIds.add(a.id);

    if (seenPaths.has(a.path)) {
      problems.set(a.id, 'duplicate path');
    }
    seenPaths.add(a.path);

    for (const dep of a.dependsOn) {
      if (dep === a.id) {
        problems.set(a.id, 'assignment depends on itself');
      } else if (!ids.has(dep)) {
        problems.set(a.id, `depends on nonexistent assignment ${dep}`);
      }
    }

    if (a.operation === 'MODIFY' && !existingPaths.has(a.path)) {
      problems.set(a.id, 'MODIFY targets a file that does not exist');
    }
    if (a.operation === 'CREATE' && existingPaths.has(a.path)) {
      problems.set(a.id, 'CREATE targets an existing file');
    }
  }

  // Dependency cycle detection via Kahn's algorithm residue: every node that
  // cannot be resolved is part of a cycle.
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const a of assignments) {
    indegree.set(a.id, 0);
    dependents.set(a.id, []);
  }
  for (const a of assignments) {
    for (const dep of a.dependsOn) {
      if (dep === a.id || !ids.has(dep)) {
        continue;
      }
      indegree.set(a.id, (indegree.get(a.id) ?? 0) + 1);
      dependents.get(dep)?.push(a.id);
    }
  }

  const queue: number[] = [];
  for (const [id, deg] of indegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }
  const resolved = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    resolved.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
      }
    }
  }

  for (const a of assignments) {
    if (!resolved.has(a.id)) {
      problems.set(a.id, 'dependency cycle');
    }
  }

  return problems;
}

/**
 * Kahn topological layering over the supplied (already-validated) assignments.
 * Dependencies on ids not present in the input are treated as satisfied.
 * Assumes cycle-free input (guaranteed by `validateAssignments` filtering).
 */
export function computeWaves(assignments: FileAssignment[]): FileAssignment[][] {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const a of assignments) {
    indegree.set(a.id, 0);
    dependents.set(a.id, []);
  }
  for (const a of assignments) {
    for (const dep of a.dependsOn) {
      if (!byId.has(dep)) {
        continue; // dependency outside the input is already satisfied
      }
      indegree.set(a.id, (indegree.get(a.id) ?? 0) + 1);
      dependents.get(dep)?.push(a.id);
    }
  }

  const waves: FileAssignment[][] = [];
  const remaining = new Set(assignments.map((a) => a.id));

  while (remaining.size > 0) {
    const wave: FileAssignment[] = [];
    for (const id of remaining) {
      if ((indegree.get(id) ?? 0) === 0) {
        wave.push(byId.get(id)!);
      }
    }
    if (wave.length === 0) {
      break; // cycle — should not happen with validated input
    }
    waves.push(wave);
    for (const a of wave) {
      remaining.delete(a.id);
      for (const dependent of dependents.get(a.id) ?? []) {
        indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
      }
    }
  }

  return waves;
}

/**
 * Scans an editor response from the end for the first `RESULT: DONE` or
 * `RESULT: BLOCKED: <reason>` line. No match yields `UNKNOWN`. Never throws —
 * structural validation of the actual file state is the real gate.
 */
export function parseEditorResult(raw: string): {
  status: 'DONE' | 'BLOCKED' | 'UNKNOWN';
  detail?: string;
  contextComplaint?: string;
} {
  const lines = raw.split(/\r?\n/);
  let contextComplaint: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].trim().match(/^CONTEXT\s+COMPLAINT:\s*(.*)$/i);
    if (match) {
      const complaint = match[1].trim();
      if (complaint.length > 0 && complaint.toUpperCase() !== 'NONE') {
        contextComplaint = complaint;
      }
      break;
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].trim().match(/^RESULT:\s*(DONE|BLOCKED)(?::\s*(.*))?$/i);
    if (match) {
      const status = match[1].toUpperCase() as 'DONE' | 'BLOCKED';
      const detail = match[2]?.trim();
      return { status, detail: detail || undefined, contextComplaint };
    }
  }
  return { status: 'UNKNOWN', contextComplaint };
}
