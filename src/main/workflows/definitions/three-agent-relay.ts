import { WorkflowDefinition } from '../types';

export const threeAgentRelay: WorkflowDefinition = {
  id: 'three-agent-relay',
  name: 'Three Agent Relay',
  steps: [
    {
      subagentId: 'EDITOR-PRIMARY',
      description: 'Relay step 1',
      buildPrompt: ({ initialPrompt }) => initialPrompt,
    },
    {
      subagentId: 'CONFIRMER',
      description: 'Relay step 2',
      buildPrompt: ({ previousOutput }) =>
        `The previous agent produced the following output. Review and build on it:\n\n${previousOutput}`,
    },
    {
      subagentId: 'REVIEWER-RECTIFIER',
      description: 'Relay step 3',
      buildPrompt: ({ previousOutput }) =>
        `The previous agent produced the following output. Provide a final pass:\n\n${previousOutput}`,
    },
  ],
};
