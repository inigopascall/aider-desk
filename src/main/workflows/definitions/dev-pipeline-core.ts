import fs from 'fs/promises';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

import { fileExists } from '@common/utils';

import { Task } from '@/task';
import { WorkflowCancelled, WorkflowError } from '../dispatch';
import { WorkflowLogger, WorkflowRunContext } from '../types';
import {
  createJourney,
  type EditPassRecord,
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
  parseConfirmerResponse,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeFileEdits,
  verifyEditAlignment,
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
  confirmer: 'CONFIRMER',
} as const;

export const MAX_EVIDENCE_ITERATIONS = 3;
export const MAX_CONFIRM_PASSES = 3;
export const MAX_DIFF_CHARS = 80_000;
export const MAX_RESEARCH_DOC_CHARS = 30_000;
export const HEAVY_NEW_CHAR_THRESHOLD = 10_000;
export const HEAVY_NEW_LINE_THRESHOLD = 250;
export const HEAVY_EDIT_CHAR_THRESHOLD = 6_000;

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

export function evaluateEditGate(results: EditorOutcome[], changedPaths: string[]): { passed: boolean; reason: string } {
  if (results.length === 0) return { passed: false, reason: 'no edits were dispatched' };

  const notDone = results.filter((result) => result.outcome !== 'DONE').map((result) => result.path);
  if (notDone.length > 0) return { passed: false, reason: `editor did not report DONE for: ${notDone.join(', ')}` };

  const expected = new Set(results.map((result) => normalizePath(result.path)));
  const actual = new Set(changedPaths);
  const missing = [...expected].filter((filePath) => !actual.has(filePath));
  if (missing.length > 0) return { passed: false, reason: `instructed file(s) absent from the diff: ${missing.join(', ')}` };

  const extra = [...actual].filter((filePath) => !expected.has(filePath));
  if (extra.length > 0) return { passed: false, reason: `diff touches unexpected file(s): ${extra.join(', ')}` };

  return { passed: true, reason: '' };
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

export async function collectDiffStats(git: SimpleGit, fromRef: string, toRef?: string): Promise<Map<string, { insertions: number; deletions: number }>> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  try {
    const summary = await git.diffSummary(toRef ? [fromRef, toRef] : [fromRef]);
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
      { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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

    journey.digesterVerdicts.push(response.verdict);
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
      { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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
        { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
        { title: 'USER REQUEST', body: ctx.initialPrompt },
        { title: 'RESEARCH BRIEF', body: response.researchBrief },
      ]);
      const research = await ctx.dispatch.agent(AGENTS.researcher, researcherPrompt, `Researching online (round ${iteration})`);
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
          { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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
          { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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
  if (research) journey.unknownsResearchResolved = true;
  if (codebase) {
    journey.unknownsCodebaseResolved = true;
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
    { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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
  isRectification: boolean,
  stageLabel?: string,
): Promise<FileEditInstruction[]> {
  const label = stageLabel ?? (isRectification ? 'Rectification plan decomposed' : 'Implementation plan decomposed');
  const decomposerSections: PromptSection[] = [
    { title: 'CONVERSATION HISTORY', body: ctx.conversationText },
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

  const result = await ctx.dispatch.parsed(
    AGENTS.decompositor,
    decomposerPrompt,
    isRectification ? 'Decomposing rectification plan into file edits' : 'Decomposing plan into file edits',
    parseDecompositorResponse,
    () => {
      journey.formatRetries++;
    },
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
    const results: EditorOutcome[] = new Array(currentEdits.length);
    const groups = new Map<string, number[]>();
    currentEdits.forEach((edit, index) => {
      const key = normalizePath(edit.path);
      groups.set(key, [...(groups.get(key) ?? []), index]);
    });
    await Promise.all([...groups.values()].map(async (indexes) => {
      for (const index of indexes) {
        const edit = currentEdits[index];
        const heavy = selectEditorRole(edit, escalatedPaths) === 'heavy';
        try {
          const raw = await ctx.dispatch.agent(
            heavy ? AGENTS.heavyEditor : AGENTS.editor,
            `Apply the following edit to exactly one file:\n\n${serializeFileEdits([edit])}`,
            `Editing ${edit.path}${heavy ? ' (heavy editor)' : ''}`,
          );
          results[index] = { path: edit.path, ...parseEditorResponse(raw), editorRole: heavy ? 'heavy' : 'light' };
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          results[index] = { path: edit.path, outcome: 'FAILED', detail: String(error), editorRole: heavy ? 'heavy' : 'light' };
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
    const statsMap = await collectDiffStats(git, passBase, commitSucceeded ? 'HEAD' : undefined);
    const rows = buildEditRows(results, changedPaths, statsMap);
    const gate = evaluateEditGate(results, changedPaths);
    for (const row of rows) { const entry = journey.fileStats[row.path] ?? { insertions: 0, deletions: 0, passes: 0 }; entry.insertions += row.insertions; entry.deletions += row.deletions; entry.passes++; journey.fileStats[row.path] = entry; }
    await reconfigureContext(ctx, journey, `${commitLabel} — pass ${pass} outputs`, [...new Set([...editedPaths, ...changedPaths])]);
    const verificationResults: EditVerificationResult[] = [];
    for (const edit of currentEdits) { let content: string | null = null; try { content = await fs.readFile(path.resolve(ctx.task.getTaskDir(), edit.path), 'utf-8'); } catch {} verificationResults.push(verifyEditAlignment(edit, content, statsMap.get(normalizePath(edit.path)) ?? { insertions: 0, deletions: 0 })); }
    const diff = await withGitRetry(() => commitSucceeded ? git.raw(['diff', passBase, 'HEAD']) : git.raw(['diff', passBase]), { name: 'confirmer diff', onRetry: bumpGitRetry });
    const suspicious = verificationResults.filter((v) => v.suspicious);
    const confirmer = await ctx.dispatch.parsed(AGENTS.confirmer, buildPrompt([
      { title: 'FILE EDITS THAT WERE SUPPOSED TO BE APPLIED', body: serializeFileEdits(currentEdits) },
      { title: 'GIT DIFF', body: ['```diff', diff.slice(0, MAX_DIFF_CHARS), '```'].join('\n') },
      { title: 'EDITOR RESULTS', body: results.map((r) => `${r.path}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`).join('\n') },
      { title: 'SUSPICIOUS EDITS FLAGGED BY SCRIPT VERIFICATION', body: suspicious.length ? suspicious.map((v) => `${v.path}: ${v.reasons.join('; ')}`).join('\n') : 'None' },
    ]), `Confirming edits (pass ${pass})`, parseConfirmerResponse, () => { journey.formatRetries++; });
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
