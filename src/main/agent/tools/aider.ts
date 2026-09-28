import path from 'path';

import { tool } from 'ai';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import {
  TOOL_GROUP_NAME_SEPARATOR,
  AIDER_TOOL_GROUP_NAME as TOOL_GROUP_NAME,
  AIDER_TOOL_GET_CONTEXT_FILES as TOOL_GET_CONTEXT_FILES,
  AIDER_TOOL_ADD_CONTEXT_FILES as TOOL_ADD_CONTEXT_FILES,
  AIDER_TOOL_DROP_CONTEXT_FILES as TOOL_DROP_CONTEXT_FILES,
  AIDER_TOOL_RUN_PROMPT as TOOL_RUN_PROMPT,
  AIDER_TOOL_DESCRIPTIONS,
} from '@common/tools';
import { AgentProfile, AutonomyMode, PromptContext, ToolApprovalState } from '@common/types';

import { ApprovalManager } from './approval-manager';

import type { ToolSet } from 'ai';

import { coerceBoolean } from '@/agent/utils';
import { Task } from '@/task';

export const createAiderToolset = (task: Task, profile: AgentProfile, promptContext?: PromptContext): ToolSet => {
  const approvalManager = new ApprovalManager(task, profile);

  const getContextFilesTool = tool({
    description: AIDER_TOOL_DESCRIPTIONS[TOOL_GET_CONTEXT_FILES],
    inputSchema: z.object({
      taskDir: z.string().describe("The task directory. Can be '.' for current task."),
    }),
    execute: async (input, { toolCallId }) => {
      const { taskDir } = input;
      task.addToolMessage(
        toolCallId,
        TOOL_GROUP_NAME,
        TOOL_GET_CONTEXT_FILES,
        {
          taskDir,
        },
        undefined,
        undefined,
        promptContext,
      );

      const toolName = `${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_GET_CONTEXT_FILES}`;
      const questionKey = toolName;
      const questionText = 'Approve getting context files?';

      const [isApproved, userInput] = await approvalManager.handleToolApproval(toolName, input, questionKey, questionText);

      if (!isApproved) {
        return `Getting context files denied by user. Reason: ${userInput}`;
      }

      const files = await task.getContextFiles();
      return JSON.stringify(files);
    },
  });

  const addContextFilesTool = tool({
    description: AIDER_TOOL_DESCRIPTIONS[TOOL_ADD_CONTEXT_FILES],
    inputSchema: z.object({
      paths: z
        .array(z.string())
        .describe(
          'One or more paths to files or folders that already exist on disk. A relative path (e.g. "src/file.ts") is resolved against the task directory and nowhere else. For anything outside the task directory, including files in other projects, pass the full absolute path (e.g. "/home/user/other-project/src/file.ts"). Paths that do not exist are rejected; this tool never creates files.',
        ),
      readOnly: coerceBoolean
        .optional()
        .describe('Whether the file(s) are read-only. Applies to all paths if true. Set to true for files outside the task directory.'),
    }),
    execute: async (input, { toolCallId }) => {
      const { paths, readOnly = false } = input;
      task.addToolMessage(
        toolCallId,
        TOOL_GROUP_NAME,
        TOOL_ADD_CONTEXT_FILES,
        {
          paths,
          readOnly,
        },
        undefined,
        undefined,
        promptContext,
      );

      const toolName = `${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_ADD_CONTEXT_FILES}`;
      const taskDir = task.getTaskDir();
      const results: string[] = [];
      for (const filePath of paths) {
        const resolvedPath = path.resolve(taskDir, filePath);

        if (!path.isAbsolute(filePath)) {
          const relativeToTaskDir = path.relative(taskDir, resolvedPath);
          const escapesTaskDir = relativeToTaskDir === '..' || relativeToTaskDir.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTaskDir);
          if (escapesTaskDir) {
            task.addLogMessage(
              'warning',
              `add_context_files rejected '${filePath}': the relative path points outside the task directory (it resolves to '${resolvedPath}'). Nothing was added.`,
            );
            results.push(
              `Error: '${filePath}' was not added. It is a relative path that points outside the task directory. Relative paths are resolved against the task directory '${taskDir}' only, so it resolves to '${resolvedPath}'. For a file outside the task directory, including a file in another project, pass its full absolute path instead.`,
            );
            continue;
          }
        }

        const existingPath = await task.resolveContextFilePath(filePath);
        if (!existingPath) {
          task.addLogMessage(
            'warning',
            `add_context_files rejected '${filePath}': nothing exists at '${resolvedPath}'. No file was created and nothing was added.`,
          );
          const hint = path.isAbsolute(filePath)
            ? 'Check that the path is correct.'
            : `Relative paths are resolved against the task directory '${taskDir}' only. If the file is in another project or anywhere else outside the task directory, pass its full absolute path.`;
          results.push(
            `Error: '${filePath}' was not added: nothing exists at '${resolvedPath}'. This tool never creates files, and nothing was created. ${hint} To work on a new file, create it first with a file-writing tool, then add it.`,
          );
          continue;
        }

        const questionKey = `${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_ADD_CONTEXT_FILES}_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const questionText = `Approve adding file '${filePath}' to context?`;

        const [isApproved, userInput] = await approvalManager.handleToolApproval(toolName, input, questionKey, questionText);

        if (!isApproved) {
          results.push(`Adding '${filePath}' to context denied by user. Reason: ${userInput}`);
          continue;
        }

        const added = await task.addFiles({
          path: filePath,
          readOnly,
        });
        if (added) {
          results.push(`Added file: ${filePath}`);
        } else {
          results.push(`Not added - file '${filePath}' was already in the context.`);
        }
      }
      return results.join('\n');
    },
  });

  const dropContextFilesTool = tool({
    description: AIDER_TOOL_DESCRIPTIONS[TOOL_DROP_CONTEXT_FILES],
    inputSchema: z.object({
      paths: z.array(z.string()).describe('One or more file paths to remove from context.'),
    }),
    execute: async (input, { toolCallId }) => {
      const { paths } = input;
      task.addToolMessage(toolCallId, TOOL_GROUP_NAME, TOOL_DROP_CONTEXT_FILES, { paths }, undefined, undefined, promptContext);

      const toolName = `${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_DROP_CONTEXT_FILES}`;
      const results: string[] = [];
      for (const filePath of paths) {
        const questionKey = toolName;
        const questionText = `Approve dropping file '${filePath}' from context?`;

        const [isApproved, userInput] = await approvalManager.handleToolApproval(toolName, input, questionKey, questionText);

        if (!isApproved) {
          results.push(`Dropping file '${filePath}' from context denied by user. Reason: ${userInput}`);
          continue;
        }

        task.dropFile(filePath);
        results.push(`Dropped file: ${filePath}`);
      }
      return results.join('\n');
    },
  });

  const runPromptTool = tool({
    description: AIDER_TOOL_DESCRIPTIONS[TOOL_RUN_PROMPT],
    inputSchema: z.object({
      prompt: z.string().describe('The prompt to run in natural language.'),
    }),
    execute: async (input, { toolCallId }) => {
      const { prompt } = input;
      const aiderPromptContext: PromptContext = {
        id: uuidv4(),
        group: {
          id: uuidv4(),
          color: 'var(--color-agent-aider-tools)',
          name: 'toolMessage.aider.working',
        },
      };

      task.addToolMessage(toolCallId, TOOL_GROUP_NAME, TOOL_RUN_PROMPT, { prompt }, undefined, undefined, aiderPromptContext);

      const toolName = `${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_RUN_PROMPT}`;
      const questionKey = toolName;
      const questionText = 'Approve prompt to run in Aider?';

      // Ask the question and wait for the answer
      const [isApproved, userInput] = await approvalManager.handleToolApproval(toolName, input, questionKey, questionText, prompt);

      if (!isApproved) {
        return {
          responses: [],
          updatedFiles: [],
          deniedReason: userInput,
          error: 'Aider prompt execution denied by user. Update the prompt based on the denied reason or cancel and do not run again.',
        };
      }

      task.addToolMessage(toolCallId, TOOL_GROUP_NAME, TOOL_RUN_PROMPT, { prompt }, undefined, undefined, aiderPromptContext);

      const responses = await task.sendPromptToAider(prompt, aiderPromptContext, 'code', [], undefined, {
        autoApprove: task.task.autonomyMode !== AutonomyMode.Manual,
        denyCommands: true,
      });

      // Notify that we are still processing after aider finishes
      task.addLogMessage('loading');

      const updatedFiles = responses.flatMap((response) => response.editedFiles || []).filter((value, index, self) => self.indexOf(value) === index);
      return {
        responses,
        updatedFiles,
        promptContext: {
          ...aiderPromptContext,
          group: {
            ...aiderPromptContext.group!,
            name: updatedFiles.length ? 'toolMessage.aider.finishedTask' : 'toolMessage.aider.noChanges',
            finished: true,
          },
        } satisfies PromptContext,
      };
    },
  });

  const allTools = {
    [`${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_GET_CONTEXT_FILES}`]: getContextFilesTool,
    [`${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_ADD_CONTEXT_FILES}`]: addContextFilesTool,
    [`${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_DROP_CONTEXT_FILES}`]: dropContextFilesTool,
    [`${TOOL_GROUP_NAME}${TOOL_GROUP_NAME_SEPARATOR}${TOOL_RUN_PROMPT}`]: runPromptTool,
  };

  // Filter out tools that are set to Never in toolApprovals
  const filteredTools: ToolSet = {};
  for (const [toolId, tool] of Object.entries(allTools)) {
    if (profile.toolApprovals[toolId] !== ToolApprovalState.Never) {
      filteredTools[toolId] = tool;
    }
  }

  return filteredTools;
};
