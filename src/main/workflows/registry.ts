import { WorkflowDefinition } from './types';
import { devPipeline } from './definitions/dev-pipeline';
import { devPipelineReview } from './definitions/dev-pipeline-review';

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [devPipeline.id]: devPipeline,
  [devPipelineReview.id]: devPipelineReview,
};

export const getWorkflow = (id: string): WorkflowDefinition | undefined => WORKFLOWS[id];
export const listWorkflows = (): WorkflowDefinition[] => Object.values(WORKFLOWS);
