import { AgentProfile } from '@common/types';

import { findEnabledSubagent } from '@/agent/subagent';
import type { Task } from '@/task';

import { ParseError } from './parsers';

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
 * Dispatches a single workflow subagent run and returns its text output.
 * A cancelled run throws `WorkflowCancelled`; an errored run throws
 * `WorkflowError` (naming the agent).
 */
export async function dispatchAgent(task: Task, subagentId: string, prompt: string, description: string): Promise<string> {
  const target = resolveWorkflowAgent(task, subagentId);
  const { status, outputText } = await task.dispatchSubagent(target, prompt, description);

  if (status === 'cancelled') {
    throw new WorkflowCancelled();
  }
  if (status === 'error') {
    throw new WorkflowError(`Workflow agent '${subagentId}' failed to complete its run.`);
  }

  return outputText;
}

/**
 * Dispatches a workflow subagent and parses its response, retrying on
 * malformed output. On a `ParseError` the agent is re-dispatched with the
 * original prompt plus a corrective footer describing the format error and
 * echoing the previous (truncated) response. Non-`ParseError` exceptions
 * propagate immediately. After `maxAttempts` consecutive failures a
 * `WorkflowError` is thrown.
 */
export async function dispatchParsed<T>(
  task: Task,
  subagentId: string,
  prompt: string,
  description: string,
  parse: (raw: string) => T,
  onRetry?: (attempt: number, error: string) => void,
  maxAttempts = 3,
): Promise<T> {
  let lastError = '';
  let lastRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    if (attempt === 1) {
      raw = await dispatchAgent(task, subagentId, prompt, description);
    } else {
      const footer = [
        `⚠ FORMAT ERROR — RETRY ATTEMPT ${attempt}`,
        `Your previous response could not be parsed: ${lastError}.`,
        'Your previous response was:',
        lastRaw.slice(0, 4000),
        'Respond again now, strictly and exactly in the required output format. Output nothing else.',
      ].join('\n');
      raw = await dispatchAgent(task, subagentId, `${prompt}\n\n${footer}`, description);
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

  throw new WorkflowError(`Workflow agent '${subagentId}' failed to produce a parseable response after ${maxAttempts} attempts`);
}
