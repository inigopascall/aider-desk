import { WORKFLOW_AGENT_ROLES } from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  conversationSection,
  emitCheckpoint,
  emitReport,
  emitInfo,
  getCumulativeDiff,
  prepareRepository,
  runAssignmentBatch,
  runDecompositionStage,
  runEvidenceStage,
  runPlanningStage,
} from './dev-pipeline-core';
import { createJourney, type ReportState } from '../journey';
import { formatArbiterRound, formatAssignmentTargets } from '../reporting';
import { parseArbiterResponse } from '../parsers';
import { WorkflowCancelled } from '../dispatch';
import { runPreArbiterCommand } from '../bash-command';
import { buildPrompt } from '../prompt-formatting';

const ARBITER_RUNS = 1;
const MAX_ARBITER_DIFF_CHARS = 60_000;
const AGENT_ARBITER = 'ARBITER';

export async function runDevPipelineReview(ctx: WorkflowRunContext): Promise<void> {
  const { task, modelConfig, conversationText } = ctx;
  const journey = createJourney(modelConfig, conversationText);
  const report: ReportState = { status: 'aborted' };

  try {
    const { git, baselineCommit, warnings } = await prepareRepository(task);
    journey.gitWarnings.push(...warnings);
    for (const warning of warnings) await ctx.log.warning(warning);

    const researchFindings = await runEvidenceStage(ctx, journey, report);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Evidence');

    const { planText, unknownsResearch } = await runPlanningStage(ctx, journey, report, researchFindings);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Plan');

    const { assignments, summary: decompositionSummary } = await runDecompositionStage(ctx, journey, report, planText, unknownsResearch);
    let editVerdict = await runAssignmentBatch(ctx, journey, report, git, assignments, 'dev-pipeline-review');
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Edit Loop');

    let finalStatus: 'aligned' | 'deficient' = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
    report.abortStage = 'arbiter review';

    for (let round = 1; round <= ARBITER_RUNS; round++) {
      journey.reviewRounds = round;
      const diff = await getCumulativeDiff(git, baselineCommit, MAX_ARBITER_DIFF_CHARS);
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

      const validationOutput = await runPreArbiterCommand(task, 'dev-pipeline-review', ctx.log);

      const prompt = buildPrompt([
        {
          title: 'REVIEW CONTEXT',
          body: "The user request and the actual code/diff are authoritative. The decompositor's assignment summary is non-authoritative provenance. Conversation history, when present, is authoritative for intent. Any rectification must be expressed as semantic per-file assignments in the decompositor format — exactly one assignment per file, no search/replace blocks.",
        },
        conversationSection(ctx),
        { title: 'USER REQUEST', body: ctx.initialPrompt },
        { title: 'ARBITER ROUND', body: `This is arbiter round ${round} of ${ARBITER_RUNS}.` },
        { title: 'DECOMPOSITOR ASSIGNMENTS SUMMARY', body: decompositionSummary },
        { title: 'CHANGED FILES', body: changedFilesSummary || 'None' },
        { title: 'ASSIGNMENT SIGNALS', body: assignmentSignals },
        { title: 'VALIDATION COMMAND OUTPUT', body: validationOutput ?? 'No validation command configured.' },
        { title: 'CUMULATIVE GIT DIFF', body: ['```diff', diff, '```'].join('\n') },
      ]);

      let arbiter;
      try {
        arbiter = await ctx.dispatch.parsed(
          AGENT_ARBITER,
          prompt,
          `Arbiter review (round ${round})`,
          parseArbiterResponse,
          () => {
            journey.formatRetries++;
          },
        );
      } catch (error) {
        if (error instanceof WorkflowCancelled) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        journey.arbiterFailures.push(msg);
        journey.reviewTable.push({ round, outcome: 'failed', rectificationEdits: 0 });
        await ctx.log.warning(`Arbiter review failed (round ${round}): ${msg}`);
        finalStatus = 'deficient';
        break;
      }

      journey.arbiterSummaries.push({ round, summary: arbiter.reviewSummary });
      await emitInfo(ctx.log, formatArbiterRound(round, arbiter.reviewSummary, arbiter.assignments.length));

      if (arbiter.assignments.length === 0) {
        journey.reviewTable.push({ round, outcome: 'clean', rectificationEdits: 0 });
        finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
        break;
      }

      await emitInfo(ctx.log, formatAssignmentTargets(`Arbiter rectification — round ${round}`, arbiter.assignments));
      report.abortStage = `arbiter rectification (round ${round})`;
      editVerdict = await runAssignmentBatch(ctx, journey, report, git, arbiter.assignments, `dev-pipeline-review rectification ${round}`);
      finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
      journey.reviewTable.push({ round, outcome: 'rectified', rectificationEdits: arbiter.assignments.length });
      await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', `Arbiter Round ${round}`);
    }

    report.status = finalStatus;
    await emitReport(ctx, journey, report, 'Dev Pipeline + Review');
  } catch (error) {
    if (error instanceof WorkflowCancelled) {
      journey.cancelled = true;
      report.status = 'cancelled';
      await ctx.log.warning('Dev Pipeline + Review cancelled by user.');
    } else {
      report.status = 'aborted';
      journey.error = error instanceof Error ? error.message : String(error);
      await ctx.log.error(`Dev Pipeline + Review aborted: ${journey.error}`);
    }
    await emitReport(ctx, journey, report, 'Dev Pipeline + Review');
  }
}

export const devPipelineReview: WorkflowDefinition = {
  id: 'dev-pipeline-review',
  name: 'Dev Pipeline + Review',
  agents: WORKFLOW_AGENT_ROLES['dev-pipeline-review'],
  run: runDevPipelineReview,
};
