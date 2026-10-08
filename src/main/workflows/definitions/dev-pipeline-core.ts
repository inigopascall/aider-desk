import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

import { fileExists } from '@common/node-utils';

import { Task } from '@/task';
import { WorkflowCancelled, WorkflowError, WorkflowTimeout } from '../dispatch';
import { WorkflowLogger, WorkflowRunContext } from '../types';
import {
  type AssignmentOutcome,
  type EvidenceRow,
  type FileChangeRow,
  type Journey,
  type ReportState,
} from '../journey';
import {
  formatAssignmentBatchSummary,
  formatAssignmentTargets,
  formatContextChange,
  formatEvidenceInsufficient,
  formatEvidenceSufficient,
  formatJourneyReport,
  formatCheckpointReport,
  formatConfirmerReport,
  formatPlanProduced,
  formatPlanUnknowns,
  formatResearchReceived,
} from '../reporting';
import {
  type FileAssignment,
  computeWaves,
  parseAssignmentsResponse,
  parseDigesterResponse,
  parseEditorResult,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeAssignment,
  validateAssignments,
} from '../parsers';

import { runValidationCommand } from '../bash-command';
import { buildPrompt, PromptSection } from '../prompt-formatting';
import { withGitRetry } from '../git-utils';

export const AGENTS = {
  digester: 'DIGESTER',
  investigator: 'INVESTIGATOR',
  researcher: 'RESEARCHER',
  planner: 'GRAND-PLANNER',
  decompositor: 'DECOMPOSITOR',
  editor: 'EDITOR',
  reviewer: 'REVIEWER',
  arbiter: 'ARBITER',
  confirmer: 'CONFIRMER',
} as const;

export const MAX_EVIDENCE_ITERATIONS = 3;
export const MAX_DIFF_CHARS = 80_000;
export const MAX_RESEARCH_DOC_CHARS = 30_000;
export const MAX_REVIEW_DIFF_CHARS = 60_000;
export const EDITOR_TIMEOUT_MS = 10 * 60_000;

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolves a validated project-relative assignment path against the task's
 * effective working directory for host-side filesystem operations only.
 * The resolved path must never be exposed to workflow agents.
 */
export function resolveAssignmentTarget(taskDir: string, assignmentPath: string): string {
  const normalizedTaskDir = path.resolve(taskDir);
  const normalizedAssignmentPath = normalizePath(assignmentPath.trim());

  if (
    normalizedAssignmentPath.length === 0 ||
    path.isAbsolute(normalizedAssignmentPath) ||
    normalizedAssignmentPath.split('/').includes('..')
  ) {
    throw new WorkflowError(`Invalid assignment target '${assignmentPath}'`);
  }

  const absolutePath = path.resolve(normalizedTaskDir, normalizedAssignmentPath);
  const relativePath = path.relative(normalizedTaskDir, absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new WorkflowError(`Assignment target escapes the task directory: '${assignmentPath}'`);
  }

  return absolutePath;
}

export function parseChangedPaths(raw: string): string[] {
  return raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith('./') ? entry.slice(2) : entry))
    .map(normalizePath);
}

/**
 * Builds the conversation section for agent prompts.
 */
export function conversationSection(ctx: WorkflowRunContext): PromptSection {
  return {
    title: 'CONVERSATION HISTORY',
    body: ctx.conversationText,
  };
}

export async function prepareRepository(task: Task): Promise<{ git: SimpleGit; baselineCommit: string; warnings: string[] }> {
  const git = simpleGit(task.getTaskDir());
  if (!(await git.checkIsRepo())) {
    throw new WorkflowError('The task directory is not a git repository. The Dev Pipeline requires git.');
  }
  const warnings: string[] = [];
  const status = await withGitRetry(() => git.status(), { name: 'status' });
  if (!status.isClean()) {
    try {
      await withGitRetry(async () => { await git.add('-A'); await git.raw(['commit', '--no-verify', '-m', '[dev-pipeline] pre-edit snapshot']); }, { name: 'pre-edit snapshot commit' });
    } catch (error) {
      warnings.push(`Pre-edit snapshot commit failed after retries: ${error instanceof Error ? error.message : String(error)}. Baseline may include pre-existing uncommitted changes.`);
    }
  }
  return { git, baselineCommit: (await withGitRetry(() => git.revparse(['HEAD']), { name: 'baseline commit' })).trim(), warnings };
}

export async function getCumulativeDiff(git: SimpleGit, fromCommit: string, maxChars: number): Promise<string> {
  let diff = await withGitRetry(() => git.raw(['diff', fromCommit]), { name: 'cumulative diff' });
  if (diff.length > maxChars) diff = diff.slice(0, maxChars) + '\n…[diff truncated]';
  return diff;
}

/** Single funnel for every workflow progress message. Keeps the channel and level consistent. */
export async function emitInfo(log: WorkflowLogger, message: string): Promise<void> {
  await log.info(message);
}

export async function emitCheckpoint(ctx: WorkflowRunContext, journey: Journey, workflowName: string, label: string): Promise<void> {
  await ctx.log.summary(formatCheckpointReport(journey, workflowName, label), 'checkpoint', label);
}

export async function reconfigureContext(
  ctx: WorkflowRunContext,
  journey: Journey,
  label: string,
  addPaths: string[],
  removePaths: string[] = [],
): Promise<{ added: string[]; removed: string[]; skipped: string[] }> {
  const task = ctx.task;
  const added: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];

  for (const raw of addPaths) {
    const filePath = normalizePath(raw);
    if (!(await fileExists(path.resolve(task.getTaskDir(), filePath)))) {
      skipped.push(filePath);
      continue;
    }
    const wasAdded = await task.addFiles({ path: filePath, readOnly: false });
    if (wasAdded) {
      added.push(filePath);
    }
  }

  if (removePaths.length > 0) {
    const current = new Set((await task.getContextFiles()).map((file) => normalizePath(file.path)));
    for (const raw of removePaths) {
      const filePath = normalizePath(raw);
      if (added.includes(filePath) || !current.has(filePath)) {
        continue;
      }
      await task.dropFile(filePath);
      removed.push(filePath);
    }
  }

  journey.filesAdded.push(...added);
  journey.filesRemoved.push(...removed);
  journey.filesSkipped.push(...skipped);

  if (added.length > 0 || removed.length > 0) {
    journey.contextChanges.push({ label, added, removed, skipped });
    await emitInfo(ctx.log, formatContextChange(label, added, removed, skipped));
  }

  return { added, removed, skipped };
}

export async function collectDiffStats(
  git: SimpleGit,
  fromRef: string,
  toRef: string | undefined,
  onRetry?: (attempt: number, message: string) => void,
): Promise<Map<string, { insertions: number; deletions: number }>> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  try {
    const summary = await withGitRetry(
      () => git.diffSummary(toRef ? [fromRef, toRef] : [fromRef]),
      { name: 'diff statistics', onRetry },
    );
    for (const file of summary.files) {
      const insertions = 'insertions' in file ? file.insertions : 0;
      const deletions = 'deletions' in file ? file.deletions : 0;
      stats.set(normalizePath(file.file), { insertions, deletions });
    }
  } catch {
    // Binary-only or first-commit edge cases must never break the pipeline.
  }
  return stats;
}

export function buildAssignmentRows(
  outcomes: AssignmentOutcome[],
  changedPaths: string[],
  stats: Map<string, { insertions: number; deletions: number }>,
): FileChangeRow[] {
  const changed = new Set(changedPaths);
  const rows: FileChangeRow[] = [];

  // Group by path and take the LAST outcome for that path
  const lastOutcomeByPath = new Map<string, AssignmentOutcome>();
  for (const outcome of outcomes) {
    lastOutcomeByPath.set(normalizePath(outcome.path), outcome);
  }

  for (const [filePath, outcome] of lastOutcomeByPath.entries()) {
    const stat = stats.get(filePath) ?? { insertions: 0, deletions: 0 };
    // A completed DELETE is aligned regardless of diff presence — the host
    // removed the file, so it cannot appear in the diff.
    const isDeleteDone = outcome.operation === 'DELETE' && outcome.outcome === 'DONE';
    rows.push({
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      outcome: outcome.outcome,
      alignment: isDeleteDone || changed.has(filePath) ? 'ok' : 'missing',
      detail: outcome.detail,
    });
  }

  const expected = new Set(lastOutcomeByPath.keys());
  for (const filePath of changedPaths) {
    if (expected.has(filePath)) {
      continue;
    }
    const stat = stats.get(filePath) ?? { insertions: 0, deletions: 0 };
    rows.push({
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      outcome: 'NOT INSTRUCTED',
      alignment: 'unsolicited',
    });
  }

  return rows;
}

export async function runEvidenceStage(ctx: WorkflowRunContext, journey: Journey, report: ReportState): Promise<string[]> {
  report.abortStage = 'evidence gathering';
  const findings: string[] = [];

  for (let iteration = 1; iteration <= MAX_EVIDENCE_ITERATIONS; iteration++) {
    const digesterPrompt = buildPrompt([
      conversationSection(ctx),
      { title: 'USER REQUEST', body: ctx.initialPrompt },
      { title: 'RESEARCH FINDINGS GATHERED SO FAR', body: findings.join('\n\n---\n\n') },
      { title: 'ITERATION', body: `This is evidence-gathering iteration ${iteration} of ${MAX_EVIDENCE_ITERATIONS}.` },
    ]);

    const response = await ctx.dispatch.parsed(
      AGENTS.digester,
      digesterPrompt,
      `Assessing evidence (round ${iteration})`,
      parseDigesterResponse,
      () => {
        journey.formatRetries++;
      },
      3,
      {
        onPersistPrimaryRetry: () => {
          journey.persistPrimaryRetries++;
        },
      },
    );

    journey.evidenceIterations = iteration;
    const row: EvidenceRow = {
      iteration,
      verdict: response.verdict,
      added: [],
      removed: [],
      research: false,
    };

    if (response.verdict === 'YES') {
      if (response.irrelevantFiles.length > 0) {
        const change = await reconfigureContext(
          ctx,
          journey,
          `DIGESTER — irrelevant files (round ${iteration})`,
          [],
          response.irrelevantFiles,
        );
        row.removed = change.removed;
      }

      if (response.researchBrief) {
        const research = await ctx.dispatch.agent(
          AGENTS.researcher,
          buildPrompt([
            conversationSection(ctx),
            { title: 'USER REQUEST', body: ctx.initialPrompt },
            { title: 'RESEARCH BRIEF', body: response.researchBrief },
          ]),
          `Researching online (round ${iteration}, pre-planning)`,
        );
        findings.push(research);
        journey.researchDocs++;
        row.research = true;
        await emitInfo(ctx.log, formatResearchReceived(iteration, research.length));
      }

      await emitInfo(ctx.log, formatEvidenceSufficient());
      journey.evidenceRows.push(row);
      break;
    }

    await emitInfo(ctx.log, formatEvidenceInsufficient(iteration, MAX_EVIDENCE_ITERATIONS, !!response.researchBrief));

    const investigatorPrompt = buildPrompt([
      conversationSection(ctx),
      { title: 'USER REQUEST', body: ctx.initialPrompt },
      { title: 'INVESTIGATION BRIEF', body: response.investigationBrief },
      { title: 'REMINDER', body: 'Respond with exactly the required file sections.' },
    ]);

    const investigation = await ctx.dispatch.parsed(
      AGENTS.investigator,
      investigatorPrompt,
      `Investigating codebase (round ${iteration})`,
      parseInvestigatorResponse,
      () => {
        journey.formatRetries++;
      },
    );

    const change = await reconfigureContext(
      ctx,
      journey,
      `INVESTIGATOR — round ${iteration}`,
      investigation.add,
      investigation.remove,
    );
    row.added = change.added;
    row.removed = change.removed;

    if (response.researchBrief) {
      const researcherPrompt = buildPrompt([
        conversationSection(ctx),
        { title: 'USER REQUEST', body: ctx.initialPrompt },
        { title: 'RESEARCH BRIEF', body: response.researchBrief },
      ]);
      const research = await ctx.dispatch.agent(
        AGENTS.researcher,
        researcherPrompt,
        `Researching online (round ${iteration})`,
      );
      findings.push(research);
      journey.researchDocs++;
      row.research = true;
      await emitInfo(ctx.log, formatResearchReceived(iteration, research.length));
    }

    journey.evidenceRows.push(row);
  }

  return findings;
}

export async function resolvePlanUnknowns(
  ctx: WorkflowRunContext,
  journey: Journey,
  planText: string,
  label: string,
): Promise<string | null> {
  const { researchUnknowns, codebaseUnknowns } = parsePlanUnknowns(planText);
  if (researchUnknowns || codebaseUnknowns) {
    await emitInfo(ctx.log, formatPlanUnknowns(label, researchUnknowns, codebaseUnknowns));
  }
  const researchPromise = researchUnknowns
    ? ctx.dispatch.agent(
        AGENTS.researcher,
        buildPrompt([
          conversationSection(ctx),
          { title: 'USER REQUEST', body: ctx.initialPrompt },
          { title: 'RESEARCH UNKNOWNS', body: researchUnknowns },
        ]),
        `Resolving ${label} research unknowns`,
      )
    : Promise.resolve(null);
  const codebasePromise = codebaseUnknowns
    ? ctx.dispatch.parsed(
        AGENTS.investigator,
        buildPrompt([
          conversationSection(ctx),
          { title: 'USER REQUEST', body: ctx.initialPrompt },
          { title: 'CODEBASE UNKNOWNS', body: codebaseUnknowns },
        ]),
        `Resolving ${label} codebase unknowns`,
        parseInvestigatorResponse,
        () => {
          journey.formatRetries++;
        },
      )
    : Promise.resolve(null);

  const [research, codebase] = await Promise.all([researchPromise, codebasePromise]);
  if (codebase) {
    if (codebase.remove.length > 0) {
      await emitInfo(
        ctx.log,
        `### ℹ️ ${label} — codebase unknowns\nINVESTIGATOR proposed removing ${codebase.remove.length} context file(s) (${codebase.remove.join(', ')}); removals were discarded to retain planner context.`,
      );
    }
    // Investigator removals are discarded here: the planner's context must be
    // retained, so only additions are applied.
    await reconfigureContext(ctx, journey, `${label} — codebase unknowns`, codebase.add, []);
  }
  return research;
}

export async function runPlanningStage(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  researchFindings: string[],
): Promise<{ planText: string; unknownsResearch: string | null }> {
  report.abortStage = 'planning';
  const plannerPrompt = buildPrompt([
    conversationSection(ctx),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: 'RESEARCH FINDINGS', body: researchFindings.join('\n\n---\n\n') },
    { title: 'INSTRUCTION', body: 'Produce the Implementation Plan now, per your instructions.' },
  ]);

  const planText = await ctx.dispatch.agent(
    AGENTS.planner,
    plannerPrompt,
    'Producing Implementation Plan',
  );
  journey.planTitle = parsePlanUnknowns(planText).title;
  await emitInfo(ctx.log, formatPlanProduced(journey.planTitle));
  return { planText, unknownsResearch: await resolvePlanUnknowns(ctx, journey, planText, 'plan') };
}

export async function runDecompositionStage(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  planText: string,
  resolvedResearch: string | null,
): Promise<{ assignments: FileAssignment[]; summary: string }> {
  report.abortStage = 'decomposition';
  const decomposerSections: PromptSection[] = [
    conversationSection(ctx),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: 'IMPLEMENTATION PLAN', body: `${planText}\n\n(verbatim — treat as strict instructions)` },
  ];

  if (resolvedResearch) {
    decomposerSections.push({ title: 'ADDITIONAL RESEARCH', body: resolvedResearch });
  }

  const contextFiles = await ctx.task.getContextFiles();
  const availableContextFiles = [...new Set(contextFiles.map((file) => normalizePath(file.path)))];

  decomposerSections.push({
    title: 'AVAILABLE CONTEXT FILES',
    body:
      availableContextFiles.length > 0
        ? availableContextFiles.map((filePath) => `- ${filePath}`).join('\n')
        : 'NONE',
  });

  decomposerSections.push({
    title: 'INSTRUCTION',
    body:
      'Resolve plan conditionals using ADDITIONAL RESEARCH and the newly enriched context. Emit one semantic assignment per file, including every contextual file the editor must read and the exact contracts distilled from that evidence. Do not emit exact patches and do not request another planner run.',
  });

  const decomposerPrompt = buildPrompt(decomposerSections);

  const result = await ctx.dispatch.parsed(
    AGENTS.decompositor,
    decomposerPrompt,
    'Decomposing plan into per-file assignments',
    parseAssignmentsResponse,
    () => {
      journey.formatRetries++;
    },
  );

  await emitInfo(ctx.log, formatAssignmentTargets('Implementation plan decomposed', result.assignments));
  return { assignments: result.assignments, summary: result.summary };
}

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function readTarget(absPath: string): Promise<{ exists: boolean; content: string | null; hash: string | null; size: number }> {
  try {
    const content = await fs.readFile(absPath, 'utf8');
    return {
      exists: true,
      content,
      hash: hashOf(content),
      size: Buffer.byteLength(content, 'utf8'),
    };
  } catch {
    return {
      exists: false,
      content: null,
      hash: null,
      size: 0,
    };
  }
}

/**
 * Structurally validates the actual on-disk state of a file after an
 * assignment attempt. The filesystem is authoritative — the editor's RESULT
 * line is only a hint. Returns a problem description, or null when the file
 * state satisfies the assignment's operation.
 */
function validateAssignmentResult(
  assignment: FileAssignment,
  pre: { exists: boolean; content: string | null; hash: string | null; size: number },
  post: { exists: boolean; content: string | null; hash: string | null; size: number },
): string | null {
  if (assignment.operation === 'DELETE') {
    if (post.exists) {
      return 'file still exists after delete';
    }
    return null;
  }

  if (!post.exists || post.content === null) {
    return 'post-edit file does not exist';
  }

  const lines = post.content.split(/\r?\n/);
  for (const line of lines) {
    if (/^<{7}/.test(line) || /^>{7}/.test(line)) {
      return 'post-edit file contains conflict markers (<<<<<<< or >>>>>>>)';
    }
  }

  if (assignment.path.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(post.content);
    } catch {
      return 'post-edit JSON file is not valid JSON';
    }
  }

  if (assignment.operation === 'CREATE') {
    if (pre.exists) {
      return 'file already existed before create';
    }
    if (post.content.trim().length === 0) {
      return 'created file is empty';
    }
    return null;
  }

  if (assignment.operation === 'MODIFY') {
    if (!pre.exists) {
      return 'file did not exist before modify';
    }
    if (post.content.trim().length === 0) {
      return 'modified file is empty';
    }
    if (post.hash === pre.hash) {
      return 'file content was unchanged';
    }
    return null;
  }

  return 'unknown assignment operation';
}

/**
 * Restores a target file to its pre-dispatch snapshot. Existing files are
 * rewritten with their original content; files that did not exist are removed.
 */
async function restoreTarget(
  abs: string,
  pre: { exists: boolean; content: string | null; hash: string | null; size: number },
): Promise<void> {
  if (pre.exists && pre.content !== null) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, pre.content, 'utf8');
  } else {
    await fs.rm(abs, { force: true });
  }
}

/**
 * Builds the prompt handed to the EDITOR for one file-scoped assignment. The
 * editor is told to read the live file first and implement the objective
 * semantically — no exact anchors are ever supplied.
 */
export function buildEditorPrompt(assignment: FileAssignment): string {
  return [
    'You are implementing exactly one file-scoped assignment.',
    '',
    serializeAssignment(assignment),
    '',
    `The assignment path '${assignment.path}' is the only writable file.`,
    'All paths in this assignment are project-relative and must be passed to file tools exactly as written.',
    "AiderDesk resolves project-relative paths against the task's effective working directory.",
    'Context files are read-only.',
    'Read every declared evidence file in full before implementation.',
    'RELEVANT CONTRACTS AND PATTERNS is the decompositor digest, but the declared files remain authoritative.',
    'Search is allowed only after the declared evidence has been read. If search is needed because essential evidence was omitted, emit a specific CONTEXT COMPLAINT.',
    '',
    'Finish with "CONTEXT COMPLAINT: NONE" or a specific complaint, followed by "RESULT: DONE" or "RESULT: BLOCKED: <reason>".',
  ].join('\n');
}

/**
 * Executes one assignment transactionally. The target file is snapshotted
 * before dispatch; on failure the snapshot is restored before any fallback
 * retry. A dispatch failure whose post-state passes structural validation is
 * accepted — the file, not the response, is truth. DELETE assignments are
 * host operations and never reach an editor.
 */
async function runSingleAssignment(
  ctx: WorkflowRunContext,
  journey: Journey,
  assignment: FileAssignment,
  abs: string,
): Promise<AssignmentOutcome> {
  const label = `ASSIGNMENT ${assignment.id}: ${assignment.path}`;
  const pre = await readTarget(abs);

  // DELETE is a host-only operation — real fs.rm, no editor dispatch.
  if (assignment.operation === 'DELETE') {
    if (!pre.exists) {
      return { id: assignment.id, path: assignment.path, operation: 'DELETE', outcome: 'DONE', detail: 'already absent' };
    }
    try {
      await fs.rm(abs, { force: true });
    } catch (error) {
      return {
        id: assignment.id,
        path: assignment.path,
        operation: 'DELETE',
        outcome: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const post = await readTarget(abs);
    const structural = validateAssignmentResult(assignment, pre, post);
    if (structural === null) {
      return { id: assignment.id, path: assignment.path, operation: 'DELETE', outcome: 'DONE' };
    }
    return { id: assignment.id, path: assignment.path, operation: 'DELETE', outcome: 'FAILED', detail: structural };
  }

  // CREATE parents are created by the host before any editor dispatch.
  if (assignment.operation === 'CREATE') {
    await fs.mkdir(path.dirname(abs), { recursive: true });
  }

  const recordComplaint = async (complaint?: string): Promise<void> => {
    if (!complaint) {
      return;
    }
    const duplicate = journey.contextComplaints.some(
      (entry) => entry.assignmentId === assignment.id && entry.complaint === complaint,
    );
    if (!duplicate) {
      journey.contextComplaints.push({
        assignmentId: assignment.id,
        path: assignment.path,
        complaint,
      });
      await ctx.log.warning(`⚠️ ASSIGNMENT ${assignment.id} (${assignment.path}) required editor-side context recovery:\n${complaint}`);
    }
  };

  const attempt = async (
    slot: 'primary' | 'fallback',
  ): Promise<{
    ok: boolean;
    structural: string | null;
    hint: { status: 'DONE' | 'BLOCKED' | 'UNKNOWN'; detail?: string; contextComplaint?: string };
  }> => {
    const raw = await ctx.dispatch.agent(
      AGENTS.editor,
      buildEditorPrompt(assignment),
      label,
      {
        timeoutMs: EDITOR_TIMEOUT_MS,
        modelSlot: slot,
        disableFallback: true,
        onPersistPrimaryRetry: () => {
          journey.persistPrimaryRetries++;
        },
      },
    );
    const hint = parseEditorResult(raw);
    await recordComplaint(hint.contextComplaint);
    const post = await readTarget(abs);
    const structural = validateAssignmentResult(assignment, pre, post);
    return { ok: structural === null && hint.status !== 'BLOCKED', structural, hint };
  };

  // Dispatch failure acceptance: re-read the post-state and validate it. If
  // the file is structurally correct, the change is accepted regardless of
  // what the agent's response said.
  const acceptFromFileState = async (msg: string): Promise<AssignmentOutcome> => {
    const post = await readTarget(abs);
    const structural = validateAssignmentResult(assignment, pre, post);
    if (structural === null) {
      await ctx.log.warning(`${label}: dispatch failed (${msg}) but the file state is structurally valid — accepting the change.`);
      return {
        id: assignment.id,
        path: assignment.path,
        operation: assignment.operation,
        outcome: 'DONE',
        detail: `accepted from file state after dispatch failure: ${msg}`,
      };
    }
    return { id: assignment.id, path: assignment.path, operation: assignment.operation, outcome: 'FAILED', detail: structural };
  };

  let lastReason = '';

  // Primary attempt.
  try {
    const result = await attempt('primary');
    if (result.ok) {
      return {
        id: assignment.id,
        path: assignment.path,
        operation: assignment.operation,
        outcome: 'DONE',
        contextComplaint: result.hint.contextComplaint,
      };
    }
    lastReason = result.hint.status === 'BLOCKED' ? (result.hint.detail ?? 'editor reported BLOCKED') : (result.structural ?? 'editor response was not DONE');
  } catch (error) {
    if (error instanceof WorkflowCancelled) throw error;
    if (error instanceof WorkflowTimeout) journey.editorTimeouts++;
    const msg = error instanceof Error ? error.message : String(error);
    const accepted = await acceptFromFileState(msg);
    if (accepted.outcome === 'DONE') return accepted;
    lastReason = msg;
  }

  // Fallback path: restore the snapshot first so the retry never inherits
  // partial side effects, then run a single fallback-slot attempt.
  await restoreTarget(abs, pre);
  journey.fallbackRetries++;
  await ctx.log.warning(`${label}: primary attempt failed (${lastReason}); restored snapshot and retrying with fallback model.`);

  try {
    const result = await attempt('fallback');
    if (result.ok) {
      return {
        id: assignment.id,
        path: assignment.path,
        operation: assignment.operation,
        outcome: 'DONE',
        usedFallback: true,
        contextComplaint: result.hint.contextComplaint,
      };
    }
    lastReason = result.hint.status === 'BLOCKED' ? (result.hint.detail ?? 'editor reported BLOCKED') : (result.structural ?? 'editor response was not DONE');
  } catch (error) {
    if (error instanceof WorkflowCancelled) throw error;
    if (error instanceof WorkflowTimeout) journey.editorTimeouts++;
    const msg = error instanceof Error ? error.message : String(error);
    const accepted = await acceptFromFileState(msg);
    if (accepted.outcome === 'DONE') {
      return { ...accepted, usedFallback: true };
    }
    lastReason = msg;
  }

  // Final failure — leave the tree clean.
  await restoreTarget(abs, pre);
  return { id: assignment.id, path: assignment.path, operation: assignment.operation, outcome: 'FAILED', detail: lastReason };
}

/**
 * Runs a batch of per-file assignments in dependency waves. Assignments
 * within a wave run concurrently; a failed assignment blocks only its
 * transitive dependents, never unrelated work. Deletes are performed by the
 * host, and the batch is committed with a checkpoint commit.
 */
export async function runAssignmentBatch(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  git: SimpleGit,
  assignments: FileAssignment[],
  commitLabel: string,
): Promise<'ALIGNED' | 'DEFICIENT'> {
  report.abortStage = `assignments (${commitLabel})`;
  const batch = journey.batches.length + 1;

  const bumpGitRetry = (attempt: number, message: string) => {
    journey.gitRetries++;
    void ctx.log.warning(`Git retry ${attempt}: ${message}`);
  };

  const passBase = (await withGitRetry(() => git.revparse(['HEAD']), { name: 'batch baseline', onRetry: bumpGitRetry })).trim();

  // 2. Normalize paths, check existing paths, validate assignments
  const normalized = assignments.map((a) => ({
    ...a,
    path: normalizePath(a.path),
    contextFiles: a.contextFiles ?? [],
    relevantContracts: a.relevantContracts ?? [],
  }));
  const existingPaths = new Set<string>();
  const targetProblems = new Map<number, string>();
  for (const a of normalized) {
    try {
      const abs = resolveAssignmentTarget(ctx.task.getTaskDir(), a.path);
      if (await fileExists(abs)) {
        existingPaths.add(a.path);
      }
    } catch (error) {
      targetProblems.set(a.id, error instanceof Error ? error.message : String(error));
    }
  }

  const problems = validateAssignments(normalized, existingPaths);
  for (const [id, problem] of targetProblems) {
    problems.set(id, problem);
  }
  const outcomes = new Map<number, AssignmentOutcome>();
  const valid: FileAssignment[] = [];

  for (const a of normalized) {
    const problem = problems.get(a.id);
    if (problem) {
      outcomes.set(a.id, { id: a.id, path: a.path, operation: a.operation, outcome: 'FAILED', detail: problem });
    } else {
      valid.push(a);
    }
  }

  // 3. Block transitive dependents of failed assignments
  const failedIds = new Set(outcomes.keys());
  const dependentsOf = new Map<number, number[]>();
  for (const a of valid) {
    for (const dep of a.dependsOn) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(a.id);
      dependentsOf.set(dep, list);
    }
  }
  const blockedIds = new Set<number>();
  const blockedBy = new Map<number, number>();
  const queue = [...failedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dependent of dependentsOf.get(id) ?? []) {
      if (!blockedIds.has(dependent) && !failedIds.has(dependent)) {
        blockedIds.add(dependent);
        blockedBy.set(dependent, id);
        queue.push(dependent);
      }
    }
  }
  for (const a of valid) {
    if (blockedIds.has(a.id)) {
      outcomes.set(a.id, {
        id: a.id,
        path: a.path,
        operation: a.operation,
        outcome: 'BLOCKED',
        detail: `blocked by failed ASSIGNMENT ${blockedBy.get(a.id)}`,
      });
    }
  }

  // 4. Remaining valid set → dependency waves
  const waveSet = valid.filter((a) => !blockedIds.has(a.id) && !failedIds.has(a.id));
  const waves = computeWaves(waveSet);

  // 5. Execute waves sequentially; within a wave run concurrently, chunked by
  // the optional editor concurrency cap. Only a positive integer cap limits
  // concurrency; every other value (absent, zero, negative, decimal,
  // non-numeric) leaves the wave unlimited.
  const rawCap = ctx.modelConfig?.parallelEditors;
  const editorCap = typeof rawCap === 'number' && Number.isInteger(rawCap) && rawCap > 0 ? rawCap : 0;

  for (const wave of waves) {
    const runnable = wave.filter((a) => {
      for (const dep of a.dependsOn) {
        const depOutcome = outcomes.get(dep);
        if (depOutcome && depOutcome.outcome !== 'DONE') {
          outcomes.set(a.id, {
            id: a.id,
            path: a.path,
            operation: a.operation,
            outcome: 'BLOCKED',
            detail: `blocked by failed ASSIGNMENT ${dep}`,
          });
          return false;
        }
      }
      return true;
    });
    const prepared = runnable.map((assignment) => ({
      assignment,
      target: resolveAssignmentTarget(ctx.task.getTaskDir(), assignment.path),
    }));

    // Wave dependencies are satisfied, writable targets are unique, and shared
    // contextual files are read-only, so concurrent execution is intentional.
    // With a positive cap, dispatch the wave in consecutive chunks no larger
    // than the cap and await every assignment in a chunk before starting the
    // next; with an unlimited cap the whole wave runs concurrently as before.
    const chunkSize = editorCap > 0 ? editorCap : prepared.length;
    for (let start = 0; start < prepared.length; start += chunkSize) {
      const chunk = prepared.slice(start, start + chunkSize);
      const results = await Promise.all(
        chunk.map(({ assignment, target }) =>
          runSingleAssignment(ctx, journey, assignment, target),
        ),
      );
      for (const r of results) {
        outcomes.set(r.id, r);
      }
    }
  }

  // 6. Drop successfully deleted files from the task context
  for (const a of normalized) {
    if (a.operation === 'DELETE') {
      const outcome = outcomes.get(a.id);
      if (outcome?.outcome === 'DONE') {
        await ctx.task.dropFile(a.path);
      }
    }
  }

  // 6.5 Post-edit validation — record the output before the checkpoint commit
  journey.lastValidationOutput = await runValidationCommand(ctx.task, ctx.run.workflowId, ctx.log);

  // 7. Commit & diff
  const commitMessage = `[${commitLabel} batch ${batch}] ${journey.planTitle.slice(0, 60)}`;
  let commitSucceeded = true;
  try {
    await withGitRetry(async () => {
      await git.add('-A');
      await git.raw(['commit', '--no-verify', '--allow-empty', '-m', commitMessage]);
    }, { name: 'batch checkpoint commit', onRetry: bumpGitRetry });
  } catch (error) {
    commitSucceeded = false;
    const warning = `Checkpoint commit deferred after retries: ${error instanceof Error ? error.message : String(error)}`;
    journey.gitWarnings.push(warning);
    await ctx.log.warning(warning);
  }

  const changedRaw = commitSucceeded
    ? await withGitRetry(() => git.raw(['diff', '--name-only', '-z', passBase, 'HEAD']), { name: 'changed paths', onRetry: bumpGitRetry })
    : await withGitRetry(() => git.raw(['diff', '--name-only', '-z', passBase]), { name: 'working-tree changed paths', onRetry: bumpGitRetry });
  const changedPaths = parseChangedPaths(changedRaw);
  const statsMap = await collectDiffStats(git, passBase, commitSucceeded ? 'HEAD' : undefined, bumpGitRetry);

  // 8. Batch validation
  const expected = new Set(normalized.map((a) => a.path));
  const changedSet = new Set(changedPaths);

  const doneOutcomes = [...outcomes.values()].filter((o) => o.outcome === 'DONE');
  const missing = doneOutcomes
    .filter((o) => o.operation !== 'DELETE' && o.detail !== 'already absent')
    .map((o) => o.path)
    .filter((p) => !changedSet.has(p));
  const unexpected = changedPaths.filter((p) => !expected.has(p));

  const notDone = [...outcomes.values()].filter((o) => o.outcome !== 'DONE');
  const passed = notDone.length === 0 && missing.length === 0 && unexpected.length === 0;

  const reasons: string[] = [];
  if (notDone.length > 0) {
    const failedLabels = notDone.map((o) => `ASSIGNMENT ${o.id} (${o.path}: ${o.outcome}${o.detail ? ` - ${o.detail}` : ''})`);
    reasons.push(`unsuccessful assignments: ${failedLabels.join(', ')}`);
  }
  if (missing.length > 0) {
    reasons.push(`instructed file(s) absent from the diff: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    reasons.push(`diff touches unexpected file(s): ${unexpected.join(', ')}`);
  }
  const reason = reasons.join('; ');
  const verdict = passed ? 'ALIGNED' : 'DEFICIENT';

  // 9. Build rows & accumulate stats
  const rows = buildAssignmentRows([...outcomes.values()], changedPaths, statsMap);
  for (const row of rows) {
    const entry = journey.fileStats[row.path] ?? { insertions: 0, deletions: 0, passes: 0 };
    entry.insertions += row.insertions;
    entry.deletions += row.deletions;
    entry.passes++;
    journey.fileStats[row.path] = entry;
  }

  // 9.5 Add only genuinely new files to the task context — ordinary edits to
  // existing files are not context changes. Successfully created assignment
  // targets and unsolicited changed paths that did not exist before the batch
  // are labelled as new files.
  const createdTargets = normalized
    .filter((a) => a.operation === 'CREATE' && outcomes.get(a.id)?.outcome === 'DONE')
    .map((a) => a.path);
  const unsolicitedNewFiles = changedPaths.filter((p) => !expected.has(p) && !existingPaths.has(p));
  const newFiles = [...new Set([...createdTargets, ...unsolicitedNewFiles])];
  if (newFiles.length > 0) {
    await reconfigureContext(ctx, journey, `new file created (batch ${batch})`, newFiles);
  }

  // 10. Record batch & emit summary
  journey.batches.push({
    batch,
    stage: commitLabel,
    assignmentCount: normalized.length,
    waves: waves.length,
    done: [...outcomes.values()].filter((o) => o.outcome === 'DONE').length,
    failed: [...outcomes.values()].filter((o) => o.outcome === 'FAILED').map((o) => `ASSIGNMENT ${o.id}: ${o.path}`),
    blocked: [...outcomes.values()].filter((o) => o.outcome === 'BLOCKED').map((o) => `ASSIGNMENT ${o.id}: ${o.path}`),
    verdict: passed ? 'ALIGNED' : `DEFICIENT: ${reason}`,
    commit: commitSucceeded ? commitMessage : 'DEFERRED (commit failed — see git warnings)',
    rows,
  });

  await emitInfo(ctx.log, formatAssignmentBatchSummary(commitLabel, batch, rows, passed, reason));
  return verdict;
}

export interface ReviewEvidence {
  diff: string;
  changedFilesSummary: string;
  assignmentSignals: string;
}

/**
 * Collects the shared review evidence consumed by reviewers, the arbiter, and
 * the confirmer: the cumulative diff, the changed-file summary, and the
 * assignment-signal text derived from the journey's batch records.
 */
export async function collectReviewEvidence(
  git: SimpleGit,
  baselineCommit: string,
  journey: Journey,
  maxDiffChars: number = MAX_REVIEW_DIFF_CHARS,
): Promise<ReviewEvidence> {
  const diff = await getCumulativeDiff(git, baselineCommit, maxDiffChars);
  const changedFilesSummary = Object.entries(journey.fileStats)
    .map(([filePath, stats]) => `${filePath}: +${stats.insertions} -${stats.deletions} (${stats.passes} ${stats.passes === 1 ? 'batch' : 'batches'})`)
    .join('\n');

  const signalLines = new Set<string>();
  for (const b of journey.batches) {
    if (b.verdict.startsWith('DEFICIENT')) {
      signalLines.add(`Batch ${b.batch} verdict: ${b.verdict}`);
    }
    for (const row of b.rows) {
      if (row.outcome !== 'DONE' || row.alignment !== 'ok') {
        signalLines.add(`${row.path} — ${row.outcome}${row.alignment !== 'ok' ? `, ${row.alignment}` : ''} (batch ${b.batch})`);
      }
    }
  }
  const assignmentSignals = [...signalLines].join('\n');

  return { diff, changedFilesSummary, assignmentSignals };
}

/**
 * Builds the prompt sections shared by reviewers, the arbiter, and the
 * confirmer: conversation, request, decomposition summary, changed-file
 * summary, assignment signals, validation output, and the fenced cumulative
 * diff.
 */
export function reviewEvidenceSections(
  ctx: WorkflowRunContext,
  decompositionSummary: string,
  evidence: ReviewEvidence,
  validationOutput: string | null,
): PromptSection[] {
  return [
    conversationSection(ctx),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: 'DECOMPOSITOR ASSIGNMENTS SUMMARY', body: decompositionSummary },
    { title: 'CHANGED FILES', body: evidence.changedFilesSummary || 'None' },
    { title: 'ASSIGNMENT SIGNALS', body: evidence.assignmentSignals },
    { title: 'VALIDATION COMMAND OUTPUT', body: validationOutput ?? 'No validation command configured.' },
    { title: 'CUMULATIVE GIT DIFF', body: ['```diff', evidence.diff, '```'].join('\n') },
  ];
}

/**
 * Extracts the latest rectification assignment evidence from the journey's
 * batch records. Rectification batches are labelled with the
 * 'dev-pipeline-review rectification' stage prefix; the last such batch is
 * the latest rectification the confirmer must verify against. Returns null
 * when no rectification batch was recorded.
 */
function latestRectificationAssignments(journey: Journey): string | null {
  const rectificationBatches = journey.batches.filter((batch) => batch.stage.startsWith('dev-pipeline-review rectification'));
  if (rectificationBatches.length === 0) {
    return null;
  }
  const latest = rectificationBatches[rectificationBatches.length - 1];
  const rows = latest.rows.map((row) => {
    const detail = row.detail ? ` — ${row.detail}` : '';
    return `- ${row.path}: ${row.outcome} (${row.alignment})${detail}`;
  });
  return [
    `Latest rectification batch (batch ${latest.batch} — ${latest.stage}):`,
    ...rows,
    `Batch verdict: ${latest.verdict}`,
  ].join('\n');
}

/**
 * Runs the final confirmer stage. The confirmer verifies the applied changes
 * against the latest arbiter rectification (or the original implementation
 * plan when the arbiter was disabled or not part of the workflow) and reports
 * per-file additions/changes/removals plus any remaining work. A
 * non-cancellation dispatch failure is recorded and logged as a warning
 * without aborting the workflow.
 */
export async function runConfirmerStage(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  git: SimpleGit,
  baselineCommit: string,
  planText: string,
  decompositionSummary: string,
  lastArbiterOutcome: string | null,
): Promise<void> {
  report.abortStage = 'confirmer review';
  const evidence = await collectReviewEvidence(git, baselineCommit, journey);

  // The arbitration section is built conditionally so the confirmer can
  // unambiguously select its verification basis: the latest arbiter
  // rectification when arbitration ran, or the original implementation plan
  // when the arbiter was disabled or not part of the workflow.
  const arbitrationSection: PromptSection =
    lastArbiterOutcome !== null
      ? {
          title: 'ARBITRATION OUTCOME',
          body: [
            "The Arbiter ran as part of this workflow. The content below is the authoritative latest arbitration outcome: the arbiter's verdict and the rectification assignments that were subsequently executed.",
            '',
            lastArbiterOutcome,
            '',
            latestRectificationAssignments(journey) ?? 'No rectification assignments were executed — the arbiter required no further edits.',
          ].join('\n'),
        }
      : {
          title: 'ARBITRATION OUTCOME',
          body: 'The Arbiter was disabled or was not part of this workflow — no Arbiter ran. Verify the applied changes against the original IMPLEMENTATION PLAN below; it is the verification basis for this run.',
        };

  const prompt = buildPrompt([
    ...reviewEvidenceSections(ctx, decompositionSummary, evidence, journey.lastValidationOutput),
    { title: 'IMPLEMENTATION PLAN', body: planText },
    arbitrationSection,
    {
      title: 'CONFIRMER REPORT FORMAT',
      body: [
        'Respond with a brief `# Confirmer Report` that:',
        '- lists per-file additions, changes, and removals against the baseline;',
        '- verifies each file against the latest arbitration outcome and rectification assignments when present, or against the original implementation plan when the Arbiter did not run;',
        '- checks every supplied latest rectification assignment against the CUMULATIVE GIT DIFF and VALIDATION COMMAND OUTPUT, and reports any rectification assignment that was skipped or only partially applied under `## Still to do`;',
        '- ends with a `## Still to do` section listing any remaining work.',
      ].join('\n'),
    },
  ]);

  try {
    const confirmerReport = await ctx.dispatch.agent(AGENTS.confirmer, prompt, 'Final confirmation review');
    journey.confirmerReport = confirmerReport;
    await emitInfo(ctx.log, formatConfirmerReport(confirmerReport));
  } catch (error) {
    if (error instanceof WorkflowCancelled) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    journey.confirmerFailure = msg;
    await ctx.log.warning(`Confirmer review failed: ${msg}`);
  }
}

export async function emitReport(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  workflowName: string,
): Promise<void> {
  if (report.reportEmitted) {
    return;
  }
  report.reportEmitted = true;
  const text = formatJourneyReport(journey, report, workflowName);
  await emitInfo(ctx.log, `### 🏁 ${workflowName} finished — journey report added to the conversation.`);
  await ctx.log.summary(text, 'final-summary');
}
