import { WorkflowDefinition } from './types';
import { threeAgentRelay } from './definitions/three-agent-relay';
import { devPipeline } from './definitions/dev-pipeline';

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [threeAgentRelay.id]: threeAgentRelay,
  [devPipeline.id]: devPipeline,
};

export const getWorkflow = (id: string): WorkflowDefinition | undefined => WORKFLOWS[id];
export const listWorkflows = (): WorkflowDefinition[] => Object.values(WORKFLOWS);
