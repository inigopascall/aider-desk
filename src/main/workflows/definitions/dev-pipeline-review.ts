import {
  WORKFLOW_AGENT_ROLES,
  WORKFLOW_ARBITER_ROLE,
  WORKFLOW_REVIEWER_ROLES,
  isWorkflowAgentEnabled,
} from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  collectReviewEvidence,
  emitCheckpoint,
  emitInfo,
  emitReport,
  prepareRepository,
  reviewEvidenceSections,
  runAssignmentBatch,
  runConfirmerStage,
  runDecompositionStage,
  runEvidenceStage,
  runPlanningStage,
} from './dev-pipeline-core';
import { createJourney, type ReportState } from '../journey';
import { formatArbiterRound, formatAssignmentTargets, formatReviewerReport } from '../reporting';
import { parseArbiterResponse } from '../parsers';
import { WorkflowCancelled } from '../dispatch';
import { buildPrompt, PromptSection } from '../prompt-formatting';

const MAX_ARBITER_ROUNDS = 4;

export async function runDevPipelineReview(ctx: WorkflowRunContext): Promise<void> {
  const { task, modelConfig, conversationText } = ctx;
  const journey = createJourney(modelConfig, conversationText);
  const report: ReportState = { status: 'aborted' };

  try {
    const { git, baselineCommit, warnings } = await prepareRepository(task);
    journey.gitWarnings.push(...warnings);
    for (const warning of warnings) await ctx.log.warning(warning);

    const researchFindings = await runEvidenceStage(ctx, journey, report);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Evidence gathered');

    const { planText, unknownsResearch } = await runPlanningStage(ctx, journey, report, researchFindings);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Implementation Plan created');

    const { assignments, summary: decompositionSummary } = await runDecompositionStage(ctx, journey, report, planText, unknownsResearch);
    let editVerdict = await runAssignmentBatch(ctx, journey, report, git, assignments, 'dev-pipeline-review');
    await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', 'Edits applied');

    let finalStatus: 'aligned' | 'deficient' = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';

    const arbiterEnabled = isWorkflowAgentEnabled(modelConfig, WORKFLOW_ARBITER_ROLE);
    journey.arbiterEnabled = arbiterEnabled;

    // Reviewers may run only when the arbiter is enabled; record the roles
    // that actually ran in journey state.
    const enabledReviewers = arbiterEnabled
      ? WORKFLOW_REVIEWER_ROLES.filter((role) => isWorkflowAgentEnabled(modelConfig, role))
      : [];
    journey.reviewerRoles.push(...enabledReviewers);

    let lastArbiterOutcome: string | null = null;

    if (arbiterEnabled) {
      report.abortStage = 'arbiter review';
      const reviewerReports: Array<{ role: string; report: string }> = [];

      for (let round = 1; round <= MAX_ARBITER_ROUNDS; round++) {
        journey.reviewRounds = round;
        const evidence = await collectReviewEvidence(git, baselineCommit, journey);

        // Enabled reviewers run only in round one, concurrently. Their
        // findings are shared evidence for every subsequent arbiter round.
        if (round === 1 && enabledReviewers.length > 0) {
          const reviewerPrompt = buildPrompt([
            ...reviewEvidenceSections(ctx, decompositionSummary, evidence, journey.lastValidationOutput),
            {
              title: 'REVIEW REPORT FORMAT',
              body: [
                'Produce a structured `# Review Findings` markdown report.',
                'For each finding, state its severity (critical, major, minor, or nit) and the affected file.',
                'If you identify no defects, state explicitly that no findings were identified.',
              ].join('\n'),
            },
          ]);

          const results = await Promise.allSettled(
            enabledReviewers.map((role) => ctx.dispatch.agent(role, reviewerPrompt, `Independent review (${role})`)),
          );

          for (let i = 0; i < enabledReviewers.length; i++) {
            const role = enabledReviewers[i];
            const result = results[i];
            if (result.status === 'fulfilled') {
              reviewerReports.push({ role, report: result.value });
              journey.reviewerReports.push({ role, report: result.value });
              await emitInfo(ctx.log, formatReviewerReport(role, result.value));
            } else {
              const reason = result.reason;
              if (reason instanceof WorkflowCancelled) throw reason;
              const msg = reason instanceof Error ? reason.message : String(reason);
              journey.reviewerFailures.push(`${role}: ${msg}`);
              await ctx.log.warning(`Reviewer ${role} failed: ${msg}`);
            }
          }
        }

        const isFinalRound = round === MAX_ARBITER_ROUNDS;

        const promptSections: PromptSection[] = [
          {
            title: 'REVIEW CONTEXT',
            body: "The user request and the actual code/diff are authoritative. The decompositor's assignment summary is non-authoritative provenance. Conversation history, when present, is authoritative for intent. Any rectification must be expressed as semantic per-file assignments in the decompositor format — exactly one assignment per file, no search/replace blocks.",
          },
          ...reviewEvidenceSections(ctx, decompositionSummary, evidence, journey.lastValidationOutput),
        ];

        // Reviewer report sections are included only when reports exist.
        for (const reviewer of reviewerReports) {
          promptSections.push({ title: `REVIEWER FINDINGS — ${reviewer.role}`, body: reviewer.report });
        }

        // Prior arbiter-round evidence is included from round two onward.
        if (round > 1) {
          promptSections.push({
            title: 'PRIOR ARBITER ROUNDS',
            body: journey.arbiterSummaries
              .map((entry) => `Round ${entry.round} review summary:\n${entry.summary}`)
              .join('\n\n---\n\n'),
          });
        }

        promptSections.push({
          title: isFinalRound ? 'FINAL ROUND' : 'ARBITER ROUND',
          body: isFinalRound
            ? `This is arbiter round ${round} of ${MAX_ARBITER_ROUNDS} — the FINAL round. Do not request further arbitration: set === ARBITRATE AGAIN === to NO.`
            : `This is arbiter round ${round} of ${MAX_ARBITER_ROUNDS}.`,
        });

        if (reviewerReports.length > 0) {
          promptSections.push({
            title: 'REVIEWER FINDINGS ACKNOWLEDGEMENT',
            body: 'Explicitly acknowledge every reviewer finding in your review summary, accepting or dismissing each with a concrete reason before determining rectification.',
          });
        }

        const prompt = buildPrompt(promptSections);

        let arbiter;
        try {
          arbiter = await ctx.dispatch.parsed(
            WORKFLOW_ARBITER_ROLE,
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
          journey.reviewTable.push({ round, outcome: 'failed', rectificationEdits: 0, arbitrateAgain: false });
          await ctx.log.warning(`Arbiter review failed (round ${round}): ${msg}`);
          finalStatus = 'deficient';
          break;
        }

        journey.arbiterSummaries.push({ round, summary: arbiter.reviewSummary });
        await emitInfo(ctx.log, formatArbiterRound(round, arbiter.reviewSummary, arbiter.assignments.length, arbiter.arbitrateAgain));

        if (arbiter.assignments.length === 0) {
          journey.reviewTable.push({ round, outcome: 'clean', rectificationEdits: 0, arbitrateAgain: false });
          finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
          lastArbiterOutcome = arbiter.reviewSummary;
          break;
        }

        await emitInfo(ctx.log, formatAssignmentTargets(`Arbiter rectification — round ${round}`, arbiter.assignments));
        report.abortStage = `arbiter rectification (round ${round})`;
        editVerdict = await runAssignmentBatch(ctx, journey, report, git, arbiter.assignments, `dev-pipeline-review rectification ${round}`);
        finalStatus = editVerdict === 'ALIGNED' ? 'aligned' : 'deficient';
        journey.reviewTable.push({ round, outcome: 'rectified', rectificationEdits: arbiter.assignments.length, arbitrateAgain: arbiter.arbitrateAgain });
        lastArbiterOutcome = arbiter.reviewSummary;
        await emitCheckpoint(ctx, journey, 'Dev Pipeline + Review', `Arbiter Round ${round}`);

        // Continue only when rectification assignments existed, rectification
        // was applied, the arbiter requested follow-up, and the cap is open.
        if (!arbiter.arbitrateAgain || round >= MAX_ARBITER_ROUNDS) {
          break;
        }
      }
    }

    // The confirmer always runs after optional arbitration, regardless of
    // arbiter enablement, and before the final report.
    await runConfirmerStage(ctx, journey, report, git, baselineCommit, planText, decompositionSummary, lastArbiterOutcome);

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