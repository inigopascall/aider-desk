import type { ContextMessage, WorkflowModelSet } from '@common/types';
import type { Task } from '@/task';

export interface WorkflowStepContext {
  initialPrompt: string;
  previousOutput: string;
  stepIndex: number;
  conversationText: string;
}

export interface WorkflowDispatcher {
  agent(subagentId: string, prompt: string, description: string): Promise<string>;
  parsed<T>(
    subagentId: string,
    prompt: string,
    description: string,
    parse: (raw: string) => T,
    onRetry?: (attempt: number, error: string) => void,
    maxAttempts?: number,
  ): Promise<T>;
}

export interface WorkflowStep {
  /** id OR name of an enabled subagent (resolved via findEnabledSubagent matchByName). */
  subagentId: string;
  /** Optional label shown in the subagent group header. */
  description?: string;
  /** Builds the prompt handed to this step's subagent. */
  buildPrompt: (ctx: WorkflowStepContext) => string;
}

export interface WorkflowRunContext {
  task: Task;
  initialPrompt: string;
  conversationText: string;
  conversationMessages: ContextMessage[];
  modelSet?: WorkflowModelSet;
  dispatch: WorkflowDispatcher;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  agents: string[];
  /**
   * A workflow provides *either* a linear list of `steps` *or* an imperative
   * `run` function. When `run` is present it takes precedence and `steps` is
   * ignored. When neither is provided the runner logs an error and returns.
   */
  steps?: WorkflowStep[];
  run?: (ctx: WorkflowRunContext) => Promise<void>;
}