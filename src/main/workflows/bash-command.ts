import { simpleGit } from 'simple-git';
import { execWithShellPath } from '@/utils';
import type { Task } from '@/task';
import type { WorkflowDefinition, WorkflowLogger } from './types';

const MAX_OUTPUT_CHARS = 4000;

/**
 * Truncates output text to a maximum character limit.
 *
 * @param text The string to truncate
 * @param max Maximum number of characters allowed
 * @returns The truncated string
 */
function truncateOutput(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * Runs the configured optional post-workflow bash command in the task directory,
 * followed by a final git commit of any changes if the working tree is dirty.
 *
 * @param task The task running the workflow
 * @param workflow The workflow definition
 * @param log The workflow logger
 */
export async function runWorkflowBashCommand(
  task: Task,
  workflow: WorkflowDefinition,
  log: WorkflowLogger,
): Promise<void> {
  const command = task.getProjectSettings().workflowConfigs?.[workflow.id]?.bashCommand?.trim();
  if (!command) {
    return;
  }

  await log.info(`### 🖥️ Workflow bash command\n\`\`\`bash\n${command}\n\`\`\``);

  try {
    const result = await execWithShellPath(command, {
      cwd: task.getTaskDir(),
      signal: AbortSignal.timeout(10 * 60_000),
    });

    const outputBlocks: string[] = [];
    const stdoutTrimmed = result.stdout.trim();
    const stderrTrimmed = result.stderr.trim();

    if (stdoutTrimmed.length > 0) {
      outputBlocks.push(`**stdout**\n\`\`\`\n${truncateOutput(stdoutTrimmed, MAX_OUTPUT_CHARS)}\n\`\`\``);
    }
    if (stderrTrimmed.length > 0) {
      outputBlocks.push(`**stderr**\n\`\`\`\n${truncateOutput(stderrTrimmed, MAX_OUTPUT_CHARS)}\n\`\`\``);
    }

    if (outputBlocks.length > 0) {
      await log.info(outputBlocks.join('\n\n'));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log.warning(`Workflow bash command failed: ${message}`);
  }

  try {
    const git = simpleGit(task.getTaskDir());
    if ((await git.checkIsRepo()) && !(await git.status()).isClean()) {
      await git.add('-A');
      await git.raw(['commit', '--no-verify', '-m', `[${workflow.id}] post-command changes`]);
      await log.info('Post-command changes committed.');
    }
  } catch (gitError) {
    const gitMessage = gitError instanceof Error ? gitError.message : String(gitError);
    await log.warning(`Failed to commit post-command changes: ${gitMessage}`);
  }
}

/**
 * Runs the configured optional post-edit validation command in the task
 * directory and returns its full output for the reviewer. A failing command
 * is valuable arbiter evidence, not a workflow error, so this never throws.
 *
 * @param task The task running the workflow
 * @param workflowId The workflow id whose config supplies the command
 * @param log The workflow logger
 * @returns The formatted command output, or null when no command is configured
 */
export async function runPostEditValidationCommand(task: Task, workflowId: string, log: WorkflowLogger): Promise<string | null> {
  const command = task.getProjectSettings().workflowConfigs?.[workflowId]?.preArbiterCommand?.trim();
  if (!command) {
    return null;
  }

  await log.info(`### 🧪 Post-edit validation command\n\`\`\`bash\n${command}\n\`\`\``);

  let exitLine = 'Exit: success';
  let stdout = '';
  let stderr = '';

  try {
    const result = await execWithShellPath(command, {
      cwd: task.getTaskDir(),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    stdout = result.stdout.trim();
    stderr = result.stderr.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitLine = `Exit: FAILED — ${message}`;
    if (error && typeof error === 'object' && 'stdout' in error) {
      stdout = String((error as { stdout?: unknown }).stdout ?? '').trim();
    }
    if (error && typeof error === 'object' && 'stderr' in error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    }
  }

  const blocks: string[] = [`Command: ${command}`, exitLine];
  if (stdout.length > 0) {
    blocks.push('--- stdout ---', truncateOutput(stdout, MAX_OUTPUT_CHARS));
  }
  if (stderr.length > 0) {
    blocks.push('--- stderr ---', truncateOutput(stderr, MAX_OUTPUT_CHARS));
  }
  const resultText = blocks.join('\n');

  if (exitLine === 'Exit: success') {
    await log.info(resultText);
  } else {
    await log.warning(resultText);
  }

  return resultText;
}
