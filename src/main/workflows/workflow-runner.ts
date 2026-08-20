import { formatConversation } from './conversation';
import { createWorkflowDispatcher } from './dispatch';
import { describeModelSet, resolveActiveModelSet, validateModelSet } from './model-sets';
import { WorkflowDefinition } from './types';
import { createWorkflowLogger, createWorkflowRun } from './logging';
import { formatWorkflowStart } from './reporting';

import type { Task } from '@/task';

export async function runWorkflow(task: Task, workflow: WorkflowDefinition, prompt: string): Promise<void> {
  await task.ensureWorkflowHistory();

  // Snapshot the conversation before the workflow command was added.
  // handleWorkflowCommand emits the command via addUserMessage (UI-only, not
  // persisted to context), so getContextMessages returns the prior thread.
  const conversationText = formatConversation(await task.getContextMessages());

  const run = createWorkflowRun(workflow);
  const log = createWorkflowLogger(task, run);
  await task.addWorkflowInvocationMessage(prompt, run);

  // Resolve and validate the active model set.
  const modelSet = resolveActiveModelSet(task, workflow);
  const problems = validateModelSet(task, modelSet);
  if (problems.length > 0) {
    await log.error(
      `Workflow '${workflow.name}': model set '${modelSet.name}' cannot be used:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
    return;
  }

  await log.info(formatWorkflowStart(workflow.name, describeModelSet(modelSet), conversationText.length));

  const dispatch = createWorkflowDispatcher(task, run, modelSet);

  // Imperative path
  if (workflow.run) {
    await workflow.run({ task, initialPrompt: prompt, conversationText, modelSet, dispatch, run, log });
    return;
  }

  // Linear (steps) path
  let previousOutput = prompt;
  const steps = workflow.steps ?? [];

  if (steps.length === 0) {
    await log.error(`Workflow '${workflow.name}' has neither a run function nor any steps.`);
    return;
  }

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    const stepPrompt = step.buildPrompt({ initialPrompt: prompt, previousOutput, stepIndex, conversationText });
    const label = step.description ?? `${workflow.name} — step ${stepIndex + 1}`;

    await log.info(`### ▶️ ${label}`);
    try {
      previousOutput = await dispatch.agent(step.subagentId, stepPrompt, label);
    } catch (error) {
      await log.warning(`Workflow '${workflow.name}' stopped at step ${stepIndex + 1}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }

  await log.info(`Workflow '${workflow.name}' completed.`);
  await log.summary(`## ${workflow.name} — Summary\n\n${previousOutput}`, 'final-summary');
}
