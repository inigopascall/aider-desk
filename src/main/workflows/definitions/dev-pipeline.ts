import { WORKFLOW_AGENT_ROLES } from '@common/types';

import { WorkflowDefinition, WorkflowRunContext } from '../types';
import {
  emitCheckpoint,
  emitReport,
  prepareRepository,
  runDecompositionStage,
  runEditLoop,
  runEvidenceStage,
  runPlanningStage,
} from './dev-pipeline-core';
import { createJourney, type ReportState } from '../journey';

export async function runDevPipeline(ctx: WorkflowRunContext): Promise<void> {
  const { task, modelConfig, conversationText } = ctx;
  const journey = createJourney(modelConfig, conversationText);
  const report: ReportState = { status: 'aborted' };

  try {
    const { git, warnings } = await prepareRepository(task);
    journey.gitWarnings.push(...warnings);
    for (const warning of warnings) await ctx.log.warning(warning);
    const researchFindings = await runEvidenceStage(ctx, journey, report);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline', 'Evidence');
    const { planText, unknownsResearch } = await runPlanningStage(ctx, journey, report, researchFindings);
    await emitCheckpoint(ctx, journey, 'Dev Pipeline', 'Plan');
    const { edits } = await runDecompositionStage(ctx, journey, report, planText, unknownsResearch);
    const verdict = await runEditLoop(ctx, journey, report, git, edits, 'dev-pipeline');
    await emitCheckpoint(ctx, journey, 'Dev Pipeline', 'Edit Loop');

    report.status = verdict === 'ALIGNED' ? 'aligned' : 'deficient';
    await emitReport(ctx, journey, report, 'Dev Pipeline');
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkflowCancelled') {
      journey.cancelled = true;
      report.status = 'cancelled';
      await ctx.log.warning('Dev Pipeline cancelled by user.');
    } else {
      report.status = 'aborted';
      journey.error = error instanceof Error ? error.message : String(error);
      await ctx.log.error(`Dev Pipeline aborted: ${journey.error}`);
    }
    await emitReport(ctx, journey, report, 'Dev Pipeline');
  }
}

export const devPipeline: WorkflowDefinition = {
  id: 'dev-pipeline',
  name: 'Dev Pipeline',
  agents: WORKFLOW_AGENT_ROLES['dev-pipeline'],
  run: runDevPipeline,
};
