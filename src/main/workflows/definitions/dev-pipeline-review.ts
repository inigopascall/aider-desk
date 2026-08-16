import { WORKFLOW_AGENT_ROLES } from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  emitCheckpoint,
  emitReport,
  emitInfo,
  getCumulativeDiff,
  prepareRepository,
  resolvePlanUnknowns,
  runDecompositionStage,
  runEditLoop,
  runEvidenceStage,
  runPlanningStage,
} from './dev-pipeline-core';
import { createJourney, type ReportState } from '../journey';
import { formatReviewRound, truncate } from '../reporting';
import { parseReviewerResponse, parseVerifierResponse } from '../parsers';
import { WorkflowCancelled, WorkflowError } from '../dispatch';
import { buildPrompt } from '../prompt-formatting';

const REVIEW_AGENTS = {
  correctness: 'VERIFIER-CORRECTNESS',
  quality: 'VERIFIER-QUALITY',
  reviewer: 'REVIEWER-RECTIFIER',
} as const;

const MAX_REVIEW_ROUNDS = 2;
const MAX_VERIFIER_DIFF_CHARS = 60_000;
const MAX_REVIEW_PLAN_CHARS = 6_000;

export async function runDevPipelineReview(ctx: WorkflowRunContext): Promise<void> {
  const { task, modelSet, conversationText } = ctx;
  const journey = createJourney(modelSet, conversationText);
  const report: ReportState = { status: 'aborted' };

  try {
    const { git, baselineCommit, warnings } = await prepareRepository(task);
    journey.gitWarnings.push(...warnings);
    for (const warning of warnings) await ctx.log.warning(warning);
    const researchFindings = await runEvidenceStage(ctx, journey, report);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Evidence');
    const { planText, unknownsResearch } = await runPlanningStage(ctx, journey, report, researchFindings);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Plan');
    const edits = await runDecompositionStage(ctx, journey, report, planText, unknownsResearch, false);
    let editVerdict = await runEditLoop(ctx, journey, report, git, edits, 'dev-pipeline-review');
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Edit Loop');

    let finalStatus: 'aligned' | 'deficient' = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
    report.abortStage = 'review';

    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      journey.reviewRounds = round;
      const diff = await getCumulativeDiff(git, baselineCommit, MAX_VERIFIER_DIFF_CHARS);
      const changedFilesSummary = Object.entries(journey.fileStats)
        .map(([filePath, stats]) => `${filePath}: +${stats.insertions} -${stats.deletions} (${stats.passes} ${stats.passes === 1 ? 'pass' : 'passes'})`)
        .join('\n');
      const descriptorSections = [
        { title: 'REVIEW CONTEXT', body: 'The user request and resulting code are authoritative. The implementation plan is non-authoritative provenance only and must not override the user request or the code.' },
        { title: 'CONVERSATION HISTORY', body: conversationText },
        { title: 'USER REQUEST', body: ctx.initialPrompt },
      ];
      if (planText.trim()) {
        descriptorSections.push({ title: 'IMPLEMENTATION PLAN (NON-AUTHORITATIVE)', body: 'The following plan is included only as provenance and is not authoritative.\n\n' + truncate(planText, MAX_REVIEW_PLAN_CHARS) });
      }
      descriptorSections.push(
        { title: 'CHANGED FILES', body: changedFilesSummary || 'None' },
        { title: 'CUMULATIVE GIT DIFF', body: ['```diff', diff, '```'].join('\n') },
      );
      const descriptor = buildPrompt(descriptorSections);

      const verify = async (agent: string, lens: string) => {
        try {
          return await ctx.dispatch.parsed(
            agent,
            `${descriptor}\n\nVERIFIER_LENS: ${lens}\n\nVerify now, per your instructions.`,
            `Verifying ${lens} (round ${round})`,
            parseVerifierResponse,
            () => {
              journey.formatRetries++;
            },
          );
        } catch (error) {
          if (error instanceof WorkflowCancelled) throw error;
          if (error instanceof WorkflowError) {
            const message = error instanceof Error ? error.message : String(error);
            journey.verifierFailures.push(message);
            await ctx.log.warning(`Dev Pipeline + Review ▸ ${agent} failed (round ${round}): ${message}`);
            return null;
          }
          throw error;
        }
      };

      const [correctness, quality] = await Promise.all([
        verify(REVIEW_AGENTS.correctness, 'correctness'),
        verify(REVIEW_AGENTS.quality, 'quality'),
      ]);

      if (!correctness && !quality) {
        journey.reviewTable.push({ round, correctness: 'FAILED', quality: 'FAILED', outcome: 'exhausted', rectificationEdits: 0 });
        await ctx.log.warning('Dev Pipeline + Review ▸ both verifiers failed.');
        break;
      }

      const reviewer = await ctx.dispatch.parsed(
        REVIEW_AGENTS.reviewer,
        `${descriptor}\n\n# CORRECTNESS_VERIFIER_FINDINGS\n${correctness?.raw ?? 'UNAVAILABLE: verifier execution failed'}\n\n# QUALITY_VERIFIER_FINDINGS\n${quality?.raw ?? 'UNAVAILABLE: verifier execution failed'}\n\nArbitrate now, per your instructions.`,
        `Arbitrating review (round ${round})`,
        parseReviewerResponse,
        () => {
          journey.formatRetries++;
        },
      );

      journey.reviewFindings.push({ round, findings: reviewer.findings });
      if (reviewer.considerations) journey.reviewerConsiderations = reviewer.considerations;
      emitInfo(
        ctx.log,
        formatReviewRound(
          round,
          correctness?.verdict ?? null,
          quality?.verdict ?? null,
          reviewer.findings,
          !!reviewer.rectificationPlan,
        ),
      );

      if (!reviewer.rectificationPlan) {
        journey.reviewTable.push({
          round,
          correctness: correctness?.verdict ?? 'FAILED',
          quality: quality?.verdict ?? 'FAILED',
          outcome: 'clean',
          rectificationEdits: 0,
        });
        finalStatus = 'aligned';
        break;
      }

      report.abortStage = `rectification (round ${round})`;
      const resolved = await resolvePlanUnknowns(ctx, journey, reviewer.rectificationPlan, `rectification round ${round}`);
      const rectificationEdits = await runDecompositionStage(
        ctx,
        journey,
        report,
        reviewer.rectificationPlan,
        resolved,
        true,
        `Rectification plan — round ${round}`,
      );
      editVerdict = await runEditLoop(ctx, journey, report, git, rectificationEdits, `dev-pipeline-review rectification ${round}`);
      finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
      journey.reviewTable.push({
        round,
        correctness: correctness?.verdict ?? 'FAILED',
        quality: quality?.verdict ?? 'FAILED',
        outcome: round === MAX_REVIEW_ROUNDS ? 'exhausted' : 'rectified',
        rectificationEdits: rectificationEdits.length,
      });
      await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', `Review Round ${round}`);
    }

    if (journey.reviewTable.at(-1)?.outcome === 'exhausted') {
      await ctx.log.warning('Dev Pipeline + Review ▸ max review rounds reached with rectifications still outstanding.');
      finalStatus = 'deficient';
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
