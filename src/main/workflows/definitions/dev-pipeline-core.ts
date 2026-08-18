import fs from 'fs/promises';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

import { fileExists } from '@common/node-utils';

import { Task } from '@/task';
import { WorkflowCancelled, WorkflowError, WorkflowTimeout } from '../dispatch';
import { WorkflowLogger, WorkflowRunContext } from '../types';
import {
  type EditorOutcome,
  type EvidenceRow,
  type FileChangeRow,
  type Journey,
  type ReportState,
} from '../journey';
import {
  formatConfirmerVerdict,
  formatContextChange,
  formatDeficiencyNotice,
  formatEditSummary,
  formatEditTargets,
  formatEvidenceInsufficient,
  formatEvidenceSufficient,
  formatJourneyReport,
  formatCheckpointReport,
  formatPlanProduced,
  formatPlanUnknowns,
  formatResearchReceived,
  formatVerificationFlags,
} from '../reporting';
import {
  FileEditInstruction,
  EditVerificationResult,
  normalizeForCompare,
  parseConfirmerResponse,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeFileEdits,
  validateFileEditInstruction,
  verifyEditAlignment,
} from '../parsers';

import { buildPrompt, PromptSection } from '../prompt-formatting';
import { extractAddedLinesByFile, withGitRetry } from '../git-utils';
import { formatConversation, splitConversationForSummary } from '../conversation';

export const AGENTS = {
  digester: 'DIGESTER',
  investigator: 'INVESTIGATOR',
  researcher: 'RESEARCHER',
  planner: 'GRAND-PLANNER',
  decompositor: 'DECOMPOSITOR',
  editor: 'EDITOR-LIGHT',
  heavyEditor: 'EDITOR-HEAVY',
  confirmer: 'CONFIRMER',
  summarizer: 'SUMMARIZER',
} as const;

export const MAX_EVIDENCE_ITERATIONS = 3;
export const MAX_CONFIRM_PASSES = 3;
export const MAX_DIFF_CHARS = 80_000;
export const MAX_RESEARCH_DOC_CHARS = 30_000;
export const HEAVY_NEW_CHAR_THRESHOLD = 10_000;
export const HEAVY_NEW_LINE_THRESHOLD = 250;
export const HEAVY_EDIT_CHAR_THRESHOLD = 6_000;
export const EDITOR_LIGHT_TIMEOUT_MS = 5 * 60_000;
export const EDITOR_HEAVY_TIMEOUT_MS = 10 * 60_000;

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function parseChangedPaths(raw: string): string[] {
  return raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith('./') ? entry.slice(2) : entry))
    .map(normalizePath);
}

export function selectEditorRole(edit: FileEditInstruction, escalatedPaths: Set<string>): 'light' | 'heavy' {
  if (escalatedPaths.has(normalizePath(edit.path))) return 'heavy';
  if (edit.type === 'NEW' && (edit.instructions.length > HEAVY_NEW_CHAR_THRESHOLD || edit.instructions.split(/\r?\n/).length > HEAVY_NEW_LINE_THRESHOLD)) return 'heavy';
  if (edit.type === 'EDIT' && edit.instructions.length > HEAVY_EDIT_CHAR_THRESHOLD) return 'heavy';
  return 'light';
}

export function evaluateEditGate(
  results: EditorOutcome[],
  changedPaths: string[],
  suspicious: EditVerificationResult[] = [],
): { passed: boolean; reason: string } {
  if (results.length === 0) return { passed: false, reason: 'no edits were dispatched' };

  const notDone = results.filter((result) => result.outcome !== 'DONE').map((result) => result.path);
  if (notDone.length > 0) return { passed: false, reason: `editor did not report DONE for: ${notDone.join(', ')}` };

  const expected = new Set(results.map((result) => normalizePath(result.path)));
  const actual = new Set(changedPaths);
  const missing = [...expected].filter((filePath) => !actual.has(filePath));
  if (missing.length > 0) return { passed: false, reason: `instructed file(s) absent from the diff: ${missing.join(', ')}` };

  const extra = [...actual].filter((filePath) => !expected.has(filePath));
  if (extra.length > 0) return { passed: false, reason: `diff touches unexpected file(s): ${extra.join(', ')}` };

  if (suspicious.length > 0) {
    return {
      passed: false,
      reason: `script verification flagged ${suspicious.length} suspicious edit(s): ${suspicious.map((v) => v.path).join(', ')}`,
    };
  }

  return { passed: true, reason: '' };
}

/**
 * Builds the conversation section for agent prompts. Once the pipeline has
 * summarized the prior conversation, the section is labelled as a digest so
 * downstream agents treat it as a compressed record rather than a verbatim
 * history.
 */
export function conversationSection(ctx: WorkflowRunContext, journey: Journey): PromptSection {
  return {
    title: journey.conversationSummarized ? 'CONVERSATION DIGEST (SUMMARIZED)' : 'CONVERSATION HISTORY',
    body: ctx.conversationText,
  };
}

/**
 * Compresses the older portion of the prior conversation via the SUMMARIZER
 * agent, keeping the most recent turns verbatim. The pipeline never aborts
 * over summarization: any `WorkflowError` (including timeouts) falls back to
 * the raw conversation text with a warning. User cancellation rethrows.
 */
export async function resolveConversationDigest(ctx: WorkflowRunContext, journey: Journey): Promise<string> {
  const { tail, recent } = splitConversationForSummary(ctx.conversationMessages);
  if (tail.length === 0) {
    return ctx.conversationText;
  }

  const prompt = buildPrompt([
    { title: 'CONVERSATION TO COMPACT', body: formatConversation(tail) },
    {
      title: 'INSTRUCTION',
      body: 'Compress the older conversation above into a decisions-only summary per your instructions. Output only the summary document.',
    },
  ]);

  try {
    const summary = await ctx.dispatch.agent(AGENTS.summarizer, prompt, 'Summarizing prior conversation');
    const summaryText = summary.trim();
    const summarized = summaryText.length > 0 && summaryText.toUpperCase() !== 'NONE';
    journey.conversationSummarized = true;
    journey.summaryChars = summarized ? summaryText.length : 0;
    await emitInfo(
      ctx.log,
      `Conversation compressed: ${formatConversation(tail).length.toLocaleString()} chars → ${journey.summaryChars.toLocaleString()} chars (${recent.length} recent turns kept verbatim).`,
    );
    if (!summarized) {
      return `=== RECENT CONVERSATION (VERBATIM) ===\n${formatConversation(recent)}`;
    }
    return `=== PRIOR CONVERSATION SUMMARY (decisions only) ===\n${summaryText}\n\n=== RECENT CONVERSATION (VERBATIM) ===\n${formatConversation(recent)}`;
  } catch (error) {
    if (error instanceof WorkflowCancelled) throw error;
    if (error instanceof WorkflowError) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.log.warning(`Conversation summarization failed (${message}); falling back to raw conversation text.`);
      return ctx.conversationText;
    }
    throw error;
  }
}

/**
 * Wraps a single agent dispatch with exactly one retry on `WorkflowError`
 * (not user cancellation). The second failure propagates to the caller.
 */
export async function withAgentRetry<T>(ctx: WorkflowRunContext, label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkflowCancelled) throw error;
    if (error instanceof WorkflowError) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.log.warning(`${label} failed (${message}); retrying once.`);
      return await fn();
    }
    throw error;
  }
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

export function buildEditRows(
  results: EditorOutcome[],
  changedPaths: string[],
  stats: Map<string, { insertions: number; deletions: number }>,
): FileChangeRow[] {
  const changed = new Set(changedPaths);
  const expected = new Set(results.map((result) => normalizePath(result.path)));
  const rows: FileChangeRow[] = [];

  for (const result of results) {
    const filePath = normalizePath(result.path);
    const stat = stats.get(filePath) ?? { insertions: 0, deletions: 0 };
    rows.push({
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      editorOutcome: result.outcome,
      editorRole: result.editorRole,
      alignment: changed.has(filePath) ? 'ok' : 'missing',
      detail: result.detail,
    });
  }

  for (const filePath of changedPaths) {
    if (expected.has(filePath)) {
      continue;
    }
    const stat = stats.get(filePath) ?? { insertions: 0, deletions: 0 };
    rows.push({
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      editorOutcome: 'NOT INSTRUCTED',
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
      conversationSection(ctx, journey),
      { title: 'USER REQUEST', body: ctx.initialPrompt },
      { title: 'RESEARCH FINDINGS GATHERED SO FAR', body: findings.join('\n\n---\n\n') },
      { title: 'ITERATION', body: `This is evidence-gathering iteration ${iteration} of ${MAX_EVIDENCE_ITERATIONS}.` },
    ]);

    const response = await withAgentRetry(ctx, `DIGESTER (round ${iteration})`, () =>
      ctx.dispatch.parsed(
        AGENTS.digester,
        digesterPrompt,
        `Assessing evidence (round ${iteration})`,
        parseDigesterResponse,
        () => {
          journey.formatRetries++;
        },
      ),
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
      await emitInfo(ctx.log, formatEvidenceSufficient());
      journey.evidenceRows.push(row);
      break;
    }

    await emitInfo(ctx.log, formatEvidenceInsufficient(iteration, MAX_EVIDENCE_ITERATIONS, !!response.researchBrief));

    const investigatorPrompt = buildPrompt([
      conversationSection(ctx, journey),
      { title: 'USER REQUEST', body: ctx.initialPrompt },
      { title: 'INVESTIGATION BRIEF', body: response.investigationBrief },
      { title: 'REMINDER', body: 'Respond with exactly the required file sections.' },
    ]);

    const investigation = await withAgentRetry(ctx, `INVESTIGATOR (round ${iteration})`, () =>
      ctx.dispatch.parsed(
        AGENTS.investigator,
        investigatorPrompt,
        `Investigating codebase (round ${iteration})`,
        parseInvestigatorResponse,
        () => {
          journey.formatRetries++;
        },
      ),
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
        conversationSection(ctx, journey),
        { title: 'USER REQUEST', body: ctx.initialPrompt },
        { title: 'RESEARCH BRIEF', body: response.researchBrief },
      ]);
      const research = await withAgentRetry(ctx, `RESEARCHER (round ${iteration})`, () =>
        ctx.dispatch.agent(AGENTS.researcher, researcherPrompt, `Researching online (round ${iteration})`),
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
    ? withAgentRetry(ctx, `RESEARCHER (${label} unknowns)`, () =>
        ctx.dispatch.agent(
          AGENTS.researcher,
          buildPrompt([
            conversationSection(ctx, journey),
            { title: 'USER REQUEST', body: ctx.initialPrompt },
            { title: 'RESEARCH UNKNOWNS', body: researchUnknowns },
          ]),
          `Resolving ${label} research unknowns`,
        ),
      )
    : Promise.resolve(null);
  const codebasePromise = codebaseUnknowns
    ? withAgentRetry(ctx, `INVESTIGATOR (${label} unknowns)`, () =>
        ctx.dispatch.parsed(
          AGENTS.investigator,
          buildPrompt([
            conversationSection(ctx, journey),
            { title: 'USER REQUEST', body: ctx.initialPrompt },
            { title: 'CODEBASE UNKNOWNS', body: codebaseUnknowns },
          ]),
          `Resolving ${label} codebase unknowns`,
          parseInvestigatorResponse,
          () => {
            journey.formatRetries++;
          },
        ),
      )
    : Promise.resolve(null);

  const [research, codebase] = await Promise.all([researchPromise, codebasePromise]);
  if (codebase) {
    await reconfigureContext(ctx, journey, `${label} — codebase unknowns`, codebase.add, codebase.remove);
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
    conversationSection(ctx, journey),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: 'RESEARCH FINDINGS', body: researchFindings.join('\n\n---\n\n') },
    { title: 'INSTRUCTION', body: 'Produce the Implementation Plan now, per your instructions.' },
  ]);

  const planText = await withAgentRetry(ctx, 'GRAND-PLANNER', () =>
    ctx.dispatch.agent(
      AGENTS.planner,
      plannerPrompt,
      'Producing Implementation Plan',
    ),
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
  isRectification: boolean,
  stageLabel?: string,
): Promise<FileEditInstruction[]> {
  const label = stageLabel ?? (isRectification ? 'Rectification plan decomposed' : 'Implementation plan decomposed');
  const decomposerSections: PromptSection[] = [
    conversationSection(ctx, journey),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: isRectification ? 'RECTIFICATION PLAN' : 'IMPLEMENTATION PLAN', body: `${planText}\n\n(verbatim — treat as strict instructions)` },
  ];

  if (resolvedResearch) {
    decomposerSections.push({ title: 'ADDITIONAL RESEARCH', body: resolvedResearch });
  }

  decomposerSections.push({
    title: 'INSTRUCTION',
    body: 'Decompose into per-file edit blocks now, per your instructions.',
  });

  const decomposerPrompt = buildPrompt(decomposerSections);

  const result = await withAgentRetry(ctx, 'DECOMPOSITOR', () =>
    ctx.dispatch.parsed(
      AGENTS.decompositor,
      decomposerPrompt,
      isRectification ? 'Decomposing rectification plan into file edits' : 'Decomposing plan into file edits',
      parseDecompositorResponse,
      () => {
        journey.formatRetries++;
      },
    ),
  );

  if (result.ambiguities) {
    journey.ambiguities = journey.ambiguities ? `${journey.ambiguities}\n\n---\n\n${result.ambiguities}` : result.ambiguities;
  }
  await emitInfo(
    ctx.log,
    formatEditTargets(label, result.edits.map((edit) => ({ path: edit.path, type: edit.type })), result.ambiguities),
  );
  return result.edits;
}

export async function runEditLoop(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  git: SimpleGit,
  edits: FileEditInstruction[],
  commitLabel: string,
): Promise<'ALIGNED' | 'DEFICIENT'> {
  report.abortStage = `editing (${commitLabel})`;
  let currentEdits = edits;
  let verdict: 'ALIGNED' | 'DEFICIENT' = 'DEFICIENT';
  const escalatedPaths = new Set<string>();
  const bumpGitRetry = (attempt: number, message: string) => {
    journey.gitRetries++;
    void ctx.log.warning(`Git retry ${attempt}: ${message}`);
  };

  for (let localPass = 1; localPass <= MAX_CONFIRM_PASSES; localPass++) {
    const pass = journey.passes.length + 1;
    const passBase = (await withGitRetry(() => git.revparse(['HEAD']), { name: 'pass baseline', onRetry: bumpGitRetry })).trim();

    // Pre-flight: execute deletions and validate paths synchronously before
    // any dispatch. Deletions are the pipeline's own job — editors never see
    // them. An EDIT whose file is missing is failed up front so the CONFIRMER
    // can issue a corrected path.
    const dispatchedEdits: FileEditInstruction[] = [];
    const results: EditorOutcome[] = [];
    for (const edit of currentEdits) {
      const abs = path.resolve(ctx.task.getTaskDir(), edit.path);
      if (edit.type === 'DELETE') {
        try {
          if (await fileExists(abs)) {
            await fs.rm(abs, { force: true });
            results.push({ path: edit.path, outcome: 'DONE', detail: 'deleted by pipeline' });
          } else {
            results.push({ path: edit.path, outcome: 'DONE', detail: 'already absent' });
          }
        } catch (error) {
          results.push({ path: edit.path, outcome: 'FAILED', detail: `deletion failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        continue;
      }
      // Pre-dispatch guard: a malformed instruction (prose instead of exact
      // code, empty NEW body, non-empty DELETE body) must never reach an
      // editor prompt — it becomes a FAILED outcome so the CONFIRMER issues
      // parse-validated corrective edits.
      const invalidReason = validateFileEditInstruction(edit);
      if (invalidReason) {
        results.push({ path: edit.path, outcome: 'FAILED', detail: `invalid edit instructions: ${invalidReason}` });
        continue;
      }
      if (edit.type === 'EDIT' && !(await fileExists(abs))) {
        results.push({ path: edit.path, outcome: 'FAILED', detail: 'instructed path does not exist' });
        continue;
      }
      if (edit.type === 'NEW') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }
      dispatchedEdits.push(edit);
    }

    // Dispatch: serial within a file, parallel across files. Each dispatch
    // carries a role-specific hard timeout; a light-editor timeout escalates
    // the same edit to EDITOR-HEAVY within this pass.
    const groups = new Map<string, number[]>();
    dispatchedEdits.forEach((edit, index) => {
      const key = normalizePath(edit.path);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    await Promise.all([...groups.values()].map(async (indexes) => {
      for (const index of indexes) {
        const edit = dispatchedEdits[index];
        const heavy = selectEditorRole(edit, escalatedPaths) === 'heavy';
        const timeoutMs = heavy ? EDITOR_HEAVY_TIMEOUT_MS : EDITOR_LIGHT_TIMEOUT_MS;
        const prompt = `Apply the following edit to exactly one file. The PATH has been verified by the pipeline: ${edit.type === 'NEW' ? 'the parent directory exists' : 'the file exists'}. Do not search for it.\n\n${serializeFileEdits([edit])}`;
        try {
          const raw = await ctx.dispatch.agent(
            heavy ? AGENTS.heavyEditor : AGENTS.editor,
            prompt,
            `Editing ${edit.path}${heavy ? ' (heavy editor)' : ''}`,
            { timeoutMs },
          );
          results.push({ path: edit.path, ...parseEditorResponse(raw), editorRole: heavy ? 'heavy' : 'light' });
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          if (error instanceof WorkflowTimeout) {
            if (!heavy) {
              journey.editorTimeouts++;
              escalatedPaths.add(normalizePath(edit.path));
              await ctx.log.warning(`Light editor timed out on ${edit.path}; escalating to EDITOR-HEAVY.`);
              try {
                const raw = await ctx.dispatch.agent(
                  AGENTS.heavyEditor,
                  prompt,
                  `Editing ${edit.path} (heavy editor, after light timeout)`,
                  { timeoutMs: EDITOR_HEAVY_TIMEOUT_MS },
                );
                results.push({ path: edit.path, ...parseEditorResponse(raw), editorRole: 'heavy' });
                continue;
              } catch (retryError) {
                if (retryError instanceof WorkflowCancelled) throw retryError;
                if (retryError instanceof WorkflowTimeout) journey.editorTimeouts++;
                results.push({ path: edit.path, outcome: 'FAILED', detail: String(retryError), editorRole: 'heavy' });
                continue;
              }
            }
            journey.editorTimeouts++;
            results.push({ path: edit.path, outcome: 'FAILED', detail: String(error), editorRole: 'heavy' });
            continue;
          }
          results.push({ path: edit.path, outcome: 'FAILED', detail: String(error), editorRole: heavy ? 'heavy' : 'light' });
        }
      }
    }));

    const editedPaths = results.map((result) => result.path);
    const commitMessage = `[${commitLabel} pass ${pass}] ${journey.planTitle.slice(0, 60)}`;
    let commitSucceeded = true;
    try {
      await withGitRetry(async () => { await git.add('-A'); await git.raw(['commit', '--no-verify', '--allow-empty', '-m', commitMessage]); }, { name: 'pass checkpoint commit', onRetry: bumpGitRetry });
    } catch (error) {
      commitSucceeded = false;
      const warning = `Checkpoint commit deferred after retries: ${error instanceof Error ? error.message : String(error)}`;
      journey.gitWarnings.push(warning); await ctx.log.warning(warning);
    }
    const changedRaw = commitSucceeded
      ? await withGitRetry(() => git.raw(['diff', '--name-only', '-z', passBase, 'HEAD']), { name: 'changed paths', onRetry: bumpGitRetry })
      : await withGitRetry(() => git.raw(['diff', '--name-only', '-z', passBase]), { name: 'working-tree changed paths', onRetry: bumpGitRetry });
    const changedPaths = parseChangedPaths(changedRaw);
    const statsMap = await collectDiffStats(git, passBase, commitSucceeded ? 'HEAD' : undefined, bumpGitRetry);
    const rows = buildEditRows(results, changedPaths, statsMap);
    const diff = await withGitRetry(() => commitSucceeded ? git.raw(['diff', passBase, 'HEAD']) : git.raw(['diff', passBase]), { name: 'pass diff', onRetry: bumpGitRetry });
    const addedLinesByFile = extractAddedLinesByFile(diff);
    const verificationResults: EditVerificationResult[] = [];
    for (const edit of currentEdits) {
      let content: string | null = null;
      try { content = await fs.readFile(path.resolve(ctx.task.getTaskDir(), edit.path), 'utf-8'); } catch {}
      const normPath = normalizePath(edit.path);
      const addedLines = new Set((addedLinesByFile.get(normPath) ?? []).map((line) => normalizeForCompare(line)));
      verificationResults.push(verifyEditAlignment(edit, content, statsMap.get(normPath) ?? { insertions: 0, deletions: 0 }, addedLines));
    }
    const suspicious = verificationResults.filter((v) => v.suspicious);
    const gate = evaluateEditGate(results, changedPaths, suspicious);
    for (const row of rows) { const entry = journey.fileStats[row.path] ?? { insertions: 0, deletions: 0, passes: 0 }; entry.insertions += row.insertions; entry.deletions += row.deletions; entry.passes++; journey.fileStats[row.path] = entry; }
    await reconfigureContext(ctx, journey, `${commitLabel} — pass ${pass} outputs`, [...new Set([...editedPaths, ...changedPaths])]);

    await emitInfo(ctx.log, formatEditSummary(commitLabel, pass, rows, gate.passed, gate.reason));
    if (suspicious.length > 0) {
      await emitInfo(ctx.log, formatVerificationFlags(verificationResults));
    }

    // Gate fast-path: when every edit is DONE, present in the diff, and free
    // of script-level suspicion, the CONFIRMER is skipped entirely.
    if (gate.passed) {
      journey.confirmerSkips++;
      journey.passes.push({ pass, stage: commitLabel, editCount: currentEdits.length, done: results.filter((r) => r.outcome === 'DONE').length, failed: results.filter((r) => r.outcome === 'FAILED').map((r) => r.path), unknown: results.filter((r) => r.outcome === 'UNKNOWN').map((r) => r.path), verdict: 'ALIGNED (gate)', commit: commitSucceeded ? commitMessage : 'DEFERRED (commit failed — see git warnings)', rows });
      verdict = 'ALIGNED';
      break;
    }

    await emitInfo(ctx.log, formatDeficiencyNotice(gate.reason));

    let confirmer: { verdict: 'ALIGNED' } | { verdict: 'DEFICIENT'; edits: FileEditInstruction[] };
    try {
      confirmer = await withAgentRetry(ctx, `CONFIRMER (pass ${pass})`, () =>
        ctx.dispatch.parsed(
          AGENTS.confirmer,
          buildPrompt([
            { title: 'FILE EDITS THAT WERE SUPPOSED TO BE APPLIED', body: serializeFileEdits(currentEdits) },
            { title: 'GIT DIFF', body: ['```diff', diff.slice(0, MAX_DIFF_CHARS), '```'].join('\n') },
            { title: 'EDITOR RESULTS', body: results.map((r) => `${r.path}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`).join('\n') },
            { title: 'SUSPICIOUS EDITS FLAGGED BY SCRIPT VERIFICATION', body: suspicious.length ? suspicious.map((v) => `${v.path}: ${v.reasons.join('; ')}`).join('\n') : 'None' },
            { title: 'PASS', body: `This is confirmation pass ${localPass} of ${MAX_CONFIRM_PASSES} for this edit batch.` },
          ]),
          `Confirming edits (pass ${pass})`,
          parseConfirmerResponse,
          () => { journey.formatRetries++; },
        ),
      );
    } catch (error) {
      if (error instanceof WorkflowCancelled) throw error;
      journey.passes.push({ pass, stage: commitLabel, editCount: currentEdits.length, done: results.filter((r) => r.outcome === 'DONE').length, failed: results.filter((r) => r.outcome === 'FAILED').map((r) => r.path), unknown: results.filter((r) => r.outcome === 'UNKNOWN').map((r) => r.path), verdict: 'CONFIRMER FAILED', commit: commitSucceeded ? commitMessage : 'DEFERRED (commit failed — see git warnings)', rows });
      await ctx.log.warning(`CONFIRMER failed after retries (pass ${pass}); marking the batch DEFICIENT.`);
      return 'DEFICIENT';
    }

    await emitInfo(ctx.log, formatConfirmerVerdict(pass, confirmer.verdict, confirmer.verdict === 'DEFICIENT' ? confirmer.edits.length : 0));
    for (const result of results) if (result.outcome !== 'DONE') escalatedPaths.add(normalizePath(result.path));
    for (const result of verificationResults) if (result.suspicious) escalatedPaths.add(normalizePath(result.path));
    journey.passes.push({ pass, stage: commitLabel, editCount: currentEdits.length, done: results.filter((r) => r.outcome === 'DONE').length, failed: results.filter((r) => r.outcome === 'FAILED').map((r) => r.path), unknown: results.filter((r) => r.outcome === 'UNKNOWN').map((r) => r.path), verdict: confirmer.verdict, commit: commitSucceeded ? commitMessage : 'DEFERRED (commit failed — see git warnings)', rows });
    if (confirmer.verdict === 'ALIGNED') { verdict = 'ALIGNED'; break; }
    currentEdits = confirmer.edits;
  }
  return verdict;
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
