import path from 'path';

import { simpleGit } from 'simple-git';
import { v4 as uuidv4 } from 'uuid';

import { ContextAssistantMessage, MessageRole, WORKFLOW_AGENT_ROLES } from '@common/types';
import { fileExists } from '@common/utils';

import type { Task } from '@/task';
import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  type FileEditInstruction,
  parseConfirmerResponse,
  parseDecompositorResponse,
  parseDigesterResponse,
  parseEditorResponse,
  parseInvestigatorResponse,
  parsePlanUnknowns,
  serializeFileEdits,
} from '../parsers';
import { WorkflowCancelled, WorkflowError } from '../dispatch';

/**
 * The "Dev Pipeline" is an imperative, end-to-end development workflow. It
 * drives a sequence of specialised workflow agents (evidence gathering,
 * planning, decomposition, editing, confirmation) directly from a `run`
 * function rather than a static list of steps.
 */

const AGENTS = {
  digester: 'DIGESTER',
  investigator: 'INVESTIGATOR',
  researcher: 'RESEARCHER',
  planner: 'GRAND-PLANNER',
  decompositor: 'DECOMPOSITOR',
  editor: 'EDITOR',
  confirmer: 'CONFIRMER',
};

const MAX_EVIDENCE_ITERATIONS = 3;
const MAX_CONFIRM_PASSES = 3;
const MAX_DIFF_CHARS = 80_000;
const MAX_RESEARCH_DOC_CHARS = 30_000;

/** One row of the evidence-gathering table rendered in the final report. */
interface EvidenceRow {
  iteration: number;
  verdict: string;
  added: string[];
  removed: string[];
  research: boolean;
}

/** Accumulated state describing the whole pipeline run, rendered at the end. */
interface Journey {
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
  /** Name of the active model set, or '' when running on agent-profile models. */
  modelSetName: string;
  /** Role -> model id overrides actually in force for this run. */
  modelOverrides: Record<string, string>;
  /** Character length of the conversation transcript injected into DIGESTER/GRAND-PLANNER. */
  conversationChars: number;
  error?: string;
}

/**
 * Report-only state used to render the final markdown report. Kept separate
 * from the prescribed `Journey` interface: the journey itself carries only
 * the fields defined by the workflow plan, while this structure holds the
 * evidence rows, the final pipeline status, and the abort stage (if any).
 */
interface ReportState {
  evidenceRows: EvidenceRow[];
  status: 'aligned' | 'deficient' | 'aborted' | 'cancelled';
  abortStage?: string;
}

/** Normalises path separators to forward slashes for reliable comparison. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

type EditorOutcome = { path: string; outcome: 'DONE' | 'FAILED' | 'UNKNOWN'; detail?: string };

/**
 * Parses the NUL-separated output of `git diff --name-only -z`.
 *
 * The `-z` flag is used specifically so git never quotes or escapes paths
 * containing spaces or non-ASCII characters, making the comparison exact.
 */
function parseChangedPaths(raw: string): string[] {
  return raw
    .split('\0')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith('./') ? entry.slice(2) : entry))
    .map(normalizePath);
}

/**
 * Pure, never-throwing gate check. Returns `{ passed: true, reason: '' }` when
 * every editor self-reported DONE and the changed-path set exactly matches the
 * instructed path set. Any failure mode returns `{ passed: false, reason }`
 * with a human-readable reason used verbatim in the fallback log line.
 */
function evaluateEditGate(results: EditorOutcome[], changedPaths: string[]): { passed: boolean; reason: string } {
  // 1. Empty guard.
  if (results.length === 0) {
    return { passed: false, reason: 'no edits were dispatched' };
  }

  // 2. Self-report check.
  const notDone = results.filter((r) => r.outcome !== 'DONE').map((r) => r.path);
  if (notDone.length > 0) {
    return { passed: false, reason: `editor did not report DONE for: ${notDone.join(', ')}` };
  }

  // 3. Build sets.
  const expected = new Set(results.map((r) => normalizePath(r.path)));
  const actual = new Set(changedPaths);

  // 4. Missing check.
  const missing = [...expected].filter((p) => !actual.has(p));
  if (missing.length > 0) {
    return { passed: false, reason: `instructed file(s) absent from the diff: ${missing.join(', ')}` };
  }

  // 5. Extras check.
  const extra = [...actual].filter((p) => !expected.has(p));
  if (extra.length > 0) {
    return { passed: false, reason: `diff touches unexpected file(s): ${extra.join(', ')}` };
  }

  // 6. All checks passed.
  return { passed: true, reason: '' };
}

/**
 * Builds the final markdown report from the accumulated journey state and
 * the separate report-only state (evidence rows, final status, abort stage).
 */
function buildReport(journey: Journey, report: ReportState): string {
  const lines: string[] = [];
  lines.push('# 🏁 Dev Pipeline Report');
  lines.push('');

  lines.push('## Run configuration');
  lines.push('');
  lines.push(`- **Model set:** ${journey.modelSetName || 'Default (agent profile models)'}`);
  lines.push(`- **Conversation context:** ${journey.conversationChars > 0 ? `${journey.conversationChars} characters` : 'none'}`);
  lines.push('');

  const overrideEntries = Object.entries(journey.modelOverrides).filter(([, v]) => v && v.trim().length > 0);
  if (overrideEntries.length > 0) {
    lines.push('| Agent | Model |');
    lines.push('|---|---|');
    for (const [role, model] of overrideEntries) {
      lines.push(`| ${role} | \`${model}\` |`);
    }
    lines.push('');
  }

  lines.push('## Evidence gathering');
  lines.push('');
  lines.push('| Iteration | Verdict | Files added | Files removed | Research |');
  lines.push('|---|---|---|---|---|');
  for (const row of report.evidenceRows) {
    lines.push(`| ${row.iteration} | ${row.verdict} | ${row.added.join(', ') || '—'} | ${row.removed.join(', ') || '—'} | ${row.research ? 'yes' : 'no'} |`);
  }
  lines.push('');

  if (journey.filesSkipped.length > 0) {
    lines.push('### Skipped (nonexistent) paths');
    lines.push('');
    for (const p of journey.filesSkipped) {
      lines.push(`- \`${p}\``);
    }
    lines.push('');
  }

  lines.push('## Plan');
  lines.push('');
  lines.push(`- **Title:** ${journey.planTitle || '—'}`);
  lines.push(`- **Research unknowns resolved:** ${journey.unknownsResearchResolved ? 'yes' : 'no'}`);
  lines.push(`- **Codebase unknowns resolved:** ${journey.unknownsCodebaseResolved ? 'yes' : 'no'}`);
  lines.push('');

  if (journey.ambiguities) {
    lines.push('## Ambiguities');
    lines.push('');
    lines.push(journey.ambiguities);
    lines.push('');
  }

  lines.push('## Edit passes');
  lines.push('');
  lines.push('| Pass | Edits dispatched | DONE | FAILED | UNKNOWN | Confirmer verdict | Commit |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const p of journey.passes) {
    lines.push(`| ${p.pass} | ${p.editCount} | ${p.done} | ${p.failed.join(', ') || '—'} | ${p.unknown.join(', ') || '—'} | ${p.verdict} | \`${p.commit}\` |`);
  }
  lines.push('');

  lines.push(`**Format retries:** ${journey.formatRetries}`);
  lines.push('');
  lines.push(`**CONFIRMER skips (fast-path gate):** ${journey.confirmerSkips}`);
  lines.push('');

  let statusLine: string;
  if (report.status === 'aligned') {
    statusLine = '✅ Completed aligned.';
  } else if (report.status === 'deficient') {
    statusLine = '⚠️ Completed with outstanding deficiencies.';
  } else if (report.status === 'cancelled') {
    statusLine = '❌ Cancelled by user.';
  } else {
    statusLine = `❌ Aborted at stage ${report.abortStage ?? 'unknown'}.`;
  }
  lines.push(`**Status:** ${statusLine}`);

  return lines.join('\n');
}

/**
 * Persists the report into the task context and renders it as a completed
 * assistant response.
 */
async function emitReport(task: Task, journey: Journey, report: ReportState): Promise<void> {
  const reportText = buildReport(journey, report);
  const id = uuidv4();
  await task.addContextMessage(
    { id, role: MessageRole.Assistant, content: reportText, timestamp: Date.now() } as ContextAssistantMessage,
    true,
  );
  await task.processResponseMessage({ id, action: 'response', content: reportText, finished: true }, false);
}

/**
 * Adds a set of project-relative paths to the task context, recording which
 * were added and which did not exist on disk.
 */
async function addPathsToContext(task: Task, journey: Journey, paths: string[]): Promise<void> {
  for (const p of paths) {
    if (await fileExists(path.resolve(task.getTaskDir(), p))) {
      await task.addFiles({ path: p, readOnly: false });
      journey.filesAdded.push(p);
    } else {
      journey.filesSkipped.push(p);
    }
  }
}

/**
 * Top-level entry point for the Dev Pipeline workflow.
 */
export async function runDevPipeline({ task, initialPrompt, conversationText, modelSet, dispatch }: WorkflowRunContext): Promise<void> {
  const journey: Journey = {
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
  };

  // Report-only state: never part of the prescribed Journey interface.
  const report: ReportState = {
    evidenceRows: [],
    status: 'aborted',
  };

  try {
    // Preflight: the pipeline relies on git commits and diffs, so the task
    // directory must be a git repository before anything else happens.
    const git = simpleGit(task.getTaskDir());
    if (!(await git.checkIsRepo())) {
      throw new WorkflowError('The task directory is not a git repository. The Dev Pipeline requires git.');
    }

    // ---- Stage 1: Evidence loop -------------------------------------------
    report.abortStage = 'evidence gathering';
    const researchFindings: string[] = [];

    for (let i = 1; i <= MAX_EVIDENCE_ITERATIONS; i++) {
      const findingsText = researchFindings.length
        ? researchFindings.map((f) => f.slice(0, MAX_RESEARCH_DOC_CHARS)).join('\n\n---\n\n')
        : 'None yet.';

      const digesterPrompt = [
        ...(conversationText
          ? [
              '# Conversation so far',
              '',
              'This is the discussion that led to the request below. Use it to understand intent and prior decisions. It is context, not the instruction.',
              '',
              conversationText,
              '',
            ]
          : []),
        '# User request',
        initialPrompt,
        '',
        '# Research findings gathered so far',
        findingsText,
        '',
        '# Iteration',
        `This is evidence-gathering iteration ${i} of ${MAX_EVIDENCE_ITERATIONS}.`,
      ].join('\n');

      const verdictResp = await dispatch.parsed(
        AGENTS.digester,
        digesterPrompt,
        `Assessing evidence (round ${i})`,
        parseDigesterResponse,
        () => {
          journey.formatRetries++;
        },
      );
      journey.digesterVerdicts.push(verdictResp.verdict);

      if (verdictResp.verdict === 'YES') {
        report.evidenceRows.push({ iteration: i, verdict: 'YES', added: [], removed: [], research: false });
        journey.evidenceIterations = i;
        break;
      }

      // NO verdict → fan out to the investigator and (optionally) researcher.
      const investigationP = dispatch.parsed(
        AGENTS.investigator,
        `${verdictResp.investigationBrief}\n\nReminder of your output contract: respond with exactly the === FILES TO ADD === and === FILES TO REMOVE === sections and nothing else.`,
        `Investigating codebase (round ${i})`,
        parseInvestigatorResponse,
        () => {
          journey.formatRetries++;
        },
      );

      // RESEARCHER failure is non-fatal only for WorkflowError: warn and
      // continue with what we have. Cancellation propagates so the top-level
      // handler emits a cancellation report, and any unexpected error also
      // propagates so the pipeline is recorded as aborted.
      const researchP = verdictResp.researchBrief
        ? dispatch.agent(AGENTS.researcher, verdictResp.researchBrief, `Researching online (round ${i})`).catch((e) => {
            if (e instanceof WorkflowCancelled) {
              throw e;
            }
            if (e instanceof WorkflowError) {
              task.addLogMessage('warning', `Dev Pipeline ▸ RESEARCHER failed (round ${i}): ${e instanceof Error ? e.message : String(e)}`);
              return null;
            }
            throw e;
          })
        : Promise.resolve(null);

      const [inv, research] = await Promise.all([investigationP, researchP]);

      // The script mutates the context (not the agent).
      const addedThisRound: string[] = [];
      for (const p of inv.add) {
        if (await fileExists(path.resolve(task.getTaskDir(), p))) {
          await task.addFiles({ path: p, readOnly: false });
          addedThisRound.push(p);
          journey.filesAdded.push(p);
        } else {
          journey.filesSkipped.push(p);
        }
      }

      const currentContext = await task.getContextFiles();
      const removedThisRound: string[] = [];
      for (const p of inv.remove) {
        const normP = normalizePath(p);
        if (currentContext.some((f) => normalizePath(f.path) === normP)) {
          await task.dropFile(p);
          removedThisRound.push(p);
          journey.filesRemoved.push(p);
        }
      }

      if (research) {
        researchFindings.push(research);
        journey.researchDocs++;
      }

      report.evidenceRows.push({
        iteration: i,
        verdict: 'NO',
        added: addedThisRound,
        removed: removedThisRound,
        research: !!research,
      });
      journey.evidenceIterations = i;

      task.addLogMessage(
        'info',
        `Dev Pipeline ▸ evidence round ${i}: added ${addedThisRound.length} file(s), removed ${removedThisRound.length} file(s), research ${research ? 'yes' : 'no'}.`,
      );
    }

    if (journey.digesterVerdicts[journey.digesterVerdicts.length - 1] !== 'YES') {
      task.addLogMessage('warning', 'Dev Pipeline ▸ evidence loop exhausted without a YES verdict — proceeding to planning with the evidence gathered.');
    }

    // ---- Stage 2: Grand plan + unknown resolution --------------------------
    report.abortStage = 'planning';
    const plannerPrompt = [
      ...(conversationText
        ? [
            '# Conversation so far',
            '',
            'This is the discussion that led to the request below. Treat it as requirements context. It is context, not the instruction.',
            '',
            conversationText,
            '',
          ]
        : []),
      '# User request',
      initialPrompt,
      '',
      ...(researchFindings.length ? ['# Research findings', researchFindings.join('\n\n---\n\n'), ''] : []),
      'Produce the Implementation Plan now, per your instructions.',
    ].join('\n');

    const planText = await dispatch.agent(AGENTS.planner, plannerPrompt, 'Producing Implementation Plan');
    const { title, researchUnknowns, codebaseUnknowns } = parsePlanUnknowns(planText);
    journey.planTitle = title;

    let unknownsResearch: string | null = null;

    const researchP2 = researchUnknowns
      ? dispatch.agent(
          AGENTS.researcher,
          `# Unknowns raised by the Implementation Plan — find the answers\n${researchUnknowns}`,
          'Resolving plan research unknowns',
        ).catch((e) => {
          if (e instanceof WorkflowCancelled) {
            throw e;
          }
          if (e instanceof WorkflowError) {
            task.addLogMessage('warning', `Dev Pipeline ▸ RESEARCHER failed resolving plan unknowns: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
          throw e;
        })
      : Promise.resolve(null);

    const codebaseP2 = codebaseUnknowns
      ? dispatch.parsed(
          AGENTS.investigator,
          `# The Implementation Plan raised these codebase unknowns — locate the relevant files\n${codebaseUnknowns}`,
          'Resolving plan codebase unknowns',
          parseInvestigatorResponse,
          () => {
            journey.formatRetries++;
          },
        )
      : Promise.resolve(null);

    const [researchRes, codebaseRes] = await Promise.all([researchP2, codebaseP2]);

    if (researchRes) {
      unknownsResearch = researchRes;
      journey.unknownsResearchResolved = true;
    }
    if (codebaseRes) {
      journey.unknownsCodebaseResolved = true;
      // Add the located files to context; removals are only an evidence-loop concern.
      await addPathsToContext(task, journey, codebaseRes.add);
    }

    task.addLogMessage(
      'info',
      `Dev Pipeline ▸ plan produced: "${title}" (research unknowns: ${researchUnknowns ? 'resolved' : 'none'}, codebase unknowns: ${codebaseUnknowns ? 'resolved' : 'none'}).`,
    );

    // ---- Stage 3: Decomposition --------------------------------------------
    report.abortStage = 'decomposition';
    const decompPrompt = [
      '# Implementation Plan (verbatim — treat as strict instructions)',
      '',
      planText,
      '',
      ...(unknownsResearch ? ["# Additional research resolving the plan's unknowns", '', unknownsResearch, ''] : []),
      'Decompose the plan into per-file edit blocks now, per your instructions.',
    ].join('\n');

    const { ambiguities, edits } = await dispatch.parsed(
      AGENTS.decompositor,
      decompPrompt,
      'Decomposing plan into file edits',
      parseDecompositorResponse,
      () => {
        journey.formatRetries++;
      },
    );
    journey.ambiguities = ambiguities;

    if (ambiguities) {
      task.addLogMessage('warning', `Dev Pipeline ▸ DECOMPOSITOR raised ambiguities (see final report):\n${ambiguities}`);
    }
    task.addLogMessage('info', `Dev Pipeline ▸ plan decomposed into ${edits.length} file edit(s).`);

    // ---- Stage 4: Parallel edit → commit → diff → confirm loop -------------
    report.abortStage = 'editing';

    // Snapshot any pre-existing dirty state so each pass's diff is clean.
    const status = await git.status();
    if (!status.isClean()) {
      await git.add('-A');
      await git.raw(['commit', '--no-verify', '-m', '[dev-pipeline] pre-edit snapshot']);
    }

    let currentEdits = edits;
    let finalVerdict: 'ALIGNED' | 'DEFICIENT' = 'DEFICIENT';

    for (let pass = 1; pass <= MAX_CONFIRM_PASSES; pass++) {
      // Editors run in parallel, one dispatch per file edit.
      const results: EditorOutcome[] = await Promise.all(
        currentEdits.map(async (edit) => {
          const prompt = 'Apply the following edit to exactly one file, per your instructions.\n\n' + serializeFileEdits([edit]);
          try {
            const raw = await dispatch.agent(AGENTS.editor, prompt, `Editing ${edit.path}`);
            return { path: edit.path, ...parseEditorResponse(raw) };
          } catch (e) {
            if (e instanceof WorkflowCancelled) {
              throw e;
            }
            // Continue; the CONFIRMER will catch the deficiency.
            return { path: edit.path, outcome: 'FAILED' as const, detail: String(e) };
          }
        }),
      );

      // Commit this pass, then diff it. Because every pass makes its own
      // commit, HEAD~1..HEAD is always exactly the latest pass's changes.
      const commitMsg = `[dev-pipeline pass ${pass}] ${journey.planTitle.slice(0, 60)}`;
      await git.add('-A');
      await git.raw(['commit', '--no-verify', '--allow-empty', '-m', commitMsg]);

      const done = results.filter((r) => r.outcome === 'DONE').length;
      const failed = results.filter((r) => r.outcome === 'FAILED').map((r) => r.path);
      const unknown = results.filter((r) => r.outcome === 'UNKNOWN').map((r) => r.path);

      // Cheap name-only query: the expensive full-diff text is fetched only
      // when the gate fails and CONFIRMER actually needs it.
      const changedPaths = parseChangedPaths(await git.raw(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']));

      let passVerdict: string;
      let aligned: boolean;
      let nextEdits: FileEditInstruction[] | null = null;

      const gate = evaluateEditGate(results, changedPaths);

      if (gate.passed) {
        journey.confirmerSkips++;
        passVerdict = 'ALIGNED (gate)';
        aligned = true;
        task.addLogMessage(
          'info',
          `Dev Pipeline ▸ pass ${pass}: all ${results.length} edit(s) reported DONE and the diff matches the instructed file set exactly — skipping CONFIRMER.`,
        );
      } else {
        task.addLogMessage('info', `Dev Pipeline ▸ pass ${pass}: fast-path gate not satisfied (${gate.reason}) — running CONFIRMER.`);

        let diff = await git.raw(['diff', 'HEAD~1', 'HEAD']);
        if (diff.length > MAX_DIFF_CHARS) {
          diff = diff.slice(0, MAX_DIFF_CHARS) + '\n…[diff truncated]';
        }

        const confirmerPrompt = [
          '# File edits that were supposed to be applied',
          '',
          serializeFileEdits(currentEdits),
          '',
          '# Git diff of what was actually applied',
          '',
          '```diff',
          diff,
          '```',
          '',
          'Verify alignment now, per your instructions.',
        ].join('\n');

        const verdict = await dispatch.parsed(
          AGENTS.confirmer,
          confirmerPrompt,
          `Confirming edits (pass ${pass})`,
          parseConfirmerResponse,
          () => {
            journey.formatRetries++;
          },
        );

        passVerdict = verdict.verdict;
        aligned = verdict.verdict === 'ALIGNED';
        if (!aligned) {
          nextEdits = verdict.edits;
        }
      }

      journey.passes.push({
        pass,
        editCount: currentEdits.length,
        done,
        failed,
        unknown,
        verdict: passVerdict,
        commit: commitMsg,
      });

      if (aligned) {
        finalVerdict = 'ALIGNED';
        break;
      }

      // DEFICIENT → loop again with the confirmer's corrective edit list.
      currentEdits = nextEdits!;
      if (pass === MAX_CONFIRM_PASSES) {
        task.addLogMessage('warning', 'Dev Pipeline ▸ max confirm passes reached with deficiencies outstanding.');
      }
    }

    // ---- Stage 5: Final report ---------------------------------------------
    report.status = finalVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
    await emitReport(task, journey, report);
  } catch (error) {
    if (error instanceof WorkflowCancelled) {
      journey.cancelled = true;
      report.status = 'cancelled';
      task.addLogMessage('warning', 'Dev Pipeline cancelled by user.');
    } else {
      report.status = 'aborted';
      journey.error = error instanceof Error ? error.message : String(error);
      task.addLogMessage('error', `Dev Pipeline aborted: ${journey.error}`);
    }
    await emitReport(task, journey, report);
  }
}

export const devPipeline: WorkflowDefinition = {
  id: 'dev-pipeline',
  name: 'Dev Pipeline',
  agents: WORKFLOW_AGENT_ROLES['dev-pipeline'],
  run: runDevPipeline,
};
