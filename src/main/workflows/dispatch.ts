import { AgentProfile, WorkflowConfig, isWorkflowPersistPrimaryEnabled } from '@common/types';

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
export const PERSIST_PRIMARY_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const PERSIST_PRIMARY_MAX_RETRIES = PERSIST_PRIMARY_RETRY_DELAYS_MS.length;

const waitForPersistPrimaryBackoff = (delayMs: number): Promise<void> => {
  const jitter = delayMs * (0.9 + Math.random() * 0.2);
  return new Promise((resolve) => setTimeout(resolve, jitter));
};

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
      const slot = options?.modelSlot ?? 'primary';
      const persistPrimary = slot === 'primary' && isWorkflowPersistPrimaryEnabled(config, subagentId);
      const timeoutMs = options?.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

      const runOnce = async (target: AgentProfile): Promise<string> => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        try {
          const { status, outputText, errorDetail } = await task.dispatchSubagent(target, prompt, description, controller.signal);
          if (status === 'cancelled') {
            if (timedOut) throw new WorkflowTimeout(subagentId, timeoutMs);
            throw new WorkflowCancelled();
          }
          if (status === 'error') {
            throw new WorkflowError(errorDetail ?? `Workflow agent '${subagentId}' failed to complete its run.`);
          }
          return outputText;
        } finally {
          clearTimeout(timer);
        }
      };

      const primary = applyModelOverride(base, subagentId, config, slot);
      let target = primary;
      if (slot === 'fallback') {
        // Direct fallback-slot dispatch escalates effort: triple the agent's iteration budget (0 = unlimited stays 0).
        target = { ...primary, maxIterations: primary.maxIterations > 0 ? primary.maxIterations * 3 : 0 };
      }

      const runWithPersistPrimaryRetry = async (): Promise<string> => {
        try {
          return await runOnce(target);
        } catch (error) {
          if (!persistPrimary || error instanceof WorkflowCancelled || error instanceof WorkflowTimeout || !(error instanceof WorkflowError)) {
            throw error;
          }

          let lastError: WorkflowError = error;
          for (let retry = 0; retry < PERSIST_PRIMARY_MAX_RETRIES; retry++) {
            const delayMs = PERSIST_PRIMARY_RETRY_DELAYS_MS[retry];
            await log?.warning(
              `Workflow agent '${subagentId}' failed with ${target.provider}/${target.model} (${lastError.message}); persist-primary retry ${retry + 1}/${PERSIST_PRIMARY_MAX_RETRIES} in ${Math.round(delayMs / 1000)}s before fallback.`,
            );
            options?.onPersistPrimaryRetry?.();
            await waitForPersistPrimaryBackoff(delayMs);
            try {
              return await runOnce(target);
            } catch (retryError) {
              if (retryError instanceof WorkflowCancelled || retryError instanceof WorkflowTimeout || !(retryError instanceof WorkflowError)) {
                throw retryError;
              }
              lastError = retryError;
            }
          }
          throw lastError;
        }
      };

      try {
        return await runWithPersistPrimaryRetry();
      } catch (error) {
        if (error instanceof WorkflowCancelled) {
          throw error;
        }
        if (!(error instanceof WorkflowError)) {
          throw error;
        }

        // The built-in automatic fallback retry only applies to primary-slot dispatches
        // that have not opted out. Fallback-slot dispatches propagate errors immediately.
        if (slot === 'primary' && !options?.disableFallback) {
          // With an unset fallback slot, the fallback resolves to the agent profile's own model —
          // a real fallback whenever a primary override is set, and a no-op (no extra attempt) when neither slot is set.
          const fallbackBase = applyModelOverride(base, subagentId, config, 'fallback');
          if (fallbackBase.provider === primary.provider && fallbackBase.model === primary.model) {
            throw error;
          }

          // Fallback mode escalates effort: triple the agent's iteration budget (0 = unlimited stays 0).
          const fallback: AgentProfile = {
            ...fallbackBase,
            maxIterations: fallbackBase.maxIterations > 0 ? fallbackBase.maxIterations * 3 : 0,
          };

          const message = error.message;
          await log?.warning(
            `Workflow agent '${subagentId}' failed with ${primary.provider}/${primary.model} (${message}); retrying with fallback ${fallback.provider}/${fallback.model} (max iterations ×3).`,
          );
          return await runOnce(fallback);
        }

        throw error;
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
