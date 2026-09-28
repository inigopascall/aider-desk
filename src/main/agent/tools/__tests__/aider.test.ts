/**
 * Tests for the aider add_context_files tool: it adds existing paths and never creates files.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Aider Tools - add_context_files', () => {
  const TOOL_ID = 'aider---add_context_files';

  let createAiderToolset: any;
  let rootDir: string;
  let taskDir: string;
  let otherProjectDir: string;
  let mockTask: any;
  let mockProfile: any;

  const exists = (filePath: string): Promise<boolean> =>
    fs.access(filePath).then(
      () => true,
      () => false,
    );

  const runTool = async (paths: string[], readOnly?: boolean): Promise<string> => {
    const tools = createAiderToolset(mockTask, mockProfile);
    return tools[TOOL_ID].execute({ paths, readOnly }, { toolCallId: 'tool-call-1', messages: [] });
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aider-add-context-files-'));
    taskDir = path.join(rootDir, 'project');
    otherProjectDir = path.join(rootDir, 'other-project');
    await fs.mkdir(path.join(taskDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(otherProjectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(taskDir, 'src', 'existing.ts'), 'export const a = 1;\n');
    await fs.writeFile(path.join(otherProjectDir, 'src', 'other.ts'), 'export const b = 2;\n');

    mockTask = {
      taskId: 'test-task-id',
      task: { autonomyMode: 'autonomous' },
      getTaskDir: vi.fn(() => taskDir),
      getProjectDir: vi.fn(() => taskDir),
      resolveContextFilePath: vi.fn(async (filePath: string) => {
        const absolutePath = path.resolve(taskDir, filePath);
        return (await exists(absolutePath)) ? absolutePath : null;
      }),
      addFiles: vi.fn().mockResolvedValue(true),
      addToGit: vi.fn(),
      addToolMessage: vi.fn(),
      addLogMessage: vi.fn(),
      askQuestion: vi.fn(),
      dispatchExtensionEvent: vi.fn(async (_eventName: string, event: Record<string, unknown>) => ({ ...event, blocked: false, allowed: false })),
    };

    mockProfile = {
      toolApprovals: {},
      toolSettings: {},
    };

    createAiderToolset = (await import('../aider')).createAiderToolset;
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('adds an existing file given as a relative path', async () => {
    const result = await runTool(['src/existing.ts']);

    expect(result).toBe('Added file: src/existing.ts');
    expect(mockTask.addFiles).toHaveBeenCalledWith({ path: 'src/existing.ts', readOnly: false });
    expect(mockTask.addLogMessage).not.toHaveBeenCalledWith('warning', expect.anything());
  });

  it('adds an existing file outside the project given as an absolute path', async () => {
    const absolutePath = path.join(otherProjectDir, 'src', 'other.ts');

    const result = await runTool([absolutePath], true);

    expect(result).toBe(`Added file: ${absolutePath}`);
    expect(mockTask.addFiles).toHaveBeenCalledWith({ path: absolutePath, readOnly: true });
  });

  it('rejects a missing relative path without creating the file or its directory', async () => {
    const result = await runTool(['src/missing/new-file.ts']);

    expect(result).toMatch(/^Error: /);
    expect(result).toContain(path.join(taskDir, 'src', 'missing', 'new-file.ts'));
    expect(await exists(path.join(taskDir, 'src', 'missing'))).toBe(false);
    expect(mockTask.addFiles).not.toHaveBeenCalled();
    expect(mockTask.addToGit).not.toHaveBeenCalled();
    expect(mockTask.addLogMessage).toHaveBeenCalledWith('warning', expect.stringContaining('src/missing/new-file.ts'));
  });

  it('rejects a missing absolute path without creating anything', async () => {
    const missingPath = path.join(rootDir, 'nowhere', 'file.ts');

    const result = await runTool([missingPath]);

    expect(result).toMatch(/^Error: /);
    expect(await exists(path.join(rootDir, 'nowhere'))).toBe(false);
    expect(mockTask.addFiles).not.toHaveBeenCalled();
    expect(mockTask.addLogMessage).toHaveBeenCalledWith('warning', expect.stringContaining(missingPath));
  });

  it('rejects a path given relative to another project root instead of creating it here', async () => {
    const result = await runTool(['src/other.ts']);

    expect(result).toMatch(/^Error: /);
    expect(result).toContain('absolute path');
    expect(await exists(path.join(taskDir, 'src', 'other.ts'))).toBe(false);
    expect(mockTask.addFiles).not.toHaveBeenCalled();
  });

  it('rejects a relative path that climbs out of the task directory, even when the file exists', async () => {
    const result = await runTool(['../other-project/src/other.ts']);

    expect(result).toMatch(/^Error: /);
    expect(result).toContain('absolute path');
    expect(mockTask.addFiles).not.toHaveBeenCalled();
    expect(mockTask.addLogMessage).toHaveBeenCalledWith('warning', expect.stringContaining('../other-project/src/other.ts'));
    expect(await fs.readFile(path.join(otherProjectDir, 'src', 'other.ts'), 'utf8')).toBe('export const b = 2;\n');
  });

  it('in manual mode, rejects a missing path without asking to create it', async () => {
    mockTask.task.autonomyMode = 'manual';

    const result = await runTool(['src/missing.ts']);

    expect(result).toMatch(/^Error: /);
    expect(mockTask.askQuestion).not.toHaveBeenCalled();
    expect(await exists(path.join(taskDir, 'src', 'missing.ts'))).toBe(false);
  });

  it('adds the valid paths and reports the invalid ones in a mixed batch', async () => {
    const result = await runTool(['src/existing.ts', 'src/missing.ts']);
    const lines = result.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Added file: src/existing.ts');
    expect(lines[1]).toMatch(/^Error: 'src\/missing\.ts'/);
    expect(mockTask.addFiles).toHaveBeenCalledTimes(1);
  });
});
