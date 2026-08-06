import { WorkflowDefinition } from './types';
import { threeAgentRelay } from './definitions/three-agent-relay';

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  [threeAgentRelay.id]: threeAgentRelay,
};

export const getWorkflow = (id: string): WorkflowDefinition | undefined => WORKFLOWS[id];
export const listWorkflows = (): WorkflowDefinition[] => Object.values(WORKFLOWS);
