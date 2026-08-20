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

export const DELETE_MARKER = '[DEPRECATED: PLEASE DELETE]';

/**
 * A single per-file edit instruction produced by the DECOMPOSITOR or ARBITER.
 */
export interface FileEditInstruction {
  /** Unique positive integer in execution order. */
  id: number;
  /** Project-relative normalized path. */
  path: string;
  /** create → NEW, edit → EDIT, delete → DELETE. */
  type: 'NEW' | 'EDIT' | 'DELETE';
  /** Exact instructions with code snippet and anchor. */
  instructions: string;
}

/**
 * Report produced by the ARBITER subagent after code review.
 */
export interface ArbiterReport {
  reviewSummary: string;
  edits: FileEditInstruction[];
  editsSummary: string | null;
  raw: string;
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
 * Parses a series of `== EDIT <id>: <create|edit|delete>: <path> ==` blocks
 * from a text section. Shared by DECOMPOSITOR and ARBITER parsers.
 */
export function parseEditSpecBlocks(sectionText: string): FileEditInstruction[] {
  const lines = sectionText.split(/\r?\n/);
  const headerRegex = /^==\s*EDIT\s+(\d+)\s*:\s*(.+?)\s*:\s*(.+?)\s*==\s*$/i;

  interface HeaderMatch {
    lineIndex: number;
    idStr: string;
    opStr: string;
    pathStr: string;
  }

  const headers: HeaderMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRegex);
    if (match) {
      headers.push({
        lineIndex: i,
        idStr: match[1],
        opStr: match[2].trim(),
        pathStr: match[3],
      });
    }
  }

  if (headers.length === 0) {
    return [];
  }

  const seenIds = new Set<number>();
  const edits: FileEditInstruction[] = [];

  for (let h = 0; h < headers.length; h++) {
    const current = headers[h];
    const nextLineIndex = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
    const bodyLines = lines.slice(current.lineIndex + 1, nextLineIndex);
    const instructions = bodyLines.join('\n').trim();

    const id = parseInt(current.idStr, 10);
    if (isNaN(id) || id <= 0) {
      throw new ParseError(`EDIT ${current.idStr}: id must be a positive integer`);
    }
    if (seenIds.has(id)) {
      throw new ParseError(`EDIT ${id}: duplicate edit id`);
    }
    seenIds.add(id);

    const opLower = current.opStr.toLowerCase();
    let type: 'NEW' | 'EDIT' | 'DELETE';
    if (opLower === 'create') {
      type = 'NEW';
    } else if (opLower === 'edit') {
      type = 'EDIT';
    } else if (opLower === 'delete') {
      type = 'DELETE';
    } else {
      throw new ParseError(`EDIT ${id}: unknown operation '${current.opStr}'`);
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
      throw new ParseError(`EDIT ${id}: invalid file path '${current.pathStr.trim()}'`);
    }

    if (instructions.length === 0) {
      throw new ParseError(`EDIT ${id}: instructions must not be empty`);
    }

    edits.push({
      id,
      path: normalizedPath,
      type,
      instructions,
    });
  }

  return edits;
}

/**
 * Parses the DECOMPOSITOR's response.
 *
 * Requires `=== EDIT SPECS ===` and `=== EDITS SUMMARY ===` markers.
 * At least one edit spec is required, and the summary section must not be empty or NONE.
 */
export function parseDecompositorResponse(text: string): { edits: FileEditInstruction[]; summary: string } {
  const t = stripCodeFences(text);
  const specsMarker = findMarker(t, '=== EDIT SPECS ===');
  const summaryMarker = findMarker(t, '=== EDITS SUMMARY ===');

  if (!specsMarker || !summaryMarker) {
    throw new ParseError('response must contain === EDIT SPECS === and === EDITS SUMMARY === markers');
  }
  if (summaryMarker.start < specsMarker.end) {
    throw new ParseError('=== EDITS SUMMARY === must appear after === EDIT SPECS ===');
  }

  const specsText = t.slice(specsMarker.end, summaryMarker.start);
  const edits = parseEditSpecBlocks(specsText);
  if (edits.length === 0) {
    throw new ParseError('at least one edit specification is required');
  }

  const summaryText = t.slice(summaryMarker.end).trim();
  if (summaryText.length === 0 || summaryText.toUpperCase() === 'NONE') {
    throw new ParseError('=== EDITS SUMMARY === must not be empty or NONE');
  }

  return { edits, summary: summaryText };
}

/**
 * Parses the ARBITER's review report.
 *
 * Requires `=== REVIEW SUMMARY ===` with non-empty content.
 * An `=== EDIT SPECS ===` section containing NONE or empty yields zero edits.
 * When edits exist, `=== EDITS SUMMARY ===` is required and must not be empty/NONE.
 */
export function parseArbiterResponse(text: string): ArbiterReport {
  const raw = text;
  const t = stripCodeFences(text);

  const reviewMarker = findMarker(t, '=== REVIEW SUMMARY ===');
  if (!reviewMarker) {
    throw new ParseError('response must contain === REVIEW SUMMARY === marker');
  }

  const specsMarker = findMarker(t, '=== EDIT SPECS ===');
  const summaryMarker = findMarker(t, '=== EDITS SUMMARY ===');

  const reviewEnd = specsMarker && specsMarker.start >= reviewMarker.end ? specsMarker.start : t.length;
  const reviewSummary = t.slice(reviewMarker.end, reviewEnd).trim();
  if (reviewSummary.length === 0) {
    throw new ParseError('=== REVIEW SUMMARY === must not be empty');
  }

  let edits: FileEditInstruction[] = [];
  if (specsMarker) {
    const specsEnd = summaryMarker && summaryMarker.start >= specsMarker.end ? summaryMarker.start : t.length;
    const specsContent = t.slice(specsMarker.end, specsEnd).trim();
    if (specsContent.length > 0 && specsContent.toUpperCase() !== 'NONE') {
      edits = parseEditSpecBlocks(specsContent);
    }
  }

  let editsSummary: string | null = null;
  if (edits.length > 0) {
    if (!summaryMarker) {
      throw new ParseError('=== EDITS SUMMARY === is required when edits are present');
    }
    const sumContent = t.slice(summaryMarker.end).trim();
    if (sumContent.length === 0 || sumContent.toUpperCase() === 'NONE') {
      throw new ParseError('=== EDITS SUMMARY === must not be empty or NONE when edits are present');
    }
    editsSummary = sumContent;
  } else {
    if (summaryMarker) {
      const sumContent = t.slice(summaryMarker.end).trim();
      if (sumContent.length > 0 && sumContent.toUpperCase() !== 'NONE') {
        editsSummary = sumContent;
      }
    }
  }

  return {
    reviewSummary,
    edits,
    editsSummary,
    raw,
  };
}

/**
 * Serializes a list of FileEditInstruction items into standard spec format.
 */
export function serializeFileEdits(edits: FileEditInstruction[]): string {
  return edits
    .map((edit) => {
      const op = edit.type === 'NEW' ? 'create' : edit.type === 'EDIT' ? 'edit' : 'delete';
      return `== EDIT ${edit.id}: ${op}: ${edit.path} ==\n${edit.instructions}`;
    })
    .join('\n\n');
}

/**
 * Validates logical chains of edits per file path against existing disk state.
 * Returns a map of path -> problem description.
 */
export function validateEditChains(edits: FileEditInstruction[], existingPaths: Set<string>): Map<string, string> {
  const chains = new Map<string, FileEditInstruction[]>();
  for (const edit of edits) {
    const list = chains.get(edit.path);
    if (list) {
      list.push(edit);
    } else {
      chains.set(edit.path, [edit]);
    }
  }

  const problems = new Map<string, string>();

  for (const [path, chain] of chains.entries()) {
    const fileExists = existingPaths.has(path);
    const firstOp = chain[0].type;

    if (!fileExists && firstOp !== 'NEW') {
      problems.set(path, 'file does not exist and the first edit is not a create');
      continue;
    }

    if (fileExists && chain.some((e) => e.type === 'NEW')) {
      problems.set(path, 'create targets an existing file');
      continue;
    }

    const createCount = chain.filter((e) => e.type === 'NEW').length;
    if (createCount > 1) {
      problems.set(path, 'multiple create edits for one file');
      continue;
    }

    if (createCount === 1 && chain[0].type !== 'NEW') {
      problems.set(path, 'create must be the first edit for the file');
      continue;
    }

    let seenDelete = false;
    let editAfterDelete = false;
    for (const edit of chain) {
      if (seenDelete) {
        editAfterDelete = true;
        break;
      }
      if (edit.type === 'DELETE') {
        seenDelete = true;
      }
    }
    if (editAfterDelete) {
      problems.set(path, 'edit follows a delete in the same chain');
      continue;
    }
  }

  return problems;
}

/**
 * Parses the EDITOR's one-line outcome response. Lenient and never throws:
 * a response starting with `DONE` maps to DONE, one starting with `FAILED`
 * maps to FAILED (with the remainder as detail), and anything else maps to
 * UNKNOWN with the first 200 characters as detail.
 */
export function parseEditorResponse(text: string): { outcome: 'DONE' | 'FAILED' | 'UNKNOWN'; detail?: string } {
  const t = stripCodeFences(text).trim();
  const lines = t.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase() === 'DONE') {
      return { outcome: 'DONE' };
    }
    const failedMatch = trimmed.match(/^FAILED\s*[:\s]\s*(.*)$/i);
    if (failedMatch) {
      const detail = failedMatch[1].trim();
      return { outcome: 'FAILED', detail: detail || undefined };
    }
  }

  return { outcome: 'UNKNOWN', detail: t.slice(0, 200) };
}
