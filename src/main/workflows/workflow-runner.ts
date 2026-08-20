import { formatConversation } from './conversation';
import { createWorkflowDispatcher, WorkflowCancelled, WorkflowError } from './dispatch';
import { describeWorkflowConfig, resolveWorkflowConfig, validateWorkflowConfig } from './model-config';
import { runWorkflowBashCommand } from './bash-command';
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

  // Resolve and validate the workflow model configuration.
  const modelConfig = resolveWorkflowConfig(task, workflow);
  const problems = validateWorkflowConfig(task, modelConfig);
  if (problems.length > 0) {
    await log.error(`Workflow '${workflow.name}': model configuration cannot be used:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    return;
  }

  await log.info(formatWorkflowStart(workflow.name, describeWorkflowConfig(modelConfig), conversationText.length));

  const dispatch = createWorkflowDispatcher(task, modelConfig, log);

  // Imperative path
  if (workflow.run) {
    await workflow.run({ task, initialPrompt: prompt, conversationText, modelConfig, dispatch, run, log });
    await runWorkflowBashCommand(task, workflow, log);
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
      if (error instanceof WorkflowCancelled) {
        await log.warning(`Workflow '${workflow.name}' cancelled at step ${stepIndex + 1}.`);
        return;
      }
      if (error instanceof WorkflowError) {
        await log.warning(`Workflow '${workflow.name}' stopped at step ${stepIndex + 1}: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  await runWorkflowBashCommand(task, workflow, log);
  await log.info(`Workflow '${workflow.name}' completed.`);
  await log.summary(`## ${workflow.name} — Summary\n\n${previousOutput}`, 'final-summary');
}
