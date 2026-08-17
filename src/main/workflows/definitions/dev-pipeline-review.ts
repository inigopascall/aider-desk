import { WORKFLOW_AGENT_ROLES } from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  conversationSection,
  emitCheckpoint,
  emitReport,
  emitInfo,
  getCumulativeDiff,
  prepareRepository,
  resolveConversationDigest,
  resolvePlanUnknowns,
  runDecompositionStage,
  runEditLoop,
  runEvidenceStage,
  runPlanningStage,
  withAgentRetry,
} from './dev-pipeline-core';
import { createJourney, type ReportState } from '../journey';
import { formatEditTargets, formatReviewRound, truncate } from '../reporting';
import { parseReviewerResponse, parseVerifierResponse, serializeFileEdits, type ReviewerReport } from '../parsers';
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
    const digest = await resolveConversationDigest(ctx, journey);
    const effCtx = { ...ctx, conversationText: digest };
    const researchFindings = await runEvidenceStage(effCtx, journey, report);
    await emitCheckpoint(effCtx, journey, 'Dev Pipeline + Review', 'Evidence');
    const { planText, unknownsResearch } = await runPlanningStage(effCtx, journey, report, researchFindings);
    await emitCheckpoint(effCtx, journey, 'Dev Pipeline + Review', 'Plan');
    const edits = await runDecompositionStage(effCtx, journey, report, planText, unknownsResearch, false);
    let editVerdict = await runEditLoop(effCtx, journey, report, git, edits, 'dev-pipeline-review');
    await emitCheckpoint(effCtx, journey, 'Dev Pipeline + Review', 'Edit Loop');

    let finalStatus: 'aligned' | 'deficient' = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
    report.abortStage = 'review';

    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      journey.reviewRounds = round;
      const diff = await getCumulativeDiff(git, baselineCommit, MAX_VERIFIER_DIFF_CHARS);
      const changedFilesSummary = Object.entries(journey.fileStats)
        .map(([filePath, stats]) => `${filePath}: +${stats.insertions} -${stats.deletions} (${stats.passes} ${stats.passes === 1 ? 'pass' : 'passes'})`)
        .join('\n');

      // EDIT-LOOP SIGNALS: deduplicated lines for rows whose edits failed,
      // were flagged suspicious, or went unconfirmed during the edit loop.
      const signalLines = new Set<string>();
      for (const pass of journey.passes) {
        for (const row of pass.rows) {
          if (row.editorOutcome !== 'DONE' || row.alignment !== 'ok') {
            signalLines.add(`${row.path} — ${row.editorOutcome}${row.alignment !== 'ok' ? `, ${row.alignment}` : ''} (pass ${pass.pass})`);
          }
        }
      }
      const editLoopSignals = [...signalLines].join('\n');

      const descriptorSections = [
        {
          title: 'REVIEW CONTEXT',
          body: 'The user request and resulting code are authoritative. The implementation plan is non-authoritative provenance only and must not override the user request or the code. The conversation digest, when present, records decisions agreed during discussion and is authoritative for intent.',
        },
        conversationSection(effCtx, journey),
        { title: 'USER REQUEST', body: ctx.initialPrompt },
        {
          title: 'REVIEW ROUND',
          body: `This is review round ${round} of ${MAX_REVIEW_ROUNDS}.${
            round === MAX_REVIEW_ROUNDS
              ? ' This is the final round: only CRITICAL or HIGH findings with a concrete failure scenario may justify rectification; anything less severe must be recorded as observations only.'
              : ''
          }`,
        },
      ];
      if (planText.trim()) {
        descriptorSections.push({ title: 'IMPLEMENTATION PLAN (NON-AUTHORITATIVE)', body: 'The following plan is included only as provenance and is not authoritative.\n\n' + truncate(planText, MAX_REVIEW_PLAN_CHARS) });
      }
      descriptorSections.push({ title: 'CHANGED FILES', body: changedFilesSummary || 'None' });
      if (editLoopSignals) {
        descriptorSections.push({
          title: 'EDIT-LOOP SIGNALS',
          body: `Files whose edits failed, were flagged suspicious, or went unconfirmed during the edit loop:\n${editLoopSignals}`,
        });
      }
      descriptorSections.push({ title: 'CUMULATIVE GIT DIFF', body: ['```diff', diff, '```'].join('\n') });
      const descriptor = buildPrompt(descriptorSections);

      const verify = async (agent: string, lens: string, trailer: string) => {
        try {
          return await withAgentRetry(ctx, `${agent} (round ${round})`, () =>
            ctx.dispatch.parsed(
              agent,
              `${descriptor}\n\n${trailer}`,
              `Verifying ${lens} (round ${round})`,
              parseVerifierResponse,
              () => {
                journey.formatRetries++;
              },
            ),
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
        verify(
          REVIEW_AGENTS.correctness,
          'correctness',
          'VERIFIER_LENS: correctness\n\nConcentrate on the diff hunks, error paths, state transitions, and any file listed under EDIT-LOOP SIGNALS.\n\nVerify now, per your instructions.',
        ),
        verify(
          REVIEW_AGENTS.quality,
          'quality',
          'VERIFIER_LENS: quality\n\nConcentrate on the post-edit whole-file state (the context files), naming, duplication, and test coverage.\n\nVerify now, per your instructions.',
        ),
      ]);

      if (!correctness && !quality) {
        journey.reviewTable.push({ round, correctness: 'FAILED', quality: 'FAILED', outcome: 'exhausted', rectificationEdits: 0 });
        await ctx.log.warning('Dev Pipeline + Review ▸ both verifiers failed.');
        break;
      }

      let reviewer: ReviewerReport;
      try {
        reviewer = await withAgentRetry(ctx, `REVIEWER-RECTIFIER (round ${round})`, () =>
          ctx.dispatch.parsed(
            REVIEW_AGENTS.reviewer,
            `${descriptor}\n\n# CORRECTNESS_VERIFIER_FINDINGS\n${correctness?.raw ?? 'UNAVAILABLE: verifier execution failed'}\n\n# QUALITY_VERIFIER_FINDINGS\n${quality?.raw ?? 'UNAVAILABLE: verifier execution failed'}\n\nArbitrate now, per your instructions.`,
            `Arbitrating review (round ${round})`,
            parseReviewerResponse,
            () => {
              journey.formatRetries++;
            },
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowCancelled) throw error;
        const message = error instanceof Error ? error.message : String(error);
        journey.reviewerFailure = message;
        journey.verifierFailures.push(message);
        await ctx.log.warning(`Dev Pipeline + Review ▸ REVIEWER-RECTIFIER failed (round ${round}): ${message}`);
        break;
      }

      journey.reviewFindings.push({
        round,
        findings: reviewer.findings,
        correctnessAreas: correctness?.areasSound || undefined,
        qualityAreas: quality?.areasSound || undefined,
      });
      if (reviewer.considerations) journey.reviewerConsiderations = reviewer.considerations;

      const rectificationRequired = !!(reviewer.rectificationEdits || reviewer.rectificationPlan);
      emitInfo(
        ctx.log,
        formatReviewRound(
          round,
          correctness?.verdict ?? null,
          quality?.verdict ?? null,
          reviewer.findings,
          rectificationRequired,
        ),
      );

      if (!rectificationRequired) {
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

      // The final round is verify-only: rectification items are recorded for
      // the report but never executed.
      if (round === MAX_REVIEW_ROUNDS) {
        journey.outstandingRectification = reviewer.rectificationEdits
          ? serializeFileEdits(reviewer.rectificationEdits)
          : reviewer.rectificationPlan ?? '';
        journey.reviewTable.push({
          round,
          correctness: correctness?.verdict ?? 'FAILED',
          quality: quality?.verdict ?? 'FAILED',
          outcome: 'exhausted',
          rectificationEdits: reviewer.rectificationEdits?.length ?? 0,
        });
        await ctx.log.warning('Dev Pipeline + Review ▸ final review round produced rectification items; recorded but not executed.');
        finalStatus = 'deficient';
        break;
      }

      report.abortStage = `rectification (round ${round})`;
      let rectificationEditCount = 0;
      if (reviewer.rectificationEdits) {
        rectificationEditCount = reviewer.rectificationEdits.length;
        await emitInfo(
          ctx.log,
          formatEditTargets(
            `Rectification edits — round ${round} (direct, no decomposition)`,
            reviewer.rectificationEdits.map((edit) => ({ path: edit.path, type: edit.type })),
            null,
          ),
        );
        editVerdict = await runEditLoop(effCtx, journey, report, git, reviewer.rectificationEdits, `dev-pipeline-review rectification ${round}`);
      } else {
        const resolved = await resolvePlanUnknowns(effCtx, journey, reviewer.rectificationPlan ?? '', `rectification round ${round}`);
        const rectificationEdits = await runDecompositionStage(
          effCtx,
          journey,
          report,
          reviewer.rectificationPlan ?? '',
          resolved,
          true,
          `Rectification plan — round ${round}`,
        );
        rectificationEditCount = rectificationEdits.length;
        editVerdict = await runEditLoop(effCtx, journey, report, git, rectificationEdits, `dev-pipeline-review rectification ${round}`);
      }
      finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
      journey.reviewTable.push({
        round,
        correctness: correctness?.verdict ?? 'FAILED',
        quality: quality?.verdict ?? 'FAILED',
        outcome: 'rectified',
        rectificationEdits: rectificationEditCount,
      });
      await emitCheckpoint(effCtx, journey, 'Dev Pipeline + Review', `Review Round ${round}`);
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