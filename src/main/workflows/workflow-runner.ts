import { findEnabledSubagent } from '@/agent/subagent';

import { WorkflowDefinition } from './types';

import type { Task } from '@/task';

export async function runWorkflow(task: Task, workflow: WorkflowDefinition, prompt: string): Promise<void> {
  // Imperative workflows provide a `run` function that drives the whole
  // pipeline itself; delegate to it and return.
  if (workflow.run) {
    await workflow.run({ task, initialPrompt: prompt });
    return;
  }

  // Workflow steps are resolved exclusively from the Workflow Agents tier.
  const workflowAgents = task.getProject().getWorkflowAgentProfiles();

  let previousOutput = prompt;

  const steps = workflow.steps ?? [];

  if (steps.length === 0) {
    task.addLogMessage('error', `Workflow '${workflow.name}' has neither a run function nor any steps.`);
    return;
  }

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    const target = findEnabledSubagent(workflowAgents, step.subagentId, { matchByName: true });

    if (!target) {
      task.addLogMessage('error', `Workflow '${workflow.name}': workflow agent '${step.subagentId}' not found. Create it under Workflow Agents.`);
      return;
    }

    const stepPrompt = step.buildPrompt({ initialPrompt: prompt, previousOutput, stepIndex });
    const label = step.description ?? `${workflow.name} — step ${stepIndex + 1}`;

    const { status, outputText } = await task.dispatchSubagent(target, stepPrompt, label);

    if (status !== 'success') {
      task.addLogMessage('warning', `Workflow '${workflow.name}' stopped at step ${stepIndex + 1} (status: ${status}).`);
      return;
    }

    previousOutput = outputText;
  }

  task.addLogMessage('info', `Workflow '${workflow.name}' completed.`);
}
