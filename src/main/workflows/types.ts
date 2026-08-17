import type { ContextMessage, WorkflowModelSet, WorkflowRunInfo } from '@common/types';
import type { Task } from '@/task';

export interface WorkflowStepContext {
  initialPrompt: string;
  previousOutput: string;
  stepIndex: number;
  conversationText: string;
}

export interface WorkflowDispatchOptions {
  /** Hard timeout for the subagent run; on expiry the run is aborted and a WorkflowTimeout is thrown. */
  timeoutMs?: number;
}

export interface WorkflowDispatcher {
  agent(subagentId: string, prompt: string, description: string, options?: WorkflowDispatchOptions): Promise<string>;
  parsed<T>(
    subagentId: string,
    prompt: string,
    description: string,
    parse: (raw: string) => T,
    onRetry?: (attempt: number, error: string) => void,
    maxAttempts?: number,
    options?: WorkflowDispatchOptions,
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

export interface WorkflowLogger {
  readonly run: WorkflowRunInfo;
  info(message: string): Promise<void>;
  warning(message: string): Promise<void>;
  error(message: string): Promise<void>;
  summary(content: string, kind: 'checkpoint' | 'final-summary', label?: string): Promise<void>;
}

export interface WorkflowRunContext {
  task: Task;
  initialPrompt: string;
  conversationText: string;
  conversationMessages: ContextMessage[];
  modelSet?: WorkflowModelSet;
  dispatch: WorkflowDispatcher;
  run: WorkflowRunInfo;
  log: WorkflowLogger;
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