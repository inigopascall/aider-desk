import { AgentProfile, WorkflowModelSet, WorkflowRunInfo } from '@common/types';

import { findEnabledSubagent } from '@/agent/subagent';
import type { Task } from '@/task';

import { ParseError } from './parsers';
import { applyModelIdToProfile, applyModelSetToProfile } from './model-sets';
import { WorkflowDispatcher } from './types';

/**
 * Raised for any non-cancellation failure within an imperative workflow
 * (missing agent, dispatch error, or repeated malformed responses).
 */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/**
 * Raised when a workflow subagent run is cancelled by the user. The pipeline
 * treats this as a graceful stop rather than a failure.
 */
export class WorkflowCancelled extends Error {
  constructor(message = 'Workflow cancelled by user.') {
    super(message);
    this.name = 'WorkflowCancelled';
  }
}

/**
 * Raised when a workflow subagent run exceeds its configured hard timeout.
 * Subclassing `WorkflowError` keeps every existing catch working unchanged.
 */
export class WorkflowTimeout extends WorkflowError {
  constructor(subagentId: string, timeoutMs: number) {
    super(`Workflow agent '${subagentId}' timed out after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'WorkflowTimeout';
  }
}

/** Default hard timeout applied to every workflow subagent dispatch. */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 15 * 60_000;

/** Phase-one fallback used when the primary workflow model cannot complete. */
export const DEFAULT_WORKFLOW_FALLBACK_MODEL_ID = '9router/openai-compatible-opencode-go/deepseek-v4-flash';

/**
 * Resolves a workflow agent by its slug/name from the Workflow Agents tier.
 * Throws a `WorkflowError` when the agent is not found.
 */
export function resolveWorkflowAgent(task: Task, subagentId: string): AgentProfile {
  const target = findEnabledSubagent(task.getProject().getWorkflowAgentProfiles(), subagentId, { matchByName: true });
  if (!target) {
    throw new WorkflowError(`Workflow agent '${subagentId}' not found. Create it under Workflow Agents.`);
  }
  return target;
}

/**
 * Creates a workflow dispatch handle bound to a task and (optionally) a model
 * set. The returned `WorkflowDispatcher` resolves each workflow agent by role
 * name, applies any model-set override, dispatches the run, and surfaces
 * failures as `WorkflowError` / `WorkflowCancelled`.
 */
export function createWorkflowDispatcher(task: Task, run: WorkflowRunInfo, modelSet?: WorkflowModelSet): WorkflowDispatcher {
  const dispatchOnce = async (
    subagentId: string,
    target: AgentProfile,
    prompt: string,
    description: string,
    timeoutMs: number,
  ): Promise<string> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const { status, outputText } = await task.dispatchSubagent(target, prompt, description, controller.signal, run);
      if (status === 'cancelled') {
        if (timedOut) throw new WorkflowTimeout(subagentId, timeoutMs);
        throw new WorkflowCancelled();
      }
      if (status === 'error') throw new WorkflowError(`Workflow agent '${subagentId}' failed to complete its run.`);
      return outputText;
    } finally {
      clearTimeout(timer);
    }
  };

  const dispatcher: WorkflowDispatcher = {
    agent: async (subagentId, prompt, description, options) => {
      const base = resolveWorkflowAgent(task, subagentId);
      const primary = applyModelSetToProfile(base, subagentId, modelSet);
      const timeoutMs = options?.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

      try {
        return await dispatchOnce(subagentId, primary, prompt, description, timeoutMs);
      } catch (error) {
        if (error instanceof WorkflowCancelled) throw error;
        if (!(error instanceof WorkflowError)) throw error;

        const fallbackModelId = options?.fallbackModelId ?? DEFAULT_WORKFLOW_FALLBACK_MODEL_ID;
        const fallback = applyModelIdToProfile(primary, fallbackModelId);
        if (fallback.provider === primary.provider && fallback.model === primary.model) {
          throw error;
        }
        if (!task.hasProvider(fallback.provider)) {
          throw new WorkflowError(`${error.message} Fallback provider '${fallback.provider}' is not configured.`);
        }

        try {
          return await dispatchOnce(subagentId, fallback, prompt, `${description} (fallback)`, timeoutMs);
        } catch (fallbackError) {
          if (fallbackError instanceof WorkflowCancelled) throw fallbackError;
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new WorkflowError(`${error.message} Fallback '${fallbackModelId}' also failed: ${fallbackMessage}`);
        }
      }
    },

    parsed: async (subagentId, prompt, description, parse, onRetry, maxAttempts = 3, options) => {
      let lastError = '';
      let lastRaw = '';

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let raw: string;
        if (attempt === 1) {
          raw = await dispatcher.agent(subagentId, prompt, description, options);
        } else {
          const footer = [
            `⚠ FORMAT ERROR — RETRY ATTEMPT ${attempt}`,
            `Your previous response could not be parsed: ${lastError}.`,
            'Your previous response was:',
            lastRaw.slice(0, 4000),
            'Respond again now, strictly and exactly in the required output format. Output nothing else.',
          ].join('\n');
          raw = await dispatcher.agent(subagentId, `${prompt}\n\n${footer}`, description, options);
        }

        try {
          return parse(raw);
        } catch (error) {
          if (error instanceof ParseError) {
            lastError = error.message;
            lastRaw = raw;
            onRetry?.(attempt, error.message);
            continue;
          }
          throw error;
        }
      }

      throw new WorkflowError(`Workflow agent '${subagentId}' failed to produce a parseable response after ${maxAttempts} attempts. Last parse error: ${lastError}`);
    },
  };

  return dispatcher;
}
