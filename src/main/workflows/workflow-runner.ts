import { findEnabledSubagent } from '@/agent/subagent';

import { WorkflowDefinition } from './types';

import type { Task } from '@/task';

export async function runWorkflow(task: Task, workflow: WorkflowDefinition, prompt: string): Promise<void> {
  // Workflow steps are resolved exclusively from the Workflow Agents tier.
  const workflowAgents = task.getProject().getWorkflowAgentProfiles();

  let previousOutput = prompt;

  for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex++) {
    const step = workflow.steps[stepIndex];
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
