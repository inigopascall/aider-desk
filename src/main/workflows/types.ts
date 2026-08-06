export interface WorkflowStepContext {
  initialPrompt: string;
  previousOutput: string;
  stepIndex: number;
}

export interface WorkflowStep {
  /** id OR name of an enabled subagent (resolved via findEnabledSubagent matchByName). */
  subagentId: string;
  /** Optional label shown in the subagent group header. */
  description?: string;
  /** Builds the prompt handed to this step's subagent. */
  buildPrompt: (ctx: WorkflowStepContext) => string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStep[];
}
