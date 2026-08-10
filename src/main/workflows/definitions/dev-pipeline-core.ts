import fs from 'fs/promises';
import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';

import { fileExists } from '@common/utils';

import { Task } from '@/task';
import { WorkflowCancelled, WorkflowError } from '../dispatch';
import { WorkflowRunContext } from '../types';
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

export const AGENTS = {
  digester: 'DIGESTER',
  investigator: 'INVESTIGATOR',
  researcher: 'RESEARCHER',
  planner: 'GRAND-PLANNER',
  decompositor: 'DECOMPOSITOR',
  editor: 'EDITOR',
  confirmer: 'CONFIRMER',
} as const;

export const MAX_EVIDENCE_ITERATIONS = 3;
export const MAX_CONFIRM_PASSES = 3;
export const MAX_DIFF_CHARS = 80_000;
export const MAX_RESEARCH_DOC_CHARS = 30_000;

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

export async function prepareRepository(task: Task): Promise<{ git: SimpleGit; baselineCommit: string }> {
  const git = simpleGit(task.getTaskDir());
  if (!(await git.checkIsRepo())) {
    throw new WorkflowError('The task directory is not a git repository. The Dev Pipeline requires git.');
  }

  const status = await git.status();
  if (!status.isClean()) {
    await git.add('-A');
    await git.raw(['commit', '--no-verify', '-m', '[dev-pipeline] pre-edit snapshot']);
  }

  return { git, baselineCommit: (await git.revparse(['HEAD'])).trim() };
}

export async function getCumulativeDiff(git: SimpleGit, fromCommit: string, maxChars: number): Promise<string> {
  let diff = await git.raw(['diff', fromCommit, 'HEAD']);
  if (diff.length > maxChars) diff = diff.slice(0, maxChars) + '\n…[diff truncated]';
  return diff;
}

/** Single funnel for every workflow progress message. Keeps the channel and level consistent. */
export function emitInfo(task: Task, message: string): void {
  task.addLogMessage('info', message);
}

export async function reconfigureContext(
  task: Task,
  journey: Journey,
  label: string,
  addPaths: string[],
  removePaths: string[] = [],
): Promise<{ added: string[]; removed: string[]; skipped: string[] }> {
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
    emitInfo(task, formatContextChange(label, added, removed, skipped));
  }

  return { added, removed, skipped };
}

export async function collectDiffStats(git: SimpleGit): Promise<Map<string, { insertions: number; deletions: number }>> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  try {
    const summary = await git.diffSummary(['HEAD~1', 'HEAD']);
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
    const response = await ctx.dispatch.parsed(
      AGENTS.digester,
      `# User request\n${ctx.initialPrompt}\n\n# Research findings gathered so far\n${findings.join('\n\n---\n\n') || 'None yet.'}\n\n# Iteration\nThis is evidence-gathering iteration ${iteration} of ${MAX_EVIDENCE_ITERATIONS}.`,
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
          ctx.task,
          journey,
          `DIGESTER — irrelevant files (round ${iteration})`,
          [],
          response.irrelevantFiles,
        );
        row.removed = change.removed;
      }
      emitInfo(ctx.task, formatEvidenceSufficient());
      journey.evidenceRows.push(row);
      break;
    }

    emitInfo(ctx.task, formatEvidenceInsufficient(iteration, MAX_EVIDENCE_ITERATIONS, !!response.researchBrief));

    const investigation = await ctx.dispatch.parsed(
      AGENTS.investigator,
      `${response.investigationBrief}\n\nReminder: respond with exactly the required file sections.`,
      `Investigating codebase (round ${iteration})`,
      parseInvestigatorResponse,
      () => {
        journey.formatRetries++;
      },
    );

    const change = await reconfigureContext(
      ctx.task,
      journey,
      `INVESTIGATOR — round ${iteration}`,
      investigation.add,
      investigation.remove,
    );
    row.added = change.added;
    row.removed = change.removed;

    if (response.researchBrief) {
      const research = await ctx.dispatch.agent(AGENTS.researcher, response.researchBrief, `Researching online (round ${iteration})`);
      findings.push(research);
      journey.researchDocs++;
      row.research = true;
      emitInfo(ctx.task, formatResearchReceived(iteration, research.length));
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
    emitInfo(ctx.task, formatPlanUnknowns(label, researchUnknowns, codebaseUnknowns));
  }
  const researchPromise = researchUnknowns
    ? ctx.dispatch.agent(AGENTS.researcher, `# Unknowns raised by the Implementation Plan — find the answers\n${researchUnknowns}`, `Resolving ${label} research unknowns`)
    : Promise.resolve(null);
  const codebasePromise = codebaseUnknowns
    ? ctx.dispatch.parsed(
        AGENTS.investigator,
        `# The Implementation Plan raised these codebase unknowns — locate the relevant files\n${codebaseUnknowns}`,
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
    await reconfigureContext(ctx.task, journey, `${label} — codebase unknowns`, codebase.add, codebase.remove);
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
  const planText = await ctx.dispatch.agent(
    AGENTS.planner,
    `# User request\n${ctx.initialPrompt}\n\n${researchFindings.join('\n\n---\n\n')}\n\nProduce the Implementation Plan now, per your instructions.`,
    'Producing Implementation Plan',
  );
  journey.planTitle = parsePlanUnknowns(planText).title;
  emitInfo(ctx.task, formatPlanProduced(journey.planTitle));
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
  const result = await ctx.dispatch.parsed(
    AGENTS.decompositor,
    `${isRectification ? '# Rectification Plan' : '# Implementation Plan'} (verbatim — treat as strict instructions)\n\n${planText}\n\n${
      resolvedResearch ? `# Additional research\n\n${resolvedResearch}\n\n` : ''
    }Decompose into per-file edit blocks now, per your instructions.`,
    isRectification ? 'Decomposing rectification plan into file edits' : 'Decomposing plan into file edits',
    parseDecompositorResponse,
    () => {
      journey.formatRetries++;
    },
  );

  if (result.ambiguities) {
    journey.ambiguities = journey.ambiguities ? `${journey.ambiguities}\n\n---\n\n${result.ambiguities}` : result.ambiguities;
  }
  emitInfo(
    ctx.task,
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

  for (let localPass = 1; localPass <= MAX_CONFIRM_PASSES; localPass++) {
    const pass = journey.passes.length + 1;

    const results = await Promise.all(
      currentEdits.map(async (edit) => {
        try {
          const raw = await ctx.dispatch.agent(
            AGENTS.editor,
            `Apply the following edit to exactly one file:\n\n${serializeFileEdits([edit])}`,
            `Editing ${edit.path}`,
          );
          return { path: edit.path, ...parseEditorResponse(raw) };
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          return { path: edit.path, outcome: 'FAILED' as const, detail: String(error) };
        }
      }),
    );

    const editedPaths = results.map((result) => result.path);
    await reconfigureContext(ctx.task, journey, `${commitLabel} — pass ${pass} outputs`, editedPaths);

    const commitMessage = `[${commitLabel} pass ${pass}] ${journey.planTitle.slice(0, 60)}`;
    await git.add('-A');
    await git.raw(['commit', '--no-verify', '--allow-empty', '-m', commitMessage]);

    const changedPaths = parseChangedPaths(await git.raw(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']));
    const statsMap = await collectDiffStats(git);
    const rows = buildEditRows(results, changedPaths, statsMap);
    const gate = evaluateEditGate(results, changedPaths);

    for (const row of rows) {
      const entry = journey.fileStats[row.path] ?? { insertions: 0, deletions: 0, passes: 0 };
      entry.insertions += row.insertions;
      entry.deletions += row.deletions;
      entry.passes += 1;
      journey.fileStats[row.path] = entry;
    }

    emitInfo(ctx.task, formatEditSummary(commitLabel, pass, rows, gate.passed, gate.reason));
    if (!gate.passed) emitInfo(ctx.task, formatDeficiencyNotice(gate.reason));

    const verificationResults: EditVerificationResult[] = [];
    for (const edit of currentEdits) {
      const filePath = path.resolve(ctx.task.getTaskDir(), edit.path);
      let fileContent: string | null = null;
      try {
        fileContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        // Missing files are represented by null for deterministic verification.
      }
      const fileStats = statsMap.get(normalizePath(edit.path)) ?? { insertions: 0, deletions: 0 };
      verificationResults.push(verifyEditAlignment(edit, fileContent, fileStats));
    }

    const verificationMessage = formatVerificationFlags(verificationResults);
    if (verificationMessage) emitInfo(ctx.task, verificationMessage);

    let diff = await git.raw(['diff', 'HEAD~1', 'HEAD']);
    if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff truncated]';

    const editorResultsSummary = results
      .map((r) => `${r.path}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`)
      .join('\n');
    const suspiciousEdits = verificationResults.filter((v) => v.suspicious);
    const suspiciousSummary = suspiciousEdits.length > 0
      ? suspiciousEdits.map((v) => `${v.path}: ${v.reasons.join('; ')}`).join('\n')
      : 'None';

    const confirmerPrompt = [
      `# File edits that were supposed to be applied`,
      ``,
      serializeFileEdits(currentEdits),
      ``,
      `# Git diff`,
      ``,
      '```diff',
      diff,
      '```',
      ``,
      `# Editor results`,
      ``,
      editorResultsSummary,
      ``,
      `# Suspicious edits flagged by script verification`,
      ``,
      suspiciousSummary,
      ``,
      `# Verification instructions`,
      ``,
      `You must verify that every instructed edit is present and correct in the diff/files.`,
      ``,
      `Critical rules:`,
      `- If an editor reported FAILED for a file, you CANNOT return ALIGNED unless you have read that file and confirmed the edit was actually applied correctly despite the editor's report.`,
      `- If an edit was flagged as suspicious by the script verification, you MUST read that file and verify the instruction was applied correctly. You CANNOT return ALIGNED for a suspicious edit without explicitly verifying it.`,
      `- If an editor reported UNKNOWN, treat it the same as FAILED: you MUST NOT return ALIGNED for that file unless you have read the file and confirmed the edit was applied correctly.`,
      ``,
      `Verify alignment now.`,
    ].join('\n');

    const confirmation = await ctx.dispatch.parsed(
      AGENTS.confirmer,
      confirmerPrompt,
      `Confirming edits (pass ${pass})`,
      parseConfirmerResponse,
      () => {
        journey.formatRetries++;
      },
    );

    let passVerdict = confirmation.verdict;
    let nextEdits: FileEditInstruction[] | null = null;
    if (confirmation.verdict === 'DEFICIENT') nextEdits = confirmation.edits;

    emitInfo(ctx.task, formatConfirmerVerdict(pass, confirmation.verdict, nextEdits?.length ?? 0));

    const record: EditPassRecord = {
      pass,
      stage: commitLabel,
      editCount: currentEdits.length,
      done: results.filter((result) => result.outcome === 'DONE').length,
      failed: results.filter((result) => result.outcome === 'FAILED').map((result) => result.path),
      unknown: results.filter((result) => result.outcome === 'UNKNOWN').map((result) => result.path),
      verdict: passVerdict,
      commit: commitMessage,
      rows,
    };
    journey.passes.push(record);

    if (passVerdict === 'ALIGNED') {
      verdict = 'ALIGNED';
      break;
    }

    currentEdits = nextEdits ?? [];
  }

  return verdict;
}

export async function emitReport(task: Task, journey: Journey, report: ReportState, workflowName: string): Promise<void> {
  emitInfo(task, formatJourneyReport(journey, report, workflowName));
}