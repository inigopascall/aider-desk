import { getSubagentId } from '@common/agent';

import { findEnabledSubagent } from '@/agent/subagent';
import logger from '@/logger';

import { WorkflowDefinition } from './types';

import type { Task } from '@/task';

export async function runWorkflow(task: Task, workflow: WorkflowDefinition, prompt: string): Promise<void> {
  const mainAgentProfile = await task.getTaskAgentProfile();
  const enabledSubagents = task
    .getProject()
    .getAgentProfiles()
    .filter((p) => p.subagent.enabled === true && p.id !== mainAgentProfile?.id);

  let previousOutput = prompt;

  for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex++) {
    const step = workflow.steps[stepIndex];
    const target = findEnabledSubagent(enabledSubagents, step.subagentId, { matchByName: true });

    if (!target) {
      task.addLogMessage('error', `Workflow '${workflow.name}': subagent '${step.subagentId}' not found or not enabled.`);
      return;
    }

    const stepPrompt = step.buildPrompt({ initialPrompt: prompt, previousOutput, stepIndex });
    const label = step.description ?? `${workflow.name} — step ${stepIndex + 1}`;

    logger.info('Running workflow step', { workflow: workflow.id, stepIndex, subagent: getSubagentId(target) });

    const { status, outputText } = await task.dispatchSubagent(target, stepPrompt, label);

    if (status !== 'success') {
      task.addLogMessage('warning', `Workflow '${workflow.name}' stopped at step ${stepIndex + 1} (status: ${status}).`);
      return;
    }

    previousOutput = outputText;
  }

  task.addLogMessage('info', `Workflow '${workflow.name}' completed.`);
}
