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
  const command = task.getSettings().workflowConfigs?.[workflow.id]?.bashCommand?.trim();
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
