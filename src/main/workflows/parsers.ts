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
 * A single per-file edit instruction produced by the DECOMPOSITOR (and
 * re-emitted by the CONFIRMER for corrective passes).
 */
export interface FileEditInstruction {
  /** Project-relative path of the file to create or edit. */
  path: string;
  /** `NEW` = write the full file content; `EDIT` = apply precise edit steps. */
  type: 'NEW' | 'EDIT';
  /** Full file content (NEW) or ordered, executor-ready edit commands (EDIT). */
  instructions: string;
}

/**
 * Removes a single wrapping code fence (with or without a language tag) when
 * the entire response is fenced, and trims surrounding whitespace. This makes
 * the parsers tolerant of agents that wrap their structured output in a
 * markdown code block.
 */
function stripCodeFences(text: string): string {
  let t = text.trim();
  const fenceMatch = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    t = fenceMatch[1].trim();
  }
  return t;
}

/**
 * Locates a marker (e.g. `=== FILES TO ADD ===`) case-insensitively and
 * tolerating flexible whitespace between words. Returns the character range
 * of the match, or `null` when the marker is absent.
 */
function findMarker(text: string, marker: string): { start: number; end: number } | null {
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
function contentUntilMarker(text: string, fromIndex: number, stopMarker: string | null): string {
  if (stopMarker) {
    const stop = findMarker(text, stopMarker);
    if (stop && stop.start >= fromIndex) {
      return text.slice(fromIndex, stop.start);
    }
  }
  return text.slice(fromIndex);
}

/**
 * Splits `text` on every occurrence of `marker`, returning the segments that
 * follow each marker. The leading segment (before the first marker) is
 * dropped, as it typically holds preamble or the AMBIGUITIES section.
 */
function splitOnMarker(text: string, marker: string): string[] {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexible = escaped.replace(/\s+/g, '\\s+');
  const re = new RegExp(flexible, 'gi');
  return text.split(re).slice(1);
}

/**
 * Parses a list of project-relative file paths from the lines of a section.
 * Empty lines, the word `NONE`, and lines beginning with `#`, `=`, `-` or a
 * backtick are skipped, and a leading `./` is stripped from each path.
 */
function parsePathLines(lines: string[]): string[] {
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
 * `VERDICT: NO` / `NO`. A `NO` verdict must be followed by an
 * `=== INVESTIGATION BRIEF ===` section (non-empty) and an optional
 * `=== RESEARCH BRIEF ===` section whose content of `NONE` (or absence)
 * maps to `null`.
 */
export function parseDigesterResponse(
  text: string,
): { verdict: 'YES' } | { verdict: 'NO'; investigationBrief: string; researchBrief: string | null } {
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
    return { verdict: 'YES' };
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

export interface VerifierReport {
  verdict: 'ALIGNED' | 'MISALIGNED';
  findings: string;
  areasSound: string;
  raw: string;
}

export function parseVerifierResponse(text: string): VerifierReport {
  const raw = text;
  const t = stripCodeFences(text);
  const verdictMarker = findMarker(t, '=== VERDICT ===');
  const findingsMarker = findMarker(t, '=== FINDINGS ===');
  const areasMarker = findMarker(t, '=== AREAS SOUND ===');

  if (!verdictMarker || !findingsMarker) {
    throw new ParseError('response must contain === VERDICT === followed by ALIGNED or MISALIGNED');
  }

  const verdictLine = t
    .slice(verdictMarker.end)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const verdict = verdictLine?.toUpperCase();
  if (verdict !== 'ALIGNED' && verdict !== 'MISALIGNED') {
    throw new ParseError('response must contain === VERDICT === followed by ALIGNED or MISALIGNED');
  }

  const findingsEnd = areasMarker && areasMarker.start >= findingsMarker.end ? areasMarker.start : t.length;
  const findingsText = t.slice(findingsMarker.end, findingsEnd).trim();
  const findings = findingsText.length === 0 || findingsText.toUpperCase() === 'NONE' ? '' : findingsText;

  if (verdict === 'MISALIGNED' && findings.length === 0) {
    throw new ParseError('MISALIGNED verdict requires a non-empty FINDINGS section');
  }

  const areasSound = areasMarker ? t.slice(areasMarker.end).trim() : '';

  return {
    verdict,
    findings,
    areasSound,
    raw,
  };
}

export interface ReviewerReport {
  findings: string;
  considerations: string | null;
  rectificationPlan: string | null;
  raw: string;
}

export function parseReviewerResponse(text: string): ReviewerReport {
  const raw = text;
  const t = stripCodeFences(text);
  const findingsMarker = findMarker(t, '=== FINDINGS ===');
  const considerationsMarker = findMarker(t, '=== CONSIDERATIONS ===');
  const planMarker = findMarker(t, '=== RECTIFICATION PLAN ===');

  if (!findingsMarker) {
    throw new ParseError('response must contain a non-empty === FINDINGS === section');
  }
  if (!planMarker) {
    throw new ParseError('response must contain === RECTIFICATION PLAN ===');
  }

  const findingsEnd =
    [considerationsMarker, planMarker]
      .filter((marker): marker is { start: number; end: number } => !!marker && marker.start >= findingsMarker.end)
      .sort((a, b) => a.start - b.start)[0]?.start ?? t.length;
  const findings = t.slice(findingsMarker.end, findingsEnd).trim();

  if (!findings || findings.toUpperCase() === 'NONE') {
    throw new ParseError('response must contain a non-empty === FINDINGS === section');
  }

  const considerationsEnd = planMarker.start >= (considerationsMarker?.end ?? 0) ? planMarker.start : t.length;
  const considerationsText = considerationsMarker ? t.slice(considerationsMarker.end, considerationsEnd).trim() : '';
  const considerations =
    considerationsText.length === 0 || ['NONE', 'N/A'].includes(considerationsText.toUpperCase()) ? null : considerationsText;

  const planText = t.slice(planMarker.end).trim();
  const rectificationPlan =
    planText.length === 0 || ['NONE', 'N/A'].includes(planText.toUpperCase()) ? null : planText;

  return {
    findings,
    considerations,
    rectificationPlan,
    raw,
  };
}

/**
 * Extracts the content of a `## UNKNOWNS: ...` section from a plan. The
 * content runs to the next `## ` heading or the end of the text. Returns
 * `null` when the section is absent, empty, or literally `NONE`.
 */
function extractUnknownsSection(text: string, heading: string): string | null {
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
 * Parses a single `=== FILE EDIT ===` block into a `FileEditInstruction`.
 * The block must contain, in order: a non-empty `PATH:` line, a `TYPE:` line
 * whose value is `NEW` or `EDIT`, an `INSTRUCTIONS:` marker, and then the
 * instruction content up to `=== END FILE EDIT ===` (or the end of the
 * block). Any violation throws a `ParseError` naming the offending block.
 */
function parseFileEditBlock(block: string, index: number): FileEditInstruction {
  const lines = block.split('\n');

  const pathLineIdx = lines.findIndex((l) => /^\s*PATH\s*:/i.test(l));
  if (pathLineIdx === -1) {
    throw new ParseError(`FILE EDIT block ${index + 1}: missing PATH line`);
  }
  const pathRaw = lines[pathLineIdx].replace(/^\s*PATH\s*:\s*/i, '').trim();
  if (pathRaw.length === 0) {
    throw new ParseError(`FILE EDIT block ${index + 1}: PATH must not be empty`);
  }
  let path = pathRaw;
  if (path.startsWith('./')) {
    path = path.slice(2);
  }

  const typeLineIdx = lines.findIndex((l, i) => i > pathLineIdx && /^\s*TYPE\s*:/i.test(l));
  if (typeLineIdx === -1) {
    throw new ParseError(`FILE EDIT block ${index + 1}: missing TYPE line`);
  }
  const typeRaw = lines[typeLineIdx].replace(/^\s*TYPE\s*:\s*/i, '').trim().toUpperCase();
  if (typeRaw !== 'NEW' && typeRaw !== 'EDIT') {
    throw new ParseError(`FILE EDIT block ${index + 1}: TYPE must be NEW or EDIT (got '${typeRaw}')`);
  }

  const instrIdx = lines.findIndex((l, i) => i > typeLineIdx && /^\s*INSTRUCTIONS\s*:/i.test(l));
  if (instrIdx === -1) {
    throw new ParseError(`FILE EDIT block ${index + 1}: missing INSTRUCTIONS marker`);
  }

  // Content is whatever follows the INSTRUCTIONS colon (same line or below),
  // up to the `=== END FILE EDIT ===` terminator or the end of the block.
  const afterColon = lines[instrIdx].replace(/^\s*INSTRUCTIONS\s*:\s*/i, '');
  const restLines = lines.slice(instrIdx + 1);
  const endIdx = restLines.findIndex((l) => /^\s*=== END FILE EDIT ===\s*$/i.test(l));
  const body = endIdx === -1 ? restLines : restLines.slice(0, endIdx);
  const instructions = [afterColon, ...body].join('\n').trim();

  return { path, type: typeRaw as 'NEW' | 'EDIT', instructions };
}

/**
 * Parses a response containing an optional `=== AMBIGUITIES ===` section
 * followed by zero or more `=== FILE EDIT ===` blocks.
 */
export function parseFileEditBlocks(text: string): { ambiguities: string | null; edits: FileEditInstruction[] } {
  const t = stripCodeFences(text);

  // Ambiguities section: content between the AMBIGUITIES marker and the first
  // FILE EDIT marker (or the end of the text).
  let ambiguities: string | null = null;
  const ambMarker = findMarker(t, '=== AMBIGUITIES ===');
  if (ambMarker) {
    const firstEdit = findMarker(t, '=== FILE EDIT ===');
    const end = firstEdit && firstEdit.start >= ambMarker.end ? firstEdit.start : t.length;
    const content = t.slice(ambMarker.end, end).trim();
    if (content.length > 0 && content.toUpperCase() !== 'NONE') {
      ambiguities = content;
    }
  }

  const blocks = splitOnMarker(t, '=== FILE EDIT ===');
  const edits: FileEditInstruction[] = [];
  for (let i = 0; i < blocks.length; i++) {
    edits.push(parseFileEditBlock(blocks[i], i));
  }

  return { ambiguities, edits };
}

/**
 * Parses the DECOMPOSITOR's response. Identical to `parseFileEditBlocks`
 * except that at least one `FILE EDIT` block is required.
 */
export function parseDecompositorResponse(text: string): { ambiguities: string | null; edits: FileEditInstruction[] } {
  const result = parseFileEditBlocks(text);
  if (result.edits.length === 0) {
    throw new ParseError('at least one FILE EDIT block is required');
  }
  return result;
}

/**
 * Parses the CONFIRMER's verdict response.
 *
 * Requires an `=== VERDICT ===` marker followed by `ALIGNED` or `DEFICIENT`
 * on the next non-empty line. A `DEFICIENT` verdict must be accompanied by
 * at least one corrective `FILE EDIT` block.
 */
export function parseConfirmerResponse(
  text: string,
): { verdict: 'ALIGNED' } | { verdict: 'DEFICIENT'; edits: FileEditInstruction[] } {
  const t = stripCodeFences(text);

  const verdictMarker = findMarker(t, '=== VERDICT ===');
  if (!verdictMarker) {
    throw new ParseError('response must contain === VERDICT === marker');
  }

  const nextLine = t
    .slice(verdictMarker.end)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!nextLine) {
    throw new ParseError('VERDICT must be followed by ALIGNED or DEFICIENT');
  }

  const verdict = nextLine.toUpperCase();
  if (verdict === 'ALIGNED') {
    return { verdict: 'ALIGNED' };
  }
  if (verdict === 'DEFICIENT') {
    const { edits } = parseFileEditBlocks(t);
    if (edits.length === 0) {
      throw new ParseError('DEFICIENT verdict requires at least one FILE EDIT block');
    }
    return { verdict: 'DEFICIENT', edits };
  }

  throw new ParseError(`VERDICT must be ALIGNED or DEFICIENT (got '${nextLine}')`);
}

/**
 * Parses the EDITOR's one-line outcome response. Lenient and never throws:
 * a response starting with `DONE` maps to DONE, one starting with `FAILED`
 * maps to FAILED (with the remainder as detail), and anything else maps to
 * UNKNOWN with the first 200 characters as detail.
 */
export function parseEditorResponse(text: string): { outcome: 'DONE' | 'FAILED' | 'UNKNOWN'; detail?: string } {
  const t = stripCodeFences(text).trim();

  if (t.toUpperCase().startsWith('DONE')) {
    return { outcome: 'DONE' };
  }
  if (t.toUpperCase().startsWith('FAILED')) {
    const detail = t
      .slice('FAILED'.length)
      .replace(/^[\s:]*/, '')
      .trim();
    return { outcome: 'FAILED', detail: detail || undefined };
  }
  return { outcome: 'UNKNOWN', detail: t.slice(0, 200) };
}

/**
 * Re-emits a list of file edits in the canonical `=== FILE EDIT ===` block
 * format. Used to hand edits to the CONFIRMER and to re-hand CONFIRMER-
 * produced corrective edits to the EDITORs.
 */
export function serializeFileEdits(edits: FileEditInstruction[]): string {
  return edits
    .map((edit) => {
      return ['=== FILE EDIT ===', `PATH: ${edit.path}`, `TYPE: ${edit.type}`, 'INSTRUCTIONS:', edit.instructions, '=== END FILE EDIT ==='].join(
        '\n',
      );
    })
    .join('\n\n');
}
