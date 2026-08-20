import { AgentProfile, WorkflowConfig } from '@common/types';

import { findEnabledSubagent } from '@/agent/subagent';
import type { Task } from '@/task';

import { applyModelOverride } from './model-config';
import { ParseError } from './parsers';
import { WorkflowDispatcher, WorkflowLogger } from './types';

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

/**
 * Resolves a workflow agent by its slug/name from the Workflow Agents tier.
 * Throws a `WorkflowError` when the agent is not found.
 *
 * @param task The task running the workflow
 * @param subagentId The name or identifier of the workflow subagent
 * @returns The resolved AgentProfile
 */
export function resolveWorkflowAgent(task: Task, subagentId: string): AgentProfile {
  const target = findEnabledSubagent(task.getProject().getWorkflowAgentProfiles(), subagentId, { matchByName: true });
  if (!target) {
    throw new WorkflowError(`Workflow agent '${subagentId}' not found. Create it under Workflow Agents.`);
  }
  return target;
}

/**
 * Creates a workflow dispatch handle bound to a task, workflow configuration, and logger.
 * The returned `WorkflowDispatcher` resolves each workflow agent by role name,
 * attempts dispatch with primary model overrides, and falls back to fallback model overrides
 * on WorkflowError / WorkflowTimeout.
 *
 * @param task The task running the workflow
 * @param config Optional workflow model configuration overrides
 * @param log Optional workflow logger for progress and warnings
 * @returns A WorkflowDispatcher instance for executing workflow subagent prompts
 */
export function createWorkflowDispatcher(task: Task, config?: WorkflowConfig, log?: WorkflowLogger): WorkflowDispatcher {
  const dispatcher: WorkflowDispatcher = {
    agent: async (subagentId, prompt, description, options) => {
      const base = resolveWorkflowAgent(task, subagentId);
      const timeoutMs = options?.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

      const runOnce = async (target: AgentProfile): Promise<string> => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          const { status, outputText } = await task.dispatchSubagent(target, prompt, description, controller.signal);
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

      const primary = applyModelOverride(base, subagentId, config, 'primary');
      try {
        return await runOnce(primary);
      } catch (error) {
        if (error instanceof WorkflowCancelled) {
          throw error;
        }
        if (!(error instanceof WorkflowError)) {
          throw error;
        }

        // With an unset fallback slot, the fallback resolves to the agent profile's own model —
        // a real fallback whenever a primary override is set, and a no-op (no extra attempt) when neither slot is set.
        const fallback = applyModelOverride(base, subagentId, config, 'fallback');
        if (fallback.provider === primary.provider && fallback.model === primary.model) {
          throw error;
        }

        const message = error.message;
        await log?.warning(
          `Workflow agent '${subagentId}' failed with ${primary.provider}/${primary.model} (${message}); retrying with fallback ${fallback.provider}/${fallback.model}.`,
        );
        return await runOnce(fallback);
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
