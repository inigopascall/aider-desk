import { WORKFLOW_AGENT_ROLES } from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  AGENTS,
  MAX_DIFF_CHARS,
  emitReport,
  getCumulativeDiff,
  prepareRepository,
  resolvePlanUnknowns,
  runDecompositionStage,
  runEditLoop,
  runEvidenceStage,
  runPlanningStage,
  createJourney,
  type ReportState,
} from './dev-pipeline-core';
import { parseReviewerResponse, parseVerifierResponse } from '../parsers';
import { WorkflowCancelled, WorkflowError } from '../dispatch';

const REVIEW_AGENTS = {
  correctness: 'VERIFIER-CORRECTNESS',
  quality: 'VERIFIER-QUALITY',
  reviewer: 'REVIEWER-RECTIFIER',
} as const;

const MAX_REVIEW_ROUNDS = 2;
const MAX_VERIFIER_DIFF_CHARS = 60_000;

export async function runDevPipelineReview(ctx: WorkflowRunContext): Promise<void> {
  const { task, modelSet, conversationText } = ctx;
  const journey = createJourney(modelSet, conversationText);
  const report: ReportState = { evidenceRows: [], status: 'aborted' };

  try {
    const { git, baselineCommit } = await prepareRepository(task);
    const researchFindings = await runEvidenceStage(ctx, journey, report);
    const { planText, unknownsResearch } = await runPlanningStage(ctx, journey, report, researchFindings);
    const edits = await runDecompositionStage(ctx, journey, report, planText, unknownsResearch, false);
    let editVerdict = await runEditLoop(ctx, journey, report, git, edits, 'dev-pipeline-review');

    let finalStatus: 'aligned' | 'deficient' = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
    report.abortStage = 'review';

    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      journey.reviewRounds = round;
      const diff = await getCumulativeDiff(git, baselineCommit, MAX_VERIFIER_DIFF_CHARS);
      const descriptor = `# Review descriptor\n\nThe following work was carried out by an automated development pipeline and now requires review.\n\n## Original user request\n${ctx.initialPrompt}\n\n## Implementation plan title\n${journey.planTitle}\n\n## Cumulative git diff\n\`\`\`diff\n${diff}\n\`\`\``;

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
            task.addLogMessage('warning', `Dev Pipeline + Review ▸ ${agent} failed (round ${round}): ${message}`);
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
        task.addLogMessage('warning', 'Dev Pipeline + Review ▸ both verifiers failed.');
        break;
      }

      const reviewer = await ctx.dispatch.parsed(
        REVIEW_AGENTS.reviewer,
        `${descriptor}\n\n# CORRECTNESS_VERIFIER_FINDINGS\n${correctness?.raw ?? 'N/A'}\n\n# QUALITY_VERIFIER_FINDINGS\n${quality?.raw ?? 'N/A'}\n\nArbitrate now, per your instructions.`,
        `Arbitrating review (round ${round})`,
        parseReviewerResponse,
        () => {
          journey.formatRetries++;
        },
      );

      journey.reviewFindings.push({ round, findings: reviewer.findings });
      if (reviewer.considerations) journey.reviewerConsiderations = reviewer.considerations;

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
      const rectificationEdits = await runDecompositionStage(ctx, journey, report, reviewer.rectificationPlan, resolved, true);
      editVerdict = await runEditLoop(ctx, journey, report, git, rectificationEdits, `dev-pipeline-review rectification ${round}`);
      finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
      journey.reviewTable.push({
        round,
        correctness: correctness?.verdict ?? 'FAILED',
        quality: quality?.verdict ?? 'FAILED',
        outcome: round === MAX_REVIEW_ROUNDS ? 'exhausted' : 'rectified',
        rectificationEdits: rectificationEdits.length,
      });
    }

    if (journey.reviewTable.at(-1)?.outcome === 'exhausted') {
      task.addLogMessage('warning', 'Dev Pipeline + Review ▸ max review rounds reached with rectifications still outstanding.');
      finalStatus = 'deficient';
    }

    report.status = finalStatus;
    await emitReport(task, journey, report);
  } catch (error) {
    if (error instanceof WorkflowCancelled) {
      journey.cancelled = true;
      report.status = 'cancelled';
      task.addLogMessage('warning', 'Dev Pipeline + Review cancelled by user.');
    } else {
      report.status = 'aborted';
      journey.error = error instanceof Error ? error.message : String(error);
      task.addLogMessage('error', `Dev Pipeline + Review aborted: ${journey.error}`);
    }
    await emitReport(task, journey, report);
  }
}

export const devPipelineReview: WorkflowDefinition = {
  id: 'dev-pipeline-review',
  name: 'Dev Pipeline + Review',
  agents: WORKFLOW_AGENT_ROLES['dev-pipeline-review'],
  run: runDevPipelineReview,
};