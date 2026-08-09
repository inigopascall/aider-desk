import path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import { v4 as uuidv4 } from 'uuid';

import { ContextAssistantMessage, MessageRole, WORKFLOW_AGENT_ROLES, WorkflowModelSet } from '@common/types';
import { fileExists } from '@common/utils';

import { Task } from '@/task';
import { WorkflowCancelled, WorkflowError } from '../dispatch';
import { WorkflowRunContext } from '../types';
import {
  FileEditInstruction,
  parseConfirmerResponse,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeFileEdits,
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

export interface EvidenceRow {
  iteration: number;
  verdict: string;
  added: string[];
  removed: string[];
  research: boolean;
}

export interface EditorOutcome {
  path: string;
  outcome: 'DONE' | 'FAILED' | 'UNKNOWN';
  detail?: string;
}

export interface ReviewRoundRow {
  round: number;
  correctness: string;
  quality: string;
  outcome: 'clean' | 'rectified' | 'exhausted';
  rectificationEdits: number;
}

export interface Journey {
  evidenceIterations: number;
  filesAdded: string[];
  filesRemoved: string[];
  filesSkipped: string[];
  researchDocs: number;
  digesterVerdicts: string[];
  planTitle: string;
  unknownsResearchResolved: boolean;
  unknownsCodebaseResolved: boolean;
  ambiguities: string | null;
  passes: { pass: number; editCount: number; done: number; failed: string[]; unknown: string[]; verdict: string; commit: string }[];
  formatRetries: number;
  confirmerSkips: number;
  cancelled: boolean;
  modelSetName: string;
  modelOverrides: Record<string, string>;
  conversationChars: number;
  reviewRounds: number;
  reviewTable: ReviewRoundRow[];
  reviewFindings: { round: number; findings: string }[];
  reviewerConsiderations: string | null;
  verifierFailures: string[];
  error?: string;
}

export interface ReportState {
  evidenceRows: EvidenceRow[];
  status: 'aligned' | 'deficient' | 'aborted' | 'cancelled';
  abortStage?: string;
}

export function createJourney(modelSet: WorkflowModelSet | undefined, conversationText: string): Journey {
  return {
    evidenceIterations: 0,
    filesAdded: [],
    filesRemoved: [],
    filesSkipped: [],
    researchDocs: 0,
    digesterVerdicts: [],
    planTitle: '',
    unknownsResearchResolved: false,
    unknownsCodebaseResolved: false,
    ambiguities: null,
    passes: [],
    formatRetries: 0,
    confirmerSkips: 0,
    cancelled: false,
    modelSetName: modelSet?.name ?? '',
    modelOverrides: modelSet?.models ?? {},
    conversationChars: conversationText.length,
    reviewRounds: 0,
    reviewTable: [],
    reviewFindings: [],
    reviewerConsiderations: null,
    verifierFailures: [],
  };
}

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

export async function addPathsToContext(task: Task, journey: Journey, paths: string[]): Promise<void> {
  for (const filePath of paths) {
    if (await fileExists(path.resolve(task.getTaskDir(), filePath))) {
      await task.addFiles({ path: filePath, readOnly: false });
      journey.filesAdded.push(filePath);
    } else {
      journey.filesSkipped.push(filePath);
    }
  }
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
    if (response.verdict === 'YES') break;

    const investigation = await ctx.dispatch.parsed(
      AGENTS.investigator,
      `${response.investigationBrief}\n\nReminder: respond with exactly the required file sections.`,
      `Investigating codebase (round ${iteration})`,
      parseInvestigatorResponse,
      () => {
        journey.formatRetries++;
      },
    );
    await addPathsToContext(ctx.task, journey, investigation.add);

    if (response.researchBrief) {
      const research = await ctx.dispatch.agent(AGENTS.researcher, response.researchBrief, `Researching online (round ${iteration})`);
      findings.push(research);
      journey.researchDocs++;
    }
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
    await addPathsToContext(ctx.task, journey, codebase.add);
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
  return { planText, unknownsResearch: await resolvePlanUnknowns(ctx, journey, planText, 'plan') };
}

export async function runDecompositionStage(
  ctx: WorkflowRunContext,
  journey: Journey,
  report: ReportState,
  planText: string,
  resolvedResearch: string | null,
  isRectification: boolean,
): Promise<FileEditInstruction[]> {
  report.abortStage = isRectification ? 'rectification decomposition' : 'decomposition';
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
          const raw = await ctx.dispatch.agent(AGENTS.editor, `Apply the following edit to exactly one file:\n\n${serializeFileEdits([edit])}`, `Editing ${edit.path}`);
          return { path: edit.path, ...parseEditorResponse(raw) };
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          return { path: edit.path, outcome: 'FAILED' as const, detail: String(error) };
        }
      }),
    );

    for (const result of results) {
      if (await fileExists(path.resolve(ctx.task.getTaskDir(), result.path))) {
        await ctx.task.addFiles({ path: result.path, readOnly: false });
      }
    }

    const commitMessage = `[${commitLabel} pass ${pass}] ${journey.planTitle.slice(0, 60)}`;
    await git.add('-A');
    await git.raw(['commit', '--no-verify', '--allow-empty', '-m', commitMessage]);

    const changedPaths = parseChangedPaths(await git.raw(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']));
    const gate = evaluateEditGate(results, changedPaths);
    let nextEdits: FileEditInstruction[] | null = null;
    let passVerdict = gate.passed ? 'ALIGNED (gate)' : '';

    if (!gate.passed) {
      let diff = await git.raw(['diff', 'HEAD~1', 'HEAD']);
      if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff truncated]';
      const confirmation = await ctx.dispatch.parsed(
        AGENTS.confirmer,
        `# File edits that were supposed to be applied\n\n${serializeFileEdits(currentEdits)}\n\n# Git diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nVerify alignment now.`,
        `Confirming edits (pass ${pass})`,
        parseConfirmerResponse,
        () => {
          journey.formatRetries++;
        },
      );
      passVerdict = confirmation.verdict;
      if (confirmation.verdict === 'DEFICIENT') nextEdits = confirmation.edits;
    } else {
      journey.confirmerSkips++;
    }

    const done = results.filter((result) => result.outcome === 'DONE').length;
    journey.passes.push({
      pass,
      editCount: currentEdits.length,
      done,
      failed: results.filter((result) => result.outcome === 'FAILED').map((result) => result.path),
      unknown: results.filter((result) => result.outcome === 'UNKNOWN').map((result) => result.path),
      verdict: passVerdict,
      commit: commitMessage,
    });

    if (gate.passed || passVerdict === 'ALIGNED') {
      verdict = 'ALIGNED';
      break;
    }

    currentEdits = nextEdits ?? [];
  }

  return verdict;
}

export async function buildReport(journey: Journey, report: ReportState): Promise<string> {
  const lines = [`# 🏁 Dev Pipeline Report`, '', '## Plan', '', `- **Title:** ${journey.planTitle || '—'}`, ''];
  lines.push('## Edit passes', '', '| Pass | Edits dispatched | DONE | FAILED | UNKNOWN | Confirmer verdict | Commit |', '|---|---|---|---|---|---|---|');
  for (const pass of journey.passes) {
    lines.push(`| ${pass.pass} | ${pass.editCount} | ${pass.done} | ${pass.failed.join(', ') || '—'} | ${pass.unknown.join(', ') || '—'} | ${pass.verdict} | \`${pass.commit}\` |`);
  }
  if (journey.reviewRounds > 0) {
    lines.push('', '## Review', '', '| Round | Correctness | Quality | Outcome | Rectification edits |', '|---|---|---|---|---|');
    for (const row of journey.reviewTable) {
      lines.push(`| ${row.round} | ${row.correctness} | ${row.quality} | ${row.outcome} | ${row.rectificationEdits} |`);
    }
    for (const finding of journey.reviewFindings) {
      lines.push('', `### Review round ${finding.round} — arbiter findings`, '', finding.findings);
    }
    if (journey.reviewerConsiderations) lines.push('', '### Reviewer considerations', '', journey.reviewerConsiderations);
    if (journey.verifierFailures.length > 0) lines.push('', '### Verifier failures', '', ...journey.verifierFailures.map((failure) => `- ${failure}`));
    lines.push('', `**Review rounds:** ${journey.reviewRounds}`);
  }
  lines.push('', `**Format retries:** ${journey.formatRetries}`, '', `**CONFIRMER skips (fast-path gate):** ${journey.confirmerSkips}`, '', `**Status:** ${report.status}`);
  return lines.join('\n');
}

export async function emitReport(task: Task, journey: Journey, report: ReportState): Promise<void> {
  const reportText = await buildReport(journey, report);
  const id = uuidv4();
  await task.addContextMessage({ id, role: MessageRole.Assistant, content: reportText, timestamp: Date.now() } as ContextAssistantMessage, true);
  await task.processResponseMessage({ id, action: 'response', content: reportText, finished: true }, false);
}