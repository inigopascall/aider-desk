import { createHash } from 'node:crypto';
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
  formatContextChange,
  formatEditBatchSummary,
  formatEditTargets,
  formatEvidenceInsufficient,
  formatEvidenceSufficient,
  formatJourneyReport,
  formatCheckpointReport,
  formatPlanProduced,
  formatPlanUnknowns,
  formatResearchReceived,
} from '../reporting';
import {
  DELETE_MARKER,
  FileEditInstruction,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeFileEdits,
  validateEditChains,
} from '../parsers';

import { buildPrompt, PromptSection } from '../prompt-formatting';
import { withGitRetry } from '../git-utils';

export const AGENTS = {
  digester: 'DIGESTER',
  investigator: 'INVESTIGATOR',
  researcher: 'RESEARCHER',
  planner: 'GRAND-PLANNER',
  decompositor: 'DECOMPOSITOR',
  editor: 'EDITOR-LIGHT',
  heavyEditor: 'EDITOR-HEAVY',
} as const;

export const MAX_EVIDENCE_ITERATIONS = 3;
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

export function selectEditorRole(edit: FileEditInstruction): 'light' | 'heavy' {
  if (edit.type === 'NEW' && (edit.instructions.length > HEAVY_NEW_CHAR_THRESHOLD || edit.instructions.split(/\r?\n/).length > HEAVY_NEW_LINE_THRESHOLD)) return 'heavy';
  if (edit.type === 'EDIT' && edit.instructions.length > HEAVY_EDIT_CHAR_THRESHOLD) return 'heavy';
  return 'light';
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

export function buildEditRows(
  results: EditorOutcome[],
  changedPaths: string[],
  stats: Map<string, { insertions: number; deletions: number }>,
): FileChangeRow[] {
  const changed = new Set(changedPaths);
  const rows: FileChangeRow[] = [];

  // Group by path and take the LAST outcome for that path
  const lastOutcomeByPath = new Map<string, EditorOutcome>();
  for (const result of results) {
    lastOutcomeByPath.set(normalizePath(result.path), result);
  }

  for (const [filePath, result] of lastOutcomeByPath.entries()) {
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
): Promise<{ edits: FileEditInstruction[]; summary: string }> {
  const decomposerSections: PromptSection[] = [
    conversationSection(ctx),
    { title: 'USER REQUEST', body: ctx.initialPrompt },
    { title: 'IMPLEMENTATION PLAN', body: `${planText}\n\n(verbatim — treat as strict instructions)` },
  ];

  if (resolvedResearch) {
    decomposerSections.push({ title: 'ADDITIONAL RESEARCH', body: resolvedResearch });
  }

  decomposerSections.push({
    title: 'INSTRUCTION',
    body: 'Decompose into ordered edit specs now, per your instructions.',
  });

  const decomposerPrompt = buildPrompt(decomposerSections);

  const result = await ctx.dispatch.parsed(
    AGENTS.decompositor,
    decomposerPrompt,
    'Decomposing plan into file edits',
    parseDecompositorResponse,
    () => {
      journey.formatRetries++;
    },
  );

  await emitInfo(ctx.log, formatEditTargets('Implementation plan decomposed', result.edits));
  return { edits: result.edits, summary: result.summary };
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

function validateAppliedEdit(
  edit: FileEditInstruction,
  pre: { exists: boolean; content: string | null; hash: string | null; size: number },
  post: { exists: boolean; content: string | null; hash: string | null; size: number },
): string | null {
  if (!post.exists || post.content === null) {
    return 'post-edit file does not exist';
  }

  const lines = post.content.split(/\r?\n/);
  for (const line of lines) {
    if (/^<{7}/.test(line) || /^>{7}/.test(line)) {
      return 'post-edit file contains conflict markers (<<<<<<< or >>>>>>>)';
    }
  }

  if (edit.path.toLowerCase().endsWith('.json') && edit.type !== 'DELETE') {
    try {
      JSON.parse(post.content);
    } catch {
      return 'post-edit JSON file is not valid JSON';
    }
  }

  if (edit.type === 'NEW') {
    if (pre.exists) {
      return 'file already existed before create';
    }
    if (post.content.trim().length === 0) {
      return 'created file is empty';
    }
    return null;
  }

  if (edit.type === 'EDIT') {
    if (!pre.exists) {
      return 'file did not exist before edit';
    }
    if (post.content.trim().length === 0) {
      return 'edited file is empty';
    }
    if (post.hash === pre.hash) {
      return 'file content was unchanged after edit';
    }
    return null;
  }

  if (edit.type === 'DELETE') {
    if (post.content.trim() !== DELETE_MARKER) {
      return `deleted file does not contain exact deprecation marker: ${DELETE_MARKER}`;
    }
    return null;
  }

  return 'unknown edit type';
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
  const batch = journey.batches.length + 1;
  const escalatedPaths = new Set<string>();

  const bumpGitRetry = (attempt: number, message: string) => {
    journey.gitRetries++;
    void ctx.log.warning(`Git retry ${attempt}: ${message}`);
  };

  const passBase = (await withGitRetry(() => git.revparse(['HEAD']), { name: 'batch baseline', onRetry: bumpGitRetry })).trim();

  // 2. Normalize edit paths, check existing paths, validate chains
  const normalizedEdits = edits.map((e) => ({ ...e, path: normalizePath(e.path) }));
  const uniquePaths = [...new Set(normalizedEdits.map((e) => e.path))];
  const existingPaths = new Set<string>();
  for (const p of uniquePaths) {
    const abs = path.resolve(ctx.task.getTaskDir(), p);
    if (await fileExists(abs)) {
      existingPaths.add(p);
    }
  }

  const chainProblems = validateEditChains(normalizedEdits, existingPaths);
  const results: EditorOutcome[] = [];
  const validEditsByPath = new Map<string, FileEditInstruction[]>();

  for (const edit of normalizedEdits) {
    const problem = chainProblems.get(edit.path);
    if (problem) {
      const alreadyReported = results.some((r) => r.path === edit.path);
      if (!alreadyReported) {
        results.push({ editId: edit.id, path: edit.path, outcome: 'FAILED', detail: problem });
      } else {
        results.push({ editId: edit.id, path: edit.path, outcome: 'BLOCKED', detail: 'blocked by invalid chain' });
      }
    } else {
      const list = validEditsByPath.get(edit.path) ?? [];
      list.push(edit);
      validEditsByPath.set(edit.path, list);
    }
  }

  // 3. Ensure parent directory exists for files starting with NEW
  for (const [p, chain] of validEditsByPath.entries()) {
    if (chain[0].type === 'NEW') {
      const abs = path.resolve(ctx.task.getTaskDir(), p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
    }
  }

  // 4. Run chains concurrently
  await Promise.all(
    [...validEditsByPath.entries()].map(async ([p, chain]) => {
      const abs = path.resolve(ctx.task.getTaskDir(), p);

      for (let i = 0; i < chain.length; i++) {
        const edit = chain[i];
        const pre = await readTarget(abs);
        let heavy = escalatedPaths.has(p) || selectEditorRole(edit) === 'heavy';
        let timeoutMs = heavy ? EDITOR_HEAVY_TIMEOUT_MS : EDITOR_LIGHT_TIMEOUT_MS;

        const basePrompt = `Apply the following edit to exactly one file. Earlier edits to this file in this batch are already applied — the file's current on-disk content is authoritative.\n\n${serializeFileEdits([edit])}`;

        let outcomeResult: { outcome: 'DONE' | 'FAILED' | 'UNKNOWN'; detail?: string };
        let failureReason: string | null = null;
        let usedRole: 'light' | 'heavy' = heavy ? 'heavy' : 'light';

        try {
          const raw = await ctx.dispatch.agent(
            heavy ? AGENTS.heavyEditor : AGENTS.editor,
            basePrompt,
            `Editing ${edit.path} (EDIT ${edit.id}${heavy ? ', heavy' : ''})`,
            { timeoutMs },
          );
          outcomeResult = parseEditorResponse(raw);
          if (outcomeResult.outcome !== 'DONE') {
            failureReason = outcomeResult.detail ?? outcomeResult.outcome;
          } else {
            const post = await readTarget(abs);
            failureReason = validateAppliedEdit(edit, pre, post);
          }
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          if (error instanceof WorkflowTimeout) journey.editorTimeouts++;
          failureReason = error instanceof Error ? error.message : String(error);
          outcomeResult = { outcome: 'FAILED', detail: failureReason };
        }

        // Escalation: if light attempt failed, retry ONCE with heavy
        if (failureReason !== null && !heavy) {
          escalatedPaths.add(p);
          heavy = true;
          usedRole = 'heavy';
          await ctx.log.warning(`Light editor failed on ${edit.path} (EDIT ${edit.id}: ${failureReason}); escalating to EDITOR-HEAVY.`);

          const retryPrompt = `${basePrompt}\n\n=== PREVIOUS ATTEMPT FAILED ===\n${failureReason}\nRe-read the file and apply the edit correctly.`;
          try {
            const raw = await ctx.dispatch.agent(
              AGENTS.heavyEditor,
              retryPrompt,
              `Editing ${edit.path} (EDIT ${edit.id}, heavy escalation)`,
              { timeoutMs: EDITOR_HEAVY_TIMEOUT_MS },
            );
            outcomeResult = parseEditorResponse(raw);
            if (outcomeResult.outcome !== 'DONE') {
              failureReason = outcomeResult.detail ?? outcomeResult.outcome;
            } else {
              const post = await readTarget(abs);
              failureReason = validateAppliedEdit(edit, pre, post);
            }
          } catch (retryError) {
            if (retryError instanceof WorkflowCancelled) throw retryError;
            if (retryError instanceof WorkflowTimeout) journey.editorTimeouts++;
            failureReason = retryError instanceof Error ? retryError.message : String(retryError);
            outcomeResult = { outcome: 'FAILED', detail: failureReason };
          }
        }

        if (failureReason === null) {
          results.push({ editId: edit.id, path: edit.path, outcome: 'DONE', editorRole: usedRole });
        } else {
          results.push({ editId: edit.id, path: edit.path, outcome: 'FAILED', detail: failureReason, editorRole: usedRole });
          // Block all remaining edits in this chain
          for (let j = i + 1; j < chain.length; j++) {
            results.push({
              editId: chain[j].id,
              path: chain[j].path,
              outcome: 'BLOCKED',
              detail: `blocked by failed EDIT ${edit.id}`,
            });
          }
          return;
        }
      }
    }),
  );

  // 5. Commit & diff
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

  // 6. Batch validation
  const expected = new Set(normalizedEdits.map((e) => e.path));
  const changedSet = new Set(changedPaths);

  const donePaths = new Set(results.filter((r) => r.outcome === 'DONE').map((r) => r.path));
  const missing = [...donePaths].filter((p) => !changedSet.has(p));
  const unexpected = changedPaths.filter((p) => !expected.has(p));

  const notDone = results.filter((r) => r.outcome !== 'DONE');
  const passed = notDone.length === 0 && missing.length === 0 && unexpected.length === 0;

  const reasons: string[] = [];
  if (notDone.length > 0) {
    const failedLabels = notDone.map((r) => `EDIT ${r.editId} (${r.path}: ${r.outcome}${r.detail ? ` - ${r.detail}` : ''})`);
    reasons.push(`unsuccessful edits: ${failedLabels.join(', ')}`);
  }
  if (missing.length > 0) {
    reasons.push(`instructed file(s) absent from the diff: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    reasons.push(`diff touches unexpected file(s): ${unexpected.join(', ')}`);
  }
  const reason = reasons.join('; ');
  const verdict = passed ? 'ALIGNED' : 'DEFICIENT';

  // 7. Build rows & accumulate stats
  const rows = buildEditRows(results, changedPaths, statsMap);
  for (const row of rows) {
    const entry = journey.fileStats[row.path] ?? { insertions: 0, deletions: 0, passes: 0 };
    entry.insertions += row.insertions;
    entry.deletions += row.deletions;
    entry.passes++;
    journey.fileStats[row.path] = entry;
  }
  await reconfigureContext(ctx, journey, `${commitLabel} — batch ${batch} outputs`, [...new Set([...expected, ...changedPaths])]);

  // 8. Record batch & emit summary
  journey.batches.push({
    batch,
    stage: commitLabel,
    editCount: normalizedEdits.length,
    done: results.filter((r) => r.outcome === 'DONE').length,
    failed: results.filter((r) => r.outcome === 'FAILED').map((r) => `EDIT ${r.editId}: ${r.path}`),
    blocked: results.filter((r) => r.outcome === 'BLOCKED').map((r) => `EDIT ${r.editId}: ${r.path}`),
    unknown: results.filter((r) => r.outcome === 'UNKNOWN').map((r) => `EDIT ${r.editId}: ${r.path}`),
    verdict: passed ? 'ALIGNED' : `DEFICIENT: ${reason}`,
    commit: commitSucceeded ? commitMessage : 'DEFERRED (commit failed — see git warnings)',
    rows,
  });

  await emitInfo(ctx.log, formatEditBatchSummary(commitLabel, batch, rows, passed, reason));
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
